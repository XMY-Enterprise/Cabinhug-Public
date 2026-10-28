/**
 * Mem0 embedder 配置。
 *
 * # 缺省用 DashScope
 *
 * LLM 走 DeepSeek，但 DeepSeek 的开放 API 只有 chat / FIM，没有 embeddings 接口，
 * 记忆的向量化不能复用 LLM 那条线。本机 Ollama（`nomic-embed-text`）要求每台开发机
 * 安装并拉取模型，缺失时 ②③⑥ 记忆读写全部 `degraded: fetch failed`，因此只作可选项。
 *
 * `DASHSCOPE_API_KEY` 已供 ASR / TTS / 护栏共用，DashScope 的 OpenAI 兼容口
 * 上 `text-embedding-v4` 支持 `dimensions`，`research-runtime/ontology/embed.ts` 也用它。
 * mem0 自带的 `openai` embedder 即 `new OpenAI({apiKey, baseURL})` +
 * `embeddings.create({model, input, dimensions})`，与兼容口形状一致，无需自写。
 * 维度为 768，与 `cabinhug_memories` 的 `vector(768)` 列一致。
 *
 * # 缺 key 时传空串，不传 undefined、不抛
 *
 * OpenAI SDK 在 `apiKey === undefined` 且没有 `OPENAI_API_KEY` 环境变量时构造即抛，
 * 而构造发生在 `new Memory(...)` 里，会导致 runtime 无法启动。空串构造不抛、请求期 401，
 * 走 `CabinhugMemoryClient.guard()` 的降级：对话照常，只是没有个性化，`health()`
 * 能给出原因。这里只 warn 一次，缺配置不阻止启动。
 *
 * # 批量上限：DashScope 是 10 段一批，mem0 的 openai embedder 是 100
 *
 * 当前所有写入都 `infer: false`、一次一段文本，不受此差异影响。
 * 打开 `infer: true` 让 LLM 一次抽出多条事实时，超过 10 条会收到
 * `batch size is invalid, it should not be larger than 10`。
 */

import type { MemoryConfig } from "mem0ai/oss";

export const DASHSCOPE_EMBEDDING_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const DASHSCOPE_EMBEDDING_MODEL = "text-embedding-v4";
export const OLLAMA_EMBEDDING_BASE_URL = "http://localhost:11434";
export const OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
export const DEFAULT_EMBEDDING_DIMS = 768;

export type EmbedderSettings = MemoryConfig["embedder"];

/** 只读这几个键；显式列出便于看清配置来源，也便于用例只注入这几个。 */
export interface EmbedderEnv {
  MEM0_EMBEDDING_PROVIDER?: string;
  MEM0_EMBEDDING_MODEL?: string;
  MEM0_EMBEDDING_BASE_URL?: string;
  MEM0_EMBEDDING_DIMS?: string;
  MEM0_EMBEDDING_API_KEY?: string;
  DASHSCOPE_API_KEY?: string;
}

let warnedMissingKey = false;

/**
 * 从环境变量解析 embedder 配置。
 *
 * - `provider` 缺省 `openai`（任何 OpenAI 兼容口，缺省填 DashScope）；`ollama` 才回到本机那组缺省。
 * - `openai` 一侧的 key：`MEM0_EMBEDDING_API_KEY` 优先，留空回落 `DASHSCOPE_API_KEY`，两把都缺给空串。
 * - `ollama` 一侧不带 `apiKey` 字段，它不需要 key。
 */
export function resolveEmbedderConfig(
  env: EmbedderEnv = process.env,
  warn: (msg: string) => void = (msg) => console.warn(msg),
): EmbedderSettings {
  const provider = env.MEM0_EMBEDDING_PROVIDER ?? "openai";
  const embeddingDims = Number(env.MEM0_EMBEDDING_DIMS ?? DEFAULT_EMBEDDING_DIMS);

  if (provider === "ollama") {
    return {
      provider,
      config: {
        model: env.MEM0_EMBEDDING_MODEL ?? OLLAMA_EMBEDDING_MODEL,
        baseURL: env.MEM0_EMBEDDING_BASE_URL ?? OLLAMA_EMBEDDING_BASE_URL,
        embeddingDims,
      },
    };
  }

  const apiKey = env.MEM0_EMBEDDING_API_KEY ?? env.DASHSCOPE_API_KEY ?? "";
  if (apiKey === "" && !warnedMissingKey) {
    warnedMissingKey = true;
    warn(
      "[memory] embedding 缺 API key（MEM0_EMBEDDING_API_KEY / DASHSCOPE_API_KEY 都没有）：" +
        "记忆读写会降级为不可用，对话不受影响",
    );
  }
  return {
    provider,
    config: {
      model: env.MEM0_EMBEDDING_MODEL ?? DASHSCOPE_EMBEDDING_MODEL,
      baseURL: env.MEM0_EMBEDDING_BASE_URL ?? DASHSCOPE_EMBEDDING_BASE_URL,
      embeddingDims,
      apiKey,
    },
  };
}

/** 仅测试用：让"只 warn 一次"在多个用例之间可复位。 */
export function resetEmbedderWarnings(): void {
  warnedMissingKey = false;
}
