/**
 * 旁路自己的闲聊记忆。
 *
 * # 跨轮且独立于主会话
 *
 * `registry` 按 `turnId` 存，`closePair` 在 turn 结束时删掉整个 `PairSession`，
 * `said` / `place` 随之消失。没有跨轮记忆时，同一次驾驶里连问几个与同一地点有关的问题，
 * 旁路会重复同一段闲话，而每一轮单看都正常。
 *
 * 它记的是自己说过什么：主会话的历史里没有垫场话（有不留痕断言守护），
 * 所以这份记忆只能自己维护。
 *
 * # 进程内的 Map，不是 Mem0
 *
 * `check:arch` 的 `sidecar-isolation` 禁止 `sidecar/` import `@cabinhug/memory`
 * 与 `@cabinhug/db`：能力边界靠依赖守。给旁路接跨会话记忆需要单独设计
 * （谁写、写哪个 category、衰减怎么算、PII 怎么办），不在这里破边界。
 *
 * 这一层是"这一趟车的记忆"，不是"这个人的记忆"。
 * 进程重启即失忆，与旁路"失败不影响主链路"的定位一致。
 *
 * # 主要风险是内存泄漏
 *
 * 会话结束没有通知，所以两道闸都要有：按条数封顶（`MAX_SAID`）、
 * 按空闲时间清（`IDLE_MS`），且清扫挂在写入路径上，不另起定时器。
 */

/** 每个会话最多记几句。够避免重复，又不至于把上下文喂爆。 */
const MAX_SAID = 24;

/** 一个会话多久没动就忘掉。比 ①Working 的 24h 短得多：闲聊没有那么长的价值。 */
const IDLE_MS = 30 * 60 * 1000;

/** 同时记多少个会话。超了先扔最久没动的。 */
const MAX_SESSIONS = 200;

interface ChatMemo {
  /** 这一趟里说过的闲话，按顺序。 */
  said: string[];
  /** 聊过哪些地方。用来判断"这个地方是不是刚聊过"。 */
  places: string[];
  /** 起过几次头。开场白按它轮换，所以同一趟车里每轮的开场都不一样。 */
  turns: number;
  lastAt: number;
}

const memos = new Map<string, ChatMemo>();

function sweep(now: number): void {
  for (const [id, m] of memos) {
    if (now - m.lastAt > IDLE_MS) memos.delete(id);
  }
  while (memos.size > MAX_SESSIONS) {
    let oldest: [string, number] | undefined;
    for (const [id, m] of memos) {
      if (!oldest || m.lastAt < oldest[1]) oldest = [id, m.lastAt];
    }
    if (!oldest) break;
    memos.delete(oldest[0]);
  }
}

function memoOf(sessionId: string, now: number): ChatMemo {
  let m = memos.get(sessionId);
  if (!m) {
    m = { said: [], places: [], turns: 0, lastAt: now };
    memos.set(sessionId, m);
    sweep(now);
  }
  m.lastAt = now;
  return m;
}

/**
 * 本轮开始。返回这一趟车里的第几轮（0 起），开场白按它轮换。
 *
 * 不清空 `said`：跨轮保留是这一层的用途。
 */
export function beginChatTurn(sessionId: string, now: number): number {
  const m = memoOf(sessionId, now);
  const n = m.turns;
  m.turns += 1;
  return n;
}

/** 记一句说过的话。 */
export function rememberSaid(sessionId: string, text: string, now: number): void {
  const m = memoOf(sessionId, now);
  m.said.push(text);
  while (m.said.length > MAX_SAID) m.said.shift();
}

/** 记一个聊过的地方。 */
export function rememberPlace(sessionId: string, place: string, now: number): void {
  const m = memoOf(sessionId, now);
  if (!m.places.includes(place)) m.places.push(place);
  while (m.places.length > 8) m.places.shift();
}

/** 这一趟车里说过的话（含更早的轮次）。 */
export function recallSaid(sessionId: string): readonly string[] {
  return memos.get(sessionId)?.said ?? [];
}

/** 这个地方在这一趟里是不是已经聊过了。 */
export function placeSeen(sessionId: string, place: string): boolean {
  return memos.get(sessionId)?.places.includes(place) ?? false;
}

/** 仅供测试与指标：泄漏检测靠它。 */
export function chatMemorySize(): number {
  return memos.size;
}

export function resetChatMemory(): void {
  memos.clear();
}
