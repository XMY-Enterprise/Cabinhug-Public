/**
 * [F-58-11][AC-58-7] 一边认可一边补新要求。
 *
 * 例：「这样定了我们就这样定了，我们是走自驾啊」。意图理解会把"自驾出行"写进
 * constraints，但确认路径只读 action，若不处理会把按高铁排的版本直接落库。
 *
 * 两层防线：模型判 none 为主（提示词说明），把未采纳的新要求列进弹窗是安全网。
 * 增量由模型自己报（`intent.newAsks`），编排层只消费；不对两轮 constraints
 * 做集合差，理由见 `newAsksOf` 的注释。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildIntentInstruction, parseIntent } from "../src/graph/intent";
import { commitDisclosures, describeCommitted, newAsksOf } from "../src/graph/subgraphs/itinerary";
import type { TripPlanState } from "../src/graph/state";

const plan = (): TripPlanState => ({
  status: "refining",
  destination: "徐州",
  days: 4,
  skeleton: [{ day: 1, theme: "抵达", spots: [{ name: "云龙湖" }] }],
  caveats: [],
  updatedTurnId: "t1",
});

describe("[F-58-11] 第一层：提示词让模型判 none", () => {
  it("commit 那一栏点名「一边认可一边补新要求」的三种说法", () => {
    const instr = buildIntentInstruction();
    assert.match(instr, /一边认可一边补新要求/);
    assert.match(instr, /我们是走自驾啊/, "真跑那一句要在例子里");
    assert.match(instr, /不要的那一版/, "要说清后果，不然它不知道为什么");
    assert.match(instr, /只有认可、没有新要求时才是 commit/);
  });
});

describe("[F-58-11] 第二层：模型报的增量进弹窗，但不阻断", () => {
  it("模型报了就照单列出来", () => {
    assert.deepEqual(newAsksOf({ newAsks: ["自驾出行（不走高铁/飞机）"] }), ["自驾出行（不走高铁/飞机）"]);
  });

  it("没报就一条都不出——缺席、空数组、空白串都算没报", () => {
    assert.deepEqual(newAsksOf(undefined), []);
    assert.deepEqual(newAsksOf({}), []);
    assert.deepEqual(newAsksOf({ newAsks: [] }), []);
    assert.deepEqual(newAsksOf({ newAsks: ["  ", ""] }), []);
  });

  it("列进弹窗的是最后一行，天序与大交通照旧在前面", () => {
    const lines = commitDisclosures(plan(), ["自驾出行（不走高铁/飞机）"]);
    assert.equal(lines[lines.length - 1], "这一轮你还提到：自驾出行（不走高铁/飞机）");
    assert.ok(lines.some((l) => l.startsWith("第1天")), "逐日行还在");
  });

  it("不传新要求时，弹窗与从前逐字相同——安全网不该改老行为", () => {
    assert.deepEqual(commitDisclosures(plan()), commitDisclosures(plan(), []));
  });
});

describe("[F-58-11] 落了库也要说清哪条没进去", () => {
  it("禁掉「我改不了」那句假话，并给出下一步怎么说", () => {
    const text = describeCommitted(plan(), ["自驾出行（不走高铁/飞机）"]);
    assert.match(text, /没有.*照它改/);
    assert.match(text, /不要说自己改不了/, "真跑那句「这个我这边没法直接改」是假话——改行程一直是通的");
    assert.match(text, /改完再确认一次/);
  });

  it("没有新要求时，这一段不出现——老行为逐字不变", () => {
    assert.equal(describeCommitted(plan()), describeCommitted(plan(), []));
    assert.doesNotMatch(describeCommitted(plan()), /没有.*照它改/);
  });
});

/**
 * 同义复述的回归数据：车主只说「就这样定了」，未提新要求；
 * 两轮 constraints 是同五条要求的两次复述，措辞不同。
 * 字面集合差在这组数据上报 5 条，弹窗会误称车主提的要求没照改。
 */
describe("[F-58-11] 同义改写不该被当成新要求", () => {
  /** 建草案那轮模型给的 constraints，逐字。 */
  const BUILT = [
    "出行方式为自驾",
    "第一天早上要睡到自然醒（不安排早起出发）",
    "第三天要在 16:00 前回到上海",
    "行程共三天",
    "从上海出发，目的地温州",
  ];
  /** 说「就这样定了」那轮模型给的 constraints，逐字：同五条要求，措辞不同。 */
  const THIS_ROUND = [
    "出行方式为自驾",
    "第一天早上睡到自然醒",
    "第三天 16:00 前回到上海",
    "共三天",
    "上海出发到温州",
  ];

  it("五条里有四条逐字不同，字面集合差在这组数据上必然误报", () => {
    const seen = new Set(BUILT.map((c) => c.replace(/\s+/g, "")));
    const literalDiff = THIS_ROUND.filter((c) => !seen.has(c.replace(/\s+/g, "")));
    assert.equal(literalDiff.length, 4, "这就是旧判据报出来的那几条，留作反例");
  });

  it("判据只看模型报的 newAsks：未报则一条都不出", () => {
    const intent = parseIntent(
      JSON.stringify({
        goal: "把当前上海到温州三日自驾行程草案定下来落库",
        route: "itinerary",
        action: "commit",
        constraints: THIS_ROUND,
        transitMode: "drive",
      }),
      "就这样定了",
    );
    assert.equal(intent.action, "commit");
    assert.deepEqual(intent.constraints, THIS_ROUND, "全量快照照旧给下游，这一栏没被动过");
    assert.equal(intent.newAsks, undefined, "没报增量就整栏不给");
    assert.deepEqual(newAsksOf(intent), []);
    assert.doesNotMatch(describeCommitted(plan(), newAsksOf(intent)), /没有.*照它改/);
  });

  it("真有增量时照旧接得住：模型报什么就列什么", () => {
    const intent = parseIntent(
      JSON.stringify({
        goal: "确认行程，同时改成自驾",
        route: "itinerary",
        action: "commit",
        constraints: THIS_ROUND,
        newAsks: ["改成自驾，不走高铁"],
      }),
      "就这样定了，我们是走自驾啊",
    );
    assert.deepEqual(newAsksOf(intent), ["改成自驾，不走高铁"]);
  });

  it("提示词写清 newAsks 是增量不是复述", () => {
    const instr = buildIntentInstruction();
    assert.match(instr, /newAsks/);
    assert.match(instr, /子集/, "要说清它与 constraints 的关系");
    assert.match(instr, /别把老要求换个说法塞进来/);
  });
});
