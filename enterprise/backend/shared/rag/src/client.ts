/**
 * RAGFlow Cloud 客户端（§6）。
 *
 * # 我们只调检索接口
 *
 * 解析→切分→向量化→检索全部由 RAGFlow 承担（§6 首段），本仓不自建向量库。
 * 切分质量因此不完全由我们控制，"看得见切分"的能力（F-24-05）是这个选型的必要对冲。
 *
 * # 出处是检索结果的一部分，不是可选字段
 *
 * §6 要求返回带引用来源的 chunk。出处由 RAGFlow 返回，不由 LLM 生成，
 * 避免模型编造出处（F-16-09）。
 */

import { catalogModels } from "@cabinhug/shared";

import { datasetFor, datasetsForAgent, type DatasetDef, type DatasetKey } from "./datasets";

export interface RetrievedChunk {
  content: string;
  /**
   * 出处：文档名 + 位置 + 来自哪个集。没有出处的 chunk 不使用。
   *
   * `dataset` 按 chunk 记录（ACR-042）：一次检索可以跨多个集（`service` 缺省同查
   * 维修手册与车险条款），调用级只记一个集名会把出处标错。
   */
  source: { document: string; location?: string; dataset: DatasetKey };
  score: number;
  /**
   * 数据来源标注（F-24-11），跟着 chunk 走，不跟着调用走。
   *
   * 同一次跨集检索里可以同时有 `public`（厂商手册、示范条款）与 `simulated`
   * （自写的流程整理稿），整段只打一个标签必然标错其中一类。
   */
  provenance: DatasetDef["provenance"];
}

/**
 * RAGFlow 检索的"高级设置"。省略即用下面的常量默认值。
 *
 * 单独抽出是为了让评测脚本扫参（`pnpm rag:eval`），调参以可复现的量化结果为依据。
 */
export interface RetrievalTuning {
  /** 低于此相似度的块直接丢弃。调高更准更少，调低更全更吵。 */
  similarityThreshold?: number;
  /** 向量相似度的权重，其余给关键词。1.0 = 纯向量，0 = 纯关键词。 */
  vectorSimilarityWeight?: number;
  /** 候选池大小（不是返回条数）。向量召回先取这么多再排序截断。 */
  candidatePoolSize?: number;
  /** 重排模型 id。留空表示不重排。 */
  rerankId?: string;
}

export interface RetrieveArgs {
  /** 单集检索。与 `datasets` 二选一——都给时以 `datasets` 为准，都不给抛错。 */
  dataset?: DatasetKey;
  /**
   * 多集检索（ACR-042）：一次调用跨集召回。
   *
   * RAGFlow 的 `/api/v1/retrieval` 接收 `dataset_ids` 数组，四个集同一个
   * embedding（bge-m3），分数直接可比，因此一次请求即可，不在本侧逐集合并。
   */
  datasets?: readonly DatasetKey[];
  query: string;
  /** 返回条数。映射到 RAGFlow 的 `page_size`，不是它的 `top_k`。 */
  topK?: number;
  tuning?: RetrievalTuning;
  /** 调用方 Agent——用于强制隔离检查。 */
  agent: string;
  /**
   * 车型限定（FL-23 F-23-07）。多车型同库时必须提供。
   *
   * 不限定时，同一数据集里的其他车型手册片段可能带着出处被返回，答案有引用但说的是
   * 另一辆车，且不报错。
   *
   * 省略即不限定：仅用于单车型库，或调用方确实要跨车型查（如购车对比）。
   */
  vehicleModel?: string;
}

export interface RagflowConfig {
  baseUrl: string;
  apiKey: string;
  /** dataset key → RAGFlow dataset id。 */
  datasetIds: Record<string, string>;
  /**
   * 超时。默认 15s。
   *
   * RAGFlow Cloud 的 `/retrieval` 要先把 query 送到 embedding 服务（SiliconFlow 的
   * bge-m3）再检索，实测空数据集就要 2.3~2.7s，首次调用更高；8s 会间歇性超时。
   * 超时时双路退化为单路，用户只看到"本次未引用说明书出处"。
   */
  timeoutMs?: number;
}

export class DatasetAccessError extends Error {}

/**
 * 车型限定后一篇文档都没匹配上。
 *
 * 单独成类，不按"零命中"处理：零命中表示知识库里没有这内容，
 * 而这里表示没有这辆车的资料可查。也不退回全库检索，否则绕开了限定本身。
 */
