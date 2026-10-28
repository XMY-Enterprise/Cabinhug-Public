/**
 * 研究服务自己的 LLM 薄封装。
 *
 * # 不 import agent-runtime 的封装
 *
 * `check:arch` 的 `research-isolation` 禁止研究进程 import 车主进程的包（ARCH-001）：
 * 那个进程里每个仓储都带用户键，混进来等于把无键读与带键读放进同一个进程。
 * 因此本文件独立实现同一条关思考的判据。
 *
 * # 思考必须显式关，关不掉时没有报错
 *
 * DeepSeek v4 全系默认 thinking on，`@ai-sdk/deepseek` 0.1.x 不透传关闭参数。
 * 不关时预算耗在推理上，`generateObject` 拿不到 JSON，但不报错。
 *
 * 关闭动作放在 provider 的 `fetch` 层：发往 `chat/completions` 的 JSON 请求
 * 都合入 `thinking: {type:"disabled"}`。请求体已有同名字段时以请求体为准，
 * SDK 日后自行传参时不冲突。
 *
 * # 这个文件是唯一的模型入口
 *
 * `test/thinking.test.ts` 扫源码：`src/**` 里每一处 `generateObject(` / `generateText(`
 * 都必须拿本文件给出的模型。绕过本文件不会报错，只会多耗一次推理预算。
 */

import { createDeepSeek } from "@ai-sdk/deepseek";
import type { LanguageModelV1 } from "ai";

/** 研究面只有两档模型：编码用便宜快的，综合/挑战用强的。 */
export type ResearchModelKind = "coder" | "synth";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * 把"关思考"合进请求体。与 `agent-runtime/src/llm/thinking-policy.ts` 的
 * `withDeepSeekThinking` 同一套判据，两处须同步修改，否则某一侧会开始消耗推理预算。
 */
export function withThinkingDisabled(base: FetchLike = fetch): FetchLike {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (init?.method?.toUpperCase() === "POST" && /\/chat\/completions(\?|$)/.test(url) && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        return base(input, {
          ...init,
          body: JSON.stringify({ thinking: { type: "disabled" }, ...body }),
        });
      } catch {
        /* 不是 JSON 就原样放过：这里只处理本服务拼的请求 */
      }
    }
    return base(input, init);
  };
}

export interface ResearchModelConfig {
  apiKey: string;
  baseURL?: string;
  coderModel: string;
  synthModel: string;
}

export interface ResearchModel {
  kind: ResearchModelKind;
  /** `llm_usage.agent` 的取值：`research-coder` / `research-synth`。 */
  agent: string;
  modelName: string;
  model: LanguageModelV1;
}

/**
 * 构造一档模型。思考恒关：研究面这两档的产出都给代码解析
 * （`generateObject` 的 JSON、六栏卡的字段），与 `-task` 后缀的规则一致。
 */
export function createResearchModel(kind: ResearchModelKind, config: ResearchModelConfig): ResearchModel {
  const modelName = kind === "coder" ? config.coderModel : config.synthModel;
  const deepseek = createDeepSeek({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    fetch: withThinkingDisabled(),
  });
  return {
    kind,
    agent: `research-${kind}`,
    modelName,
    model: deepseek(modelName),
  };
}

/** 一次调用的用量，落 `llm_usage`（表结构不改，只多两种 `agent` 取值）。 */
export interface ResearchUsage {
  agent: string;
  /**
   * 执行这次调用的通道。缺省 `deepseek`：本文件建的两档都直连 DeepSeek。
   * 经 pi 的调用记 `pi-acp`：其 token 按字符估算，与直连的真值口径不同，
   * 需要据此区分，否则按模型聚合成本时会混在一起（见底座 `EST_TOKENS_PER_CHAR` 的注释）。
   */
  provider?: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /**
   * 推理 token。研究面这两档恒应为 0；不为 0 说明 `withThinkingDisabled`
   * 未生效（换了 SDK、换了 baseURL、或绕过本文件直接建了 provider）。
   * 验收要查 `SELECT sum(reasoning_tokens) FROM llm_usage WHERE agent LIKE 'research-%'`。
   */
  reasoningTokens: number;
}

/** 从 AI SDK 的 usage 里取数。字段缺席按 0 记（缺席不等于没花钱，但无可取值）。 */
export function usageOf(
  m: ResearchModel,
  usage: { promptTokens?: number; completionTokens?: number } | undefined,
  providerMetadata?: Record<string, unknown>,
): ResearchUsage {
  const ds = (providerMetadata?.deepseek ?? {}) as Record<string, unknown>;
  const reasoning = typeof ds.reasoningTokens === "number" ? ds.reasoningTokens : 0;
  return {
    agent: m.agent,
    model: m.modelName,
    promptTokens: usage?.promptTokens ?? 0,
    completionTokens: usage?.completionTokens ?? 0,
    reasoningTokens: reasoning,
  };
}
