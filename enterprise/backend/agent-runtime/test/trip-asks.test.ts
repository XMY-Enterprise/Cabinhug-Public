/**
 * 诉求覆盖判定。
 *
 * 汇聚不仅在分支失败时报缺失，分支成功但没答到车主所问（如「找一天不下雨的」）时也报缺口。
 * 缺口不显式写进求解结果时，应答节点会自行补查，或在没有工具时编造「我帮您查了」。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { unmetAsks, describeMerged, TRIP_ASKS } from "../src/graph/subgraphs/trip";
import { mergeBranches, parseDriveText } from "../src/graph/merge";
import { driveText, legsFrom } from "./helpers/drive-legs";

/** 「找一天不下雨的回去」这一问的意图抽取结果。 */
const GOAL_D454 = "为上海至徐州的返乡返程挑选一天不下雨的日期并安排返程行程";
const CONSTRAINTS_D454 = ["当天不下雨", "返程", "同行有小朋友"];

test("问了天气窗口、分支什么都没查到 → 报缺口", () => {
  const unmet = unmetAsks(GOAL_D454, CONSTRAINTS_D454, undefined);
  assert.equal(unmet.length, 1);
  // 缺口那句话同时说清"缺什么"与"因此不能说什么"；
  // 只说"没查到天气"时，模型仍会自己挑一天推荐。
  assert.match(unmet[0], /没查到天气/);
  assert.match(unmet[0], /不要推荐任何具体日期/);
});

test("分支交回了带日期与天气的证据 → 不报缺口", () => {
  const unmet = unmetAsks(GOAL_D454, CONSTRAINTS_D454, [
    "16 号徐州晴、淮安晴，上海有小雨，22 到 31 度（weather 工具查询）",
  ]);
  assert.deepEqual(unmet, []);
});

test("空洞的 findings 不算答上了", () => {
  // 「天气不错」与「没查」在文本上无法区分，不能作为证据；
  // 放过它会让下游以为查过了而照常推荐日期。
  const unmet = unmetAsks(GOAL_D454, CONSTRAINTS_D454, ["天气还行，适合出门"]);
  assert.equal(unmet.length, 1);
});

test("分支自述「没查到」的 finding 不能当证据", () => {
  // 「未能查到天气，不确定是否下雨」含"雨"字，而证据正则靠这类词判定答上了；
  // 自述没查到的 finding 须先排除，否则缺口判定会被绕过。
  const unmet = unmetAsks(GOAL_D454, CONSTRAINTS_D454, ["未能查到天气数据，不确定是否下雨"]);
  assert.equal(unmet.length, 1);
});

test("一条自述没查到、另一条真查到了 → 仍算答上了", () => {
  // 逐条过滤，不是整段过滤：整段过滤会把有效证据一起丢掉，凭空多报缺口。
  const unmet = unmetAsks(GOAL_D454, CONSTRAINTS_D454, [
    "没有查到实时路况",
    "16 号徐州晴、淮安晴（weather 工具查询）",
  ]);
  assert.deepEqual(unmet, []);
});

test("车主没问天气 → 即使没有 findings 也不报缺口", () => {
  // 不一律要求 findings：多数出行请求只问行程本身，
  // 无差别报缺口会让每一轮回答都多出一句"这次没查到天气"。
  const unmet = unmetAsks(
    "今天下午三点从上海静安开车去南通如东丰利中学，途中下服务区买东西并找加油站",
    ["今天下午三点发车（时间窗约束）", "途中需下服务区购买物品"],
    undefined,
  );
  assert.deepEqual(unmet, []);
});

test("问法在 constraints 里而不在 goal 里，同样要判出来", () => {
  // 意图模型有时把"不下雨"落在 constraints、goal 只写"安排返程"，只看 goal 会漏判。
  const unmet = unmetAsks("安排返程行程", ["当天不下雨"], undefined);
  assert.equal(unmet.length, 1);
});

test("findings 穿过 parse → merge → describe 全程不丢", () => {
  // 正文解析、solve 逐字段重建 draft、describeMerged 三段都须带上 findings；
  // 任一段漏掉，应答模型都看不到，会自己重查一遍。
  // 正文回落只认「整段就是一个 JSON 对象」（ACR-047 的 parseDriveText）。
  const text = driveText(legsFrom([151, 108, 131], ["扬州服务区", "无锡服务区"]), { findings: ["16 号徐州晴、淮安晴（weather 查询）"] });

  const parsed = parseDriveText(text)!;
  assert.deepEqual(parsed.findings, ["16 号徐州晴、淮安晴（weather 查询）"]);

  const merged = mergeBranches([{ agent: "trip-task", status: "ok", text }], []);
  assert.deepEqual(merged.draft.findings, ["16 号徐州晴、淮安晴（weather 查询）"]);

  const described = describeMerged(merged, "icev");
  assert.match(described, /分支查到的事实/);
  assert.match(described, /16 号徐州晴/);
});

test("两条分支各自的 findings 要合并，不能后盖前", () => {
  // 行程侧查天气、补能侧查加油站，覆盖语义会随机丢掉半边。
  const merged = mergeBranches(
    [
      {
        agent: "trip-task",
        status: "ok",
        text: driveText(legsFrom([80, 80], ["崇启大桥服务区"]), { findings: ["16 号沿途晴"] }),
      },
      {
        agent: "ownership-task",
        status: "ok",
        text: '{"energyStops":["中国石化桐本加油站"],"findings":["系统没有实时油量数据"]}',
      },
    ],
    [],
  );
  assert.deepEqual(merged.draft.findings, ["16 号沿途晴", "系统没有实时油量数据"]);
});

test("只交 findings、没交结构化字段的分支仍然算没干活", () => {
  // 否则"分支返回了东西"会掩盖"分支没干成主业"。
  const merged = mergeBranches(
    [{ agent: "trip-task", status: "ok", text: '{"findings":["16 号晴"]}' }],
    [],
  );
  assert.deepEqual(merged.draft.findings, ["16 号晴"]);
  assert.ok(merged.missing.some((m) => m.includes("未返回结构化字段")));
});

test("空串 findings 不能骗过覆盖判定", () => {
  const parsed = parseDriveText('{"findings":["", "   "]}');
  assert.deepEqual(parsed?.findings ?? [], []);
  assert.equal(unmetAsks(GOAL_D454, CONSTRAINTS_D454, parsed?.findings ?? []).length, 1);
});

test("规则表里每条的 asked/answered 不能是同一个意思", () => {
  // 用同一条正则会永远判不出满足：车主说"不下雨"，分支回的是"16 号徐州晴"。
  for (const ask of TRIP_ASKS) {
    assert.notEqual(ask.asked.source, ask.answered.source, `${ask.key} 的两条正则相同`);
  }
});
