/**
 * [F-58-13][AC-58-4] 体检运行参数：默认值与非法值回落。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { auditBudgetMs, auditLimits, auditMaxRounds, driveDailyMaxMin, driveLegSafeMaxMin } from "../src/graph/audit-config";

const KEYS = ["CABINHUG_PLAN_AUDIT_MAX_ROUNDS", "CABINHUG_PLAN_AUDIT_BUDGET_MS", "CABINHUG_DRIVE_DAILY_MAX_MIN", "CABINHUG_DRIVE_LEG_SAFE_MAX_MIN"];

describe("[F-58-13][AC-58-4] audit-config", () => {
  afterEach(() => {
    for (const k of KEYS) delete process.env[k];
  });

  it("默认值", () => {
    assert.equal(auditMaxRounds(), 3);
    assert.equal(auditBudgetMs(), 90_000);
    assert.equal(driveDailyMaxMin(), 540);
    assert.equal(driveLegSafeMaxMin(), 180);
  });

  it("环境变量生效；非法 / 非正数回默认", () => {
    process.env.CABINHUG_PLAN_AUDIT_MAX_ROUNDS = "2";
    process.env.CABINHUG_DRIVE_LEG_SAFE_MAX_MIN = "abc";
    process.env.CABINHUG_DRIVE_DAILY_MAX_MIN = "-5";
    assert.equal(auditMaxRounds(), 2);
    assert.equal(driveLegSafeMaxMin(), 180);
    assert.equal(driveDailyMaxMin(), 540);
  });

  it("auditLimits：同行者上限只在给了时出现", () => {
    assert.deepEqual(auditLimits(), { legSafeMaxMin: 180, dailyMaxMin: 540 });
    assert.deepEqual(auditLimits(120), { legMaxMin: 120, legSafeMaxMin: 180, dailyMaxMin: 540 });
  });
});