export class NoDocumentsForModelError extends Error {
  constructor(readonly vehicleModel: string, readonly dataset: string) {
    super(`数据集 ${dataset} 里没有 ${vehicleModel} 的资料。**不退回全库检索**——那会返回别的车型的内容。`);
    this.name = "NoDocumentsForModelError";
  }
}

/**
 * 车型名到文档名的匹配。
 *
 * 文档名写法不统一（`Model3_车主手册.pdf` / `tesla_m3_选配.md` /
 * `2017雪佛兰全新迈锐宝用户手册.pdf`），所以两边都先归一化：
 * 去掉空格下划线连字符、转小写，再做子串匹配，并补一张常见简写表。
 *
 * 宁可匹配不到也不匹配错：匹配不到会抛 NoDocumentsForModelError（明确的"没资料"），
 * 匹配错则会拿另一辆车的手册作答且无痕迹。
 */
const MODEL_ALIASES: Record<string, readonly string[]> = {
  model3: ["model3", "m3"],
  modely: ["modely", "my"],
  models: ["models", "ms"],
  modelx: ["modelx", "mx"],
  cybertruck: ["cybertruck", "ct"],
};

/** 全部去掉分隔符：`Model3_车主手册` → `model3车主手册`。长别名用它。 */
function compact(s: string): string {
  return s.toLowerCase().replace(/[\s_\-（）()]/g, "");
}

/** 分隔符归一成空格：`tesla_m3_选配` → `tesla m3 选配`。短别名的边界靠它。 */
function spaced(s: string): string {
  return s.toLowerCase().replace(/[_\-（）()]+/g, " ");
}

/**
 * 目录页：大量行以页码结尾（`引言 . 0-1` / `钥匙 1-2`）。
 *
 * 目录天然没有句末标点，跑串读检查必然全中，而目录切分对检索无影响，因此排除。
 */
export function looksLikeToc(content: string): boolean {
  const lines = content.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 4) return false;
  // 行尾是"数字-数字"或"点线 + 数字"——目录条目的两种常见收尾。
  const dotted = lines.filter((l) => /[.·…\s]\s*\d+\s*[-–]\s*\d+\s*$|\.{2,}\s*\d+\s*$/.test(l)).length;
  return dotted / lines.length > 0.5;
}

/** 长度到此为止的别名按"短"处理——短到会在无关文件名里撞上。 */
const SHORT_ALIAS_MAX = 3;

export function documentMatchesModel(documentName: string, vehicleModel: string): boolean {
  const docCompact = compact(documentName);
  const docSpaced = spaced(documentName);
  const needles = MODEL_ALIASES[compact(vehicleModel)] ?? [compact(vehicleModel)];

  return needles.some((n) => {
    // 长别名（model3 / cybertruck）：去分隔符后直接子串匹配。
    if (n.length > SHORT_ALIAS_MAX) return docCompact.includes(n);
    // 短别名（m3 / my / ct）：必须在分隔符归一后的串上做边界匹配。
    // 若去掉全部分隔符，`tesla_m3_选配` 会变成 `teslam3选配`，`m3` 前面是字母 `a`，
    // 边界检查失效。
    return new RegExp(`(^|[^a-z0-9])${n}([^a-z0-9]|$)`).test(docSpaced);
  });
}

/** 见 `RagflowConfig.timeoutMs` 的实测说明。 */
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * RAGFlow 的分页上限。超过就报 `page_size must be less than or equal to 100`。
 */
const MAX_PAGE_SIZE = 100;

/**
 * 版面识别流水线：先识别版面 → 切图 → OCR → 再切块。
 *
 * 不开时多栏 PDF 会被按行横着串读：三列的半句交替出现，
 * 每一行本身通顺、关键词也在，检索照样命中并给出处，但拼起来语义错乱。
 * 无法预先知道一份 PDF 是几栏的，所以一律开。
 *
 * 写成常量而不是内联字符串：RAGFlow 对这个字段不做取值校验，
 * 传 `"__invalid__"` 也返回 `code=0` 并静默退回默认；拼错时多栏 PDF 被串读且无任何报错。
 */
const LAYOUT_DEEPDOC = "DeepDOC";

