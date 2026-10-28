/**
 * 运行轨迹采集（§4.1 X2 / FL-14 F-14-06）。
 *
 * # 粒度基准：能回答罗启明的四个问题，不是"尽可能全"
 *
 * 1. 真的是多 Agent 吗 → `agent_session`（各 Agent 的独立会话可分别观察）
 * 2. 并行是真的吗 → `branch` 的 startedAt/endedAt（时间轴重叠）
 * 3. 中断恢复是真的吗 → `interrupt` / `resume` 的时间差
 * 4. 数据是真的吗 → `tool_call` 的入参出参摘要 + `source.kind`
 *
 * 记太粗与日志无异，记太细存不起；以这四个问题为界。
 *
 * # 写入永不阻塞主链路
 *
 * 与审计同一取向（FL-10 F-10-12）：轨迹是旁路，
 * 采集失败不能让对话失败。所有写入都是 fire-and-forget。
 */

export type TraceKind =
  | "turn_start"
  | "intent"
  /** 风险边界门的判定与处置（AC-11-7），被拒的那一轮在回放里不能看起来像"没说话"。 */
  | "risk"
  | "route"
  /** 观察层：照片 → 受控观察 + 图标匹配的结果与耗时，回放里据此看到「这轮看图看到了什么」。 */
  | "vision"
  /** 视频：网关派生的帧序图张数、转写段数、截断与缺失，回放里据此看到「这轮看视频看到了什么」。 */
  | "video"
  /** 表述模型这一步实际附了几张图；图片是否到达模型只能从这里看。 */
  | "media"
  | "agent_session"
  | "branch"
  | "merge"
  /** 行程可执行性体检：结论计数与修复轮数，回放里据此看到"这份方案验了几项、修了几处"。 */
  | "audit"
  | "tool_call"
  | "guard"
  | "interrupt"
  | "resume"
  | "cancel"
  /** 行程确认/取消的裁决与结果，回放页据此看到"这一轮定下来了没有"。 */
  | "commit"
  | "turn_end"
  | "span"
  /** 一次 LLM 调用的产出文本，与 `prompt` 成对，业务视图据此展示"这个 Agent 答了什么"。 */
  | "agent_output"
  /**
   * 这一轮装载的两级状态与各 Agent 实际拿到的锚定块 / 尾区（ACR-036 的可观测面）。
   * 每轮一条，落在 `turn_end` 之前；会话页的「查看上下文」读它。载荷见 `context/trace.ts`。
   */
  | "context";

/**
 * 一跳的耗时（FL-44 F-44-04）。
 *
 * # 只有一个 kind
 *
 * 不为每种外部依赖各开一个 kind，否则 `timeline.ts` 的 `POINT_LABELS` 会无限膨胀。
 * 一个 `span` + `name` 前缀分组，页面只认前缀（`llm.` / `tool.` / `node.` / `acp.` / `guard.`）。
 *
 * # 与内容事件分开
 *
 * `intent` / `route` / `merge` / `branch` 记的是内容不是耗时；
 * 需要耗时的地方额外发一条 span。
 *
 * # detail 里不放用户原文（AC-44-10）
 *
 * 指标系统不是绕过审计脱敏的后门。允许放的只有结构性信息：
 * 工具名、agent、命中块数、失败原因分类。
 */
/**
 * `cancelled` 与 `failed` 是两回事：「提交即收工」会主动掐掉分支流，分支超时与用户打断
 * 也会 abort 底层调用。这些流都以 CancelledError 收场，但调用本身没有坏，
 * 记成 failed 会让轨迹页看起来像模型故障（fanout.ts 在分支层有同样的区分）。
 * `detail` 里带取消原因（submitted / timeout / …）。
 */
export type SpanStatus = "ok" | "failed" | "cancelled";

