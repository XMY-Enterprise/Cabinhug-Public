/**
 * HITL resume 结果 → 弹层处置（F-04-08）。
 *
 * 纯函数，供 `app/index.tsx` 的 `decidePermission` 调用，便于单测：
 * 三种结果里有两种不收弹层。
 *
 * # `!accepted` 与抛错都不收弹层
 *
 * 服务端进程在确认挂起期间重启时，挂起随进程消失。此时若照常收起，车主看到
 * "点了确认、窗关了"会以为已生效，而实际什么都没发生。resume 没被接住时，
 * 弹层不能表现得像成功。
 */

export type ResumeOutcome =
  /** 服务端接住了：`POST /v1/session/:id/resume` 返回 `resumed:true`。 */
  | { kind: "accepted" }
  /** 请求到了但服务端已不在等这条确认（超时 / 重启）：`resumed:false`。 */
  | { kind: "not_waiting" }
  /** 请求根本没送达（网络 / 服务异常）。 */
  | { kind: "failed" };

export interface ResumeDisposition {
  /** true = 弹层收起、动作已被服务端接走；false = 弹层留着，改成告知态。 */
  close: boolean;
  /** 告知文案；`close` 为 true 时恒为 undefined。 */
  notice?: string;
}

export const NOTICE_NOT_WAITING =
  "这次确认没有生效——服务端已经不在等这条确认了（多半是超时或服务重启）。动作没有执行，请再说一次。";
export const NOTICE_FAILED = "确认没能送达（网络或服务异常）。动作没有执行，请稍后再说一次。";

export function resumeDisposition(outcome: ResumeOutcome): ResumeDisposition {
  switch (outcome.kind) {
    case "accepted":
      return { close: true };
    case "not_waiting":
      return { close: false, notice: NOTICE_NOT_WAITING };
    case "failed":
      return { close: false, notice: NOTICE_FAILED };
  }
}
