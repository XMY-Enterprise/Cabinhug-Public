/**
 * 分层自检的具体检查项（F-43-*）。
 *
 * 与 `selfcheck.ts` 分开：那边是执行器与报告器（纯函数、可单测），
 * 这边是真连数据库、真发 HTTP 的部分。执行器的单测用假 check，
 * 检查项本身的覆盖以本文件为准。
 *
 * # 必需项与非必需项
 *
 * 分层规则是"前一层不过就不跑后一层"，避免派生失败掩盖真正的原因。
 * 非必需依赖（如对象存储未接线）不应让端到端链路整段跳过，
 * 因此用 `required: false` 标记：失败照样显示，但不阻断后续层。
 * 判据是"这次演示要不要用它"，不是"它重不重要"。
 */

import { getPrisma, createTripRepository, createVehicleRepository } from "@cabinhug/db";
import { resolveEmbedderConfig } from "@cabinhug/memory";
// 走相对路径而不是 `@cabinhug/rag`：根 package.json 没有这个依赖，
// pnpm 严格 node_modules 下按包名解析会 ERR_MODULE_NOT_FOUND（同 kb 脚本的写法）。
import { datasetIdsFromEnv } from "../../../enterprise/backend/shared/rag/src/index";
import { dataFreshnessTool, setUsageStore, setVehicleStore } from "@cabinhug/tools";

import type { CheckDef } from "./selfcheck";
import { SELFCHECK_PREFIX, isSelfcheckArtifact } from "./selfcheck";
import { DEMO_TRIP_PREFIX, DEMO_VIN_PREFIX, DEMO_USER } from "../demo/demo-seed";

// 缺省端口与 `.env.example` / `dev.sh` / 文档一致：网关 8790、runtime 8791。
// 缺省值与实配不一致时，没有 .env 的环境会探到空端口，把自检失败误报成产品问题。
const gatewayUrl = () => process.env.CABINHUG_GATEWAY_URL ?? `http://localhost:${process.env.GATEWAY_PORT ?? 8790}`;
const runtimeUrl = () => process.env.AGENT_RUNTIME_URL ?? "http://localhost:8791";
const demoToken = () => process.env.CABINHUG_DEMO_TOKEN ?? "demo-token";