export interface SpanData extends Record<string, unknown> {
  /** 形如 `llm.supervisor` / `tool.ragflow_retrieve` / `node.answer` / `acp.connect`。 */
  name: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  status: SpanStatus;
  agent?: string;
  /** 结构性信息，不含用户原文。 */
  detail?: string;
  /**
   * 换算不到真会话 id 时置位（thread 已注销、异步回调迟到）。
   * 仍然写入，否则无法排查缺失的一跳。
   */
  keyFallback?: true;
  /**
   * `durationMs` 里有多少是在自己的限速闸排队（`@cabinhug/tools` 的 `wait-meter`）。
   *
   * fan-out 并发请求时，`durationMs` 里可能大部分是本地限速排队而非上游耗时。
   * 两者处置相反：等上游只能等，本地排队是并发策略，可以调。
   *
   * 只有经过限速闸的工具会带上它（目前只有高德那一族）；
   * 没等是 0，量不到是 undefined，两者不能混。
   */
  waitMs?: number;
}

export function spanData(
  name: string,
  startedAt: number,
  endedAt: number,
  status: SpanStatus,
  extra?: { agent?: string; detail?: string; keyFallback?: true; waitMs?: number },
): SpanData {
  return {
    name,
    startedAt,
    endedAt,
    // 单调时钟不保证，负数会让页面画出反向的条；夹到 0 并如实保留两端时间戳。
    durationMs: Math.max(0, endedAt - startedAt),
    status,
    ...(extra?.agent !== undefined ? { agent: extra.agent } : {}),
    ...(extra?.detail !== undefined ? { detail: extra.detail } : {}),
    ...(extra?.keyFallback ? { keyFallback: true as const } : {}),
    // 0 也要写：那是"这一跳没排队"，与"这一跳没量过"是两回事。
    ...(extra?.waitMs !== undefined ? { waitMs: Math.max(0, Math.round(extra.waitMs)) } : {}),
  };
}

export interface TraceEvent {
  sessionId: string;
  turnId?: string;
  kind: TraceKind;
  at: number;
  /** 结构化载荷；展示前须经 PII 脱敏（§8.3，由回放页负责）。 */
  data: Record<string, unknown>;
}

export interface TraceSink {
  write(e: TraceEvent): void;
}

/** 内存实现：单测与离线路径用。生产装配注入落库实现（轨迹表）。 */
export class MemoryTraceSink implements TraceSink {
  private events: TraceEvent[] = [];
  constructor(private cap = 5_000) {}

  write(e: TraceEvent): void {
    this.events.push(e);
    // 有上限，避免长跑进程被轨迹吃满内存。丢弃最早的而不是拒绝新的：
    // 排障看的总是最近发生的事。
    if (this.events.length > this.cap) this.events.splice(0, this.events.length - this.cap);
  }

  bySession(sessionId: string): TraceEvent[] {
    return this.events.filter((e) => e.sessionId === sessionId);
  }

  all(): readonly TraceEvent[] {
    return this.events;
  }
}

/**
 * 采集器。所有方法都不抛错：轨迹是旁路，它坏了不该让对话坏。
 */
export class TraceCollector {
  constructor(
    private sink: TraceSink,
    private now: () => number = Date.now,
  ) {}

  record(sessionId: string, kind: TraceKind, data: Record<string, unknown>, turnId?: string): void {
    try {
      this.sink.write({ sessionId, turnId, kind, at: this.now(), data });
    } catch {
      // 吞掉：采集失败绝不能影响主链路（F-10-12 同源）。
    }
  }
}

/**
 * 取消令牌（FL-14 F-14-04/05 / FL-08 F-08-08）。
 *
 * # 副作用边界
 *
 * 只读工具的结果可以直接丢弃；有副作用的工具，取消必须发生在权限门放行之前，
 * 外部 API 一旦发出就无法收回（F-14-05）。
 * 危险窗口尽量收窄：`markSideEffectWindow` 标记"从这里到 API 返回之间不可取消"，
 * 取消请求落在窗口内时如实告诉用户"已经发出去了"，而不是假装取消成功。
 */
export class CancellationToken {
  private cancelled = false;
  private inSideEffect = false;
  private reason?: string;

  isCancelled(): boolean {
    return this.cancelled;
  }

  /** 返回 false 表示落在副作用窗口内：动作已经发出，取消不了。 */
  cancel(reason = "用户取消"): boolean {
    this.reason = reason;
    this.cancelled = true;
    return !this.inSideEffect;
  }

