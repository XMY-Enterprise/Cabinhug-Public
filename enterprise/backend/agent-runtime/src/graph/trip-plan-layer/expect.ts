/**
 * tour 这条腿该交回哪几天——骨架轮的提交期望。
 *
 * 有骨架时 tour 只补字段（estStart / estEnd / rainBackup / lodging），骨架几天就该交几天。
 * 少交的天只能靠 `mergeItinerary` 的骨架守卫接回，点都对但整天没有时段。
 *
 * 少交是低概率的随机退化，提示词无法根治，因此在提交时拦截：暂存区（`branch-submissions.ts`）
 * 按这份期望拒收残缺提交，原因原样回到模型手里，它在同一个会话里重交（约一轮往返）。
 *
 * 判据只有一条——天号覆盖。时段齐不齐、名字对不对不在这里判：
 * 前者在真实提交中未出现，后者由骨架守卫负责；每多一条判据就多一种把好提交退回去的可能。
 */

import type { SubmissionExpectation } from "../../branch-submissions";
import type { TripSkeleton } from "./types";

/** 同一跳最多退回几次。一次退回 ≈ 一轮模型往返；两次还交不齐就照收，交给骨架守卫兜。 */
export const TOUR_DAYS_MAX_REJECTS = 2;

/** 与 `mergeItinerary` 同一口径取天号：`day` 没给就按数组下标 + 1。两处不一致的话，这里放行的会在那边被判缺天。 */
function submittedDays(payload: unknown): number[] | undefined {
  const days = (payload as { days?: unknown } | null | undefined)?.days;
  if (!Array.isArray(days)) return undefined;
  return days.map((d, i) => {
    const n = (d as { day?: unknown } | null | undefined)?.day;
    return typeof n === "number" && Number.isFinite(n) ? n : i + 1;
  });
}

export function tourDaysExpectation(skeleton: TripSkeleton): SubmissionExpectation {
  const want = skeleton.days.map((d) => d.day).sort((a, b) => a - b);
  return {
    maxRejects: TOUR_DAYS_MAX_REJECTS,
    check(tool, payload) {
      if (tool !== "submit_tour_days") return undefined;
      const got = submittedDays(payload);
      // 连 days 数组都没有：那是形状问题，zod 那一层的事，这里不重复判。
      if (!got) return undefined;
      const have = new Set(got);
      const missing = want.filter((d) => !have.has(d));
      if (missing.length === 0) return undefined;
      const handed = want.filter((d) => have.has(d));
      return [
        `这次的逐天骨架是 ${want.length} 天（第 ${want.join("、")} 天），`,
        handed.length > 0 ? `你只交了第 ${handed.join("、")} 天，` : "你一天都没交，",
        `缺第 ${missing.join("、")} 天，这份提交没有被收下。`,
        `请**再调一次** \`submit_tour_days\`，一次交齐全部 ${want.length} 天——`,
        "已经补好的那几天原样带上，不要分天提交。",
      ].join("");
    },
  };
}
