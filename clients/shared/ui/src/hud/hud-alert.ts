/**
 * 暖暖的 `alert` 态从哪来。
 *
 * `alert` 的生产来源：某程的每日核查是 critical
 * （暴雨 / 台风预警、路线时长翻倍那一档）且车主还没点过「知道了」、且核查没作废。
 * AC-01-4：`alert` 抢占其余四态，需显式清除才回落——「知道了」就是那次清除。
 *
 * 判据只有这一个来源；notice 档不进 alert（那一档只在列表上打点）。
 */

import { reviewIsStale, reviewNeedsAttention, type TripPlanListEntry } from "@cabinhug/shared";

export function hudAlertFrom(entries: readonly TripPlanListEntry[]): boolean {
  return entries.some(
    (e) =>
      e.review !== undefined &&
      e.review.severity === "critical" &&
      reviewNeedsAttention(e.review) &&
      !reviewIsStale(e.review, e.updatedAt),
  );
}
