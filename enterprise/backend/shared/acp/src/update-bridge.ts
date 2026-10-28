/**
 * acp-client/update-bridge —— `session/update` → 图节点事件。
 *
 * 【映射】
 *   agent_message_chunk      → delta（文本增量，驱动端上 SSE 的 update/delta）
 *   agent_thought_chunk      → thought（思考过程；不向端上下发，FL-03 F-03-04）
 *   tool_call / tool_call_update → 忽略，工具进展另有生产方（见 `IGNORED_UPDATES`）
 *   session_info_update / available_commands_update / plan → 与端上语义无关，计数忽略
 *
 * 【不变量】映射不到的类型忽略并计数上报，不抛错，与 FL-01 F-01-08
 * 的端上适配器同一原则：协议演进不应让对话链路崩溃。
 *
 * 本模块不产出 SessionEvent：事件构造在 `events/`，封套在网关。这里只做语义分类，
 * 保证换掉 pi 时端上事件语义不变（ACP 边界，§0）。
 */

/**
 * 映射不到的类型分三桶，各自语义不同，不合并为同一条风险。
 *
 * 分类表与下面的 `switch` 是同一份真相，因此放在同一个文件里，不在 `health.ts` 另存副本。
 * 三桶合并上报时，常驻的忽略项噪音会淹没真正的协议演进信号。
 */

/**
 * 与端上语义无关，映射不到也不欠什么。丢弃，不进风险行。
 *
 * `tool_call` / `tool_call_update` 属于这一桶：端上的工具进展不从这里来。
 * pi 的 update 只覆盖模型自己发起的调用，而购车检索、双路检索、试驾下单由
 * 图节点直调 `invokeTool`，那条路上没有 ACP update。生产方挂在两条入口的共同下游
 * （`index.ts` 的 `setToolStartObserver` / `setToolObserver`）。
 */
export const IGNORED_UPDATES: readonly string[] = [
  "session_info_update",
  "available_commands_update",
  "plan",
  "tool_call",
  "tool_call_update",
];

/**
 * 已知欠账：有消费方设计、没有生产方。
 *
 * 值是"欠的是什么"，直接给人看。它们不进风险行：风险行的契约是
 * 「空数组才是可以上台的状态」，常驻项会使这个契约失效。
 *
 * 当前为空。保留该机制用于登记今后出现的"已定义但无生产方"的 update 类型。
 */
export const DEFERRED_UPDATES: Readonly<Record<string, string>> = {};

export interface UnmappedBreakdown {
  /** 明写忽略的：报出来只是噪音。 */
  ignored: Record<string, number>;
  /** 已知欠着的：`欠的是什么 → 计数`。 */
  deferred: Record<string, { count: number; owes: string }>;
  /** 协议演进的早期信号，是这组计数真正要报告的内容。 */
  unexpected: Record<string, number>;
}

/**
 * 两张表可以传入，使"欠账"这一桶在默认表为空时仍然可测。
 */
export function classifyUnmapped(
  counts: Record<string, number>,
  tables: { ignored: readonly string[]; deferred: Readonly<Record<string, string>> } = {
    ignored: IGNORED_UPDATES,
    deferred: DEFERRED_UPDATES,
  },
): UnmappedBreakdown {
  const out: UnmappedBreakdown = { ignored: {}, deferred: {}, unexpected: {} };
  for (const [kind, count] of Object.entries(counts)) {
    if (tables.ignored.includes(kind)) out.ignored[kind] = count;
    else if (tables.deferred[kind]) out.deferred[kind] = { count, owes: tables.deferred[kind] };
    else out.unexpected[kind] = count;
  }
  return out;
}

export type ProjectedUpdate =
  | { kind: "delta"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "unmapped"; rawKind: string };

export interface UpdateSink {
  push(item: { kind: "delta" | "thought"; text: string }): void;
  fail(e: Error): void;
}

/**
 * pi-acp 0.0.33 自己拼出的启动版本提示。
 *
 * 它不是模型内容，却被适配器作为普通 `agent_message_chunk` 发出；只匹配
 * 完整固定格式，避免吞掉用户或模型正常提到「新版本」的句子。
 */
const PI_ACP_UPDATE_NOTICE_RE =
  /^New version available: v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)? \(installed v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\)\. Run: `npm i -g @earendil-works\/pi-coding-agent`$/;

export function isPiAcpUpdateNotice(text: string): boolean {
  return PI_ACP_UPDATE_NOTICE_RE.test(text.trim());
}

/** ACP 的文本内容块形状：`{ type: "text", text: "..." }`。 */
function textOf(update: Record<string, unknown>): string | undefined {
  const content = update.content as { type?: string; text?: unknown } | undefined;
  if (content && content.type === "text" && typeof content.text === "string") return content.text;
  // 少数实现把文本直接挂在 update 上，容错取一次。
  if (typeof update.text === "string") return update.text;
  return undefined;
}

export function projectUpdate(update: unknown): ProjectedUpdate {
  if (!update || typeof update !== "object") return { kind: "unmapped", rawKind: "(non-object)" };
  const u = update as Record<string, unknown>;
  const rawKind = typeof u.sessionUpdate === "string" ? u.sessionUpdate : "(missing sessionUpdate)";

  switch (rawKind) {
    case "agent_message_chunk": {
      const text = textOf(u);
      return text === undefined ? { kind: "unmapped", rawKind } : { kind: "delta", text };
    }
    case "agent_thought_chunk": {
      const text = textOf(u);
      return text === undefined ? { kind: "unmapped", rawKind } : { kind: "thought", text };
    }
    default:
      return { kind: "unmapped", rawKind };
  }
}
