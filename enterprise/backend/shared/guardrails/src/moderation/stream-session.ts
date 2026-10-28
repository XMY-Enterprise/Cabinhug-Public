/**
 * 输出侧的流式内容审核会话（FL-26 F-26-06）。
 *
 * # 与流式脱敏的分工：脱敏边流边改，审核只能撤回
 *
 * 脱敏（`stream-redact.ts`）是局部替换，扣住尾巴即可边流边做。
 * 审核判"拦"时前面的 token 已推到端上，SSE 单向下行无法收回字节，
 * 只能撤回（`SessionUpdate::Retract`）。
 *
 * 撤回时用户已读到内容，因此审核要尽早判，而不是等 turn_end。
 *
 * # 按累计字数分片送，同一 sessionId
 *
 * 阿里云的 `sessionId` 让审核引擎在服务端拼接切片后再判（doc 表 1）。
 * 每积累 `sliceChars` 送一片，判定针对到目前为止的全文，跨片表述也能识别。
 *
 * 送得越勤撤得越早，但调用次数越多（该接口收费，QPS 上限 50）。
 * 默认 120 字约合两三句话，即撤回前用户最多读到这么多。
 *
 * # 输入侧不用这条
 *
 * 输入是一次性的完整文本，直接 `check()` 即可。本模块只服务输出侧。
 */

import type { ContentGuard, GuardVerdict } from "./content-guard";

/** 默认送审节奏：每累计这么多字符送一片。 */
export const DEFAULT_SLICE_CHARS = 120;

export interface ModerationSession {
  /**
   * 推入新生成的文本。累计够一片时才真正送审。
   *
   * 返回 `undefined` 表示这次没送审（还没攒够），不表示安全。
   * 为避免把 undefined 当成通过，它不返回布尔。
   */
  push(text: string): Promise<GuardVerdict | undefined>;
  /**
   * 收尾：等齐所有在途送审，再把剩下的送审并标记 done。
   *
   * `push` 不阻塞流，`turn_end` 可能早于某次裁决；若该裁决判"拦"，
   * 撤回会发在 turn_end 之后，被已收口的端上丢弃。因此必须等齐在途送审。
   *
   * 不调它，最后一段不会被审核。
   */
  finish(): Promise<GuardVerdict | undefined>;
  /** 累计已送审的字符数。诊断用。 */
  submitted(): number;
}

export interface ModerationSessionOptions {
  sliceChars?: number;
  /**
   * 审核失败（网络/超时/配额）时的处理。
   *
   * 默认 `throw`，由上层按 output fail 模式决定（§8.2 默认 fail-closed）。
   * 不在这里默默放行，以便调用方区分"审核失败"与"审核通过"。
   */
  onError?: "throw" | "skip";
}

/**
 * 开一个输出侧审核会话。一轮一个，复用会把上一轮的文本拼进这一轮。
 *
 * `guard` 传 undefined 时整个会话是 no-op（审核层未接入），
 * 与 `runOutputPipeline` 的 `moderationSkipped` 同一语义：不假装审过。
 */
export function createModerationSession(
  guard: ContentGuard | undefined,
  sessionKey: string,
  opts: ModerationSessionOptions = {},
): ModerationSession {
  const sliceChars = Math.max(1, opts.sliceChars ?? DEFAULT_SLICE_CHARS);
  const onError = opts.onError ?? "throw";
  let pending = "";
  let sent = 0;
  /** 在途送审。`finish` 要等齐它们，否则裁决会晚于 turn_end 到达。 */
  const inflight = new Set<Promise<GuardVerdict | undefined>>();
  /**
   * 已发生的送审失败。
   *
   * 中途某一片送审抛错时，调用方通常已 catch（一次审核失败不能中断整条流），
   * 且 `inflight` 已清空。不记录的话 `finish()` 会正常返回，
   * output fail-closed 失效。
   */
  const failures: unknown[] = [];

  const submit = async (text: string, done: boolean): Promise<GuardVerdict | undefined> => {
    if (!guard || text === "") return undefined;
    sent += text.length;
    try {
      // 整轮共用 sessionKey：判定针对"到目前为止的全文"，跨片表述不漏
      return await guard.check(text, "output", { sessionKey, done });
    } catch (err) {
      failures.push(err);
      if (onError === "skip") return undefined;
      throw err;
    }
  };

  return {
    async push(text) {
      pending += text;
      if (pending.length < sliceChars) return undefined;
      const slice = pending;
      pending = "";
      const p = submit(slice, false);
      inflight.add(p);
      try {
        return await p;
      } finally {
        inflight.delete(p);
      }
    },

    async finish() {
      // 先等齐在途：其中若有判"拦"的，必须在 turn_end 前处理
      await Promise.allSettled([...inflight]);

      const rest = pending;
      pending = "";
      let last: GuardVerdict | undefined;
      try {
        last = await submit(rest, true);
      } catch {
        /* 已记进 failures，下面统一抛 */
      }

      /*
       * 本轮任何一片送审失败过，就在这里抛出。
       *
       * output fail-closed 依赖调用方能区分"审核失败"与"审核通过"，因此不吞掉。
       * 如何处置由上层按 fail 模式决定（撤回 / 放行）。
       */
      if (failures.length > 0 && onError === "throw") {
        throw failures[0];
      }
      return last;
    },

    submitted() {
      return sent;
    },
  };
}