/**
 * 按扩展名选切分方法。
 *
 * RAGFlow 的切分方法各自只接受特定格式，选错时解析失败，
 * 且失败要等几分钟才在文档状态里显示：
 *   `manual` 只吃 pdf / docx —— markdown 传进去报 "file type not supported"
 *   `table`  只吃 excel / text / csv —— PDF 传进去同样报错
 *   `naive`  通用
 *
 * 在上传时决定方法，避免解析几分钟后才暴露方法不匹配。
 * 不一律用 naive：`manual` 认章节结构，对说明书类 PDF 的切分质量明显更好。
 */
export function chunkMethodFor(filename: string): "manual" | "naive" {
  return /\.(pdf|docx)$/i.test(filename) ? "manual" : "naive";
}

/**
 * RAGFlow 出错时返回 HTTP 200，错误在 body 里：
 * `{"code":100,"data":null,"message":"ValueError(...)"}`。
 *
 * 只看 `res.ok` 时，API 层错误会变成空结果：文档列表显示为没有文档，
 * 检索显示为零命中，"检索失败"与"零命中"的区分因此失效。
 * 例如 `page_size=200` 超过上限 100 时，`listDocuments` 会报 0 篇。
 */
function assertOk(body: unknown): unknown {
  const b = body as { code?: number; message?: string } | null;
  if (b && typeof b.code === "number" && b.code !== 0) {
    throw new Error(`RAGFlow 返回错误（code=${b.code}）：${b.message ?? "无说明"}`);
  }
  return body;
}

/**
 * 这个集里、这辆车看得见哪些文档（ACR-042）。判据按集的作用域分叉：
 *
 *   per-model  只有这辆车的文档可见；一篇都没有就抛——表示没有这辆车的资料可查，
 *              不是"知识库里没这内容"，也不退回全库（F-23-07）。
 *   shared     文件名不含任何目录车型的对所有车可见（行业级示范条款）；含车型的
 *              只对那款车可见（特斯拉专属的出险注意事项）。零可见不是错误，
 *              表示这辆车在这个集里没有专属内容，行业内容照常给。
 *
 * 判"文件名含不含车型"用与检索侧同一个 `documentMatchesModel`，
 * 与 `coverage.ts` 同源，保证覆盖统计与实际检索口径一致。
 */
export function documentIdsFor(
  def: DatasetDef,
  docs: readonly DocumentStatus[],
  vehicleModel: string,
  models: readonly string[] = catalogModels(),
): string[] {
  if (def.scope === "per-model") {
    const mine = docs.filter((d) => documentMatchesModel(d.name, vehicleModel));
    if (mine.length === 0) throw new NoDocumentsForModelError(vehicleModel, def.key);
    return mine.map((d) => d.documentId);
  }
  const visible = docs.filter((d) => {
    if (documentMatchesModel(d.name, vehicleModel)) return true;
    // 不含任何目录车型 = 行业级，对所有车可见。
    return !models.some((m) => documentMatchesModel(d.name, m));
  });
  return visible.map((d) => d.documentId);
}

export interface RagClient {
  retrieve(args: RetrieveArgs): Promise<RetrievedChunk[]>;
  /**
   * 数据集里的文档与解析状态（F-24-04）。
   *
   * 状态到解析层面，不止文件传输层面：文件传上去但没解析成功时检索查不到任何内容。
   */
  listDocuments(dataset: DatasetKey, agent: string): Promise<DocumentStatus[]>;
  /** 某文档的切分预览（F-24-05）——托管式 RAG 的必要对冲：我们保留可见性。 */
  listChunks(dataset: DatasetKey, documentId: string, agent: string): Promise<ChunkPreview[]>;
  /**
   * 上传并触发解析（F-24-04）。
   *
   * 两步合成一个方法：只上传不解析的文档检索不到任何内容，
   * 合并后不存在"已上传但未解析"的状态。
   */
  uploadDocument(
    dataset: DatasetKey,
    agent: string,
    file: { name: string; bytes: Uint8Array; contentType?: string },
  ): Promise<{ documentId: string }>;
  /**
   * 删除文档。
   *
   * 用于改正放错数据集的文档：数据集按消费方隔离，放错位置时该看到它的 Agent
   * 看不到，不该看到的反而能看到。
   */
  deleteDocuments(dataset: DatasetKey, agent: string, documentIds: string[]): Promise<void>;
}

