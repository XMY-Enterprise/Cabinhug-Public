/**
 * 会话生命周期的判据（两端共用）。
 *
 * # 纯函数，只有一份
 *
 * 判据写成纯函数才能单测，需要覆盖的是边界方向、"进行中不许切"与"形象判据是派生的"。
 * 服务端只有一条判据（`checkSessionUsable`，`IDLE_MS` 严格大于）；两端共用这里的一份，
 * 对"还能不能接着聊"给出同一答案。
 *
 * # 端上这份计时器只管形象，不管正确性
 *
 * 服务端才是权威（过期的会话 `POST /messages` 直接 409）。
 * 这里算错最多让暖暖的形象晚切一会儿，不会让车主发出去的话丢掉。
 */

/** 与服务端默认值一致（`DEFAULT_SESSION_IDLE_MIN`）。 */
export const IDLE_MS = 30 * 60 * 1000;

export type AssistantMode = "rest" | "work";

/**
 * 暖暖此刻在休息还是在办公。
 *
 * **派生值，不是状态位**（设计定稿 D2）：判据就是"本会话有没有说过话"。
 * 另存一位会与会话真实状态分岔，出现屏幕上暖暖在办公、服务端会话已关闭的不一致。
 */
export function assistantMode(args: {
  /** 本会话的消息条数。 */
  messageCount: number;
  /** 最后一次交互的时刻；没交互过给 undefined。 */
  lastInteractionAt?: number;
  now: number;
  idleMs?: number;
  /**
   * 唤醒窗口的截止时刻。语音唤醒把她叫起来时消息还没落库，
   * 判据扩为「消息数 > 0 **或** 唤醒态活跃」。仍是派生值：来源是 Rust
   * 唤醒事件带出的时间戳，窗口一过自然消散，**不新增可持久分岔的状态位**。
   */
  wakeUntil?: number;
}): AssistantMode {
  if (args.wakeUntil !== undefined && args.now < args.wakeUntil) return "work";
  if (args.messageCount <= 0) return "rest";
  const last = args.lastInteractionAt;
  if (last === undefined) return "work";
  // **严格大于**，与服务端同一个方向：正好卡在阈值上还算在办公。
  return args.now - last > (args.idleMs ?? IDLE_MS) ? "rest" : "work";
}

/**
 * 到点了能不能收会话。
 *
 * **一轮对话进行中不许收**：正在等应答、或权限门弹窗挂着时，
 * 收掉会话会让未确认的动作连同会话一起消失。
 * 这条优先于"准时"，晚收几分钟没有代价。
 */
export function canRetire(args: {
  lastInteractionAt?: number;
  now: number;
  /** 正在等应答（有流式气泡）。 */
  streaming: boolean;
  /** 权限门弹窗挂着。 */
  awaitingPermission: boolean;
  idleMs?: number;
}): boolean {
  if (args.streaming || args.awaitingPermission) return false;
  if (args.lastInteractionAt === undefined) return false;
  return args.now - args.lastInteractionAt > (args.idleMs ?? IDLE_MS);
}

/**
 * bootstrap 时那个存下来的会话还能不能接着用。
 *
 * 判据是**历史里最后一条消息的时刻**：`HistoryPage` 已包含它，不需要改 Rust 契约。
 *
 * 空历史只有在调用方能证明它是近期新建的会话时才可复用。旧版本没有保存创建
 * 时间，或本地元数据已经丢失时，宁可新建：空历史既可能是刚建的会话，也可能是
 * 已经被服务端懒关闭、但历史本来就为空的旧会话。
 */
export function canResume(args: {
  messages: ReadonlyArray<{ ts: number }>;
  now: number;
  idleMs?: number;
  /** 空历史时使用；有消息时仍以最后一条消息为准。 */
  createdAt?: number;
}): boolean {
  const last = args.messages[args.messages.length - 1];
  if (!last) {
    return (
      args.createdAt !== undefined &&
      Number.isFinite(args.createdAt) &&
      args.now - args.createdAt <= (args.idleMs ?? IDLE_MS)
    );
  }
  return args.now - last.ts <= (args.idleMs ?? IDLE_MS);
}
