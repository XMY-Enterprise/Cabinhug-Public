/**
 * LLM 调用的分跳耗时（FL-44）。
 *
 * # 包在 `ChatStreamer` 这一层
 *
 * 这是唯一同时覆盖两条路径的接缝：ACP 实现（经 pi 子进程）与直连实现
 * （AI SDK / fake）都实现同一个接口。包在这里，耗时口径对两条路径一致，
 * 换掉 pi 不需要重埋。
 *
 * # 首 token 延迟单列
 *
 * 只记总时长，会把"8 秒流式输出完"和"8 秒才开口"画成同一根条，
 * 而两者的优化方向相反：前者要缩短生成，后者要缩短排队/首包。
 * 用户感知的等待主要来自后者。
 *
 * 因此每次调用发两条 span：
 *   - `llm.<agent>.ttft` —— 从发起到第一个非空 chunk
 *   - `llm.<agent>`      —— 整条流的总时长
 *
 * 空 chunk 不算首 token：ACP 侧会先推一个空的 `session/update` 占位，
 * 拿它当首字会把 TTFT 记成 20ms 而用户仍在等待。
 *
 * # 与 `onUsage.durationMs` 并存
 *
 * 那条进的是用量表（按 provider/model 聚合算成本），没有 TTFT，
 * 也不按跳落进轨迹，回放页读不到。两者用途不同，都保留。
 */

import { CancelledError, type SpanStatus } from "../trace";
import { classifyError, OUTPUT_MAX_CHARS, recordAgentOutput, recordSpan } from "../trace/span";
import type { ChatStreamer } from "./index";

/**
 * 这次抛错是不是调用方自己放弃的结果。
 *
 * 三个判据缺一不可，因为两条路径的取消错误类型不同：
 *  - ACP：`connection.ts` 的 onAbort 抛 `CancelledError`；
 *  - 直连：AI SDK 对 `abortSignal` 抛 `AbortError`（DOMException，不是本仓的类）；
 *  - 兜底：只要 hooks 里的 signal 已经 aborted，此后冒出来的任何错都是取消的余波
 *    （掐流的时机不同，浮出来的错误类型也不同）。
 *
 * 分不出取消与失败时，「提交即收工」abort 分支流后成功的调用会被记成 failed。
 */
function isCancellation(err: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  if (err instanceof CancelledError) return true;
  return err instanceof Error && err.name === "AbortError";
}

/** 取消原因（fanout 经 `abort(reason)` 带过来：submitted / timeout / …）。 */
function cancelReason(signal: AbortSignal | undefined): string | undefined {
  return typeof signal?.reason === "string" ? signal.reason : undefined;
}

/**
 * 失败原因。前缀 `err:` 用于区分：取消原因里也有 `timeout`（分支超时掐流），
 * 不加前缀时"被掐"与"失败"在回放里无法区分，而前者是编排层的正常动作，
 * 后者要去查上游。
 */
function failureReason(err: unknown): string {
  return `err:${classifyError(err)}`;
}

/**
 * 给任意 `ChatStreamer` 套上耗时埋点。
 *
 * 原样透传 hooks：`threadId` / `agent` 决定 pi 侧落到哪个 ACP 会话，
 * 漏传不报错，但意图抽取与应答会共用会话，用户会收到一段 `{"goal":…}` JSON。
 */
export function withLlmSpans(inner: ChatStreamer): ChatStreamer {
  return async function* (messages, hooks) {
    const agent = hooks?.agent ?? "unknown";
    const threadId = hooks?.threadId;
    const name = `llm.${agent}`;
    const startedAt = Date.now();
    let firstTokenAt: number | undefined;
    let status: SpanStatus = "ok";
    /*
     * 产出文本同时累积下来，供业务视图显示"这个 Agent 答了什么"。
     * 只累积到入库上限再多一点就停，防止失控的流把整段留在内存里。长度仍按真实 chars 计。
     */
    let output = "";
    let outputChars = 0;
    /** catch 到的错误要在 finally 里归类，所以存进闭包。 */
    let failure: unknown;

    try {
      for await (const chunk of inner(messages, hooks)) {
        if (firstTokenAt === undefined && chunk.length > 0) {
          firstTokenAt = Date.now();
          recordSpan(threadId, `${name}.ttft`, startedAt, firstTokenAt, "ok", { agent });
        }
        outputChars += chunk.length;
        if (output.length <= OUTPUT_MAX_CHARS) output += chunk;
        yield chunk;
      }
    } catch (err) {
      // 取消≠失败：提交即收工 / 分支超时 / 用户打断都会掐流，调用本身没有坏。
      // 记成 failed 会把成功的行程 fan-out 标红（见 isCancellation）。
      status = isCancellation(err, hooks?.signal) ? "cancelled" : "failed";
      failure = err;
      throw err;
    } finally {
      const endedAt = Date.now();
      const detail =
        status === "cancelled" ? cancelReason(hooks?.signal)
        : status === "failed" ? failureReason(failure)
        : undefined;
      // 一个 token 都没出来也要发 ttft，否则"模型全程没开口"在轨迹里是空白，
      // 与"没走这条路"无法区分。
      if (firstTokenAt === undefined) {
        /*
         * 有错误时 detail 带上归类后的原因（`no_token:<原因>`）。
         * 空流（status ok）是裸 `no_token`，它没有错误可归类。
         */
        const ttftDetail =
          failure !== undefined && status !== "cancelled"
            ? `no_token:${classifyError(failure)}`
            : (detail ?? "no_token");
        recordSpan(threadId, `${name}.ttft`, startedAt, endedAt,
          // 开口之前就被取消，记为 cancelled 而不是模型失败。
          status === "cancelled" ? "cancelled" : "failed",
          { agent, detail: ttftDetail });
      }
      recordSpan(threadId, name, startedAt, endedAt, status, {
        agent,
        ...(detail ? { detail } : {}),
      });
      // 产出与 span 并列落，成败取消都发：取消的那条带半截文本，业务视图据 status 说清楚。
      recordAgentOutput(threadId, agent, outputChars > output.length ? output + "…" : output, status);
    }
  };
}
