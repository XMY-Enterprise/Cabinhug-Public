/**
 * [F-13-05][ADR-012] 车主点名的交通方式优先于推荐优先级表。
 *
 * `assembleTransit` 的缺省推荐是固定优先级表（短途自驾 → 有高铁走高铁 → 飞机）；
 * 车主点名的方式经意图 JSON 的 `transitMode` 传入并优先生效，不靠正则识别。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assembleTransit, selectedTransit } from "../src/graph/subgraphs/itinerary";
import { parseIntent } from "../src/graph/intent";

/** 昆明 → 上海：自驾 26 小时，高铁与飞机都有。 */
const KM_SH = {
  driveLine: "自驾约26小时10分，分12段",
  driveMinutes: 26 * 60 + 10,
  trainParts: ["G1372 11小时02分 约879元"],
  // 这一段由编排层拼成「飞机：…」（itinerary.ts），`TRANSIT_MATCHERS.flight` 按此匹配。
  flightPart: "飞机：直飞约 3 小时 15 分（估算，不含两头机场接驳各约 1 小时）；经济舱约 700~1400 元",
  flightWorthIt: true,
};

describe("[ADR-012] 意图里的 transitMode", () => {
  it("模型说了就收下，封闭取值", () => {
    assert.equal(parseIntent('{"goal":"g","transitMode":"flight"}', "x").transitMode, "flight");
    assert.equal(parseIntent('{"goal":"g","transitMode":"train"}', "x").transitMode, "train");
    assert.equal(parseIntent('{"goal":"g","transitMode":"drive"}', "x").transitMode, "drive");
  });

  it("表外取值一律视为未表态，由方案自己挑", () => {
    for (const bad of ['"高铁"', '"plane"', '"FLIGHT"', "123", "null"]) {
      assert.equal(parseIntent(`{"goal":"g","transitMode":${bad}}`, "x").transitMode, undefined, bad);
    }
    assert.equal(parseIntent('{"goal":"g"}', "x").transitMode, undefined);
  });
});

describe("[F-13-05] 推荐方式：点名的优先于优先级表", () => {
  it("不点名 → 火车（按优先级表）", () => {
    assert.equal(assembleTransit(KM_SH)!.recommended, "train");
  });

  it("车主说「做飞机」→ 推荐飞机，弹窗只列那一段", () => {
    const t = assembleTransit({ ...KM_SH, preferred: "flight" })!;
    assert.equal(t.recommended, "flight");
    const shown = selectedTransit({ transit: { summary: t.summary, recommended: t.recommended } } as never);
    assert.match(shown ?? "", /飞机：直飞/);
    assert.doesNotMatch(shown ?? "", /G1372/, "不该再列高铁");
  });

  it("说自驾就自驾，哪怕有高铁", () => {
    assert.equal(assembleTransit({ ...KM_SH, preferred: "drive" })!.recommended, "drive");
  });

  it("点名的方式在方案里不存在 → 落回优先级表", () => {
    // 市内行程：短途、无车次、飞机被 keepFlight 挡掉
    const local = { driveLine: "自驾约25分", driveMinutes: 25, trainParts: [] as string[] };
    assert.equal(assembleTransit({ ...local, preferred: "flight" })!.recommended, "drive");
    assert.equal(assembleTransit({ ...KM_SH, trainParts: [], preferred: "train" })!.recommended, "flight");
  });

  it("ticketed 不受点名影响，按方案里实际存在的方式列出", () => {
    const t = assembleTransit({ ...KM_SH, preferred: "flight" })!;
    assert.deepEqual(t.ticketed, ["train", "flight"]);
  });
});

describe("[F-13-05] 确认弹窗：以本轮点名为准", () => {
  const plan = {
    transit: { summary: "自驾约26小时10分，分12段；G1372 11小时02分 约879元；飞机：直飞约 3 小时 15 分；经济舱约 700~1400 元", recommended: "train" as const },
  } as never;

  it("草案存的是 train，这一轮车主说飞机 → 列飞机", () => {
    // 确认轮不重排方案；列哪一种只是展示，三种都在 summary 里，按点名挑一段。
    assert.match(selectedTransit(plan, "flight") ?? "", /飞机：直飞/);
  });

  it("本轮没点名 → 按草案存的推荐", () => {
    assert.match(selectedTransit(plan) ?? "", /G1372/);
  });

  it("点名的方式不在 summary 里 → 忽略点名，照常列出", () => {
    const noFlight = { transit: { summary: "自驾约25分", recommended: "drive" as const } } as never;
    assert.match(selectedTransit(noFlight, "flight") ?? "", /自驾约25分/);
  });
});
