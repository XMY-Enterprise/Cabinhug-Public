/**
 * 静默检测。
 *
 * # 事件驱动 + 节拍
 *
 * 内容来自事件，但 span 在完成时才落：检索跑的那几秒轨迹侧没有事件，
 * 纯事件驱动会在最长的等待里无声。所以由节拍重新判定，
 * 判定逻辑（本文件）是纯函数，可逐条断言。
 *
 * # 不管何时收口
 *
 * 不设条数与总时长上限：turn 会不会结束是会话超时的职责，
 * 旁路的生命周期绑在 turn 上（见 `budget.ts` 的模块注释）。
 */

import type { SidecarConfig } from "./budget";

export interface SilenceState {
  /** 最后一次面向用户的内容的时刻（只有 delta / retract 会推进它）。 */
  lastUserFacingAt: number;
  /**
   * 上一句垫场估算念完的时刻；没说过为 0。
   *
   * 是"念完"不是"发出"：按发出算时，长句还在念就会发出下一句，
   * 端上 `speak_filler` 会 `stop()` 掉正在播的那句，用户只听到半句。
   */
  speakingUntil: number;
  /** 静音原因集合（HITL / 告警）。非空即闭嘴。 */
  mutedBy: ReadonlySet<string>;
  closed: boolean;
}

/** 不说话的原因。分因计数是调参的依据。 */
export type SuppressReason = "closed" | "muted" | "silence" | "gap";

/**
 * 该不该开口。纯函数，判据可逐条断言。
 *
 * 返回 `undefined` 表示可以说；否则是被挡住的原因。
 */
export function suppressReason(
  state: SilenceState,
  now: number,
  cfg: SidecarConfig,
): SuppressReason | undefined {
  if (state.closed) return "closed";

  /*
   * 静音优先于静默判定。
   *
   * HITL 挂起期间的"没声音"是在等用户，不是在等系统，两者在事件流上无法区分；
   * 此时插话会盖掉确认问句这道用户侧闸门。所以信号取自真实 `permission` 事件。
   */
  if (state.mutedBy.size > 0) return "muted";

  if (now - state.lastUserFacingAt < cfg.silenceMs) return "silence";

  // 上一句还在念，或者念完还没到间隔，两种都归 gap。
  if (state.speakingUntil > 0 && now - state.speakingUntil < cfg.minGapMs) return "gap";

  return undefined;
}

export function shouldSpeak(state: SilenceState, now: number, cfg: SidecarConfig): boolean {
  return suppressReason(state, now, cfg) === undefined;
}
