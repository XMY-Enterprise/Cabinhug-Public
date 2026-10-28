/**
 * 分跳耗时的旁路出口（F-44-04）。
 *
 * # 模块级出口
 *
 * 图节点手上有 `onTrace`（带 sessionId 与 turnId），直接用即可。
 * 但有三处拿不到图的 config：
 *
 *   - 工具观察者：pi 侧的工具调用是一次独立的 HTTP 请求，跑在另一个异步上下文里；
 *   - ACP 连接：子进程冷启动发生在任何一轮之外；
 *   - LLM streamer 包装：装配在 `index.ts`，只拿得到 `hooks.threadId`。
 *
 * 三处手上都只有 threadId，因此这里提供模块级 sink + threadId 换算。
 *
 * # 采集永不阻塞主链路（AC-44-12 / F-10-12 同源）
 *
 * `record` 与 `span` 的每一层都吞异常，唯一不吞的是被包裹函数自己抛的业务错误。
 *
 * # 未装配时静默丢弃
 *
 * 单测与离线路径不必装 sink。生产装配遗漏会让轨迹整类消失且不报错，
 * 因此 `index.ts` 的装配处有一条配套的启动日志。
 */

import { currentTurnOf, sessionIdFromThread } from "../interrupt-bus";
import { spanData, type SpanData, type SpanStatus } from "./index";

export interface SpanEvent {
  sessionId: string;
  turnId?: string;
  kind: "span" | "prompt" | "tool_call" | "agent_output";
  at: number;
  data: SpanData | PromptData | ToolCallData | AgentOutputData;
}

/**
 * 一次工具调用的内容记录（`tool_call`），与耗时 span 并列而非替代。
 *
 * 四问之四"数据是真的吗"读的就是它。形状一旦走样，回放与大屏的真/模拟计数会静默为 0，
 * 因此用显式接口固定形状：`source.kind` 是回放/summarize 的判据，`provider` 是大屏三分类
 * （RAG / 模拟服务 / 自有工具）的判据。
 */
export interface ToolCallData extends Record<string, unknown> {
  name: string;
  agent?: string;
  status: "ok" | "failed";
  /** 工具注册表声明的供应商（如 ragflow-cloud / mock-dealer / amap）。 */
  provider?: string;
  source: { kind: "real" | "mock"; provider?: string };
  /**
   * 入参与返回值的 JSON 文本（控制台轨迹的业务视图）。
   *
   * 业务排查要看模型拿什么条件去搜、搜回来了什么；`name` + `status` 只说明"调过"。
   * 两者都按 `TOOL_IO_MAX_CHARS` 截断（RAG 命中块与 POI 列表可达数十 KB），
   * 截断时置 `inputTruncated` / `outputTruncated`。
   * 展示前经网关 `redact` 脱敏，与 `intent` 里的用户原文同一道处理。
   * 字段缺失 = 这一轮跑在埋点之前，与"入参为空"不是一回事。
   */
  input?: string;
  output?: string;
  inputTruncated?: true;
  outputTruncated?: true;
  durationMs?: number;
}

/** 工具入参 / 返回值各自的入库上限。 */
export const TOOL_IO_MAX_CHARS = 8_000;

/**
 * 一次 LLM 调用实际产出的文本（控制台轨迹的业务视图）。
 *
 * # 与 `prompt` 成对：那条是"发给模型什么"，这条是"模型答了什么"
 *
 * 记在 `withLlmSpans` 里：那是唯一同时覆盖 ACP 与直连两条路径的接缝，
 * 换掉 pi 也不用重埋（与 `llm.<agent>` span 同一处）。
 *
 * # 默认不像提示词那样隐藏
 *
 * 提示词约等于整段对话原文，需要提权；产出与会话页上默认可见的助手回复同类，
 * 只经 PII 脱敏。分支被「提交即收工」掐掉时这里只有半截文本，`status` 为
 * `cancelled`，结论在 `branch.submission` 里。
 */
export interface AgentOutputData extends Record<string, unknown> {
  agent: string;
  /** 原始长度。截断后 `text.length` 会小于它。 */
  chars: number;
  text: string;
  truncated?: true;
  status: SpanStatus;
}

/** 单条产出入库上限，与提示词同一档。 */
export const OUTPUT_MAX_CHARS = 20_000;

/**
 * 把任意值截成入库文本。对象走 JSON；字符串原样；超限截断并带标记。
 * 序列化失败（循环引用等）不抛，退回 `String(v)`。
 */