export function createRagClient(cfg: RagflowConfig): RagClient {
  /** 数据集访问检查：各管理方法共用同一条规则。 */
  function assertAccess(dataset: DatasetKey, agent: string): string {
    const allowed = datasetsForAgent(agent).some((d) => d.key === dataset);
    if (!allowed) throw new DatasetAccessError(`Agent ${agent} 无权访问数据集 ${dataset}`);
    const id = cfg.datasetIds[datasetFor(dataset).key];
    if (!id) throw new Error(`数据集 ${dataset} 未配置 id（${datasetFor(dataset).envKey}）`);
    return id;
  }

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${cfg.apiKey}`, ...(init?.headers ?? {}) },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`RAGFlow HTTP ${res.status}`);
      return assertOk(await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async listDocuments(dataset, agent) {
      const id = assertAccess(dataset, agent);
      const body = await call<{
        data?: { docs?: Array<{ id?: string; name?: string; run?: string; progress_msg?: string; chunk_num?: number }> };
      }>(`/api/v1/datasets/${id}/documents?page_size=${MAX_PAGE_SIZE}`);
      return (body.data?.docs ?? []).map((d) => ({
        documentId: d.id ?? "",
        name: d.name ?? "(未命名)",
        status: mapRunStatus(d.run),
        // 失败原因必须可读，不只给"解析失败"。
        error: mapRunStatus(d.run) === "failed" ? (d.progress_msg || "解析失败，原因未提供") : undefined,
        chunkCount: d.chunk_num,
      }));
    },

    async uploadDocument(dataset, agent, file) {
      const id = assertAccess(dataset, agent);

      const form = new FormData();
      form.append("file", new Blob([file.bytes as BlobPart], { type: file.contentType ?? "application/octet-stream" }), file.name);
      const up = await call<{ data?: Array<{ id?: string }> }>(
        `/api/v1/datasets/${id}/documents`,
        { method: "POST", body: form },
      );
      const documentId = up.data?.[0]?.id;
      if (!documentId) throw new Error("上传成功但没拿到 document id，无法触发解析");

      // 先定切分方法与版面识别，再触发解析。
      //
      // 数据集的默认方法未必适合这一篇：markdown 落进 manual 方法的数据集，解析必然失败。
      //
      // `layout_recognize` 的取值与校验缺失问题见 `LAYOUT_DEEPDOC`。
      await call(`/api/v1/datasets/${id}/documents/${documentId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chunk_method: chunkMethodFor(file.name),
          parser_config: {
            layout_recognize: LAYOUT_DEEPDOC,
            chunk_token_num: CHUNK_TOKEN_NUM,
            delimiter: CHUNK_DELIMITER,
          },
        }),
      });

      // 立刻触发解析，不等它跑完：解析可能要几分钟。进度由 listDocuments 轮询。
      await call(`/api/v1/datasets/${id}/chunks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document_ids: [documentId] }),
      });

      return { documentId };
    },

    async deleteDocuments(dataset, agent, documentIds) {
      const id = assertAccess(dataset, agent);
      await call(`/api/v1/datasets/${id}/documents`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: documentIds }),
      });
    },

    async listChunks(dataset, documentId, agent) {
      const id = assertAccess(dataset, agent);
      const body = await call<{
        data?: { chunks?: Array<{ content?: string; content_with_weight?: string }> };
      }>(`/api/v1/datasets/${id}/documents/${encodeURIComponent(documentId)}/chunks?page_size=${MAX_PAGE_SIZE}`);
      return (body.data?.chunks ?? []).map((c, index) => {
        const content = c.content ?? c.content_with_weight ?? "";
        return { index, content, looksTabular: looksTabular(content) };
      });
    },

    async retrieve(args) {
      const keys = args.datasets ?? (args.dataset ? [args.dataset] : []);
      if (keys.length === 0) throw new Error("retrieve 必须指定 dataset 或 datasets");

      // 跨数据集访问在调用层被拒（AC-24-8），不依赖 prompt 约束。逐个集查，
      // 多集里有一个没权限就整次拒绝，不静默剔除后查剩下的。
      const allowedKeys = new Set(datasetsForAgent(args.agent).map((d) => d.key));
      for (const key of keys) {
        if (!allowedKeys.has(key)) {
          throw new DatasetAccessError(`Agent ${args.agent} 无权检索数据集 ${key}`);
        }
      }

      const defs = keys.map((k) => datasetFor(k));
      const datasetIds = defs.map((def) => {
        const id = cfg.datasetIds[def.key];
        if (!id) throw new Error(`数据集 ${def.key} 未配置 id（${def.envKey}）`);
        return id;
      });
      /** RAGFlow 回的 chunk 带 `dataset_id`，用它把每条认回自己的集。 */
      const keyById = new Map(datasetIds.map((id, i) => [id, defs[i]!]));

      // 车型限定：把检索面缩到这辆车看得见的文档上（F-23-07 + ACR-042 作用域）。
      //
      // `document_ids` 是全局过滤，不是按集过滤：只列其中一个集的 doc id 时，
      // 其余集被整个过滤掉。所以多集限定车型时，每个集都要显式列出自己可见的文档。
      let documentIds: string[] | undefined;
      if (args.vehicleModel) {
        const perDataset = await Promise.all(
          defs.map(async (def) =>
            documentIdsFor(def, await this.listDocuments(def.key, args.agent), args.vehicleModel!),
          ),
        );
        documentIds = perDataset.flat();
        // 全部集都没有可见文档：空数组会被 RAGFlow 当成"不过滤"，即退回全库。
        // 直接返回零命中，不返回别的车型的资料。
        if (documentIds.length === 0) return [];
      }

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/api/v1/retrieval`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({
            dataset_ids: datasetIds,
            ...(documentIds ? { document_ids: documentIds } : {}),
            question: args.query,
            // `page_size` 是返回条数，`top_k` 是向量召回的候选池大小（默认 1024）。
            // 把条数写进 `top_k` 会把候选池砍小，而返回条数退回 RAGFlow 默认值，
            // 喂给 LLM 的上下文随之膨胀且不报错（topK=5 时实测返回 30 条）。
            page_size: args.topK ?? DEFAULT_PAGE_SIZE,
            top_k: args.tuning?.candidatePoolSize ?? DEFAULT_CANDIDATE_POOL,
            similarity_threshold: args.tuning?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD,
            vector_similarity_weight:
              args.tuning?.vectorSimilarityWeight ?? DEFAULT_VECTOR_WEIGHT,
            ...(args.tuning?.rerankId ? { rerank_id: args.tuning.rerankId } : {}),
          }),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`RAGFlow HTTP ${res.status}`);
        const body = assertOk(await res.json()) as {
          data?: {
            chunks?: Array<{
              content?: string;
              document_keyword?: string;
              similarity?: number;
              positions?: unknown;
              dataset_id?: string;
            }>;
          };
        };
        let unmapped = 0;
        const out = (body.data?.chunks ?? [])
          .map((c): RetrievedChunk | undefined => {
            // 单集时 chunk 不带 dataset_id 也认得出来（只有一个候选）；多集时认不出就丢，
            // 不猜，避免把条款标成手册。
            const def = c.dataset_id ? keyById.get(c.dataset_id) : defs.length === 1 ? defs[0] : undefined;
            if (!def) {
              unmapped += 1;
              return undefined;
            }
            return {
              content: c.content ?? "",
              source: {
                document: c.document_keyword ?? "未知文档",
                location: formatPosition(c.positions),
                dataset: def.key,
              },
              score: c.similarity ?? 0,
              provenance: def.provenance,
            };
          })
          // 没有出处的 chunk 直接丢弃（F-16-09）。
          .filter(
            (c): c is RetrievedChunk =>
              c !== undefined && c.content.trim().length > 0 && c.source.document !== "未知文档",
          );
        if (unmapped > 0) {
          console.warn(`[rag] ${unmapped} 条 chunk 的 dataset_id 认不回数据集，已丢弃（${keys.join("/")}）`);
        }
        return out;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * RAGFlow 的 `run` 字段到我们的四态。
 *
 * 未知取值一律映射为 `parsing` 而不是 `succeeded`：无法识别的状态不报成功。
 */