  cancelReason(): string | undefined {
    return this.reason;
  }

  /**
   * 进入/离开副作用窗口。窗口应尽可能窄：
   * 从权限门放行到外部 API 返回之间的那一小段（§11 时序的 `GC-->>Trip: allow` → `Trip->>Cal: 写入`）。
   */
  async withSideEffect<T>(fn: () => Promise<T>): Promise<T> {
    this.inSideEffect = true;
    try {
      return await fn();
    } finally {
      this.inSideEffect = false;
    }
  }

  /** 在安全点检查：已取消则抛出，让图停止推进。 */
  throwIfCancelled(): void {
    if (this.cancelled) throw new CancelledError(this.reason ?? "已取消");
  }
}

export class CancelledError extends Error {
  readonly cancelled = true;
}

/**
 * 回放数据读取（FL-29 F-29-02/03）。
 *
 * 不触发任何真实 LLM / 外部 API 调用（AC-14-7）：它只读已留存的轨迹，
 * 结构上拿不到 streamer 与工具注册表。
 */
export interface ReplayView {
  sessionId: string;
  /** 按时间排序的事件。 */
  timeline: TraceEvent[];
  /** 罗启明四问的直接答案。 */
  answers: {
    /** ① 真的是多 Agent 吗——出现过的 Agent 会话数。 */
    agentCount: number;
    /** ② 并行是真的吗——是否存在时间区间重叠的分支。 */
    hasParallelOverlap: boolean;
    /** ③ 中断恢复是真的吗——最长的一次挂起时长（ms）；无中断为 null。 */
    longestInterruptMs: number | null;
    /** ④ 数据是真的吗——工具调用次数与真实/模拟占比。 */
    toolCalls: { total: number; real: number; mock: number };
  };
}

export function buildReplay(events: readonly TraceEvent[], sessionId: string): ReplayView {
  const timeline = events.filter((e) => e.sessionId === sessionId).slice().sort((a, b) => a.at - b.at);

  const agents = new Set<string>();
  for (const e of timeline) {
    const a = (e.data as { agent?: string }).agent;
    if (a && (e.kind === "agent_session" || e.kind === "branch")) agents.add(a);
  }

  // 并行判据与 fanout.ts 保持一致：区间有交集才算（AC-13-1）。
  const branches = timeline
    .filter((e) => e.kind === "branch")
    .map((e) => e.data as { startedAt?: number; endedAt?: number })
    .filter((b): b is { startedAt: number; endedAt: number } =>
      typeof b.startedAt === "number" && typeof b.endedAt === "number");
  let overlap = false;
  for (let i = 0; i < branches.length && !overlap; i += 1) {
    for (let j = i + 1; j < branches.length; j += 1) {
      if (branches[i].startedAt < branches[j].endedAt && branches[j].startedAt < branches[i].endedAt) {
        overlap = true;
        break;
      }
    }
  }

  // 挂起时长：interrupt 与同 id 的 resume 之间的真实间隔。
  let longestInterruptMs: number | null = null;
  const opened = new Map<string, number>();
  for (const e of timeline) {
    const id = (e.data as { interruptId?: string }).interruptId;
    if (!id) continue;
    if (e.kind === "interrupt") opened.set(id, e.at);
    if (e.kind === "resume" && opened.has(id)) {
      const ms = e.at - opened.get(id)!;
      longestInterruptMs = Math.max(longestInterruptMs ?? 0, ms);
      opened.delete(id);
    }
  }

  const calls = timeline.filter((e) => e.kind === "tool_call");
  const real = calls.filter((e) => (e.data as { source?: { kind?: string } }).source?.kind === "real").length;
  const mock = calls.filter((e) => (e.data as { source?: { kind?: string } }).source?.kind === "mock").length;

  return {
    sessionId,
    timeline,
    answers: {
      agentCount: agents.size,
      hasParallelOverlap: overlap,
      longestInterruptMs,
      toolCalls: { total: calls.length, real, mock },
    },
  };
}