export function clipForTrace(v: unknown, max: number): { text: string; truncated: boolean } {
  let text: string;
  try {
    text = typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
  } catch {
    text = String(v);
  }
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n…（已截断，原长 ${text.length} 字符）`, truncated: true };
}

/**
 * 一次 LLM 调用实际发出去的提示词。
 *
 * # 记实际发出的文本，而不是图里的 messages
 *
 * ACP 那条路上，`connection.ts` 会把图状态里的消息再加工一道：新会话回灌历史
 * （`primeWithHistory`；业务 prompt 走系统提示词，不进这里），稳态下只取最后一条用户消息；
 * 编排层也会经 `describeMerged` 向最后一条用户消息注入内容。
 * 排查"模型为什么说这句"必须看实际发出的文本。
 *
 * # 读取侧有提权门
 *
 * 它几乎等于整段对话原文。落库存全文；`/console/replay/:id` 默认不返回 `text`，
 * 要看得走 `/console/replay/:id/reveal`，与会话浏览页同一道门、同样写审计。
 */
export interface PromptData extends Record<string, unknown> {
  agent: string;
  /** 原始长度。截断后 `text.length` 会小于它。 */
  chars: number;
  /** 截断后的全文。超过上限时末尾带省略标记。 */
  text: string;
  truncated?: true;
}

/** 单条提示词入库上限，超出截断；一次应答的提示词可达数十 KB。 */
export const PROMPT_MAX_CHARS = 20_000;

export type SpanSink = (e: SpanEvent) => void;

let sink: SpanSink | undefined;

/** 装配层注入落库出口；传 undefined 即卸载（单测清场用）。 */
export function setSpanSink(s: SpanSink | undefined): void {
  sink = s;
}

export function hasSpanSink(): boolean {
  return sink !== undefined;
}

export interface SpanOptions {
  agent?: string;
  /** 结构性信息，不含用户原文（AC-44-10）。 */
  detail?: string;
  /** 见 `SpanData.waitMs`：这一跳里在本地限速闸排队的部分。 */
  waitMs?: number;
}

/**
 * threadId → 落库用的会话键，两级换算。
 *
 *  1. `currentTurnOf` —— 本轮进行中，能同时拿到 turnId；
 *  2. `sessionIdFromThread` —— 轮次已结束（如确认超时后才落的裁决），
 *     按格式反推会话 id，turnId 拿不到，标 `keyFallback`。
 *
 * 两级都落空才用原值。任何一级都不丢事件，否则无法排查缺失的一跳。
 */
export function resolveTraceKey(threadId: string | undefined): {
  sessionId: string;
  turnId?: string;
  fallback: boolean;
} {
  if (!threadId) return { sessionId: "unknown", fallback: true };
  const live = currentTurnOf(threadId);
  if (live) return { sessionId: live.sessionId, turnId: live.turnId, fallback: false };
  const derived = sessionIdFromThread(threadId);
  // 反推成功仍标 fallback：会话对了但轮次缺失，这一条挂不到具体一轮。
  return { sessionId: derived ?? threadId, fallback: true };
}

/**
 * 落一条 span。换算不到时仍然写入，并打上 `keyFallback`。
 */
export function recordSpan(
  threadId: string | undefined,
  name: string,
  startedAt: number,
  endedAt: number,
  status: SpanStatus,
  opts?: SpanOptions,
): void {
  if (!sink) return;
  try {
    const key = resolveTraceKey(threadId);
    sink({
      sessionId: key.sessionId,
      turnId: key.turnId,
      kind: "span",
      at: endedAt,
      data: spanData(name, startedAt, endedAt, status, {
        ...opts,
        ...(key.fallback ? { keyFallback: true as const } : {}),
      }),
    });
  } catch {
    // 吞掉：埋点坏了不该让对话坏。
  }
}

/**
 * 落一条 `tool_call`。与 span 同一条 fire-and-forget 通道、同一套 key 换算。
 * `mode` 来自工具执行上下文（装配层注入，缺省 real）；`off` 走不到成功路径，
 * 失败时按 real 记：那是"该真调而没调成"，不是模拟。
 */
export function recordToolCall(
  threadId: string | undefined,
  o: {
    name: string;
    agent?: string;
    mode?: string;
    provider?: string;
    status: "ok" | "failed";
    /** 校验后的入参；`undefined` = 调用方没给（老接线），此时不写 `input`。 */
    args?: unknown;
    /** 成功时的返回值。 */
    result?: unknown;
    durationMs?: number;
  },
): void {
  if (!sink) return;
  try {
    const key = resolveTraceKey(threadId);
    const kind = o.mode === "mock" ? ("mock" as const) : ("real" as const);
    const input = o.args === undefined ? undefined : clipForTrace(o.args, TOOL_IO_MAX_CHARS);
    const output = o.result === undefined ? undefined : clipForTrace(o.result, TOOL_IO_MAX_CHARS);
    sink({
      sessionId: key.sessionId,
      turnId: key.turnId,
      kind: "tool_call",
      at: Date.now(),
      data: {
        name: o.name,
        ...(o.agent ? { agent: o.agent } : {}),
        status: o.status,
        ...(o.provider ? { provider: o.provider } : {}),
        source: { kind, ...(o.provider ? { provider: o.provider } : {}) },
        ...(input ? { input: input.text, ...(input.truncated ? { inputTruncated: true as const } : {}) } : {}),
        ...(output ? { output: output.text, ...(output.truncated ? { outputTruncated: true as const } : {}) } : {}),
        ...(o.durationMs !== undefined ? { durationMs: Math.max(0, o.durationMs) } : {}),
        ...(key.fallback ? { keyFallback: true as const } : {}),
      },
    });
  } catch {
    // 吞掉：埋点坏了不该让对话坏。
  }
}

/**
 * 落一条提示词。与 span 同一条 fire-and-forget 通道，坏了不影响对话。
 *
 * 空文本不记：空文本表示这次没有发出（会话新建失败等），而不是提示词为空。
 */
export function recordPrompt(
  threadId: string | undefined,
  agent: string,
  text: string,
): void {
  if (!sink || !text) return;
  try {
    const key = resolveTraceKey(threadId);
    const truncated = text.length > PROMPT_MAX_CHARS;
    sink({
      sessionId: key.sessionId,
      turnId: key.turnId,
      kind: "prompt",
      at: Date.now(),
      data: {
        agent,
        chars: text.length,
        text: truncated ? `${text.slice(0, PROMPT_MAX_CHARS)}\n…（已截断，原长 ${text.length} 字符）` : text,
        ...(truncated ? { truncated: true as const } : {}),
        ...(key.fallback ? { keyFallback: true as const } : {}),
      },
    });
  } catch {
    // 吞掉：埋点坏了不该让对话坏。
  }
}

/**
 * 落一条 LLM 产出（见 `AgentOutputData`）。空文本也记，以区分"模型一个字没答"
 * 与"没记"（状态多半是 failed / cancelled，业务视图据此说"这一步没有结果"）。
 */
export function recordAgentOutput(
  threadId: string | undefined,
  agent: string,
  text: string,
  status: SpanStatus,
): void {
  if (!sink) return;
  try {
    const key = resolveTraceKey(threadId);
    const clipped = clipForTrace(text, OUTPUT_MAX_CHARS);
    sink({
      sessionId: key.sessionId,
      turnId: key.turnId,
      kind: "agent_output",
      at: Date.now(),
      data: {
        agent,
        chars: text.length,
        text: clipped.text,
        ...(clipped.truncated ? { truncated: true as const } : {}),
        status,
        ...(key.fallback ? { keyFallback: true as const } : {}),
      },
    });
  } catch {
    // 吞掉：埋点坏了不该让对话坏。
  }
}

/**
 * 包住一次异步调用并计时。成功失败都发：失败的那一跳往往正是慢的那一跳
 * （如超时后失败）。
 *
 * 异常原样抛出，不改变调用方的失败路径。
 */
export async function span<T>(
  threadId: string | undefined,
  name: string,
  fn: () => Promise<T>,
  opts?: SpanOptions,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const r = await fn();
    recordSpan(threadId, name, startedAt, Date.now(), "ok", opts);
    return r;
  } catch (err) {
    recordSpan(threadId, name, startedAt, Date.now(), "failed", {
      ...opts,
      // 只留错误分类，不留消息全文：外部服务的报错里可能带 URL 与入参回显。
      detail: opts?.detail ?? classifyError(err),
    });
    throw err;
  }
}

/**
 * 错误归类。不落原始 message：上游报错里可能出现带查询串的 URL，
 * 其中含用户原文（AC-44-10 的边界）。
 *
 * # 不在 message 里找状态码
 *
 * 错误文本里的三位数可能来自业务数据（如校验退回时回显的停靠点名「…(507.5km)」），
 * 按数字判状态码会把入参不合法误标成服务端 5xx。分类依据取自结构化字段
 * （ADR-012）：
 *  - 工具错误读 `ToolError.category`；
 *  - HTTP 读结构化 `status`，取不到就不猜。
 *
 * `timeout` / `network` 两条的文本匹配保留：它们匹配的是错误码与固定短语
 * （`ETIMEDOUT` / `fetch failed`），不会撞上业务数据；
 * 且工具错误已在它们之前被 `ToolError` 分支接走。
 */
export function classifyError(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  const msg = err instanceof Error ? err.message : "";

  // ① 工具错误：分类依据在错误对象自己身上。duck-typing 而不 import ToolError：
  // `trace/` 是横切层，不为读一个字段依赖业务包。
  const toolCategory = toolErrorCategory(err);
  if (toolCategory) {
    const code = upstreamCode(err);
    return code ? `tool_${toolCategory}:${code}` : `tool_${toolCategory}`;
  }

  // ② HTTP：只认结构化状态码（fetch Response、SDK 的错误体、cause 链）。
  const status = httpStatus(err);
  if (status !== undefined) {
    if (status >= 500) return "http_5xx";
    if (status >= 400) return "http_4xx";
  }

  if (/timeout|timed out|ETIMEDOUT|AbortError/i.test(`${name} ${msg}`)) return "timeout";
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed/i.test(msg)) return "network";

  /*
   * ④ 本仓代码 bug：带上出错位置。
   *
   * 这四类是 JS 引擎在代码本身写错时抛的，不是环境、上游或配额问题。
   * 只有类名时无法定位到行，容易被读成外部故障。
   *
   * 落位置不违反"不落 message 全文"（AC-44-10）：位置里只有本仓的文件名与行号，
   * 没有用户原文与上游回显。
   *
   * 只限这四类：其余类名（`Error`、`RequestError`…）也可能是上游库抛的，
   * 拼位置会把三方包的内部路径落进库里。
   * 排在 `network` 之后：undici 的网络失败抛的也是 `TypeError`（`fetch failed`），
   * 需先被 network 判据接走。
   */
  if (name === "ReferenceError" || name === "TypeError" || name === "RangeError" || name === "SyntaxError") {
    const frame = ownFrame(err);
    return frame ? `${name}@${frame}` : name;
  }
  return name || "error";
}

/** 仓库里的顶层目录：栈帧落在它们下面才算本仓代码。 */
const REPO_DIRS = ["enterprise/", "clients/", "contracts/", "scripts/", "mocks/", "evals/"] as const;

/**
 * 栈里第一条属于本仓、且不在 `node_modules` 下的帧，形如 `enterprise/backend/…/x.ts:312`。
 *
 * 取第一条而不是栈顶：引擎抛错时栈顶常在 `node_modules` 或 `node:internal` 里
 * （某个库使用了传入的坏值）。一条都找不到就返回 `undefined`，不猜，调用方退回只落类名。
 *
 * 绝对路径一律剥掉：`/Users/<人名>/git/…` 含机器主人的名字，而这是落库要展示的字段。
 * 不带列号，定位靠行号即可。
 */
function ownFrame(err: unknown): string | undefined {
  const stack = err instanceof Error ? err.stack : undefined;
  if (typeof stack !== "string") return undefined;
  for (const line of stack.split("\n").slice(1)) {
    if (line.includes("node_modules") || line.includes("node:")) continue;
    for (const dir of REPO_DIRS) {
      const at = line.indexOf(dir);
      if (at < 0) continue;
      // 帧尾形如 `…/x.ts:312:11)`：取到行号为止。
      const rest = line.slice(at).replace(/\)\s*$/, "");
      const m = /^([^\s:]+):(\d+)(?::\d+)?$/.exec(rest);
      if (m) return `${m[1]}:${m[2]}`;
    }
  }
  return undefined;
}

/** `ToolError` 的 `category`（`timeout` / `upstream` / `unconfigured` / `invalid`）。 */
function toolErrorCategory(err: unknown): string | undefined {
  if (!(err instanceof Error) || err.name !== "ToolError") return undefined;
  const c = (err as { category?: unknown }).category;
  return typeof c === "string" && c.length > 0 ? c : undefined;
}

/**
 * 上游自己给的错误码（高德是 infocode）。
 *
 * 「被限流」与「上游说没有这个地方」在 message 上相同，
 * 分辨依据只有这个码（`external.ts` 的 `code` 字段）。
 * 清洗后再拼：码来自外部，而 detail 是要落库展示的。
 */
function upstreamCode(err: unknown): string | undefined {
  const raw = (err as { code?: unknown }).code;
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const cleaned = String(raw).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 24);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** 结构化 HTTP 状态码。四个来源都试，一个都取不到就返回 undefined（不猜）。 */
function httpStatus(err: unknown): number | undefined {
  const pick = (o: unknown): number | undefined => {
    if (!o || typeof o !== "object") return undefined;
    for (const key of ["status", "statusCode"] as const) {
      const v = (o as Record<string, unknown>)[key];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  return (
    pick(err) ??
    pick((err as { response?: unknown }).response) ??
    pick((err as { cause?: unknown }).cause) ??
    pick(((err as { cause?: { response?: unknown } }).cause ?? {}).response)
  );
}
