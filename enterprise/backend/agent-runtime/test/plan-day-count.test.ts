/**
 * [F-58-02][F-58-08][AC-58-2][AC-58-3] 方案的天数要与车主要的对得上。
 *
 * tour 只交部分天时，合并结果与落库的天数少于车主要求，而应答仍可能按对话上下文
 * 说出完整天数，确认弹窗和主页却只有已排的天。天数体检与修复循环负责拦住这种情况。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { auditPlan } from "@cabinhug/tools";

import { parseTripLimits } from "../src/graph/intent";
import { planRepairs } from "../src/graph/audit-repair";
import type { TripPlanState } from "../src/graph/state";

const day = (d: number) => ({ day: d, theme: `第${d}天`, spots: [{ name: `景点${d}` }] });

const audit = (skeletonDays: number, requestedDays?: number) =>
  auditPlan({
    skeleton: Array.from({ length: skeletonDays }, (_, i) => day(i + 1)),
    destination: "张家港",
    limits: { legSafeMaxMin: 180, dailyMaxMin: 540 },
    constraints: [],
    ...(requestedDays !== undefined ? { requestedDays } : {}),
  });

describe("[F-58-02] 天数体检", () => {
  it("要三天只排一天 → blocker，依据说清少几天", () => {
    const f = audit(1, 3).findings.find((x) => x.item === "days");
    assert.equal(f?.level, "blocker");
    assert.equal(f?.actual, 1);
    assert.equal(f?.limit, 3);
    assert.match(f?.basis ?? "", /只排了 1 天/);
    assert.match(f?.basis ?? "", /少 2 天/);
  });

  it("对得上 → 一条 finding 都不出", () => {
    assert.equal(audit(3, 3).findings.find((x) => x.item === "days"), undefined);
  });

  it("排多了也报——车主只有那么多假", () => {
    const f = audit(4, 3).findings.find((x) => x.item === "days");
    assert.equal(f?.level, "blocker");
    assert.match(f?.basis ?? "", /超过/);
  });

  it("车主没说天数 → 整个跳过，不报也不算通过；那是常态，报了就是恒在的噪音", () => {
    assert.equal(audit(1, undefined).findings.find((x) => x.item === "days"), undefined);
    // 同一份骨架比：只有「说没说天数」这一个变量，否则住宿项的通过数也会跟着变
    assert.equal(audit(3, 3).passed - audit(3, undefined).passed, 1, "说了天数才多一项通过");
  });
});

describe("[F-58-02] 从约束里抽「要几天」", () => {
  it("认总量语境，中文数字与阿拉伯都行", () => {
    // 这些说法由模型读懂后直接给数字，编排层只校验范围；
    // 正则逐条认说法会漏掉变体（如「三日行程」）。
    assert.equal(parseTripLimits({ days: 3 })?.days, 3);
    assert.equal(parseTripLimits({ days: 5 })?.days, 5);
    assert.equal(parseTripLimits({ days: "2" })?.days, 2, "字符串数字也收");
  });

  it("「第三天换个酒店」不该被当成总天数：由提示词约束，不靠正则排除", () => {
    // 提示词里写明了「第三天换个酒店」里的三天不是总天数、那种不填。
    // 这里守的是编排层这一侧：模型没给就是没给，不猜。
    assert.equal(parseTripLimits({}), undefined);
  });

  it("没说就是没说，不猜", () => {
    assert.equal(parseTripLimits(undefined), undefined);
    assert.equal(parseTripLimits({ days: null }), undefined);
    assert.equal(parseTripLimits({ days: 2.5 })?.days, undefined, "半天不是天数");
  });
});

describe("[F-58-08] 缺天进修复循环", () => {
  const plan = (): TripPlanState => ({
    status: "skeleton",
    destination: "张家港",
    days: 1,
    skeleton: [day(1)],
    caveats: [],
    updatedTurnId: "t1",
  });

  it("少两天 → 一条 tour 追发，点名缺第 2、3 天，并要求交回完整骨架", () => {
    const report = audit(1, 3);
    const actions = planRepairs(report, plan(), {
      constraintText: "必须满足的硬约束：三天行程",
      legLimitMin: 180,
      dailyMaxMin: 540,
    });
    const tourAction = actions.find((a) => a.branch === "tour");
    assert.ok(tourAction, "缺天必须触发 tour 追发");
    assert.deepEqual(tourAction.days, [2, 3]);
    assert.match(tourAction.prompt, /缺的是第 2、3 天/);
    assert.match(tourAction.prompt, /完整的逐天骨架/);
    assert.match(tourAction.prompt, /不安排游玩/, "回家 / 休整那天也要占一天，正是真跑里被省掉的");
  });

  it("天数对得上时不追发", () => {
    const actions = planRepairs(audit(3, 3), { ...plan(), days: 3, skeleton: [day(1), day(2), day(3)] }, {
      constraintText: "",
      legLimitMin: 180,
      dailyMaxMin: 540,
    });
    assert.equal(actions.find((a) => a.branch === "tour"), undefined);
  });
});
