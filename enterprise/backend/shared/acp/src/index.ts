/**
 * `@cabinhug/acp` —— ACP 底座（变更单 ACR-035）。
 *
 * # 这个包是什么
 *
 * 「ACP Client 那一侧」的通用部分：连接、进程池、提示词装配、思考档、
 * `session/update` 到内部流式事件的桥接。它认识协议，不认识业务。
 *
 * # 单独成包的原因
 *
 * 用研面（`research-runtime`）跑在同一套 ACP + pi 上，而
 * ADR-011
 * 与 `check:arch` 的 `research-isolation` 禁止它 import 车主面。
 *
 * # 两条硬边界（`check:arch` 的 `acp-substrate-pure` 守着）
 *
 * ① 不得 import `@cabinhug/{tools,db,memory,guardrails}`。
 *    引用工具表会让用研面间接拿到车主面的全部工具，且不报错。
 * ② 不得出现 `import.meta.url`。底座不自行推断相邻目录：
 *    `piDir` 与 `promptsDir` 一律由 `AcpApp` 描述符给出，理由见 `app.ts` 的 `piDir`。
 */

/* 底座的对外接口。 */

export {
  messageText,
  type ChatImagePart,
  type ChatStreamer,
  type ChatStreamHooks,
  type ChatTurnMessage,
  type LlmUsageSample,
} from "./stream";
export { defaultThinkingFor, type ThinkingLevel } from "./thinking";
export type { AcpApp, AcpSpanOptions, AcpSpanStatus, AcpTracer } from "./app";

export { splitThinkBursts, THINK_GAP_MS, type ThinkBurst, type ThoughtTick } from "./think";
export {
  classifyUnmapped,
  DEFERRED_UPDATES,
  IGNORED_UPDATES,
  isPiAcpUpdateNotice,
  projectUpdate,
  type ProjectedUpdate,
  type UnmappedBreakdown,
  type UpdateSink,
} from "./update-bridge";


export { canonicalAgent } from "./naming";
export {
  AcpClient,
  createAcpStreamer,
  modelSpecFor,
  trailingUserRunStart,
  type AcpClientOptions,
  type AcpHealth,
  type AcpPrompter,
} from "./connection";
export { AcpClientPool } from "./pool";
