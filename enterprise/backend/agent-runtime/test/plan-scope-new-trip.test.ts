/**
 * [F-58-11][AC-58-7] 同一会话里另起一趟，不能接着用上一趟的东西。
 *
 * 编排层若只看「状态里有没有行程」就当细化轮，会把上一趟当底子传下去，
 * 提示词里「其余保持不变」使新方案沿用上一趟的酒店与分段；
 * 任务状态的 base 仍指着上一趟的 planId，确认后会把它原地覆盖。
 * 意图理解因此要给出 planScope（refine / new）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildIntentInstruction, parseIntent } from "../src/graph/intent";
import { taskStatusLine } from "../src/context/tasks";

/** 另起一趟的典型原话。 */
const NEW_TRIP = "帮我定一个从上海到浙江的三日游一天只要安排两个景点就够了谢谢第三天要在四点之前回到上海静安";

describe("[F-58-11] 提示词把「另起一趟」问出来", () => {
  it("planScope 那一栏在 schema 里，取值只有 refine / new", () => {
    const instr = buildIntentInstruction();
    assert.match(instr, /planScope/);
    assert.match(instr, /refine \/ new/);
  });

  it("判据写的是「目的地换没换」，不是语气", () => {
    const instr = buildIntentInstruction();
    assert.match(instr, /判据是目的地换没换，不是语气/);
    assert.match(instr, /哪怕他用了「订一个」「帮我定」这种像新开一趟的说法/, "语气会骗人，要给反例");
  });

  it("说清判错成 refine 的代价——不然模型不知道该往哪边偏", () => {
    const instr = buildIntentInstruction();
    assert.match(instr, /893 公里外/, "真跑里那份「温州行程住青岛酒店」要留在例子里");
    assert.match(instr, /他已经定好的那份行程会被覆盖掉/);
    assert.match(instr, /判成 new 最多是多排一份/);
  });
});

describe("[F-58-11] planScope 解析", () => {
  it("模型说 new 就解析出 new", () => {
    const intent = parseIntent(
      JSON.stringify({
        goal: "规划一份从上海出发、去浙江的三日游行程",
        route: "itinerary",
        action: "none",
        planScope: "new",
        destinations: ["浙江"],
        constraints: ["从上海出发", "目的地是浙江"],
      }),
      NEW_TRIP,
    );
    assert.equal(intent.planScope, "new");
  });

  it("refine 照旧解析", () => {
    const intent = parseIntent(
      JSON.stringify({ goal: "换酒店", route: "itinerary", action: "none", planScope: "refine" }),
      "第二天换个酒店",
    );
    assert.equal(intent.planScope, "refine");
  });

  it("缺席与表外一律当没给：老检查点、降级路径都不带这一栏，此时走没有 planScope 的缺省行为", () => {
    const none = parseIntent(JSON.stringify({ goal: "g", route: "itinerary" }), "随便");
    assert.equal(none.planScope, undefined);
    const bogus = parseIntent(
      JSON.stringify({ goal: "g", route: "itinerary", planScope: "brand_new" }),
      "随便",
    );
    assert.equal(bogus.planScope, undefined, "表外的值不能当 new——那会平白重排一趟");
    assert.equal(parseIntent("这不是 JSON", "随便").planScope, undefined, "降级路径不猜");
  });
});

/**
 * 判据要用的事实，得在描述「手上那份」的那一行里（ADR-010）。
 *
 * 模型按「目的地换没换」判 planScope。状态行不写是哪一趟时，它只能去车主档案的
 * 已确认清单里找目的地，而那份清单与手上的草案不是一回事（草案可以还没落库）。
 */
describe("[F-21-06] 手上那件事要说清是哪一趟", () => {
  it("状态行带上目的地与天数", () => {
    const line = taskStatusLine({
      trip: {
        status: "dirty",
        draft: { destination: "苏州", days: 3 },
      } as never,
    } as never);
    assert.match(line ?? "", /行程：苏州 3 天，/);
    assert.match(line ?? "", /库里那份是旧版/, "办到哪一步照旧要说");
  });

  it("草案里没有目的地就不编——留空，不写「目的地待定」", () => {
    const line = taskStatusLine({ trip: { status: "drafting", draft: {} } as never } as never);
    assert.match(line ?? "", /行程：有一份/);
    assert.doesNotMatch(line ?? "", /待定/);
  });

  it("天数缺了只写目的地", () => {
    const line = taskStatusLine({
      trip: { status: "drafting", draft: { destination: "温州" } } as never,
    } as never);
    assert.match(line ?? "", /行程：温州，有一份/);
  });
});