async function getJson(url: string, init?: RequestInit, timeoutMs = 10_000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * 清理自检留下的会话（F-43-10 的"可清理"那一半）。
 *
 * 只删 `selfcheck-` 前缀，判据是命名本身；消息经 Cascade 跟着删除。
 *
 * 放在这个文件而不是 `selfcheck.ts`：那边对 `@cabinhug/db` 只能动态 import，
 * 而 tsx 在非 workspace 成员目录下解析不了动态的工作区包说明符；这里是静态导入。
 */
export async function cleanSelfcheckArtifacts(): Promise<number> {
  const { count } = await getPrisma().session.deleteMany({
    where: { id: { startsWith: SELFCHECK_PREFIX } },
  });
  return count;
}

/** L3 端到端产生的会话 id，带前缀便于识别与清理（F-43-10）。 */
let e2eSessionId: string | undefined;

export const CHECKS: readonly CheckDef[] = [
  // ── L0 进程起得来 ──────────────────────────────────────────
  {
    layer: "L0",
    name: "网关进程",
    remedy: `起网关：corepack pnpm --filter @cabinhug/gateway dev（监听 ${gatewayUrl()}）`,
    async run() {
      await getJson(`${gatewayUrl()}/healthz`);
      return { ok: true, detail: gatewayUrl() };
    },
  },
  {
    layer: "L0",
    name: "编排运行时进程",
    remedy: `起运行时：corepack pnpm --filter @cabinhug/agent-runtime dev（${runtimeUrl()}）。
      若网关能连而这里连不上，先核对 .env 的 AGENT_RUNTIME_URL 与实际监听端口是否一致`,
    async run() {
      const h = (await getJson(`${runtimeUrl()}/internal/health/runtime`)) as {
        health?: { agentRuntime?: string; acp?: { connected?: boolean; restarts?: number } };
      };
      const acp = h.health?.acp;
      if (!acp?.connected) return { ok: false, detail: "进程在，但 ACP 未连接——pi 子进程没起来或扩展未加载" };
      return { ok: true, detail: `${h.health?.agentRuntime}，ACP 已连接（重启 ${acp.restarts ?? 0} 次）` };
    },
  },
  {
    layer: "L0",
    name: "网关与运行时指向一致",
    remedy: `网关读的 AGENT_RUNTIME_URL 与运行时实际监听端口不一致。
      这条单独查，是因为它的症状极具误导性：大屏会显示"ACP 已连接"（那是另一处代码读的值），
      而每一轮对话都 ECONNREFUSED，端上只看到状态回到 idle`,
    async run() {
      // 网关自己报它连的是谁，与本脚本直连成功的 URL 比对。
      const d = (await getJson(`${gatewayUrl()}/healthz`)) as { ok?: boolean };
      if (!d?.ok) return { ok: false, detail: "网关 /healthz 返回异常" };
      // 真正的判据是 L3 那条端到端：这里只做"两个 URL 都可达"的前置确认。
      await getJson(`${runtimeUrl()}/internal/health/runtime`);
      return { ok: true, detail: `网关 ${gatewayUrl()} → 运行时 ${runtimeUrl()}` };
    },
  },

  // ── L1 存储可达 ────────────────────────────────────────────
  {
    layer: "L1",
    name: "PostgreSQL",
    remedy: "起容器：docker compose -f infra/docker-compose.yml up -d；再核对 .env 的 DATABASE_URL",
    async run() {
      const rows = (await getPrisma().$queryRawUnsafe("select 1 as ok")) as unknown[];
      return { ok: rows.length === 1, detail: process.env.DATABASE_URL?.replace(/:[^:@]*@/, ":***@") };
    },
  },
  {
    layer: "L1",
    name: "pgvector 扩展",
    remedy: "bash infra/scripts/pgvector-setup.sh（已有数据卷不会重跑 docker-entrypoint-initdb.d）",
    async run() {
      const rows = (await getPrisma().$queryRawUnsafe(
        "select extname from pg_extension where extname = 'vector'",
      )) as unknown[];
      if (rows.length === 0) return { ok: false, detail: "未安装——②③⑥记忆无处可落（§13-11 方案 A）" };
      return { ok: true, detail: "记忆与业务表同库，备份归入同一条 pg_dump" };
    },
  },
  {
    layer: "L1",
    name: "检查点表",
    remedy: "运行时首次启动会自建；若缺失说明运行时从未成功连上 PG（检查 DATABASE_URL）",
    async run() {
      const rows = (await getPrisma().$queryRawUnsafe(
        "select tablename from pg_tables where tablename = 'checkpoints'",
      )) as unknown[];
      return rows.length > 0
        ? { ok: true, detail: "①Working 跨重启不丢" }
        : { ok: false, detail: "checkpoints 表不存在——重启会丢上下文" };
    },
  },
  {
    layer: "L1",
    // 不叫"worker 进程"：这里查的是 `job_runs` 的心跳，不是进程表。
    // 名称反映实际检查对象，避免通过时被误读为进程已确认。
    name: "定时任务在跑",
    // 停摆不阻断后续层：端到端对话不依赖 cron。但失败必须显示。
    required: false,
    remedy: `起 worker：corepack pnpm --filter @cabinhug/worker dev
      （四个任务 memory-decay / usage-aggregation / kb-sync / vehicle-reminder 都在这一个进程里）。
      手动补一次：cd enterprise/backend/worker && node --import tsx src/index.ts --once usage-aggregation`,
    async run() {
      // worker 没起时，流水照常入库、单测照常通过，但聚合与衰减停摆，
      // 只查网关和运行时两个进程发现不了。
      //
      // 用 PG 自己的 now() 比时间，不在 JS 侧算：库存 UTC 而本机是 CST，
      // 两边分别计算会差 8 小时。
      const rows = (await getPrisma().$queryRawUnsafe(
        `select job, extract(epoch from (now() - created_at)) / 3600 as hours_ago
           from job_runs order by created_at desc limit 1`,
      )) as Array<{ job: string; hours_ago: number }>;

      if (rows.length === 0) {
        return { ok: false, detail: "job_runs 一条记录都没有——定时任务从未跑过" };
      }
      const { job, hours_ago: hoursAgo } = rows[0]!;
      // 间隔最密的两个任务是每小时一次（usage-aggregation :05 / kb-sync :20），
      // 所以 worker 活着时 2 小时内必有记录。刚起的进程在下一个整点前这里报失败，
      // 符合事实：那时定时任务确实还没跑过。
      if (hoursAgo > 2) {
        return {
          ok: false,
          detail: `最近一次任务是 ${hoursAgo.toFixed(1)} 小时前（${job}）——worker 多半没在跑；` +
            `⑥的用车画像、②③的衰减都会停在原地而不报错`,
        };
      }
      return { ok: true, detail: `最近一次 ${job}，${(hoursAgo * 60).toFixed(0)} 分钟前` };
    },
  },

  // ── L2 外部依赖 ────────────────────────────────────────────
  {
    layer: "L2",
    name: "LLM（真实调用）",
    remedy: "填 .env 的 DEEPSEEK_API_KEY；或明确接受 fake（那样演示时必须说出来）",
    async run() {
      const r = (await getJson(`${runtimeUrl()}/internal/probe/llm`, { method: "POST" }, 30_000)) as {
        ok?: boolean;
        mode?: string;
        detail?: string;
      };
      if (!r.ok) return { ok: false, detail: r.detail ?? "探活失败" };
      // fake 不算通过：这条检查用于区分 fake 与真实调用。
      if (r.mode && r.mode !== "real") return { ok: false, detail: `当前是 ${r.mode}，不是真实调用` };
      return { ok: true, detail: r.detail ?? "real" };
    },
  },
  {
    layer: "L2",
    // 名字不写死数量：检查覆盖全部数据集，新增数据集漏配时同样报失败。
    name: "RAGFlow 数据集 id",
    remedy: "corepack pnpm probe:ragflow 看具体哪一集出问题；解析未完成时检索不到那些文档",
    async run() {
      const ids = datasetIdsFromEnv();
      const missing = Object.entries(ids).filter(([, v]) => !v.trim()).map(([k]) => k);
      if (missing.length) return { ok: false, detail: `未配置数据集 id：${missing.join("、")}` };
      if (!process.env.RAGFLOW_API_KEY?.trim()) return { ok: false, detail: "RAGFLOW_API_KEY 未配置" };
      return { ok: true, detail: `${Object.keys(ids).length} 个数据集 id 与 key 就位（解析状态见 probe:ragflow）` };
    },
  },
  {
    layer: "L2",
    name: "模拟经销商系统（门店/时段/价格）",
    remedy: "corepack pnpm dev:mock-dealer 起它；或确认 .env 的 MOCK_DEALER_URL 指对端口（默认 8792）",
    /*
     * 注入口存在不等于已接上：未被装配层替换的注入口在调用时抛 unconfigured。
     *
     * 因此这里不查"配没配 URL"，而是真调一次并核对已在用的价格：
     * 235500 对不上说明种子被改过，而它同时是 cost_calc 的车价源。
     */
    async run() {
      const base = (process.env.MOCK_DEALER_URL ?? "").trim();
      if (!base) return { ok: false, detail: "MOCK_DEALER_URL 未配置——门店与时段查询会一直报未接入" };
      const r = (await getJson(`${base}/pricing?model=Model%203&trim=%E5%90%8E%E8%BD%AE%E9%A9%B1%E5%8A%A8%E7%89%88`)) as {
        trims?: Array<{ trim: string; priceCny?: number }>;
      };
      const price = r.trims?.[0]?.priceCny;
      if (price !== 235_500) {
        return { ok: false, detail: `Model 3 后驱报价 ${price ?? "缺失"}，与已在用的 235500 不一致——两个价格源打架` };
      }
      return { ok: true, detail: "四个端点可达，价格与 car-catalog 一致（Model 3 后驱 235500）" };
    },
  },
  {
    layer: "L2",
    name: "模拟车机舒适域（空调/座椅/氛围灯/媒体）",
    remedy: "corepack pnpm dev:start mock-cabin 起它；或确认 .env 的 MOCK_CABIN_URL 指对端口（默认 8793）",
    // 阻断级：座舱工具依赖它（cabin backend 装配 + ④绑定回写），
    // 它不在时，"空调调到 23 度"整条链路只剩降级话术。
    async run() {
      const base = (process.env.MOCK_CABIN_URL ?? "").trim();
      if (!base) return { ok: false, detail: "MOCK_CABIN_URL 未配置——座舱设置全部走「车机未接入」降级" };
      const r = (await getJson(`${base}/health`)) as { ok?: boolean; synthesizesAnyModel?: boolean };
      if (r.ok !== true) return { ok: false, detail: "health 不健康" };
      if (r.synthesizesAnyModel !== true) {
        return { ok: false, detail: "synthesizesAnyModel 缺失——'只认种子车型'和'任意车型可用'是两种系统" };
      }
      // 曲库为空不影响空调座椅，但"放首歌"会没有可放的。
      // "接上了"与"接上了但没歌"从外部无法区分，因此不阻断，但在 detail 里说明。
      const lib = (await getJson(`${base}/media/library`).catch(() => ({}))) as {
        tracks?: Array<unknown>;
        dir?: string;
      };
      const tracks = lib.tracks?.length ?? 0;
      if (tracks === 0) {
        return {
          ok: true,
          detail:
            `health 可达、任意车型能力合成在位；**但曲库是空的**（${lib.dir ?? "资源目录未知"}）——` +
            "「放首歌」会没有可放的。往 mocks/cabin/media/ 放一首 mp3，或 POST /media/library 重扫",
        };
      }
      return { ok: true, detail: `health 可达，任意车型能力合成在位，曲库 ${tracks} 首` };
    },
  },
  {
    layer: "L2",
    name: "Mem0 embedder",
    remedy:
      "缺省档（openai / DashScope）：在 .env 填 DASHSCOPE_API_KEY 或 MEM0_EMBEDDING_API_KEY；" +
      "Ollama 档：起 Ollama 并 ollama pull nomic-embed-text。缺它 ②③⑥ 记忆写不进去，" +
      "而双路的第二路会退化成'没有你的用车数据'",
    async run() {
      // 与 runtime 共用同一份缺省，不在这里另写 URL / 模型名，避免两处漂移。
      const { provider, config } = resolveEmbedderConfig();
      const base = config.baseURL ?? "";
      const want = String(config.model ?? "");
      if (provider === "ollama") {
        const r = (await getJson(`${base}/api/tags`)) as { models?: Array<{ name?: string }> };
        const names = (r.models ?? []).map((m) => m.name ?? "");
        const hit = names.some((n) => n.startsWith(want));
        return hit ? { ok: true, detail: `${base} 有 ${want}` } : { ok: false, detail: `${base} 没有 ${want}（现有：${names.join("、") || "无"}）` };
      }
      if (!config.apiKey) {
        return { ok: false, detail: `${provider} 档缺 key：MEM0_EMBEDDING_API_KEY / DASHSCOPE_API_KEY 都没有` };
      }
      // 真调一次（一段极短文本）：接不上、key 无效、模型不存在、维度不受支持四种都在这一跳暴露。
      const r = (await getJson(`${base}/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: want, input: ["自检"], dimensions: config.embeddingDims, encoding_format: "float" }),
      })) as { data?: Array<{ embedding?: number[] }> };
      const got = r.data?.[0]?.embedding?.length ?? 0;
      return got === config.embeddingDims
        ? { ok: true, detail: `${base} · ${want} · ${got} 维` }
        : { ok: false, detail: `${base} · ${want} 返回 ${got} 维，MEM0_EMBEDDING_DIMS=${config.embeddingDims}` };
    },
  },
  {
    layer: "L2",
    name: "内容审核层",
    required: false,
    remedy:
      "代码是完整的（`moderation/content-guard.ts` 两套协议按模型名自动切换），缺的只是配置：" +
      "在 .env 填 GUARD_BASE_URL（本机 Ollama 用 http://localhost:11434/v1）与 GUARD_MODEL，" +
      "前置 `ollama pull qwen3guard-gen:0.6b-q4km`。未接入时四道防线只有三道半",
    async run() {
      const h = (await getJson(`${runtimeUrl()}/internal/health/runtime`)) as {
        health?: { guardrails?: { prefilter?: boolean; moderation?: boolean; pii?: boolean } };
      };
      const g = h.health?.guardrails;
      if (g?.moderation) return { ok: true, detail: "规则筛 + 审核 + 脱敏三层齐" };
      return {
        ok: false,
        detail: `审核层未接入（规则筛 ${g?.prefilter ? "在" : "缺"}、脱敏 ${g?.pii ? "在" : "缺"}）——演示时要主动说出来`,
      };
    },
  },
  {
    layer: "L2",
    name: "对象存储",
    required: false,
    remedy:
      "上传实现是完整的（enterprise/backend/gateway/src/upload/），缺的只是配置：在 .env 填 " +
      "S3_ENDPOINT=http://localhost:59000 / S3_ACCESS_KEY_ID=carlife / S3_SECRET_ACCESS_KEY=carlife-secret / " +
      "S3_BUCKET=carlife-attachments（凭据与 infra/docker-compose.yml 的 MinIO 一致）",
    async run() {
      const ok = Boolean(process.env.S3_ENDPOINT?.trim() && process.env.S3_ACCESS_KEY_ID?.trim());
      return ok
        ? { ok: true, detail: process.env.S3_ENDPOINT }
        : { ok: false, detail: "未接线——多模态上传不可用（US-09）" };
    },
  },

  // ── L3 端到端链路 ──────────────────────────────────────────
  {
    layer: "L3",
    name: "对话往返（真实链路）",
    remedy:
      "前面几层都过而这条挂，最常见的是网关读到的运行时地址不对（见 L0 那条的说明），" +
      "其次是 pi 子进程没起来",
    async run() {
      const h = { authorization: `Bearer ${demoToken()}`, "content-type": "application/json" };
      // 打上自检标记（F-43-10）：网关据此给会话加 `selfcheck-` 前缀，
      // 演示前清场时据此识别；不加这个头就与真实会话无法区分。
      const s = (await getJson(`${gatewayUrl()}/v1/session`, {
        method: "POST",
        headers: { ...h, "x-cabinhug-selfcheck": "1" },
        body: "{}",
      })) as { sessionId?: string };
      if (!s.sessionId) return { ok: false, detail: "建会话失败" };
      e2eSessionId = s.sessionId;

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120_000);
      const stream = await fetch(`${gatewayUrl()}/v1/session/${s.sessionId}/stream`, {
        headers: { authorization: `Bearer ${demoToken()}` },
        signal: ctrl.signal,
      });
      const reader = stream.body?.getReader();
      if (!reader) return { ok: false, detail: "SSE 通道没建起来" };

      await fetch(`${gatewayUrl()}/v1/session/${s.sessionId}/messages`, {
        method: "POST",
        headers: h,
        // 刻意问一句一定命中 ownership 的话：这条同时验证路由与双路。
        body: JSON.stringify({ content: "说明书里写的胎压标准是多少？" }),
      });

      const dec = new TextDecoder();
      let buf = "";
      let sawDelta = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          if (/"kind":"delta"/.test(buf)) sawDelta = true;
          if (/"kind":"turn_end"/.test(buf)) {
            clearTimeout(timer);
            ctrl.abort();
            return sawDelta
              ? { ok: true, detail: `${s.sessionId} 收到流式 token 并正常收尾` }
              : { ok: false, detail: "收到 turn_end 但没有任何 token——回答是空的" };
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") throw err;
      } finally {
        clearTimeout(timer);
      }
      return { ok: false, detail: "120s 内没等到 turn_end" };
    },
  },
  {
    layer: "L3",
    name: "轨迹落库",
    remedy: "轨迹在 agent-runtime 采集、写 trace_events。没有记录说明 onTrace 出口没接上",
    async run() {
      if (!e2eSessionId) return { ok: false, detail: "上一条没跑出会话 id" };
      const rows = (await getPrisma().$queryRawUnsafe(
        `select kind from trace_events where session_id = $1`,
        e2eSessionId,
      )) as Array<{ kind: string }>;
      const kinds = rows.map((r) => r.kind);
      if (!kinds.includes("route")) return { ok: false, detail: `只落了 ${kinds.join("/") || "无"}——回放页会是空的` };
      return { ok: true, detail: `${rows.length} 条事件：${[...new Set(kinds)].join("/")}` };
    },
  },
  {
    layer: "L3",
    name: "双路检索合上了",
    remedy:
      "轨迹里没有 merge 事件 = 请求没走到双路节点（查 route.ts 的 branchFor）；" +
      "有 merge 但 personalized=false = ⑥用车数据缺，先跑 corepack pnpm demo:seed",
    async run() {
      if (!e2eSessionId) return { ok: false, detail: "上一条没跑出会话 id" };
      const rows = (await getPrisma().$queryRawUnsafe(
        `select data from trace_events where session_id = $1 and kind = 'merge'`,
        e2eSessionId,
      )) as Array<{ data: { ragOk?: boolean; usageOk?: boolean; personalized?: boolean; vehicleModel?: string | null } }>;
      if (rows.length === 0) return { ok: false, detail: "没有 merge 事件——这次请求没走到双路节点" };
      const m = rows[0].data;
      if (!m.personalized)
        return { ok: false, detail: `两路未同时可用（rag=${m.ragOk} usage=${m.usageOk}）——回答会退化成通用说明` };
      return { ok: true, detail: `personalized，车型限定 ${m.vehicleModel ?? "未限定"}` };
    },
  },

  // ── L4 演示数据就位 ────────────────────────────────────────
  {
    layer: "L4",
    name: "④车辆档案（预置）",
    remedy: "corepack pnpm demo:seed",
    async run() {
      const n = await getPrisma().vehicle.count({ where: { vin: { startsWith: DEMO_VIN_PREFIX } } });
      return n > 0 ? { ok: true, detail: `${n} 辆（VIN 前缀 ${DEMO_VIN_PREFIX}）` } : { ok: false, detail: "0 辆" };
    },
  },
  {
    layer: "L4",
    name: "⑥用车流水（预置）",
    remedy: "corepack pnpm demo:seed",
    async run() {
      const n = await getPrisma().trip.count({ where: { id: { startsWith: DEMO_TRIP_PREFIX } } });
      // 少于 MIN_SAMPLE 时画像会被判不可用，因此门槛不是 >0。
      return n >= 5 ? { ok: true, detail: `${n} 条` } : { ok: false, detail: `${n} 条，不足以支撑画像判定` };
    },
  },
  {
    /*
     * `data_freshness` 对真实演示数据跑一次（F-53-03）。
     *
     * 它证明的是"工具 + ④⑥ 两个 store + 真库"这条路通，
     * 不证明 agent-runtime 的装配层注入了 store：selfcheck 是独立进程，
     * 这里的 store 由本检查自己注入。运行时一侧的注入靠真请求的轨迹验证
     * （同上面「双路检索合上了」的形态）。
     *
     * 判据不是"三项都新鲜"：演示数据可能有陈旧项。要求的是
     * 逐项给出结论，并区分"未接入"与"查得到但数据旧"。
     */
    layer: "L4",
    name: "数据新鲜度体检（对真实数据跑一次）",
    remedy:
      "先 corepack pnpm demo:seed；仍失败看报错原文——" +
      "unconfigured 是 store 没注入，其余多半是 PG 连不上",
    async run() {
      const car = await getPrisma().vehicle.findFirst({
        where: { vin: { startsWith: DEMO_VIN_PREFIX } },
        select: { vin: true, ownerId: true },
      });
      if (!car) return { ok: false, detail: "没有演示车辆，先跑 demo:seed" };
      const prisma = getPrisma();
      setVehicleStore(createVehicleRepository(prisma));
      setUsageStore(createTripRepository(prisma));
      try {
        const { data } = await dataFreshnessTool.call(
          { userId: car.ownerId, vin: car.vin },
          { mode: "real" },
        );
        if (data.notFound) return { ok: false, detail: `档案查不到：${car.vin}` };
        const brief = data.items.map((i) => `${i.item}=${i.verdict}`).join(" ");
        return { ok: true, detail: `${brief}｜建议补录 ${data.suggested.length} 项` };
      } catch (err) {
        // "未接入"与"连不上库"是两类问题，remedy 不同，因此带出报错原文。
        return { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    layer: "L4",
    name: "预置数据可清理",
    remedy: "预置数据必须挂在 demo 用户与 DEMO 前缀下，否则 demo:reset 会误伤真实数据",
    async run() {
      const stray = await getPrisma().vehicle.count({
        where: { ownerId: DEMO_USER, NOT: { vin: { startsWith: DEMO_VIN_PREFIX } } },
      });
      return stray === 0
        ? { ok: true, detail: `demo:reset 只按前缀删，碰不到真实数据` }
        : { ok: false, detail: `${stray} 辆挂在 ${DEMO_USER} 名下却没有 DEMO 前缀——reset 会漏掉它们` };
    },
  },
  {
    layer: "L4",
    name: "自检会话可识别可清理",
    remedy:
      "网关应在收到 `x-cabinhug-selfcheck: 1` 时给会话加 `selfcheck-` 前缀（enterprise/backend/gateway/src/http/index.ts）。" +
      "堆积过多时跑 `corepack pnpm selfcheck:clean` 清掉",
    async run() {
      if (!e2eSessionId) return { ok: false, detail: "L3 没跑出会话 id" };
      if (!isSelfcheckArtifact(e2eSessionId)) {
        // 会话无前缀时必须报失败，不能以"0 个自检会话"判为通过。
        return { ok: false, detail: `本次自检留下 ${e2eSessionId}，与真实会话无法区分` };
      }
      const total = await getPrisma().session.count({ where: { id: { startsWith: SELFCHECK_PREFIX } } });
      return { ok: true, detail: `${e2eSessionId}；库里共 ${total} 个自检会话，可一键清理` };
    },
  },
];
