/**
 * 文本嵌入：DashScope 的 OpenAI 兼容口 `/compatible-mode/v1/embeddings`。
 *
 * # 走兼容口而不是原生 API
 *
 * `@cabinhug/rag` 的 `icon-index.ts` 走原生 API，因为 `qwen3-vl-embedding`
 * 不支持兼容口。`text-embedding-v4` 支持，且兼容口能传 `dimensions`：
 * 这里需要 1024 维（pgvector 的 ANN 索引上限是 2000 维，2560 维建不了索引，见 ACR-030）。
 *
 * # 维度不对就抛，不静默接受
 *
 * 返回 512 维而列是 `vector(1024)` 时，PG 在写入时报的错与根因相距甚远。
 * 在这里拦住并说明模型、期望维数与实际维数。
 */

/**
 * 一批最多多少段。
 *
 * 10 是 DashScope 的硬上限：`text-embedding-v4` 超过 10 段会回
 * `<400> InternalError.Algo.InvalidParameter: Value error, batch size is invalid,
 * it should not be larger than 10.: input.contents`。
 *
 * 缺 `DASHSCOPE_API_KEY` 时嵌入队列不注册（`src/index.ts`），此路径不会被执行到，
 * 批量上限错误只在配置 key 后才暴露。改批量前以上游文档为准。
 */
export const EMBED_BATCH = 10;

export interface EmbedConfig {
  apiKey: string;
  model: string;
  dimensions: number;
  /** 覆盖端点，测试用。 */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface EmbedResult {
  vectors: number[][];
  /** 记 `llm_usage` 用（`agent = 'research-embed'`）。 */
  promptTokens: number;
}

const DEFAULT_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";

interface EmbeddingResponse {
  data?: Array<{ index: number; embedding: number[] }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
  error?: { message?: string };
}

async function embedOnce(texts: readonly string[], cfg: EmbedConfig): Promise<EmbedResult> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const res = await doFetch(`${cfg.baseUrl ?? DEFAULT_BASE}/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, input: texts, dimensions: cfg.dimensions, encoding_format: "float" }),
  });
  if (!res.ok) {
    throw new Error(`research_embed_http_${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as EmbeddingResponse;
  if (body.error) throw new Error(`research_embed_api: ${body.error.message ?? "未知错误"}`);
  const data = body.data ?? [];
  if (data.length !== texts.length) {
    throw new Error(`research_embed_count: 送了 ${texts.length} 段，回来 ${data.length} 个向量`);
  }
  // 按 index 排回原序：兼容口不保证顺序，乱序会让向量挂到别的单元上。
  const sorted = [...data].sort((a, b) => a.index - b.index);
  for (const d of sorted) {
    if (d.embedding.length !== cfg.dimensions) {
      throw new Error(
        `research_embed_dim: ${cfg.model} 返回 ${d.embedding.length} 维，期望 ${cfg.dimensions}——` +
          "列是 vector(1024)，维度不符会在写入那一刻报一句离根因很远的话",
      );
    }
  }
  return { vectors: sorted.map((d) => d.embedding), promptTokens: body.usage?.prompt_tokens ?? 0 };
}

/** 分批 + 失败重试一次。批之间顺序执行：并发打满配额节省的时间有限。 */
export async function embedTexts(texts: readonly string[], cfg: EmbedConfig): Promise<EmbedResult> {
  const vectors: number[][] = [];
  let promptTokens = 0;

  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const slice = texts.slice(i, i + EMBED_BATCH);
    let last: unknown;
    let done = false;
    for (let attempt = 0; attempt < 2 && !done; attempt += 1) {
      try {
        const r = await embedOnce(slice, cfg);
        vectors.push(...r.vectors);
        promptTokens += r.promptTokens;
        done = true;
      } catch (err) {
        last = err;
      }
    }
    if (!done) {
      throw new Error(
        `research_embed_failed: 第 ${Math.floor(i / EMBED_BATCH) + 1} 批两次都失败：` +
          `${last instanceof Error ? last.message : String(last)}`,
      );
    }
  }

  return { vectors, promptTokens };
}