function mapRunStatus(run?: string): ParseStatus {
  switch ((run ?? "").toUpperCase()) {
    case "DONE":
      return "succeeded";
    case "FAIL":
      return "failed";
    case "UNSTART":
      return "queued";
    default:
      return "parsing";
  }
}

/**
 * 表格特征。启发式，宁可多报也不漏报。
 *
 * 必须认 HTML 表格标记：RAGFlow 会把识别出的表格转成 `<table><tr><td>`，
 * 而不是保留 markdown 的 `|` 竖线。只认竖线时，markdown 表格进 RAGFlow 后
 * 不再被识别为表格，串读检测会在其上大面积误报（实测三份选配数据 20/20 块被误报）。
 */
export function looksTabular(content: string): boolean {
  const trimmed = content.trim();
  // HTML 表格标记：RAGFlow 的表格产物形态。
  if (/<(table|thead|tbody|tr|td|th)\b/i.test(trimmed)) return true;

  const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  const piped = lines.filter((l) => /[|｜]/.test(l)).length;
  const spaced = lines.filter((l) => /\S\s{3,}\S\s{3,}\S/.test(l)).length;
  return piped / lines.length > 0.5 || spaced / lines.length > 0.5;
}

function formatPosition(p: unknown): string | undefined {
  if (Array.isArray(p) && p.length > 0) return `第 ${String(p[0])} 处`;
  return undefined;
}

