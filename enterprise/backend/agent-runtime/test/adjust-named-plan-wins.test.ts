/**
 * [F-21-06][AC-21-6] 「调整行程 <id>」点名的那一份，压过手上那件。
 *
 * 车机端发来的「调整行程 <id>：…」点名了一份行程，而手上那件任务的 base 可能指着
 * 另一份。`tasks` 档下手上几乎总有一件任务，若只在 `!activePlan` 时解析点名的 id，
 * 修改会落到错误的那一份上（例如用 3 天行程的内容覆盖 4 天行程的前 3 天，
 * 并在确认时经 trip_plan_update 写回错误的那一行）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { adjustPlanIdOf } from "@cabinhug/shared";

const SUP = readFileSync(new URL("../src/graph/supervisor.ts", import.meta.url), "utf8");

describe("[F-21-06] 点名的 id 是硬事实", () => {
  it("只认车机端拼的机器消息：锚定行首、8 位以上 id、后跟冒号", () => {
    assert.equal(adjustPlanIdOf("调整行程 cmu1dr80t00028or7pstbr2sd：第 1 天删除「七里山塘景区」"),
      "cmu1dr80t00028or7pstbr2sd");
    // 人话不会命中，所以它在场时可以当硬事实用，压过"手上那件"
    assert.equal(adjustPlanIdOf("帮我调整行程，第二天换个酒店"), undefined);
    assert.equal(adjustPlanIdOf("我想调整一下苏州那趟行程"), undefined);
    assert.equal(adjustPlanIdOf("调整行程 abc：太短的 id 不认"), undefined);
  });
});

describe("[F-21-06] 手上有草案也要按点名的那一份改", () => {
  it("装载分支的条件不只是「手上没有草案」：点名的那一份不同时也要进去", () => {
    assert.ok(
      /if \(\(!activePlan \|\| namesOtherPlan\) && wantsAdjust\(/.test(SUP),
      "只写 !activePlan 就是这次的 bug：tasks 档下手上几乎总有一件",
    );
    assert.ok(
      /const namesOtherPlan =\s*\n?\s*namedPlanId !== undefined && activePlan\?\.committedPlanId !== namedPlanId;/.test(SUP),
      "判据是「点名的那份 ≠ 手上那件的 base」",
    );
  });

  it("光改 basePlan 不够：落库读的是任务的 base，必须一并换过去", () => {
    // 落库目标取自 activePlan.committedPlanId，它来自任务的 base.ref；
    // 不换任务，改对了草案仍然会更新错那一行。
    assert.ok(/planId: activePlan\.committedPlanId/.test(SUP), "落库确实读的是任务的 base（本条断言的前提）");
    const block = SUP.slice(SUP.indexOf("basePlan = { ...target.plan"));
    assert.ok(/turnCtx\.writer\.open\(\{[\s\S]{0,200}baseRef: target\.planId/.test(block),
      "换到点名的那一份上：store.open 同事务关掉旧活跃行，新的一件 base 指向它");
  });

  it("点名了 id 就不认 planScope=new：那句话是「改这一份」，不可能是另起一趟", () => {
    assert.ok(
      /state\.intent\?\.planScope === "new" && namedPlanId === undefined/.test(SUP),
      "否则 new 会把刚装载好的那一份又冲成空，退回新规划",
    );
  });
});
