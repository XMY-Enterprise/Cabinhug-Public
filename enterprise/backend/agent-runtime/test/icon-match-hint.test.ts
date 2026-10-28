/**
 * [F-20-03][AC-20-1] 端上类别名参与匹配：目录闸门没过时拿它指向的手册图直接核验。
 *
 * 守四条：目录对上了名字不参与；闸门没过 + 名字 + 手册有图 → 核验 same 就是 matched/verified；
 * 核验不说 same 就仍是「疑似」（措辞来源 detector）；索引里没这个符号或没图时不做核验。
 * 另守 trace：匹配原因、分数、端上类别名三项进 `vision` 事件。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import type { Candidate, MatchResult } from "@cabinhug/rag";
import { createHintAwareMatcher, type HintAwareMatcherDeps } from "../src/graph/icon-match";

const CROP = Buffer.from("crop");
const ICON = Buffer.from("icon");
const ROW = { symbolId: "parking_lights", descriptor: { name: "驻车灯已开", class: "status", severity: "info" }, manualAnchor: "Model 3 车主手册 › 指示灯 › 驻车灯" };
const FAILED: MatchResult = { matched: false, reason: "below_delta", sim: 0.61 };
const MATCHED: MatchResult = { matched: true, verified: true, semantics: { symbolId: "low_beam", name: "近光灯已开", class: "status", severity: "info", manualAnchor: null }, sim: 0.8, margin: 0.2, evidence: "e" };

function deps(over: Partial<HintAwareMatcherDeps> & { verdict?: "same" | "different" | "unsure"; decided?: MatchResult; icon?: Buffer | null }): HintAwareMatcherDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    recall: async () => {
      calls.push("recall");
      return { candidates: [] as Candidate[] };
    },
    decide: async () => {
      calls.push("decide");
      return over.decided ?? FAILED;
    },
    getBySymbol: async ({ symbolId }) => {
      calls.push(`getBySymbol:${symbolId}`);
      return symbolId === "parking_lights" ? ROW : null;
    },
    iconImage: () => {
      calls.push("iconImage");
      return over.icon === undefined ? ICON : over.icon;
    },
    verifyPair: async () => {
      calls.push("verifyPair");
      return over.verdict ?? "same";
    },
    ...over,
  };
}

const args = (symbolHint?: string) => ({ crop: CROP, descriptor: { shape: "other", color: "green", state: "lit", elements: [], text: [] }, vehicleModel: "Tesla Model 3/Y", ...(symbolHint ? { symbolHint } : {}) });

describe("[F-20-03][AC-20-1] 端上类别名参与匹配", () => {
  it("目录闸门没过，端上说 parking_lights，手册那张图核验 same → 对上且已核验", async () => {
    const d = deps({});
    const r = await createHintAwareMatcher(d)(args("parking_lights"));
    assert.equal(r.matched, true);
    if (!r.matched) return;
    assert.equal(r.verified, true);
    assert.equal(r.semantics.name, "驻车灯已开");
    assert.match(r.evidence, /目录闸门未过（below_delta）.*parking_lights.*成对核验 same/);
    assert.deepEqual(d.calls, ["recall", "decide", "getBySymbol:parking_lights", "iconImage", "verifyPair"]);
  });

  it("目录对上了 → 名字不参与，不做核验", async () => {
    const d = deps({ decided: MATCHED });
    const r = await createHintAwareMatcher(d)(args("parking_lights"));
    assert.equal(r.matched && r.semantics.name, "近光灯已开");
    assert.deepEqual(d.calls, ["recall", "decide"]);
  });

  it("核验说 different / unsure → 仍是「疑似」，来源 detector，理由带上核验结论", async () => {
    for (const verdict of ["different", "unsure"] as const) {
      const r = await createHintAwareMatcher(deps({ verdict }))(args("parking_lights"));
      assert.equal(r.matched, false);
      if (r.matched) return;
      assert.equal(r.topSource, "detector");
      assert.equal(r.top?.name, "驻车灯已开");
      assert.equal(r.reason, `below_delta; hint_verify_${verdict}`);
    }
  });

  it("手册没有那张图 → 不核验，仍为「疑似 · detector」", async () => {
    const d = deps({ icon: null });
    const r = await createHintAwareMatcher(d)(args("parking_lights"));
    assert.equal(r.matched, false);
    if (r.matched) return;
    assert.equal(r.topSource, "detector");
    assert.equal(r.reason, "below_delta");
    assert.ok(!d.calls.includes("verifyPair"));
  });

  it("索引里没这个符号 → 当没给名字", async () => {
    const r = await createHintAwareMatcher(deps({}))(args("not_in_catalog"));
    assert.deepEqual(r, FAILED);
  });

  it("没给名字 → 只走目录匹配", async () => {
    const d = deps({});
    const r = await createHintAwareMatcher(d)(args());
    assert.deepEqual(r, FAILED);
    assert.deepEqual(d.calls, ["recall", "decide"]);
  });
});

describe("接线与 trace", () => {
  const INDEX = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  const VISION = readFileSync(new URL("../src/graph/vision.ts", import.meta.url), "utf8");

  it("index.ts 用 createHintAwareMatcher，不用内联闭包", () => {
    assert.match(INDEX, /createHintAwareMatcher\(\{/);
    assert.equal(/if \(decided\.matched \|\| !symbolHint\) return decided;/.test(INDEX), false, "那段闭包该删干净");
  });

  it("vision 事件的 observed 带 reason / sim / hint，用于排查「为什么没认出来」", () => {
    const at = VISION.indexOf("observed: result.items.slice(0, 8)");
    const block = VISION.slice(at, VISION.indexOf("})),", at));
    for (const k of ["reason:", "sim:", "hint:"]) assert.ok(block.includes(k), `observed 缺 ${k}`);
    assert.match(VISION, /if \(r\.sim !== undefined\) base\.matchSim = r\.sim;/);
  });
});
