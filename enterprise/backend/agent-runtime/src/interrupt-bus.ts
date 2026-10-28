/**
 * 中断出口：把权限门的挂起送进当前这一轮的事件流（§3 HITL 中转）。
 *
 * # 出口
 *
 * 权限门（`guard/http-endpoint.ts`）挂起的是一次工具调用的 HTTP 请求，
 * 它发生在图执行的深处，手上没有本轮的事件流句柄。
 * 网关已把 turn 流里的每一个 `SessionEvent` 原样转发到 SSE，
 * 所以把 `permission` 事件推进这条流即可下行，不需要新通道（§3 不用 WS）。
 * 本模块维护这张表：`threadId → 本轮的 push`。
 *
 * # 按 threadId 登记
 *
 * 权限门拿到的 `sessionId` 来自工具调用上下文，那是图的 thread_id（形如 `sess-xxx#<ts>`）。
 * 按它登记，`onInterrupt` 直接命中，不必再做一次映射。
 *
 * # 未送达要计数
 *
 * 一次挂起如果没人收，用户等不到确认弹窗，工具调用会挂到超时收敛，
 * 表现只是助手不说话。所以未命中要计数并告警。
 */

import type { SessionEvent } from "@cabinhug/shared";

type Push = (event: SessionEvent) => void;

const routes = new Map<string, { push: Push; turnId: string; sessionId: string }>();
let undelivered = 0;

/** 本轮开始时登记出口；返回注销函数（必须在 finally 里调，否则表会漏）。 */
export function registerTurnSink(
  threadId: string,
  turnId: string,
  push: Push,
  /**
   * 真会话 id（不是 threadId）。见 `currentTurnOf`：深处的旁路
   * （权限门、工具观察者）手上只有 threadId，而轨迹必须按真会话 id 落库。
   */
  sessionId: string,
): () => void {
  const entry = { push, turnId, sessionId };
  routes.set(threadId, entry);
  return () => {
    // 只删自己那条：同一个会话可能已经开始下一轮并覆盖了这一条。
    if (routes.get(threadId) === entry) routes.delete(threadId);
  };
}

/**
 * 该会话当前跑到哪一轮。
 *
 * 权限门的拒绝记忆按轮次收敛："这一轮里这个工具已经被否过"。
 * 按入参指纹太窄：模型重试时会换措辞，每次重试都是新指纹、新弹窗；
 * 按会话又太宽：用户稍后重新要求写日历，不该被自动否掉。
 */
export function currentTurnId(threadId: string): string | undefined {
  return routes.get(threadId)?.turnId;
}

/**
 * threadId → 真会话 id + 轮次。
 *
 * ACP 那侧把 threadId 当作 `cabinhugSessionId` 一路传下去
 * （`index.ts` 的 `cabinhugSessionId: hooks?.threadId`），于是权限门拿到的
 * `sessionId` 是 `sess-xxx#<ts>`，而图节点写的是真会话 id `sess-xxx`。
 * 不换算的话，回放页按真会话 id 查不到 `guard` / `interrupt` / `resume`，
 * 会话下拉框里同一次对话也会裂成两条。
 *
 * 本模块仍按 threadId 登记（见文件头），只在需要落轨迹时换算一次。
 */
export function currentTurnOf(
  threadId: string,
): { sessionId: string; turnId: string } | undefined {
  const entry = routes.get(threadId);
  return entry ? { sessionId: entry.sessionId, turnId: entry.turnId } : undefined;
}

/**
 * 二级兜底：从 threadId 的格式反推真会话 id（`sess-xxx#<ts>` → `sess-xxx`）。
 *
 * # `currentTurnOf` 之外的补充
 *
 * 那张表只在本轮进行中有条目，而权限门的裁决可能在轮次结束很久之后才落
 * （例如 `decision=deny reason=等待确认超时 durationMs=600003`）。
 * 此时一级换算落空，事件会回落到 threadId 键，回放页看不到它；
 * 而"确认超时导致动作被拒"正是需要留痕的安全事件。
 *
 * # 格式耦合集中在这里
 *
 * threadId 由 `turn-runner.threadFor` 生成，形如 `${sessionId}#${nowMs}`，
 * 而 sessionId 自身不含 `#`（`sess-<uuid8>-<3>`），按最后一个 `#` 切是可靠的。
 * 改了生成规则，改这里。
 * 认不出格式时返回 undefined，不猜，由调用方按 keyFallback 如实标注。
 */
export function sessionIdFromThread(threadId: string): string | undefined {
  const i = threadId.lastIndexOf("#");
  if (i <= 0) return undefined;
  const head = threadId.slice(0, i);
  // 尾部必须是纯数字时间戳，否则那个 `#` 不是 threadFor 加的。
  return /^\d+$/.test(threadId.slice(i + 1)) ? head : undefined;
}

/**
 * 把事件送进对应会话本轮的流。
 *
 * 返回是否送达，送不出去由调用方告警：否则权限门挂起了而用户什么都看不到。
 */
export function publishToTurn(threadId: string, event: SessionEvent): boolean {
  const entry = routes.get(threadId);
  if (!entry) {
    undelivered += 1;
    return false;
  }
  entry.push(event);
  return true;
}

export function getInterruptBusStats(): { openTurns: number; undelivered: number } {
  return { openTurns: routes.size, undelivered };
}
