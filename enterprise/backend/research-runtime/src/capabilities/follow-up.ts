/**
 * 追问（C7）的两条硬规则：几轮封顶，以及这段文字能否进 system。
 *
 * # 两个上限不在同一层
 *
 * | 上限 | 值 | 管什么 | 超了怎么样 |
 * |---|---|---|---|
 * | `CHALLENGE_MAX_STEPS` | 8 | 一次挑战里模型能调几次工具 | 判 `inconclusive` |
 * | `FOLLOW_UP_MAX_ROUNDS` | 3 | 同一张卡能被追问几次 | 端点回 400 |
 *
 * 拿步数当轮数时，追问第二次就会报超限：一次挑战常常一步就走完（模型直接出文字、
 * 不调工具），两个数字又都是个位数，难以分辨是哪一个在拦截。
 *
 * # 「这一条是追问产生的」记在 payload 里，不新增 kind
 *
 * `kind` 直接来自 `challengeSchema` 的 enum，加一个取值即改变判定口径。
 * `payload.angle` 同时记录追问的角度。
 *
 * # 追问文本过内容管线的规则筛
 *
 * 它是用户输入，且会进模型的 system 侧，inj-06「系统提示词探测」这类规则
 * 针对的正是这个位置。直接复用 `@cabinhug/guardrails`（已是 `research-runtime`
 * 的依赖），不另写长度与字符集校验。
 *
 * 审核层（模型侧）未注入：`runInputPipeline` 不给 `moderation` 时只跑规则筛，
 * 并在结果里标 `moderationSkipped`。这里如实带出该标记，不当作审核已跑。
 */

import { runInputPipeline } from "@cabinhug/guardrails";

/** 同一张卡最多追问几次。设计稿 §5.4 已定，不是可配置项。 */
export const FOLLOW_UP_MAX_ROUNDS = 3;

export interface AngleVerdict {
  ok: boolean;
  /** 不通过时给调用方的原因，原样取规则筛给的那句。 */
  reason?: string;
  /** 命中的规则 id，写进日志用。 */
  ruleId?: string;
  /** 审核层是否被跳过。为 true 时不能读成"审核通过"。 */
  moderationSkipped: boolean;
}

/**
 * 追问文本准不准用。
 *
 * 空串单独判：规则筛放行空串（既不超长也不命中注入），而没有角度的追问
 * 白耗 token，并在库里留下一条带 `angle: ""` 的记录。
 */
export async function screenAngle(raw: unknown): Promise<AngleVerdict> {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) {
    return { ok: false, reason: "追问要说清追的是什么，空的问不出东西", moderationSkipped: true };
  }

  const v = await runInputPipeline(text);
  return v.allowed
    ? { ok: true, moderationSkipped: v.moderationSkipped === true }
    : {
        ok: false,
        reason: v.reason ?? "这条追问没法处理",
        ...(v.ruleId ? { ruleId: v.ruleId } : {}),
        moderationSkipped: v.stage !== "moderation",
      };
}

/** 这条挑战记录是不是追问产生的。判据只有一条：payload 里有 `angle`。 */
export function isFollowUp(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const angle = (payload as { angle?: unknown }).angle;
  return typeof angle === "string" && angle.trim().length > 0;
}

/**
 * 这张卡被追问过几轮。
 *
 * 一轮追问会写多条记录，所以不能数记录条数：`challengeSchema` 允许一次返回
 * 1–6 条挑战，实测一次追问写 3 条，按条数算时第一次追问就用光三次额度。
 * 单测的假实现每次只写一条，覆盖不到这一点。
 *
 * 一轮的标识是 `payload.runId`（一次点击一个）；没有 runId 的旧记录退回按 `angle` 区分，
 * 同一轮里它们的 angle 必然相同。
 */
export function followUpRounds(
  records: readonly { payload?: unknown }[],
): number {
  const rounds = new Set<string>();
  for (const r of records) {
    if (!isFollowUp(r.payload)) continue;
    const p = r.payload as { runId?: unknown; angle?: string };
    rounds.add(typeof p.runId === "string" && p.runId ? `run:${p.runId}` : `angle:${p.angle!.trim()}`);
  }
  return rounds.size;
}
