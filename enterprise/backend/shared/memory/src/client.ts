/**
 * client — Mem0 OSS 客户端薄封装（FL-21 F-21-01）
 *
 * 按架构 §7，Mem0 承载 ②Episodic / ③Preference / ⑥UsagePattern 三类。
 * ④车辆档案走 PostgreSQL、⑤环境缓存走 Redis、①短期任务态在图状态里，都不进这里。
 *
 * # Mem0 的 TS OSS 形态是库，不是服务
 *
 * `mem0ai/oss` 导出的 `Memory` 类在本进程内实例化，向量库/LLM/embedder 都是它的
 * 可插拔后端。部署 Mem0 即部署它的向量库，docker-compose 里不需要 Mem0 容器。
 *
 * # 本模块守住的性质
 *
 * 1. 降级而非崩溃：记忆是增强不是必需。Mem0 不可用时对话照常进行，只是没有个性化。
 *    所有读路径返回空结果 + `degraded` 标记，不把异常抛到业务层。
 * 2. 缺用户必须失败：userId 缺失时抛错，不退化成读全量，防止跨用户泄露。
 *    降级只针对后端不可用，不针对调用方错误。
 * 3. 类别过滤两边都做：filters 传给 Mem0，拿回来再按 `metadata.category` 筛一遍，
 *    防止后端静默忽略 filters 时返回全部类别。
 *
 * # 版本要求：mem0ai ≥ 3
 *
 * 2.x 的 `PGVector.initialize()` 不幂等，而 `Memory._autoInitialize()` 会调它两次，
 * 第二次在已连接的 pg Client 上 `connect()` 抛错。3.x 用 `_initPromise`
 * 记忆化解决，并原生支持 connectionString。
 */

// 必须是本文件第一条 import：mem0ai/oss 在求值时读一次 MEM0_TELEMETRY，之后再设无效。
import "./mem0-telemetry";
import { Memory } from "mem0ai/oss";
import { resolveDeepSeekModel } from "@cabinhug/shared";

import { resolveEmbedderConfig } from "./embedder-config";

import type {
  MemoryConfig,
  AddMemoryOptions,
  SearchResult,
  MemoryItem,
} from "mem0ai/oss";
import { memoryCollectionName } from "./collection";

// ── metadata 约定 ──────────────────────────────────────────
//
// 入参类型与落库类型分开定义，不用 `Omit<Meta, "category">`。
// 这三个类型带字符串索引签名（允许业务扩展字段），`Omit` 对带索引签名的类型
// 会把 `keyof T` 算成 `string | number`，抹掉所有具名字段，
// `occurredAt` 这类必填项在编译期不再受检。

export interface EpisodicMemoryInput {
  subType?: "trip" | "consultation" | "incident" | "interaction";
  /** ISO 8601 时间戳。②情景记忆按发生时间衰减，缺它就无法定权重。 */
  occurredAt: string;
  /** 关联车辆 VIN（可选）。 */
  vin?: string;
  [key: string]: unknown;
}

export interface PreferenceMemoryInput {
  domain: string;
  /** 0–1。低置信度的偏好不该被当成事实陈述给用户。 */
  confidence: number;
  lastConfirmedAt: string;
  [key: string]: unknown;
}

export interface UsagePatternInput {
  summaryType: "daily" | "weekly" | "monthly";
  periodStart: string;
  periodEnd: string;
  [key: string]: unknown;
}

export type EpisodicMemoryMeta = EpisodicMemoryInput & { category: "episodic" };
export type PreferenceMemoryMeta = PreferenceMemoryInput & { category: "preference" };
export type UsagePatternMeta = UsagePatternInput & { category: "usage_pattern" };

export type CabinhugMemoryMeta =
  | EpisodicMemoryMeta
  | PreferenceMemoryMeta
  | UsagePatternMeta;

/** Mem0 承载的三类；④⑤① 走别的存储，写进来直接拒。 */
const MEM0_CATEGORIES = ["episodic", "preference", "usage_pattern"] as const;

// ── 降级结果 ────────────────────────────────────────────────

/**
 * 读结果。在 Mem0 的 `SearchResult` 上只加字段不改字段，
 * 既有调用方读 `.results` 的写法不受影响。
 *
 * `degraded: true` 表示这次没查到不代表没有，调用方不得把空结果
 * 当成"用户没有这个偏好"。
 */
