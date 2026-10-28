/**
 * 实时轨迹总线：回答"现在流到哪了"。
 *
 * # 与落库并列
 *
 * 轨迹仓储是缓冲 + 定时批量写（在 `TraceSink.write` 里 await 落库
 * 会把数据库延迟加到每一次 token 之间），读库最快也要等一个刷盘周期。
 * 这条总线与落库并列扇出，互不阻塞。
 *
 * # `node_start`
 *
 * `node.*` 的 span 在节点结束时才落，长节点运行期间落库侧没有任何记录。
 * 因此这里额外收一条"进了哪个节点"，只在实时通道存在：
 * 不进轨迹表、不进 `TraceKind`，回放页的分跳耗时不会多出零长跳。
 *
 * # 不订阅时几乎不做事
 *
 * 没有订阅者时只往环形缓冲里塞一条，让新订阅者能立刻看到最近发生的事。
 *
 * # 采集永不阻塞主链路
 *
 * 与轨迹、审计同一取向（F-10-12）：`publish` 整个吞异常，且不调用业务代码。
 */

import { resolveTraceKey } from "./span";

export interface LiveEvent {
  sessionId: string;
  turnId?: string;
  /** 轨迹的 `TraceKind`，外加实时专有的 `node_start`。 */
  kind: string;
  at: number;
  data: Record<string, unknown>;
}

export type LiveSubscriber = (e: LiveEvent) => void;

/**
 * 新订阅者能看到的回溯条数。
 *
 * 按一轮对话的量级定（一轮 20~40 条，出行 fan-out 上百）。
 * 太小则打开大屏时看不到上一轮；完整历史在轨迹表里，这里不做全量内存副本。
 */
const BACKLOG = 200;

class LiveTraceBus {
  private backlog: LiveEvent[] = [];
  private subscribers = new Set<LiveSubscriber>();

  publish(e: LiveEvent): void {
    try {
      this.backlog.push(e);
      if (this.backlog.length > BACKLOG) this.backlog.shift();
      for (const notify of this.subscribers) {
        try {
          notify(e);
        } catch {
          // 一个订阅者炸了不该拖垮别的订阅者，更不该拖垮主链路。
        }
      }
    } catch {
      /* 吞掉：埋点坏了不该让对话坏 */
    }
  }

  /** 订阅：先补最近 `BACKLOG` 条，再接实时流。返回退订函数。 */
  subscribe(notify: LiveSubscriber): () => void {
    for (const e of this.backlog) {
      try {
        notify(e);
      } catch {
        /* 同上 */
      }
    }
    this.subscribers.add(notify);
    return () => {
      this.subscribers.delete(notify);
    };
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** 单测清场用。 */
  reset(): void {
    this.backlog = [];
    this.subscribers.clear();
  }
}

export const liveTrace = new LiveTraceBus();

/**
 * "进了哪个节点"。由 `withNodeSpan` 在节点体开始前调用。
 *
 * 手上只有 threadId（图节点的 `configurable.thread_id`），
 * 换算沿用 `resolveTraceKey` 的两级，与 span 落库一致，保证两条通道挂到同一会话。
 */
export function noteNodeStart(threadId: string | undefined, node: string): void {
  const key = resolveTraceKey(threadId);
  liveTrace.publish({
    sessionId: key.sessionId,
    turnId: key.turnId,
    kind: "node_start",
    at: Date.now(),
    data: { name: `node.${node}` },
  });
}
