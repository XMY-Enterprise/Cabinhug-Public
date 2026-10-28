/**
 * [F-58-02][AC-58-2] `submit_drive_plan` 的逐段校验（ACR-047）。
 *
 * 平行数组契约要求模型自己维持跨数组的长度不变量，且回程有两个合法落点，
 * 会出现回程重复、累计时长翻倍、用空串凑数过校验。这里每一段自描述，
 * 没有跨数组的个数不变量，每条退回只点名一段。
 *
 * 判据是契约能否表达出重复：回程只有一种表达方式。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { assertDriveLegs, setBranchSubmissionSink, type DriveLeg } from "../src/branch-submit";
import { invokeTool } from "../src/registry";

const ctx = { sessionId: "s1", turnId: "t1", agent: "drive" };
const sink = (recorded: unknown[]) =>
  setBranchSubmissionSink({
    record(_c, _t, payload) {
      recorded.push(payload);
      return true;
    },
  });

/** 上海⇄黄山五日行程按段列表契约应提交的样子。 */
const HUANGSHAN: DriveLeg[] = [
  { day: 1, direction: "outbound", from: "上海", to: { kind: "rest", name: "嘉兴服务区(沪昆高速昆明方向)", charging: true }, minutes: 103 },
  { day: 1, direction: "outbound", from: "嘉兴服务区(沪昆高速昆明方向)", to: { kind: "rest", name: "临安服务区(杭瑞高速瑞丽方向)" }, minutes: 103 },
  { day: 1, direction: "outbound", from: "临安服务区(杭瑞高速瑞丽方向)", to: { kind: "overnight", name: "屯溪区" }, minutes: 104 },
  { day: 2, direction: "outbound", from: "屯溪区", to: { kind: "overnight", name: "黄山区" }, minutes: 98 },
  { day: 3, direction: "outbound", from: "黄山区", to: { kind: "overnight", name: "黟县" }, minutes: 145 },
  { day: 4, direction: "outbound", from: "黟县", to: { kind: "overnight", name: "祁门县" }, minutes: 58 },
  { day: 5, direction: "outbound", from: "祁门县", to: { kind: "spot", name: "牯牛降历溪" }, minutes: 62 },
  { day: 5, direction: "return", from: "牯牛降历溪", to: { kind: "rest", name: "徽州古城服务区(杭瑞高速杭州方向)" }, minutes: 104 },
  { day: 5, direction: "return", from: "徽州古城服务区(杭瑞高速杭州方向)", to: { kind: "rest", name: "月湾服务区(溧宁高速溧阳方向)" }, minutes: 79 },
  { day: 5, direction: "return", from: "月湾服务区(溧宁高速溧阳方向)", to: { kind: "rest", name: "平望服务区(沪渝高速上海方向)" }, minutes: 103 },
  { day: 5, direction: "return", from: "平望服务区(沪渝高速上海方向)", to: { kind: "origin", name: "上海" }, minutes: 107 },
];

