/**
 * 启动时那个会话怎么处置。纯函数，便于单测。
 *
 * # 只有两种结果
 *
 * `resume`（接着用上次那段）或 `none`（手上没有会话），没有 `create`。
 *
 * 开机即建会在启动后没说话、或再次重启时留下永远零消息的会话：
 * 服务端的过期是懒关闭（`checkSessionUsable` 只在下一次访问那个会话时才落
 * `closed_at`），没人再碰它就一直显示成活着的会话。
 *
 * 建会话统一交给发送侧的 `ensureUsableSession`，它建完立刻就发消息，
 * 不留下零消息的会话。车机还有一条正路：上车声明产出的 sid。
 *
 * # 独立于 App.tsx
 *
 * `App.tsx` 引了 css，`node:test` 加载不了它；拆出来这条判定才能单测。
 * 与 `session-lifecycle.ts`（在 @cabinhug/ui）同一取向。
 */

/*
 * 走子路径而不是包入口：本文件被 `node:test` 直接加载（`test/bootstrap-session.test.ts`），
 * 而 `@cabinhug/ui` 的入口会带出 assistant-avatar 的 .png 资产，node 加载不了。
 * `session-lifecycle` 是纯函数，单独露一个出口给这类不经 Vite 的数据模块。
 */
import { canResume } from "@cabinhug/ui/session-lifecycle";

/** 只要 `ts` 一个字段：判定用的是"最后一条消息有多旧"。 */
export interface HistoryLike {
  ts: number;
}

export type BootstrapPlan =
  | { kind: "resume"; sessionId: string }
  /**
   * 手上没有会话。`reason` 只进日志，不影响行为：三种成因的处置完全一样，
   * 分开是为了排障时能看出"是没存过"还是"存了但取不到"。
   */
  | { kind: "none"; reason: "no-stored" | "unreachable" | "stale" };

export function planBootstrap(args: {
  /** localStorage 里的 sid；null = 没存过。 */
  stored: string | null;
  /** 与 sid 成对保存的本地创建时间。 */
  createdAt?: number;
  /** 服务端历史；`null` = 回源失败（会话不存在 / 网关不在）。 */
  history: HistoryLike[] | null;
  now: number;
}): BootstrapPlan {
  if (!args.stored) return { kind: "none", reason: "no-stored" };
  if (args.history === null) return { kind: "none", reason: "unreachable" };
  return canResume({ messages: args.history, createdAt: args.createdAt, now: args.now })
    ? { kind: "resume", sessionId: args.stored }
    : { kind: "none", reason: "stale" };
}
