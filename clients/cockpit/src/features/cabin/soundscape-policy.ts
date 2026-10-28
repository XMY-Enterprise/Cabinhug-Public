/**
 * 音景的三个闸。
 *
 * # 静音与降级是两件事，不合并成一个 bool
 *
 * 「暖暖在说话」→ 全静：播报是功能，音景是装饰，装饰不盖住功能。
 * 「车内音乐在放」→ 降级：音乐与音景可以共存，只是不能吵。
 * 两条理由不同，合并成一个 bool 会让改其中一条误伤另一条。
 *
 * # 音景只降低自己，不去压音乐
 *
 * 让路逻辑只有一处（见 `tts/ducking.rs` 文件头），两处各写一遍会对不齐，表现为
 * 音乐一直被压着不恢复。所以本文件没有"压低音乐"的出口，`music::set_ducked` 的
 * 调用方只有 `tts::ducking::set_tts_playing`。这里只读 `music_is_audible`，降的是音景自己。
 */

import type { AssistantState } from "@cabinhug/shared";
import type { CueName } from "@cabinhug/ui";

export type SoundscapePolicy = "full" | "minimal" | "silent";

export interface PolicyInput {
  /** 界面音效开关（用户设置）。 */
  enabled: boolean;
  /** 助手此刻的五态；`speaking` 即播报中。`null`/缺省 = 不知道，按没在说话算。 */
  assistantState?: AssistantState | null;
  /** 车内音乐此刻在不在出声（`invoke("music_is_audible")` 的结果）。 */
  musicAudible: boolean;
}

/**
 * 降级形态下保留哪些 cue。
 *
 * 只留一头一尾：按下去有反馈、走的时候有收束。中间四个（铺底、就绪音、
 * 上行三音、关门闷响）属于氛围，音乐在放时让给音乐。
 */
export const MINIMAL_CUES: readonly CueName[] = ["jingle", "resolve"];

/**
 * 这一轮该用哪种形态。
 *
 * 判定顺序本身就是语义：
 *
 * 1. 开关关着 ⇒ 全静。它是用户的明确意愿，压过一切。
 * 2. 暖暖在说话 ⇒ 全静。优先于音乐那一条：降级形态保留的两个 earcon 仍会盖在播报上。
 * 3. 音乐在放 ⇒ 降级。
 * 4. 否则完整形态。
 */
export function decidePolicy({ enabled, assistantState, musicAudible }: PolicyInput): SoundscapePolicy {
  if (!enabled) return "silent";
  if (assistantState === "speaking") return "silent";
  if (musicAudible) return "minimal";
  return "full";
}

/** 这一帧跨过的 cue，按形态过一遍闸。顺序保持不变。 */
export function cuesForPolicy(policy: SoundscapePolicy, cues: readonly CueName[]): CueName[] {
  if (policy === "silent") return [];
  if (policy === "minimal") return cues.filter((c) => MINIMAL_CUES.includes(c));
  return [...cues];
}
