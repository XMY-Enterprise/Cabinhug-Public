/**
 * 启动时的会话处置（纯函数）。
 *
 * # 只有两种结果
 *
 * `resume`（接着用上次那段）或 `none`（手上没有会话），不在启动时建会话。
 *
 * 服务端的会话过期是懒关闭（只在下一次访问时才落 `closed_at`），启动即建会留下
 * 永远显示为活着的零消息会话。建会话交给发送侧，建完立刻就发。
 *
 * # 与车机的判定不同
 *
 * 车机多一道"太旧就不复用"（`canResume`）：车机是共用设备，上一段可能是别人留下的。
 * 手机是个人设备，回源得到就接着用。两端判定不同，各存一份；合并会引入一个
 * 容易设错的配置参数。
 */

export type BootstrapPlan =
  | { kind: "resume"; sessionId: string }
  /** `reason` 只进日志，不影响行为——分开是为了排障看得出是哪一种。 */
  | { kind: "none"; reason: "no-stored" | "unreachable" };

export function planBootstrap(args: {
  /** localStorage 里的 sid；null = 没存过。 */
  stored: string | null;
  /** 服务端历史；`null` = 回源失败（会话不存在 / 网关不在）。 */
  history: unknown[] | null;
}): BootstrapPlan {
  if (!args.stored) return { kind: "none", reason: "no-stored" };
  if (args.history === null) return { kind: "none", reason: "unreachable" };
  return { kind: "resume", sessionId: args.stored };
}