/**
 * 知识库管理能力（FL-24）。
 *
 * # 它是"托管式 RAG"这个选型的必要对冲
 *
 * §6 把解析与切分交给了 RAGFlow，我们保留的是可见性而非控制权。
 * 说明书里最有价值的内容（保养周期表、故障码表、操作步骤表）最容易被切坏，
 * 而切坏之后检索仍然会返回结果，只是结果不可用。
 *
 * # 状态到解析层面
 *
 * 状态必须到解析层面，不是文件传输层面（F-24-04）。
 */

export type ParseStatus = "queued" | "parsing" | "succeeded" | "failed";

export interface DocumentStatus {
  documentId: string;
  name: string;
  status: ParseStatus;
  /** 失败原因必须可读，不只给"解析失败" */
  error?: string;
  chunkCount?: number;
}

export interface ChunkPreview {
  index: number;
  content: string;
  /** 内容里是否疑似含表格结构——用于提示"这里可能被切坏了" */
  looksTabular: boolean;
}

/**
 * 多列版面被逐行串读的检测（F-24-05）。
 *
 * # 切坏形态：多列横向串读
 *
 * 三列排版的手册（如迈锐宝用户手册），RAGFlow 在未开版面识别时按行抽取，
 * 三列的文字被横着串起来：
 *
 *   引言
 *   的自录供您查找具体信息的位置。      ← 第 2 列
 *   操作车辆时应该注意的事项。忽视      ← 第 3 列
 *   本车集先进技术、安全性、环保及      ← 第 1 列
 *   该信息可能会导致错误的操作。        ← 第 3 列
 *
 * 每一行本身都是通顺的中文，关键词也都在，检索照样命中、照样给出处，
 * 但拼起来语义错乱。
 *
 * # 判据：连续多行都不以句末标点收尾
 *
 * 正常正文里，句子会在某一行结束（。！？；：）。列被串读时，每一列的半句
 * 交替出现，连续很多行都停在句子中间。用"最长的未收尾连续行数"做信号。
 *
 * 目录、参数表、列表天然也是短行，所以阈值给得保守（8 行），
 * 且只在行数足够多时才判：宁可漏报，也不在正常表格上大面积误报。
 */
export const UNTERMINATED_RUN_THRESHOLD = 8;

/**
 * 切块目标长度。
 *
 * RAGFlow 默认值是 128：实测线上 1091 块的中位数是 108，落在客服问答推荐区间
 * （256~512）的只有 12%，22% 短于 50 token（检索命中了也撑不起回答）。
 *
 * 512 取自客服/文档问答的通行区间上沿：手册类是过程性内容
 * （"先…再…最后…"），切太碎会把一个步骤序列拆成互不相干的几块，
 * 合起来答不了"这事怎么做"。
 */
export const CHUNK_TOKEN_NUM = 512;

/**
 * 切分优先落在哪些字符上。
 *
 * 在默认的句末标点之外加了 `\n`：经 `prepareMarkdownForChunking` 整理过的
 * markdown 里，段落边界就是语义边界，优先在那里断比在句号处断更整齐。
 */
export const CHUNK_DELIMITER = "\n!?;。；！？";

// ── 检索高级设置（由 `corepack pnpm rag:eval` 在 10 道画像题上扫参定出） ──
//
// 阈值和权重不独立：`vector_similarity_weight` 改变的是合成相似度的量纲，
// 同一批块在 w=0.0 时得分 0.19~0.23、w=1.0 时 0.82~0.85。
// 所以"阈值 0.3"在不同权重下含义不同，不能用固定阈值网格横比不同权重。
//
// RAGFlow 的默认组合（w=0.3）最脆：阈值升到 0.4 时关键词覆盖从 81% 掉到 43%、
// 命中率掉到 50%，而 w≥0.5 的几档不变。权重取 0.5 时，阈值 0.3 落在得分分布
// （≈0.50~0.53）之下留有余量，既能切掉尾巴，又对阈值波动不敏感。

