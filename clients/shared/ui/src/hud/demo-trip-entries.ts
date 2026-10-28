/**
 * 「行程演示」的列表条目（位于 `@cabinhug/ui`，两端共用）。
 *
 * 浏览器环境没有 Tauri invoke，网关那一路接不上；行程列表卡与变化摘要弹层
 * 只能经这份数据在浏览器里预览（与 `DEMO_TRIP_PLAN` / `DEMO_PERMISSION` 同一理由）。
 * 数据自带「演示」字样；车机只在 devbar「行程演示」开着时生效，手机端是 `?plan=demo`。
 *
 * 前三程刻意覆盖三种形态：有 notice 变化的、有 critical 变化的、没核查过的；
 * 第 8 程没定日期：按默认明天出发画成虚线色块，覆盖待定形态。
 */

import { DEMO_TRIP_PLAN } from "./demo-trip-plan";
import type { TripPlanListEntry, TripPlanSnapshot } from "@cabinhug/shared";

const COMMITTED = "2026-09-01T02:00:00.000Z";

/** 今天 + n 天（本地日期串）：让演示里有一程落在本周条上、一程落在下周（翻周可看），否则周条永远空着。 */
function inDaysIso(n: number): string {
  const d = new Date(Date.now() + n * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const tomorrowIso = () => inDaysIso(1);

/** 演示第 4–7 程：覆盖清单翻页与下周的色块，没有核查。 */
function plainEntry(planId: string, destination: string, startDate: string | undefined, days: number): TripPlanListEntry {
  return {
    planId,
    plan: { ...dated(DEMO_TRIP_PLAN, destination, startDate), days },
    committedAt: COMMITTED,
    updatedAt: COMMITTED,
  };
}

function dated(plan: TripPlanSnapshot, destination: string, startDate: string | undefined): TripPlanSnapshot {
  return { ...plan, destination, startDate };
}

export const DEMO_TRIP_ENTRIES: TripPlanListEntry[] = [
  {
    planId: "demo-plan-guangzhou",
    plan: DEMO_TRIP_PLAN,
    committedAt: COMMITTED,
    updatedAt: COMMITTED,
    review: {
      reviewId: "demo-review-1",
      planId: "demo-plan-guangzhou",
      reviewedAt: new Date().toISOString(),
      days: [
        { day: 1, kind: "cloudy", label: "多云", tempMinC: 24, tempMaxC: 31 },
        { day: 2, kind: "rain", label: "雷阵雨", tempMinC: 23, tempMaxC: 29 },
        { day: 3, kind: "sunny", label: "晴", tempMinC: 24, tempMaxC: 32 },
      ],
      route: { day: 1, from: "浙江杭州", to: "广州塔", distanceKm: 1230, durationMin: 840 },
      changes: [
        { kind: "weather", day: 2, before: "多云", after: "雷阵雨", severity: "notice", text: "第 2 天：多云 → 雷阵雨" },
        { kind: "route", day: 1, before: "780 分钟", after: "840 分钟", severity: "notice", text: "第 1 天出发路线：780 → 840 分钟" },
      ],
      severity: "notice",
    },
  },
  {
    planId: "demo-plan-qingdao",
    plan: dated(DEMO_TRIP_PLAN, "青岛（演示）", "2026-09-20"),
    committedAt: COMMITTED,
    updatedAt: COMMITTED,
    review: {
      reviewId: "demo-review-2",
      planId: "demo-plan-qingdao",
      reviewedAt: new Date().toISOString(),
      days: [
        { day: 1, kind: "rain", label: "暴雨", tempMinC: 22, tempMaxC: 26, alarms: ["暴雨橙色预警"] },
        { day: 2, kind: "overcast", label: "阴" },
        { day: 3, unavailable: true },
      ],
      changes: [
        { kind: "alarm", day: 1, before: "无预警", after: "暴雨橙色预警", severity: "critical", text: "第 1 天：新增暴雨橙色预警" },
      ],
      severity: "critical",
    },
  },
  {
    planId: "demo-plan-xuzhou",
    plan: dated(DEMO_TRIP_PLAN, "徐州（演示）", tomorrowIso()),
    committedAt: COMMITTED,
    updatedAt: COMMITTED,
  },
  plainEntry("demo-plan-nanjing", "南京（演示）", inDaysIso(8), 2),
  plainEntry("demo-plan-suzhou", "苏州（演示）", "2026-10-02", 3),
  plainEntry("demo-plan-huangshan", "黄山（演示）", "2026-10-15", 4),
  plainEntry("demo-plan-xiamen", "厦门（演示）", "2026-11-01", 3),
  // 没定日期：默认明天出发（虚线色块 / 「待定」标 / 「明天出发」）。
  plainEntry("demo-plan-wuxi", "无锡（演示）", undefined, 2),
];
