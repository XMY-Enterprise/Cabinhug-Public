/**
 * `map_route` 休息点候选的按轮白名单暂存。
 *
 * 形态与 `search-results.ts` 相同：①Working 层、进程内 Map、按 (sessionId, turnId) 键、轮结束即弃、不落库。
 * 写入端在 `enterprise/backend/shared/tools/src/map-route.ts`（经 `setRestStopCandidateRecorder` 注入，装配在 `index.ts`），
 * 读取端是 `subgraphs/nav-plan.ts` 的 merge：模型提交的每个途经点都要在这里按名字+坐标全等对上，
 * 对不上的丢：ADR-008「命中当零信息」在导航上的推论。
 *
 * 同时记 `summary`（里程/时长/过路费）：方案卡要显示它们，而它们只在 `map_route` 的返回里，
 * 记在这里模型就不需要抄数字（红线：数字由代码取，不让 LLM 抄）。
 */

import type { RestStop, RouteSummary } from "@cabinhug/tools";

interface TurnCandidates {
  stops: Map<string, RestStop>;
  summary?: RouteSummary;
}

const store = new Map<string, TurnCandidates>();

function key(sessionId: string, turnId: string): string {
  return `${sessionId}#${turnId}`;
}

function stopKey(s: { name: string; lat: number; lon: number }): string {
  return `${s.name}|${s.lat}|${s.lon}`;
}

export function recordRestStopCandidates(
  ctx: { sessionId?: string; turnId?: string; agent?: string },
  stops: readonly RestStop[],
  summary?: RouteSummary,
): void {
  if (!ctx.sessionId || !ctx.turnId) return;
  const k = key(ctx.sessionId, ctx.turnId);
  let t = store.get(k);
  if (!t) {
    t = { stops: new Map() };
    store.set(k, t);
  }
  for (const s of stops) {
    const sk = stopKey(s);
    if (!t.stops.has(sk)) t.stops.set(sk, s);
  }
  // 同一轮多次算路时取最后一次的汇总：模型按编排层给的策略只该算一次，
  // 算了两次时后一次更接近它提交的那条路。
  if (summary) t.summary = summary;
}

export function peekRestStopCandidates(
  sessionId: string,
  turnId: string,
): { stops: RestStop[]; summary?: RouteSummary } {
  const t = store.get(key(sessionId, turnId));
  return { stops: [...(t?.stops.values() ?? [])], ...(t?.summary ? { summary: t.summary } : {}) };
}

export function sweepRestStopCandidates(sessionId: string, turnId: string): void {
  store.delete(key(sessionId, turnId));
}
