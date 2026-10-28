/**
 * [ACR-063] 行程面板的纯函数：只读快照里有的东西。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { TripPlanSnapshot } from "@cabinhug/shared";

import {
  dateRangeLabel,
  dayDateLabel,
  dayHeadline,
  dayShortDate,
  draftFromSession,
  driveSummary,
  durationLabel,
  hotelStays,
  isConfirmed,
  mapStops,
  nextStopOf,
  nightOfStay,
  poiKindLabel,
  routeLines,
  spotNumbers,
  todayIndex,
  tripTitle,
} from "../src/trip";

const plan: TripPlanSnapshot = {
  status: "skeleton",
  origin: "上海",
  destination: "杭州",
  startDate: "2026-10-31",
  days: 2,
  skeleton: [
    {
      day: 1,
      theme: "钱江新城",
      spots: [
        { name: "钱江世纪公园", lat: 30.24, lon: 120.23, estStart: "15:30", estEnd: "17:30" },
        { name: "没有坐标的点" },
      ],
      hotel: { name: "杭州国际会议中心洲际酒店", lat: 30.25, lon: 120.21 },
    },
    { day: 2, theme: "上城区", spots: [{ name: "河坊街", lat: 30.24, lon: 120.17 }], hotel: { name: "杭州国际会议中心洲际酒店", lat: 30.25, lon: 120.21 } },
  ],
  legs: [
    { day: 1, direction: "outbound", driveMinutes: 100, reason: "rest", toStop: "嘉兴服务区" },
    { day: 1, direction: "outbound", driveMinutes: 68 },
    { day: 2, direction: "return", driveMinutes: 161 },
  ],
  caveats: [],
  updatedTurnId: "t1",
};

describe("[ACR-063] 行程面板纯函数", () => {
  it("标题：起终点、天数与晚数、日期区间", () => {
    assert.equal(tripTitle(plan), "上海 → 杭州 · 2 天 1 晚 · 10/31–11/1");
    assert.equal(tripTitle({ ...plan, origin: undefined, startDate: undefined, days: 1 }), "杭州 · 1 天");
  });

  it("日期标签带星期；没有出发日期就不写", () => {
    assert.equal(dayDateLabel(plan, 1), "10/31 周六");
    assert.equal(dayDateLabel(plan, 2), "11/1 周日");
    assert.equal(dayDateLabel({ startDate: undefined }, 1), undefined);
  });

  it("地图：没坐标的点不画；连住的酒店只画一次，标出覆盖的天", () => {
    const stops = mapStops(plan);
    assert.deepEqual(stops.map((s) => s.name), ["钱江世纪公园", "杭州国际会议中心洲际酒店", "河坊街"]);
    assert.deepEqual(stops.find((s) => s.kind === "hotel")?.days, [1, 2]);
  });

  it("时间轴序号与地图同一套：全程连续编号，跳过酒店与没坐标的点", () => {
    const n = spotNumbers(plan);
    assert.equal(n.get("1:钱江世纪公园"), 1);
    assert.equal(n.get("2:河坊街"), 2);
    assert.equal(n.get("1:没有坐标的点"), undefined);
    assert.equal(n.size, 2);
  });

  it("路程：按方向合计分段时长；分段为空时退回 transit.summary", () => {
    assert.deepEqual(routeLines(plan), ["去程 约 2 小时 48 分 · 中途歇 嘉兴服务区", "回程 约 2 小时 41 分"]);
    assert.deepEqual(routeLines({ ...plan, legs: [], transit: { summary: "自驾约3小时" } }), ["自驾约3小时"]);
  });

  it("草案出处：按线程号前缀认会话，前缀相同的另一个会话号不算", () => {
    assert.equal(draftFromSession({ updatedTurnId: "sess-528f5138-07a#1792778185741" }, "sess-528f5138-07a"), true);
    assert.equal(draftFromSession({ updatedTurnId: "sess-528f5138-07a#1792778185741" }, "sess-3633a937-885"), false);
    assert.equal(draftFromSession({ updatedTurnId: "sess-528f5138-07ab#1" }, "sess-528f5138-07a"), false);
    assert.equal(draftFromSession({ updatedTurnId: "t1" }, "sess-528f5138-07a"), false);
  });

  it("确认态", () => {
    assert.equal(isConfirmed(plan), false);
    assert.equal(isConfirmed({ ...plan, status: "confirmed" }), true);
  });
});

describe("[ACR-063] 定稿四屏的派生值", () => {
  it("时长与日期区间：「3天2晚」「10/31–11/1」，带年份时写全年", () => {
    assert.equal(durationLabel(plan), "2天1晚");
    assert.equal(durationLabel({ days: 1 }), "1天");
    assert.equal(dateRangeLabel(plan), "10/31–11/1");
    assert.equal(dateRangeLabel(plan, true), "2026/10/31–11/1");
    assert.equal(dateRangeLabel({ startDate: undefined, days: 2 }), undefined);
    assert.equal(dayShortDate(plan, 2), "11/1");
  });

  it("天主题：area 与 theme 相同只写一次", () => {
    assert.equal(dayHeadline({ theme: "老城漫步", area: "西湖风光" }), "老城漫步 · 西湖风光");
    assert.equal(dayHeadline({ theme: "上城区", area: "上城区" }), "上城区");
    assert.equal(dayHeadline({ theme: "上城区" }), "上城区");
  });

  it("今天是第几天：只认行程日期内的本地日历日", () => {
    assert.equal(todayIndex(plan, new Date(2026, 9, 31, 8)), 1);
    assert.equal(todayIndex(plan, new Date(2026, 10, 1, 23)), 2);
    assert.equal(todayIndex(plan, new Date(2026, 9, 30, 23)), undefined);
    assert.equal(todayIndex({ startDate: undefined, days: 2 }, new Date()), undefined);
  });

  it("下一站：不在路上说首站；今天在路上按时刻取还没开始的那一个，都过了就不写", () => {
    assert.deepEqual(nextStopOf(plan, 1, new Date(2026, 9, 20)), { label: "首站", name: "钱江世纪公园" });
    assert.deepEqual(nextStopOf(plan, 1, new Date(2026, 9, 31, 9)), { label: "下一站", name: "钱江世纪公园" });
    assert.equal(nextStopOf(plan, 1, new Date(2026, 9, 31, 18)), undefined);
  });

  it("去程回程：按方向合计分钟；里程只来自 leg，且只配去程", () => {
    assert.deepEqual(driveSummary(plan), { outbound: "约 2 小时 48 分", back: "约 2 小时 41 分" });
    const withLeg = { ...plan, leg: { distanceKm: 174.4, durationMin: 158, computedAt: "x" } };
    assert.deepEqual(driveSummary(withLeg), { outbound: "约 2 小时 48 分", outboundKm: "174 km", back: "约 2 小时 41 分" });
    assert.deepEqual(driveSummary({ ...plan, legs: [] }), {});
  });

  it("品类标签：没有品类不猜", () => {
    assert.equal(poiKindLabel("old_town"), "历史街区");
    assert.equal(poiKindLabel(undefined), undefined);
  });

  it("住宿：连住合成一行；第几晚按连续同名计", () => {
    assert.deepEqual(hotelStays(plan).map((h) => [h.hotel.name, h.days]), [["杭州国际会议中心洲际酒店", [1, 2]]]);
    assert.equal(nightOfStay(plan, 1), 1);
    assert.equal(nightOfStay(plan, 2), 2);
    assert.equal(nightOfStay({ ...plan, skeleton: [plan.skeleton[0]!, { ...plan.skeleton[1]!, hotel: undefined }] }, 2), undefined);
  });
});
