/**
 * [F-58-11][AC-58-5] 意图判断要知道行程此刻是草案还是已落库。
 *
 * 意图 probe 不说明当前状态时，模型只能从助手过去的话里猜行程是否已确认，
 * 会把「那你直接定了」「不用改了就这样吧」这类确认误判成 adjust / none：
 * 不弹框、不落库，助手却回复已经定了。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { planStateLine } from "../src/graph/intent";
import { describeItineraryPlan } from "../src/graph/subgraphs/itinerary";
import type { ItineraryMergeOutput } from "../src/graph/subgraphs/itinerary";

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("[F-58-11] planStateLine：把状态摆到判断者面前", () => {
  it("未落库的草案 → 明说「还没确认」，并点名「不用改了」这类话就是 commit", () => {
    const line = planStateLine({ status: "refining", destination: "普陀山", days: 2 })!;
    assert.match(line, /还没确认、没落库/);
    assert.match(line, /不用改了/, "真跑里正是这句被判成了 none");
    assert.match(line, /commit/);
    assert.match(line, /普陀山 2 天/);
  });

  it("已落库 → 明说已确认，再说一次「定了」是 none 不是 commit", () => {
    const line = planStateLine({ status: "confirmed", destination: "徐州", days: 3, committedPlanId: "p1" })!;
    assert.match(line, /已经确认落库/);
    assert.match(line, /adjust/);
    assert.doesNotMatch(line, /还没确认/);
  });

  it("没有行程 / 已取消 → 不加这一行，别让它变噪音", () => {
    assert.equal(planStateLine(undefined), undefined);
    assert.equal(planStateLine({ status: "cancelled", destination: "徐州", days: 3 }), undefined);
  });

  it("只给状态与规模，不把行程内容再抄一遍（对话历史里已经有了）", () => {
    const line = planStateLine({ status: "skeleton", destination: "南通", days: 3 })!;
    assert.ok(line.length < 120, `这一行不该长到挤占窗口，实际 ${line.length} 字`);
  });

  it("意图 probe 真的带上了它——写了没挂等于没做", () => {
    const sup = src("../src/graph/supervisor.ts");
    /*
     * 这句调用带 `dirty` 参数并先落到 `legacyPlanState`，所以按函数名找、
     * 再按那个变量确认它真的进了 probe，比钉死调用的字面更耐得住重构。
     * 要守的是：状态行必须挂进 probe，且排在那句指令之前。
     */
    const at = sup.indexOf("planStateLine(");
    assert.ok(at > 0, "supervisor 里必须调 planStateLine");
    const used = sup.indexOf("legacyPlanState ? [{ role:", at);
    assert.ok(used > at, "算出来的状态行必须真的挂进 probe——写了没挂等于没做");
    const instr = sup.indexOf("buildIntentInstruction(", used);
    assert.ok(instr > used, "状态行要在那句指令之前");
  });

  it("装载层开着时，状态由本轮尾区给，且同样排在指令之前", () => {
    const sup = src("../src/graph/supervisor.ts");
    const block = sup.indexOf("turnBlock\n          ? [{ role:");
    assert.ok(block > 0, "turnBlock 必须真的挂进 probe");
    const instr = sup.indexOf("buildIntentInstruction(", block);
    assert.ok(instr > block, "尾区也要在指令之前——ADR-010 那条位置约束对两条路都成立");
  });
});

describe("[F-58-11] 复述不许把「没做」说成「做了」", () => {
  const out = (): ItineraryMergeOutput => ({
    plan: {
      status: "refining",
      destination: "南通",
      days: 3,
      skeleton: [{ day: 1, theme: "回家过节", spots: [{ name: "妈妈家" }] }],
      caveats: [],
      updatedTurnId: "t1",
    },
    violations: [],
    missing: [],
    findings: [],
    tourSource: "submission",
    hotelSource: "submission",
    driveSource: "submission",
    transitSource: "missing",
    solverDegraded: false,
  });

  it("结尾明说这一轮没保存，并禁掉「已经定好了」那类话", () => {
    const text = describeItineraryPlan(out());
    assert.match(text, /这一轮没有保存/);
    assert.match(text, /不许说「已经定好了」/);
    assert.match(text, /按一下那个确认才算数/, "光说「说一声定了」不够——真正落库要在弹窗上按");
  });
});