/**
 * 返回给 LLM 的块数（RAGFlow 的 `page_size`）。
 *
 * 8 与 12 的 LLM 裁判分相同（19/20），而 8 只用 3019 tok 上下文、12 要 4475，
 * 答题质量相同时少三分之一的 token。覆盖率随条数单调上升（块越多越容易撞上关键词），
 * 所以不只按覆盖率选。
 */
export const DEFAULT_PAGE_SIZE = 8;
/** 向量召回的候选池——RAGFlow 默认 1024，够大且实测不影响延迟。 */
export const DEFAULT_CANDIDATE_POOL = 1024;
/** 相似度下限。见上面关于"阈值与权重不独立"的说明。 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.3;
/** 向量 : 关键词 的权重。手册类问题里型号、代码、单位这些字面量很重要。 */
export const DEFAULT_VECTOR_WEIGHT = 0.5;
/** 短于此的行不参与判定：标题、页码、编号本来就不该有句末标点。 */
const MIN_JUDGEABLE_LINE = 6;
const SENTENCE_END = /[。！？；：.!?]$/;

/**
 * 标题、项目符号、表格行：本来就不该有句末标点的行。
 *
 * 把它们算进"未收尾"会误判：保养手册里一串 `z 经常在低温条件下行驶` 会凑出
 * 12 行"未收尾"，规格表里一串 `## Motor Type` 会凑出 11 行，两者都正常。
 * 真串读的特征是句子被从中间切开，而列表项是完整的一项，只是短。
 *
 * `z` 是这批 PDF 里项目符号（Wingdings 的 ●）被 OCR 成的字形。
 */
const LIST_OR_HEADING =
  // 图例编号写法包括全角 `1．`、无空格的 `2.`、`3）`、`(4)`。
  // 数字标号后面必须跟非数字，否则 "2.5 米的车身长度…" 这种小数开头的
  // 正文行会被当成列表跳过。
  /^(#{1,6}\s|[-*+•·▪◆■○●z]\s|\||\d+[.．、)）]\s*(?=\D)|[A-Za-z][.．、)）]\s|[（(]\d+[）)])/;

/** 单行的键值形态：`GVWR：3,948 kg` 或 `代码 | 名称 | 价格`。 */
const KV_ROW = /^[^。！？；.!?;]{1,25}[：:]\s*\S|^[^|\n]{1,40}(\s\|\s[^|\n]+)+$/;

/**
 * 摊平后的表格块。
 *
 * `prepareMarkdownForChunking` 把小表摊成文本以便打包并带上面包屑
 * （见 chunk-prep.ts），这些行天然没有句末标点，需从串读检测里排除。
 *
 * 判断在块级而不是行级：`注意：请勿在行驶中调节座椅` 这种正文单行看就是键值形态，
 * 逐行放过会漏掉串读里最常见的一类。摊平的表格是整块都长这样，正文里冒号行只是少数。
 */
export function looksFlattenedTable(content: string): boolean {
  const lines = content.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 4) return false;
  return lines.filter((l) => KV_ROW.test(l)).length / lines.length >= 0.8;
}

export function longestUnterminatedRun(content: string): number {
  const lines = content.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  let run = 0;
  let max = 0;
  for (const l of lines) {
    // 列表项与标题跳过但不重置计数：三列串读的碎片里常混进小标题，
    // 重置会把整段串读切成两半。
    if (LIST_OR_HEADING.test(l)) continue;
    // 短行同样跳过不重置：三列串读时每一列的尾巴天然就短（"经济性于一体" 6 字），
    // 重置会漏报。
    if (l.length < MIN_JUDGEABLE_LINE) continue;
    if (SENTENCE_END.test(l)) run = 0;
    else max = Math.max(max, (run += 1));
  }
  return max;
}

/**
 * 表格的数据行数（不含表头），而不是文本的换行数。
 *
 * RAGFlow 切 PDF 时表格是多行文本，数换行等于数行；而 MinerU 输出的 `<table>`
 * 整张挤在一行里，按换行数会把完好的表判成被截断（实测 36/38 块误报）。
 */
