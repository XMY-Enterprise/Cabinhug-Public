/**
 * 同一会话里「带照片的那一轮还在跑」的登记表。
 *
 * # 问题
 *
 * 视觉观察一遍要十几秒。车主发了照片后常会补一句文字（如「帮我看看什么灯亮了」），
 * 这句话是那张照片的说明。若它另起一轮与照片轮在同一条图线程上并发：
 *
 * - 文字轮没有照片，观察节点把 `photoObservation` 清成空，检索词只剩一句白话，检索易超时；
 * - 它可能把手册图示误当成车主发的照片来描述，与照片轮的结论冲突。
 *
 * # 做法：纯文字轮先等带照片的那一轮跑完
 *
 * 等它跑完，文字轮读到的检查点里就有照片轮的消息和它的照片观察；观察节点再把
 * 这份观察沿用下来（`graph/vision.ts` 的继承逻辑），文字轮就知道「什么灯」指的是哪几盏。
 *
 * # 只等「带照片的轮」，且有上限
 *
 * 不把同会话的轮次一律串行化：敏感工具的权限确认是挂起一个 HTTP 请求等用户点头
 * （`guard/http-endpoint.ts`），那一轮在等人时一直算「在跑」，一律串行会让车主的下一句话
 * 无限等待。等待封顶（`PHOTO_TURN_WAIT_MAX_MS`），到点照常开跑，最坏情况等同于不等待。
 */

/** 最多等这么久。带照片那一轮的典型耗时是 20~30 秒（视觉 17 s + 检索 + 表述）。 */
export const PHOTO_TURN_WAIT_MAX_MS = 45_000;

export interface PhotoTurnWait {
  /** 有没有等（false = 当时没有带照片的轮在跑）。 */
  waited: boolean;
  /** 等的是哪一轮。 */
  turnId?: string;
  /** 实际等了多久。 */
  ms: number;
  /** 等到上限还没完——照常开跑，但这一轮读不到那份观察。 */
  timedOut: boolean;
}

interface Entry {
  turnId: string;
  done: Promise<void>;
  resolve: () => void;
}

export class PhotoTurnRegistry {
  private inflight = new Map<string, Entry>();

  constructor(private now: () => number = Date.now) {}

  /**
   * 带照片的轮开始时登记。返回的函数在该轮收口（finally）时调用；重复调用无害。
   * 同一会话连发两张照片时后一轮覆盖前一轮：纯文字追问指的是最近那张。
   */
  begin(sessionId: string, turnId: string): () => void {
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const entry: Entry = { turnId, done, resolve };
    this.inflight.set(sessionId, entry);
    return () => {
      resolve();
      // 只清自己那一条：后一张照片的轮可能已经把这个位置占了。
      if (this.inflight.get(sessionId) === entry) this.inflight.delete(sessionId);
    };
  }

  /** 当前会话有没有带照片的轮在跑。 */
  pending(sessionId: string): string | undefined {
    return this.inflight.get(sessionId)?.turnId;
  }

  /** 纯文字轮开跑前调：有带照片的轮在跑就等它收口，封顶 `maxMs`。 */
  async waitFor(sessionId: string, maxMs = PHOTO_TURN_WAIT_MAX_MS): Promise<PhotoTurnWait> {
    const entry = this.inflight.get(sessionId);
    if (!entry) return { waited: false, ms: 0, timedOut: false };
    const t0 = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      entry.done.then(() => false),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(true), maxMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return { waited: true, turnId: entry.turnId, ms: this.now() - t0, timedOut };
  }
}
