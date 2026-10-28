/**
 * 垫场话的出口：过输出管线再发。
 *
 * # 旁路同样过安全边界
 *
 * 能出声却不过管线的通道会绕过 §8.3 整层。L0 只吐固定文案，
 * 但 L1（架构 §13-15）可能把用户原话和记忆内容带进来，PII 可能由此外泄。
 *
 * # 入口同步，过管线异步
 *
 * 扇出入口不 `await`，而 `checkOutput` 是异步的：入口同步返回，
 * 过管线在 fire-and-forget 的 promise 里做，完成后再 push。
 * 代价是出声时刻晚一个管线往返（输入侧实测 225~287ms，输出侧同量级），
 * 计入"触发 → 出声 < 500ms"预算；超预算时调整阈值，不摘掉管线。
 */

import type { FillerDraft } from "./templates";

/**
 * 只要 `checkOutput` 这一件事。
 *
 * 不 import `../guard/pipeline` 的具体类型：旁路对安全层的依赖保持最窄。
 */
export interface FillerOutputGuard {
  checkOutput(text: string): Promise<{ allowed: boolean; text: string; reason?: string }>;
}

export interface FillerSpeakDeps {
  /** 未装配时丢弃（见下）。 */
  guard?: FillerOutputGuard;
  /** 真正下发。同步。 */
  push: (text: string, draft: FillerDraft) => void;
  /** 丢弃时的计数出口。 */
  onDropped?: (reason: "guard_denied" | "guard_error" | "no_guard") => void;
}

/**
 * 发一条垫场话。同步返回。
 *
 * 三种丢弃，都不产生任何用户可见行为：
 *
 * 1. `no_guard`：管线未装配。与主链路的 output fail-closed 同向：
 *    不放行未审核的输出，旁路不说话的代价为零。
 * 2. `guard_denied`：审核不通过。直接丢弃，不发 `retract`、不发替换文案：
 *    主内容被拦要撤回是因为用户已经读到了；垫场话还没发出去，用户不知道有过这句话。
 * 3. `guard_error`：管线抛错。同 1。
 */
export function emitFiller(deps: FillerSpeakDeps, draft: FillerDraft): void {
  if (!deps.guard) {
    deps.onDropped?.("no_guard");
    return;
  }
  void deps.guard
    .checkOutput(draft.text)
    .then((verdict) => {
      if (!verdict.allowed) {
        deps.onDropped?.("guard_denied");
        return;
      }
      // 用管线返回的 text：脱敏可能改写过它（L0 的固定文案不会，但 L1 会）
      deps.push(verdict.text, draft);
    })
    .catch(() => {
      deps.onDropped?.("guard_error");
    });
}