export function tableDataRowCount(content: string): number {
  const rows = content.match(/<tr[\s\S]*?<\/tr>/gi);
  if (rows) return rows.filter((r) => !/<th[\s>]/i.test(r)).length;
  const piped = content.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|"));
  if (piped.length > 0) {
    // markdown 管道表：表头行 + `| --- |` 分隔行都不算数据。
    const sep = piped.findIndex((l) => /^\|[\s:|-]+\|?$/.test(l));
    return sep >= 0 ? piped.length - sep - 1 : piped.length;
  }
  // 既没有 `<tr>` 也没有 `|` 起头的行，就按非空行数算：
  // 摊平后的 `代码 | 名称 | 价格` 块不以 `|` 起头，返回 0 会被误判成"只剩表头"。
  return content.split("\n").filter((l) => l.trim().length > 0).length;
}

/** 有没有表头：一块表格有没有说清每一列是什么，比它有几行要紧。 */
export function hasTableHeader(content: string): boolean {
  if (/<th[\s>]/i.test(content)) return true;
  return content.split("\n").some((l) => /^\s*\|[\s:|-]+\|?\s*$/.test(l));
}

/**
 * 切分质量的启发式检查（F-24-05）。
 *
 * 不判断切得对不对（那需要人看），只把最可能出问题的块挑出来供优先查看，
 * 例如出现表格特征却只有一两行的块，多半是一张表被拦腰截断。
 */
export function suspiciousChunks(chunks: readonly ChunkPreview[]): Array<{ index: number; why: string }> {
  const out: Array<{ index: number; why: string }> = [];
  for (const c of chunks) {
    const lines = c.content.split("\n").filter((l) => l.trim().length > 0);
    if (c.looksTabular) {
      // RAGFlow 切大表时会给每一块补上表头，所以"表头 + 一行数据"是正常产物，
      // 不按行数判截断（按行数判会把 9/20 块正常分块判成截断）。不可用的只有两种：只剩表头没有数据，以及有数据却没有表头。
      const dataRows = tableDataRowCount(c.content);
      if (dataRows === 0) {
        out.push({ index: c.index, why: "疑似表格被拦腰截断（只剩表头，没有数据行）" });
      } else if (!hasTableHeader(c.content) && dataRows <= 1) {
        out.push({ index: c.index, why: "疑似表格被拦腰截断（只有一行数据且没有表头，读不出每列是什么）" });
      }
    }
    if (c.content.trim().length < 20) {
      out.push({ index: c.index, why: "内容过短，检索命中后也难以支撑回答" });
    }
    // 表格特征跨 chunk 边界：上一块结尾与下一块开头都像表格行
    if (c.looksTabular && /^[|｜]/.test(c.content.trim())) {
      out.push({ index: c.index, why: "以表格分隔符开头，可能缺少表头" });
    }
    // 多列被逐行串读：不会让检索失败，只会让检索命中一段读不通的文字。
    //
    // 表格、目录、摊平表都排除：它们天然不带句末标点，跑串读检查必然全中。
    // `looksTabular` 再算一次而不是只信调用方传的值。
    const skip =
      c.looksTabular || looksTabular(c.content) || looksLikeToc(c.content) || looksFlattenedTable(c.content);
    if (!skip && lines.length >= UNTERMINATED_RUN_THRESHOLD) {
      const run = longestUnterminatedRun(c.content);
      if (run >= UNTERMINATED_RUN_THRESHOLD) {
        out.push({
          index: c.index,
          why: `连续 ${run} 行停在句子中间——**多列版面可能被逐行串读了**。` +
            `每行本身通顺、关键词也在，所以检索照样命中，但拼起来讲的不是一件事。` +
            `到 RAGFlow 里把该文档的 layout_recognize 设为 DeepDOC 再重新解析。`,
        });
      }
    }
  }
  return out;
}

/** 检索测试的结果：判定文档"传成功了"的标准（F-24-06）。 */
export interface RetrievalTestResult {
  query: string;
  hits: Array<{ document: string; location?: string; score: number; excerpt: string }>;
  /** 零命中不是错误：表示这个问题当前知识库答不了。 */
  empty: boolean;
}

export function summarizeRetrievalTest(
  query: string,
  chunks: readonly RetrievedChunk[],
): RetrievalTestResult {
  return {
    query,
    hits: chunks.map((c) => ({
      document: c.source.document,
      location: c.source.location,
      score: c.score,
      excerpt: c.content.slice(0, 120),
    })),
    empty: chunks.length === 0,
  };
}
