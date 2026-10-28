/**
 * 保养到期推算单测（FL-17 F-17-01）。零依赖。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isMaintenanceQuery,
  renderMaintenanceForecastContext,
} from "../src/graph/subgraphs/ownership";


describe("保养到期推算的编排接线（F-17-01）", () => {
  const profile = {
    odometerKm: 18_000,
    maintenanceIntervalKm: 10_000,
    maintenance: [{ at: Date.UTC(2026, 0, 1), odometerKm: 10_000, items: "常规", source: "4S" }],
  };

  it("保养意图门：问保养的命中，问空调的不命中", () => {
    assert.equal(isMaintenanceQuery("我下次保养大概什么时候"), true);
    assert.equal(isMaintenanceQuery("首保要做什么"), true);
    assert.equal(isMaintenanceQuery("该换机油了吗"), true);
    assert.equal(isMaintenanceQuery("空调怎么开除雾"), false);
  });

  it("区间 + 依据，不给伪精确日期（AC-17-1）", () => {
    const ctx = renderMaintenanceForecastContext(profile, 40);
    assert.match(ctx, /约剩 2000 公里/);
    assert.match(ctx, /\d+~\d+ 周/, "时间必须是区间");
    assert.match(ctx, /依据：/);
    assert.match(ctx, /不要编造具体到期日期/);
    // 历史日期（"上次保养在 2026-01-01"）是事实可以出现；
    // 禁的是推算出的未来到期日，它只以"N~M 周"的区间形态存在。
    const afterEta = ctx.slice(ctx.indexOf("周后到期"));
    assert.ok(!/到期.{0,6}\d{4}-\d{2}-\d{2}/.test(ctx), "不得出现『到期 + 具体日期』的表述");
    assert.ok(afterEta.length > 0);
  });

  it("日均未知 → 只给里程不给时间（不猜）", () => {
    const ctx = renderMaintenanceForecastContext(profile);
    assert.ok(!/周后到期/.test(ctx));
    assert.match(ctx, /不给到期时间估计/);
  });

  it("已超期直说超期，不给负数区间", () => {
    const ctx = renderMaintenanceForecastContext({ ...profile, odometerKm: 21_000 }, 40);
    assert.match(ctx, /已超期约 1000 公里/);
    assert.ok(!/周后到期/.test(ctx));
  });

  it("降级（无周期记录）→ 明确要求向用户说明是通用参考", () => {
    const ctx = renderMaintenanceForecastContext({ odometerKm: 5_000, maintenance: [] }, 40);
    assert.match(ctx, /通用参考/);
  });
});
