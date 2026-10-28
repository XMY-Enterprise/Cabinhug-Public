/**
 * 记忆浏览页的防退化断言。
 *
 * 六类记忆的接线状态写死在代码里会随实现演进而失真，写错的状态说明会让人停止查证。
 * 这里守两条：状态取自运行时而非常量；「未接线」与「0 条」分开表述。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGE = readFileSync(join(process.cwd(), "src/pages/memory/index.tsx"), "utf8");

describe("状态必须来自运行时，不是常量", () => {
  it("页面拉取 /console/memory/overview", () => {
    assert.match(PAGE, /console\/memory\/overview/);
  });

  it("不使用 taxonomy 的 `connected` 常量判定接线", () => {
    // `c.connected` 来自 MEMORY_TAXONOMY，是写死的常量。
    assert.ok(
      !/\bc\.connected\b/.test(PAGE),
      "检测到 c.connected：接线状态又被写回常量了，这正是本工单要根治的",
    );
  });

  it("接线状态取自 overview.wiring", () => {
    assert.match(PAGE, /overview\?\.wiring/);
  });
});

describe("「未接线」与「0 条」必须分开说", () => {
  it("0 条时明说是「这个用户还没有」", () => {
    /*
     * 断言的是那句说明，不是它的排版：条数与说明位于不同元素，
     * 这条守卫只要求 0 条被解释清楚。
     */
    assert.match(PAGE, /这个用户还没有，不是没做/);
  });

  it("未接线是另一句话", () => {
    assert.match(PAGE, /未接线/);
  });

  it("运行时读不到时不冒充「未接入」", () => {
    // 读不到表示控制台看不见状态，「未接入」表示运行时报告没有接线，两者不同。
    assert.match(PAGE, /状态未知|接线状态.*读不到|运行时不可达/);
  });
});

describe("只通一端要能显示出来", () => {
  it("有「仅读/仅写」这一档", () => {
    // 只通一端的类别若按两态显示，会被误标成「已接入」。
    assert.match(PAGE, /仅\{w\.read \? "读" : "写"\}已接线/);
  });
});
