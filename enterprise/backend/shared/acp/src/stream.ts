/**
 * 「一次流式对话」的形状（ACR-035）。
 *
 * # 这些类型在底座而不在 `llm/`
 *
 * 它们描述调用方与实现方之间的契约，与具体供应商无关：
 * 实现有直连 AI SDK 的、经 ACP 发 `session/prompt` 的，以及用研面的。
 * 契约放在 `agent-runtime/src/llm/` 会迫使用研面 import 车主面，违反 ADR-011。
 * `llm/index.ts` 对这里做 re-export。
 *
 * 这里只有形状，没有实现：底座不认识 DeepSeek，也不认识 pi。
 */

/** 附在用户消息上的一张图：照片或视频帧序图。`label` 是给模型看的"这是哪一张"。 */
export interface ChatImagePart {
  mimeType: string;
  base64: string;
  label?: string;
}

export interface ChatTurnMessage {
  role: "user" | "assistant";
  content: string;
  /**
   * 本条用户消息附的图片（ACR-027）。只在它自己那一轮出现：图状态里的历史消息不带，
   * 带的是下面的 `attachmentNote`。有图片的请求走视觉档（见 `createDeepSeekStreamer`）。
   */
  images?: ChatImagePart[];
  /** 历史轮的一句话（"本条附了 2 张照片"），拼在正文后面发给模型；没有字节。 */
  attachmentNote?: string;
}

/** 发给模型的正文：正文 + 附件备注。直连与 ACP 两条路径共用此函数拼接。 */
export function messageText(m: Pick<ChatTurnMessage, "content" | "attachmentNote">): string {
  return m.attachmentNote ? `${m.content}\n${m.attachmentNote}` : m.content;
}

/**
 * 一次 LLM 调用的用量（F-36-07）。
 *
 * `sessionId` / `turnId` / `agent` 由图状态注入并一路传到这里，
 * 成本才能按会话与 Agent 归因，而不只停在 provider 级。
 */
export interface LlmUsageSample {
  provider: string;
  model: string;
  /**
   * 这次调用是哪个 Agent 发的（`drive-task` / `ownership-task` / …），
   * 用量页据此按子 Agent 统计成本。
   * 给不出时由落库侧回落 supervisor（主链路那一跳是它）。
   */
  agent?: string;
  promptTokens: number;
  completionTokens: number;
  /**
   * 输入 token 里命中上下文缓存的部分（DeepSeek 的 `prompt_cache_hit_tokens`）。
   * 只有直连 DeepSeek 的路径给得出：pi-acp 按字符估算、Fake 没有缓存，
   * 它们不传。不传与 0 含义不同，见 `llm_usage` 的 schema 注释。
   */
  cacheHitTokens?: number;
  /** 未命中、因而写进缓存的输入 token（`prompt_cache_miss_tokens`）。 */
  cacheMissTokens?: number;
  durationMs: number;
  status: "ok" | "failed";
}

export interface ChatStreamHooks {
  /** 流结束时回调一次；实现方必须保证它不抛错、不阻塞 token 流。 */
  onUsage?: (sample: LlmUsageSample) => void;
  /**
   * 图 thread id（= Cabinhug 会话维度，`turn-runner` 生成）。
   *
   * ACP 实现用它把一轮对话映射到某个 (会话 × Agent) 的独立 ACP 会话；
   * 直连 LLM 的实现忽略它。放在 hooks 上，`ChatStreamer` 签名保持不变。
   */
  threadId?: string;
  /**
   * 本次调用归属哪个 Agent。ACP 实现据此选择独立的 ACP 会话
   * （§11 时序：意图理解发给 Supervisor，应答发给路由到的子 Agent，是两次独立 prompt）；
   * 直连 LLM 的实现用它选模型档位（F-33-05）。
   */
  agent?: string;
  /**
   * 取消信号（FL-14 F-14-04）。
   *
   * # 必须是主动信号
   *
   * 调用方放弃时（分支超时、用户取消），仅靠 `break` 退出 `for await` 不够：
   * 流静默时拿不到下一个 chunk，走不到 break，底层调用会继续消耗 token
   * 直到 pi 侧的 `PROMPT_TIMEOUT_MS` 收走。
   *
   * ACP 实现据此发 `session/cancel` 并立刻结束流；直连实现据此中止请求。
   */
  signal?: AbortSignal;
  /**
   * 追加到系统提示词末尾的锚定块（ACR-036 §4.9）。
   *
   * # 挂在 hooks 上而不是 `ConfiguredStreamerOptions.system`
   *
   * 后者在建 streamer 时固定（按配置版本缓存），而锚定块按线程变化，
   * 同一个 streamer 服务多个用户。挂在 hooks 上可以让每次调用带各自的档案，
   * 系统提示词本身不变。
   *
   * # 放在 system 而不是第一条消息
   *
   * 两者对前缀缓存的效果相同（都在历史之前），但语义不同：它是系统给的事实，
   * 不是车主说的话。放进 messages 会让模型把它当成对话的一部分去回应。
   *
   * ACP 实现忽略它：pi 的系统提示词在进程启动时已固定（`--append-system-prompt`），
   * 那条路的锚定块走会话首条 prompt（见 `acp-client/connection.ts`）。
   */
  systemSuffix?: string;
}

/** 统一的流式聊天接口：输入全量上下文消息，产出 token 片段流。 */
export type ChatStreamer = (
  messages: ChatTurnMessage[],
  hooks?: ChatStreamHooks,
) => AsyncIterable<string>;