export interface MemoryReadResult extends SearchResult {
  degraded?: boolean;
  error?: string;
}

// ── 默认配置 ───────────────────────────────────────────────

/**
 * 把 `postgresql://user:pw@host:port/db` 拆成 mem0 要的分立字段。
 *
 * 分立字段是必需的：mem0ai 2.x 的 `PGVector` 构造函数只读
 * `user / password / host / port / dbname`，忽略 connectionString 并按默认值连接。
 */
function parsePgUrl(url: string): { user?: string; password?: string; host?: string; port?: number; dbname?: string } {
  try {
    const u = new URL(url);
    return {
      user: decodeURIComponent(u.username) || undefined,
      password: decodeURIComponent(u.password) || undefined,
      host: u.hostname || undefined,
      port: u.port ? Number(u.port) : 5432,
      dbname: u.pathname.replace(/^\//, "") || undefined,
    };
  } catch {
    return {};
  }
}

/** 向量库落点。默认 pgvector：备份归入现有 pg_dump（§13-11 方案 A）。 */
function resolveVectorStore(): MemoryConfig["vectorStore"] {
  const provider = process.env.MEM0_VECTOR_PROVIDER ?? "pgvector";
  const collectionName = memoryCollectionName();
  const dims = Number(process.env.MEM0_EMBEDDING_DIMS ?? 768);

  if (provider === "pgvector") {
    const url = process.env.MEM0_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
    const conn = parsePgUrl(url);
    return {
      provider,
      config: {
        collectionName,
        // mem0ai ≥3 支持直接给连接串（`useDirectConnection`），连的是 URL 里
        // 已纳入备份的库。分立字段同时给上作兜底，2.x 只认分立字段。
        connectionString: url || undefined,
        dimension: dims,
        // 字段名是 embeddingModelDims 不是 dimension。传错时建表语句变成
        // `vector(undefined)` 而失败，mem0 的 `_ensureInitialized` 自动重试一次，
        // 在已连接的 pg Client 上再调 connect()，报 "Client has already been connected"，
        // 掩盖真正的首个错误。
        embeddingModelDims: dims,
        ...conn,
        // 必须显式给 dbname：PGVector 默认 dbname 是 "vector_store"，
        // 且会在库不存在时自行创建，记忆会落到 pg_dump 范围之外（§13-11 方案 A）。
        dbname: conn.dbname ?? "carlife",
      },
    };
  }

  // 离线兜底：`memory` provider 落 sqlite 文件，在备份面之外，
  // 仅供本地实验，不作为部署形态（§13-11）。
  return {
    provider,
    config: {
      collectionName,
      dimension: dims,
      dbPath: process.env.MEM0_VECTOR_DB_PATH ?? "./data/mem0-vector.db",
    },
  };
}

function defaultConfig(): MemoryConfig {
  return {
    version: "v1.2",
    // embedding 缺省走 DashScope text-embedding-v4，供应商与 key 的取法见 embedder-config.ts。
    // 维度必须与 resolveVectorStore() 的 dimension 一致——两处都读 MEM0_EMBEDDING_DIMS。
    embedder: resolveEmbedderConfig(),
    vectorStore: resolveVectorStore(),
    // Mem0 用 LLM 从对话里抽取事实。写入走 `infer: false`（metadata 自行管理），
    // LLM 只在少数推断路径上被用到。
    llm: {
      provider: "openai",
      config: {
        apiKey: process.env.DEEPSEEK_API_KEY ?? "",
        model: resolveDeepSeekModel(process.env.MEM0_LLM_MODEL),
        baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/v1",
      },
    },
    // history 是"记忆被增删改"的流水，与记忆本身分开存（默认 sqlite 文件）。
    // 它可重建（丢的是审计轨迹，不是记忆），因此不进 §13-11 的备份范围。
    disableHistory: false,
    historyDbPath: process.env.MEM0_HISTORY_DB_PATH ?? "./data/mem0-history.db",
  };
}

// ── 客户端 ──────────────────────────────────────────────────

/**
 * 实际用到的 Mem0 面。用于可测性：
 * 降级、用户隔离、类别过滤三条性质可在不连任何后端的情况下断言。
 */
export type Mem0Like = Pick<
  Memory,
  "add" | "search" | "getAll" | "get" | "update" | "delete" | "deleteAll" | "reset"
>;

export class CabinhugMemoryClient {
  private memory: Mem0Like;
  private ready = false;
  /** 最近一次后端故障。用于健康视图，也用于避免每次调用都重试一个已知挂掉的后端。 */
  private lastError?: string;

  constructor(config?: Partial<MemoryConfig>, impl?: Mem0Like) {
    this.memory = impl ?? new Memory({ ...defaultConfig(), ...config });
  }

  /**
   * 触发一次懒初始化（维度探测 + 向量库建表）。
   * 不抛错：初始化失败等同于后端不可用，走降级。
   */
  async ensureReady(): Promise<boolean> {
    if (this.ready) return true;
    try {
      await this.memory.search("__probe__", { topK: 1, filters: { user_id: "__init__" } });
      this.ready = true;
      this.lastError = undefined;
      return true;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  /** 后端是否可用 + 最近一次错误。健康页与后台记忆页读它。 */
  health(): { available: boolean; lastError?: string } {
    return { available: this.ready, lastError: this.lastError };
  }

  // ── ②情景 ────────────────────────────────────────────────

  async addEpisodic(
    userId: string,
    content: string,
    meta: EpisodicMemoryInput,
  ): Promise<MemoryReadResult> {
    return this.add(userId, content, { ...meta, category: "episodic" });
  }

  async searchEpisodic(userId: string, query: string, limit = 10): Promise<MemoryReadResult> {
    return this.search(userId, query, { category: "episodic" }, limit);
  }

  async getAllEpisodic(userId: string, limit = 50): Promise<MemoryReadResult> {
    return this.getAll(userId, { category: "episodic" }, limit);
  }

  /**
   * 落一条②情景，按事件指纹去重。
   *
   * 同一件事常在几轮对话里被反复提到。每提一次写一条会让②被同一件事占满，
   * 而衰减按条数感知重要性，反复提起的旧事会显得比新事更重要。
   *
   * 指纹由调用方给（`episodeFingerprint`：发生日 + 子类），不按文本，
   * 同一件事的措辞每次不同。
   *
   * 已存在时只更新内容（后一次的描述通常更完整），不改 `occurredAt`：
   * 事件发生时间不因再次提及而后移。
   */
  async upsertEpisodic(
    userId: string,
    fingerprint: string,
    content: string,
    meta: EpisodicMemoryInput,
  ): Promise<{ written: boolean; merged: boolean }> {
    requireUser(userId);
    const existing = await this.getAll(userId, { category: "episodic", fingerprint }, 20);
    const prior = (existing.results ?? []).find(
      (m) => (m.metadata as { fingerprint?: string } | undefined)?.fingerprint === fingerprint,
    );

    if (prior?.id) {
      if (String(prior.memory ?? "").trim() === content.trim()) {
        return { written: false, merged: true };
      }
      await this.update(prior.id, content).catch(() => undefined);
      return { written: true, merged: true };
    }

    await this.addEpisodic(userId, content, { ...meta, fingerprint });
    return { written: true, merged: false };
  }

  /**
   * 检索②，按发生时间倒序并带出时间。
   *
   * 售后语境下"这个毛病以前有过"与"这个毛病三年前有过"是不同的判断，
   * 情景记忆必须带时间。
   */
  async recallEpisodes(
    userId: string,
    query: string,
    limit = 5,
  ): Promise<{
    degraded: boolean;
    episodes: Array<{ id?: string; content: string; occurredAt?: string; subType?: string }>;
  }> {
    const r = await this.searchEpisodic(userId, query, limit);
    const episodes = (r.results ?? []).map((m) => ({
      id: m.id,
      content: String(m.memory ?? ""),
      occurredAt: (m.metadata as { occurredAt?: string } | undefined)?.occurredAt,
      subType: (m.metadata as { subType?: string } | undefined)?.subType,
    }));
    episodes.sort((a, b) => (b.occurredAt ?? "").localeCompare(a.occurredAt ?? ""));
    return { degraded: r.degraded === true, episodes };
  }

  // ── ③偏好 ────────────────────────────────────────────────

  async addPreference(
    userId: string,
    content: string,
    meta: PreferenceMemoryInput,
  ): Promise<MemoryReadResult> {
    return this.add(userId, content, { ...meta, category: "preference" });
  }

  async searchPreference(userId: string, query: string, limit = 10): Promise<MemoryReadResult> {
    return this.search(userId, query, { category: "preference" }, limit);
  }

  /**
   * 按 (userId, domain) 落一条偏好：同领域更新，不追加。
   *
   * 追加会让同一领域下堆积近义句（"晚上充电" / "夜里充电" / "习惯夜充"），
   * 检索时全部召回，下游无从判断哪条现在有效；③不硬删，堆积不会自行消退。
   *
   * 新旧矛盾时以新的为准（"我改成白天充电了"），并在 metadata 里留
   * `supersededContent`，使被覆盖的内容可追溯。
   *
   * 返回是否发生了写入——`false` 表示同内容已存在，不必重复写。
   */
  async upsertPreference(
    userId: string,
    domain: string,
    content: string,
    meta: Omit<PreferenceMemoryInput, "domain">,
  ): Promise<{ written: boolean; superseded?: string }> {
    // `Omit` 对带索引签名的类型会抹掉具名字段（见本文件顶部那条注释），
    // 所以这里显式补回 confidence / lastConfirmedAt，而不是指望 Omit 保住它们。
    const base: PreferenceMemoryInput = {
      domain,
      confidence: (meta as { confidence?: number }).confidence ?? 0.5,
      lastConfirmedAt:
        (meta as { lastConfirmedAt?: string }).lastConfirmedAt ?? new Date().toISOString(),
      ...meta,
    };
    requireUser(userId);
    const existing = await this.getAll(userId, { category: "preference", domain }, 20);
    const prior = (existing.results ?? []).find(
      (m) => (m.metadata as { domain?: string } | undefined)?.domain === domain,
    );

    if (prior && String(prior.memory ?? "").trim() === content.trim()) {
      // 内容没变：只更新"最后确认时间"的语义由访问强化承担，这里不重复写。
      return { written: false };
    }

    if (prior?.id) {
      const superseded = String(prior.memory ?? "");
      // 先删后写而不是 update：`update` 只改文本，metadata（confidence /
      // lastConfirmedAt / evidence）会停留在旧值。
      await this.delete(prior.id).catch(() => undefined);
      await this.addPreference(userId, content, { ...base, supersededContent: superseded });
      return { written: true, superseded };
    }

    await this.addPreference(userId, content, base);
    return { written: true };
  }

  /** 某用户某领域的偏好（供后台展示与用户修正，F-21-11）。 */
  async listPreferences(userId: string, limit = 50): Promise<MemoryReadResult> {
    return this.getAll(userId, { category: "preference" }, limit);
  }

  // ── ⑥用车画像摘要 ────────────────────────────────────────

  async addUsagePattern(
    userId: string,
    content: string,
    meta: UsagePatternInput,
  ): Promise<MemoryReadResult> {
    return this.add(userId, content, { ...meta, category: "usage_pattern" });
  }

  async searchUsagePattern(userId: string, query: string, limit = 10): Promise<MemoryReadResult> {
    return this.search(userId, query, { category: "usage_pattern" }, limit);
  }

  // ── 通用 ─────────────────────────────────────────────────

  async add(
    userId: string,
    content: string,
    metadata: CabinhugMemoryMeta,
  ): Promise<MemoryReadResult> {
    requireUser(userId);
    if (!(MEM0_CATEGORIES as readonly string[]).includes(metadata.category)) {
      // 不降级：这是调用方的错，不是后端故障。静默吞掉会让④档案
      // 进入向量库，违反 §7。
      throw new Error(
        `Mem0 只承载 ${MEM0_CATEGORIES.join("/")}，不承载 ${metadata.category}——` +
          `④车辆档案走 PostgreSQL、⑤环境缓存走 Redis、①短期任务态在图状态（见 taxonomy.ts）`,
      );
    }

    const opts: AddMemoryOptions = {
      userId,
      metadata: metadata as Record<string, unknown>,
      // 关闭 LLM 自动抽取：metadata 由 Cabinhug 自己管（类别、时间、置信度都是
      // 衰减层的输入，不能交给模型猜）。
      infer: false,
    };

    return this.guard(() => this.memory.add([{ role: "user", content }], opts));
  }

  async search(
    userId: string,
    query: string,
    filters?: Record<string, unknown>,
    limit = 10,
  ): Promise<MemoryReadResult> {
    requireUser(userId);
    // mem0ai ≥3 的两处命名不一致，写错不报错：
    //   `Entity`（add / deleteAll）用 camelCase `userId`
    //   `SearchFilters`（search / getAll）用 snake_case `user_id`
    // 写成 `filters: { userId }` 时它被当成普通 metadata 字段匹配，检索结果恒为空。
    return this.guard(() =>
      this.memory.search(query, { topK: limit, filters: { ...filters, user_id: userId } }),
    );
  }

  /**
   * 列举。
   *
   * 类别过滤两边都做：`filters` 传给 Mem0（3.x 的 `GetAllMemoryOptions` 支持），
   * 拿回来再按 `metadata.category` 筛一遍，防止后端静默忽略 filters
   * （2.x 的 `getAll` 即如此）时返回全部类别。
   *
   * 代价是 limit 语义：先取再筛，结果可能少于 limit。按 `limit * 4` 上取一批
   * 再截断，是多取与不无界扫库之间的折中。
   */
  async getAll(
    userId: string,
    filters?: Record<string, unknown>,
    limit = 50,
  ): Promise<MemoryReadResult> {
    requireUser(userId);
    const category = filters?.category;
    const fetchLimit = category ? limit * 4 : limit;
    const res = await this.guard(() =>
      this.memory.getAll({ topK: fetchLimit, filters: { ...filters, user_id: userId } }),
    );
    if (!category) return res;
    return {
      ...res,
      results: res.results.filter((m) => m.metadata?.category === category).slice(0, limit),
    };
  }

  async get(memoryId: string): Promise<MemoryItem | null> {
    if (!(await this.ensureReady())) return null;
    try {
      return await this.memory.get(memoryId);
    } catch (err) {
      this.noteError(err);
      return null;
    }
  }

  async update(memoryId: string, content: string): Promise<{ message: string }> {
    return this.memory.update(memoryId, content);
  }

  /**
   * 只合并 metadata、不动正文（mem0ai ≥3.1 的 `update({ metadata })`，合并语义）。
   *
   * 软删标记走这里：`scan` 按 metadata 判，读不回写进正文前缀的标记，
   * 且前缀会随重复软删叠加污染原文。
   * 置 `null` 即清除该键（合并进去的 null 会覆盖旧值），用于回滚。
   * mem0 对未变文本仍会重算一次 embedding，与改文本同代价。
   */
  async updateMetadata(
    memoryId: string,
    metadata: Record<string, unknown>,
  ): Promise<{ message: string }> {
    return this.memory.update(memoryId, { metadata });
  }

  async delete(memoryId: string): Promise<{ message: string }> {
    return this.memory.delete(memoryId);
  }

  async deleteAll(userId: string): Promise<{ message: string }> {
    requireUser(userId);
    return this.memory.deleteAll({ userId });
  }

  /** 重置向量库。破坏性操作，仅开发与演练脚本使用。 */
  async reset(): Promise<void> {
    await this.memory.reset();
    this.ready = false;
  }

  /** 底层实例（迁移脚本等需要直接操作时用）。 */
  getRawMemory(): Mem0Like {
    return this.memory;
  }

  // ── 内部 ─────────────────────────────────────────────────

  /**
   * 降级包装：后端故障 → 空结果 + `degraded` 标记，不抛到业务层。
   * 调用方的错（缺 userId、类别不对）在进入这里之前就已经抛掉了。
   */
  private async guard(fn: () => Promise<SearchResult>): Promise<MemoryReadResult> {
    if (!(await this.ensureReady())) {
      return { results: [], degraded: true, error: this.lastError };
    }
    try {
      return await fn();
    } catch (err) {
      this.noteError(err);
      return { results: [], degraded: true, error: this.lastError };
    }
  }

  private noteError(err: unknown): void {
    this.lastError = err instanceof Error ? err.message : String(err);
    // 一次失败即认为后端不可用，下次调用重新探活——避免对着挂掉的后端
    // 反复走完整超时。
    this.ready = false;
  }
}

/**
 * 无用户上下文的调用必须失败，不能退化成读全量。
 * 这是本模块唯一会抛到业务层的错误类别。
 */
function requireUser(userId: string): void {
  if (!userId || !userId.trim()) {
    throw new Error("记忆读写必须带用户维度：userId 为空。跨用户泄露是严重事故，此处不降级。");
  }
}

// ── 单例 ────────────────────────────────────────────────────

let defaultClient: CabinhugMemoryClient | null = null;

export function getMemoryClient(config?: Partial<MemoryConfig>): CabinhugMemoryClient {
  if (!defaultClient) defaultClient = new CabinhugMemoryClient(config);
  return defaultClient;
}

export function resetMemoryClient(): void {
  defaultClient = null;
}