describe("[F-58-02] submit_drive_plan：段列表契约", () => {
  afterEach(() => setBranchSubmissionSink(undefined));

  it("上海⇄黄山五日按段列表契约一次过：原样落槽，第 5 天累计 = 455 而不是 848", async () => {
    const recorded: unknown[] = [];
    sink(recorded);
    await invokeTool("submit_drive_plan", { origin: "上海", legs: HUANGSHAN, findings: ["x"] }, ctx);
    assert.equal(recorded.length, 1);
    const p = recorded[0] as { legs: DriveLeg[]; origin: string };
    assert.equal(p.origin, "上海");
    assert.equal(p.legs.length, 11);
    const day5 = p.legs.filter((l) => l.day === 5).reduce((a, l) => a + l.minutes, 0);
    assert.equal(day5, 455, "回程只有一个落点，不可能再被算一遍");
    assert.equal(p.legs.filter((l) => l.direction === "return").length, 4);
  });

  it("空提交合法：算不出就交空 legs + findings，不在这里拦", async () => {
    const recorded: unknown[] = [];
    sink(recorded);
    await invokeTool("submit_drive_plan", { legs: [], findings: ["map_route 超时"] }, ctx);
    assert.equal((recorded[0] as { legs: unknown[] }).legs.length, 0);
  });

  it("回程再抄一遍成 outbound 被退回，文案点名「只放一份」", () => {
    const dup: DriveLeg[] = [
      ...HUANGSHAN,
      { day: 5, direction: "outbound", from: "牯牛降历溪", to: { kind: "rest", name: "徽州古城服务区(杭瑞高速杭州方向)" }, minutes: 104 },
    ];
    const problems = assertDriveLegs(dup);
    // 连带还会报「origin 不是最后一段」「最后一段不是 origin」；这里断言点名到那一段的这条。
    const hit = problems.find((p) => /第 12 段 direction=outbound 出现在回程之后/.test(p));
    assert.ok(hit, problems.join("|"));
    assert.match(hit!, /只放一份/);
  });

  it("空名字被 schema 挡下", async () => {
    sink([]);
    const legs: DriveLeg[] = [
      { day: 1, direction: "outbound", from: "上海", to: { kind: "rest", name: "" }, minutes: 103 },
      { day: 1, direction: "outbound", from: "", to: { kind: "overnight", name: "屯溪区" }, minutes: 104 },
    ];
    // zod 层退回的文案告诉模型该改成什么，而不是 "String must contain at least 1 character(s)"。
    await assert.rejects(() => invokeTool("submit_drive_plan", { legs }, ctx), /入参不合法.*不要用空串占位/);
  });

  it("接续断裂点名到段：第 N 段 from 接不上第 N-1 段 to", () => {
    const legs: DriveLeg[] = [
      { day: 1, direction: "outbound", from: "上海", to: { kind: "rest", name: "嘉兴服务区" }, minutes: 103 },
      { day: 1, direction: "outbound", from: "苏州服务区", to: { kind: "overnight", name: "屯溪区" }, minutes: 104 },
    ];
    const problems = assertDriveLegs(legs);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /第 2 段 from「苏州服务区」接不上第 1 段 to「嘉兴服务区」/);
  });

  it("同一天里把途经县城标成 overnight 又接着开：不退回，这两个 kind 只作说明、不进任何判据", () => {
    const legs: DriveLeg[] = [
      { day: 2, direction: "outbound", from: "康定", to: { kind: "overnight", name: "丁青县" }, minutes: 180 },
      { day: 2, direction: "outbound", from: "丁青县", to: { kind: "overnight", name: "比如县" }, minutes: 120 },
    ];
    assert.deepEqual(assertDriveLegs(legs), []);
  });

  it("origin 只能在最后一段；有回程时最后一段必须是 origin；天不能倒退；第 1 段不能是 return", () => {
    const base = HUANGSHAN.slice(0, 3);
    assert.match(assertDriveLegs([{ ...base[0]!, to: { kind: "origin", name: "上海" } }, base[1]!, base[2]!])[0]!, /第 1 段 to.kind=origin 但它不是最后一段/);
    assert.match(
      assertDriveLegs([...base, { day: 2, direction: "return", from: "屯溪区", to: { kind: "rest", name: "某服务区" }, minutes: 100 }]).at(-1)!,
      /最后一段的 to.kind 不是 origin/,
    );
    assert.match(assertDriveLegs([base[0]!, { ...base[1]!, day: 0 }])[0]!, /day=0 不是从 1 起的整数/);
    assert.match(assertDriveLegs([{ ...base[0]!, day: 2 }, { ...base[1]!, day: 1 }])[0]!, /天只能往后走/);
    assert.match(assertDriveLegs([{ ...base[0]!, direction: "return" }])[0]!, /第 1 段就是 return/);
  });

  it("单程（没有回程段）合法：最后一段到 overnight 即可", () => {
    assert.deepEqual(assertDriveLegs(HUANGSHAN.slice(0, 3)), []);
  });

  it("退回文案以「不要为了让数字对上而删除已经查到的停靠点或合并段」收尾", async () => {
    sink([]);
    const legs: DriveLeg[] = [
      { day: 1, direction: "outbound", from: "上海", to: { kind: "rest", name: "嘉兴服务区" }, minutes: 103 },
      { day: 1, direction: "outbound", from: "苏州服务区", to: { kind: "overnight", name: "屯溪区" }, minutes: 104 },
    ];
    await assert.rejects(
      () => invokeTool("submit_drive_plan", { legs }, ctx),
      (err: Error) => /不要为了让数字对上而删除已经查到的停靠点或合并段。$/.test(err.message),
    );
  });
});

describe("[F-58-02] submit_range_assessment：续航结论走工具", () => {
  afterEach(() => setBranchSubmissionSink(undefined));
  const octx = { sessionId: "s1", turnId: "t1", agent: "ownership" };

  it("measured 带数字原样落槽；unavailable 不许带数字；measured 不带数字被退回", async () => {
    const recorded: unknown[] = [];
    sink(recorded);
    await invokeTool("submit_range_assessment", { basis: "measured", rangeMarginPct: -190, sampleSize: 53, windowDays: 30, chargeStopsNeeded: 2 }, octx);
    assert.deepEqual(recorded[0], { basis: "measured", rangeMarginPct: -190, sampleSize: 53, windowDays: 30, chargeStopsNeeded: 2, findings: [] });
    await assert.rejects(() => invokeTool("submit_range_assessment", { basis: "unavailable", rangeMarginPct: 10 }, octx), /不要再给 rangeMarginPct/);
    await assert.rejects(() => invokeTool("submit_range_assessment", { basis: "estimated" }, octx), /必须带 rangeMarginPct/);
    await invokeTool("submit_range_assessment", { basis: "unavailable", findings: ["没有实测续航"] }, octx);
    assert.deepEqual(recorded[1], { basis: "unavailable", findings: ["没有实测续航"] });
  });
});

describe("[F-58-02] submit_intent：意图四要素走工具", () => {
  afterEach(() => setBranchSubmissionSink(undefined));

  it("整个对象原样落槽（白名单在 runtime 的 parseIntent），未知字段透传", async () => {
    const recorded: unknown[] = [];
    sink(recorded);
    await invokeTool(
      "submit_intent",
      { goal: "订一份上海到黄山的五日行程", route: "itinerary", constraints: ["五天"], tripLimits: { days: 5 }, destinations: ["黄山"], extra: 1 },
      { sessionId: "s1", turnId: "t1", agent: "supervisor" },
    );
    const p = recorded[0] as Record<string, unknown>;
    assert.equal(p.goal, "订一份上海到黄山的五日行程");
    assert.equal(p.route, "itinerary");
    assert.deepEqual(p.tripLimits, { days: 5 });
    assert.equal(p.extra, 1);
  });
});
