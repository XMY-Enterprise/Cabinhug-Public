/**
 * 账号级事件总线（ACR-031）。
 *
 * 与 `SessionBus` 同构但更小：没有缓冲窗口、不取事件号、不支持 `Last-Event-ID`。
 *
 * # 不做续传
 *
 * 本通道下发的事件语义只有「重拉一次会话列表」。它不携带内容，补发过期的刷新
 * 信号与刚到的作用相同；端上重连时本来就要整拉一次（连上即收到一条
 * `reason: "connected"`）。加窗口只会多一份要维护的状态。
 *
 * 因此不复用 `SessionBus`：那边的 `eventId` 与 `sessionId` 是续传窗口的基础，
 * 这里都不需要，共用一个类会让两种语义混在同一份 `buffer` 逻辑里。
 *
 * # 没人听就什么都不做
 *
 * `publish` 在无订阅者时直接返回，连封套都不构造。发射点铺在网关的热路径上
 * （每条消息落库一次），而绝大多数时候没有端连着这条通道。
 */

import type { UserEvent, UserEventEnvelope } from "@cabinhug/shared";

export type UserSubscriber = (envelope: UserEventEnvelope) => void;

export class UserBus {
  private users = new Map<string, Set<UserSubscriber>>();

  /** 广播给这个账号此刻连着的所有端。无订阅者时是一次 Map 查询。 */
  publish(userId: string, event: UserEvent): void {
    const subscribers = this.users.get(userId);
    if (!subscribers || subscribers.size === 0) return;
    const envelope: UserEventEnvelope = { ts: Date.now(), event };
    for (const notify of subscribers) notify(envelope);
  }

  /** 订阅，返回退订函数。 */
  subscribe(userId: string, notify: UserSubscriber): () => void {
    let subscribers = this.users.get(userId);
    if (!subscribers) {
      subscribers = new Set();
      this.users.set(userId, subscribers);
    }
    subscribers.add(notify);
    return () => {
      subscribers.delete(notify);
      /*
       * 空集合要连键一起删。
       *
       * `SessionBus` 把空的会话日志留在表里无妨：会话数有界且进程重启即清。
       * 这张表的键是用户：不删的话，每个连过一次的账号都会留下一个空 Set，
       * 随注册用户数单调增长。
       */
      if (subscribers.size === 0) this.users.delete(userId);
    };
  }

  /** 此刻这个账号有几条连接。测试与排障用（回滚判据里要看它恒为 0）。 */
  subscriberCount(userId: string): number {
    return this.users.get(userId)?.size ?? 0;
  }
}
