/**
 * 大屏实时视图的状态归并。写成纯函数：这里的难点在归并逻辑，不在渲染。
 *
 * # `unknown` 不是一个会话，是兜底桶
 *
 * 运行时的 `resolveTraceKey` 换算不到真会话时返回字面量 `unknown`：
 * ACP 冷启动（发生在任何一轮之外）、旁路垫场话的提示词（那条路上没有 threadId）
 * 都落在这里。它持续产生新事件，按"最近有事件的会话"选择时，
 * 画面会在 `unknown` 与真实会话之间反复切换，图被反复卸载。
 *
 * 因此选择判据是：最近一条带 turnId 的事件属于谁。
 * 会话外事件不丢，单独计数报出来（与会话详情页数 orphan 同一取向）。
 */

export interface LiveTraceEvent {
  sessionId: string;
  turnId?: string;
  kind: string;
  at: number;
  data: Record<string, unknown>;
  redacted?: boolean;
}

/**
 * 每个会话留多少条。一轮实测 20~40 条，出行 fan-out 上百；
 * 300 够放下最近两三轮，完整历史在回放页。
 */
const PER_SESSION = 300;
/** 同时跟踪几个会话。超出按最近活动淘汰。 */
const MAX_SESSIONS = 8;

/** `resolveTraceKey` 换算不到真会话时的字面量。见模块注释。 */
export const ORPHAN_SESSION = "unknown";

export interface LiveSession {
  sessionId: string;
  events: LiveTraceEvent[];
  /** 最近一条带 turnId 的事件的到达时刻。选谁来画看的是它。 */
  lastTurnAt: number;
}

export interface LiveState {
  sessions: LiveSession[];
  /** 不属于任何轮次的事件条数（含 `unknown` 桶），计数后报出。 */
  orphanCount: number;
  /** 出现过已脱敏内容——页面据此说明看到的不是原文。 */
  anyRedacted: boolean;
}

export const EMPTY: LiveState = { sessions: [], orphanCount: 0, anyRedacted: false };

/**
 * 并入一批事件。成批而不是逐条：事件是成串到达的
 * （一次 fan-out 几十条），逐条 setState 就是几十次重渲染。
 */
export function ingest(
  state: LiveState,
  batch: readonly LiveTraceEvent[],
  now: number,
): LiveState {
  if (batch.length === 0) return state;

  let orphanCount = state.orphanCount;
  let anyRedacted = state.anyRedacted;
  const byId = new Map(state.sessions.map((s) => [s.sessionId, s]));

  for (const e of batch) {
    if (e.redacted) anyRedacted = true;
    if (!e.turnId || e.sessionId === ORPHAN_SESSION) {
      orphanCount += 1;
      // 会话外事件到此为止：让它进 `sessions` 就等于让兜底桶去抢"最近活动"。
      continue;
    }
    const prev = byId.get(e.sessionId);
    byId.set(e.sessionId, {
      sessionId: e.sessionId,
      events: [...(prev?.events ?? []), e].slice(-PER_SESSION),
      lastTurnAt: now,
    });
  }

  const sessions = [...byId.values()]
    .sort((a, b) => b.lastTurnAt - a.lastTurnAt)
    .slice(0, MAX_SESSIONS);

  return { sessions, orphanCount, anyRedacted };
}

/**
 * 要画哪个会话：指定了就找它（找不到返回 undefined，不退回最近活动），
 * 没指定就是最近有轮次事件的那个。
 *
 * 单独抽出来是因为「选哪个会话」与「取它的哪一轮」是两件事：
 * 回放控制条要的是这个会话的全部轮次，不是最后一轮。
 */
export function sessionOf(state: LiveState, sessionId?: string): LiveSession | undefined {
  return sessionId ? state.sessions.find((x) => x.sessionId === sessionId) : state.sessions[0];
}

export interface LiveTurn {
  sessionId: string;
  turnId: string;
  events: LiveTraceEvent[];
  /** 最近一条事件到现在多久。判"是不是卡住了"用它。 */
  lastAt: number;
}

/**
 * 要画哪一轮：最近活动会话的最后一轮。
 *
 * 只取一轮而不是整个会话：多轮铺在一张图上，各轮分支会同时点亮，
 * 形成一条不存在的路径。
 *
 * `sessionId` 指定要画哪个会话（大屏锁定某个会话时用）；它不在跟踪列表里
 * 就返回 undefined，不退回"最近活动"：调用方需区分
 * "锁定的会话没有实时事件"与"跟随模式没人说话"，两者提示不同。
 */
export function pickTurn(state: LiveState, sessionId?: string): LiveTurn | undefined {
  const s = sessionOf(state, sessionId);
  if (!s || s.events.length === 0) return undefined;
  const turnId = s.events[s.events.length - 1].turnId;
  if (!turnId) return undefined;
  const events = s.events.filter((e) => e.turnId === turnId);
  return {
    sessionId: s.sessionId,
    turnId,
    events,
    lastAt: s.lastTurnAt,
  };
}

/** 会话列表行里与标题有关的那部分（`/console/replay/sessions` 的子集）。 */
export interface TitledSession {
  sessionId: string;
  title: string | null;
}

/**
 * 并入一批「会话 → 标题」。
 *
 * # 大屏自己维护一张标题表
 *
 * 实时轨迹总线只给 `sessionId`（轨迹表按 id 分组，不关联 `sessions` 表），
 * 而 topbar 有标题时要显示标题。标题需另取（`/console/replay/sessions`），
 * 取回后留在页面里，避免跟随模式每换一次会话就重新请求。
 *
 * # `null` 不覆盖已知标题
 *
 * 标题是首轮之后异步补写的：同一个会话在前一次请求里还没有标题，
 * 下一次才有。"有了又变回 null"在业务上不发生，
 * 让 null 覆盖会抹掉刚显示的标题，造成闪烁。
 *
 * 返回值在无变化时是原对象——渲染层据此避免整张图跟着重画。
 */
export function mergeSessionTitles(
  prev: Readonly<Record<string, string>>,
  rows: readonly TitledSession[],
): Record<string, string> {
  let next: Record<string, string> | undefined;
  for (const r of rows) {
    if (!r.title) continue;
    if (prev[r.sessionId] === r.title) continue;
    next ??= { ...prev };
    next[r.sessionId] = r.title;
  }
  return next ?? prev;
}
