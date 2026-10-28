/** [ACR-066] 费用明细页的显示规则：Agent 名归一、金额与 token 的写法、额度占比。 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BillingService } from "@cabinhug/shared";

import { agentLabel, balanceText, formatMoney, formatTokens, quotaRatio, rowLabel } from "../src/billing";

describe("明细行的名字", () => {
  it("会话后缀不区分 Agent", () => {
    assert.equal(agentLabel("drive-task"), "驾车路线");
    assert.equal(agentLabel("supervisor-intent"), "总调度（理解意图）");
    assert.equal(agentLabel("trip-voice"), "行程规划");
  });

  it("导览的各条分支合称景点导览", () => {
    assert.equal(agentLabel("guide"), "景点导览");
    assert.equal(agentLabel("guide-spots-task"), "景点导览");
  });

  it("认不出的原样显示", () => {
    assert.equal(agentLabel("mystery-agent"), "mystery-agent");
  });

  it("按服务查对应的表", () => {
    assert.equal(rowLabel("aliyun", "input_moderation"), "输入审核（你说的话）");
    assert.equal(rowLabel("amap", "place"), "地点搜索");
    assert.equal(rowLabel("deepseek", "hotel-task"), "住宿");
  });
});

describe("数字的写法", () => {
  it("金额：没有单价写横线，不到一分钱不写 0.00", () => {
    assert.equal(formatMoney(undefined), "—");
    assert.equal(formatMoney(0), "¥0.00");
    assert.equal(formatMoney(0.0048), "不到 ¥0.01");
    assert.equal(formatMoney(12.345), "¥12.35");
    assert.equal(formatMoney(3, "USD"), "USD 3.00");
  });

  it("token 用 k / M", () => {
    assert.equal(formatTokens(950), "950");
    assert.equal(formatTokens(12_340), "12.3k");
    assert.equal(formatTokens(2_500_000), "2.5M");
  });
});

describe("卡片上的余额与额度", () => {
  const base: BillingService = { id: "deepseek", label: "", role: "", calls: 0, rows: [] };

  it("余额：有数写数，没有写原因", () => {
    assert.equal(balanceText(base), undefined);
    assert.equal(
      balanceText({ ...base, balance: { status: "ok", amount: 42.5, currency: "CNY", consoleUrl: "" } }),
      "¥42.50",
    );
    assert.equal(balanceText({ ...base, balance: { status: "unconfigured", consoleUrl: "" } }), "未配置");
    assert.equal(balanceText({ ...base, balance: { status: "failed", consoleUrl: "" } }), "查询失败");
  });

  it("额度占比封顶 1，没有额度就没有占比", () => {
    assert.equal(quotaRatio(base), undefined);
    assert.equal(quotaRatio({ ...base, quota: { used: 45, limit: 450, day: "2026-10-27" } }), 0.1);
    assert.equal(quotaRatio({ ...base, quota: { used: 500, limit: 450, day: "2026-10-27" } }), 1);
  });
});
