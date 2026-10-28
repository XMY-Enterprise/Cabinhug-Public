/**
 * [ACR-065] 补能分支开关：`CABINHUG_TRIP_ENERGY_BRANCH=off` 时骨架轮只发四条腿，缺省仍是五条。
 *
 * 单机版没有车辆档案，这条分支只能答「不知道能源类型」，白占一次模型调用。
 * 缺省必须照旧发：车机端、手机端的续航评估不能因为加了个开关就悄悄没了。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { energyBranchEnabled, runItineraryFanout, type ItineraryInput } from "../src/graph/subgraphs/itinerary";
import type { ChatStreamer } from "../src/llm";

// 走不带 Plan 层的路径：开着时 Plan 层会调真实的高德工具（同 itinerary-fanout-concurrency.test.ts）。
process.env.CABINHUG_TRIP_PLAN_LAYER = "off";

const INPUT: ItineraryInput = {
  goal: "南通三天",
  constraints: [],
  userText: "南通三天",
  energyType: "bev",
  plan: undefined,
  destinations: ["南通"],
  turnId: "t1",
};

const streamer: ChatStreamer = async function* (_m, hooks) {
  const a = hooks?.agent ?? "";
  if (a === "tour-task") return yield '{"destination":"南通","days":[{"day":1,"theme":"x","area":"崇川","spots":[{"name":"濠河"}]}]}';
  if (a === "drive-task") return yield '{"origin":"上海","legMinutes":[150],"stops":[],"findings":[]}';
  if (a === "ownership-task") return yield '{"rangePercent":60,"findings":[]}';
  return yield '{"hotels":[],"findings":[]}';
};

const agentsOf = async (threadId: string) =>
  (await runItineraryFanout(streamer, INPUT, { threadId, highlights: { fetch: async () => undefined } })).branches
    .map((b) => b.agent)
    .sort();

describe("[ACR-065] 补能分支开关", () => {
  afterEach(() => {
    delete process.env.CABINHUG_TRIP_ENERGY_BRANCH;
  });

  it("取值：只有 off（不分大小写、可带空白）才关，其余与缺省一样开着", () => {
    assert.equal(energyBranchEnabled({}), true);
    assert.equal(energyBranchEnabled({ CABINHUG_TRIP_ENERGY_BRANCH: "on" }), true);
    assert.equal(energyBranchEnabled({ CABINHUG_TRIP_ENERGY_BRANCH: " OFF " }), false);
    assert.equal(energyBranchEnabled({ CABINHUG_TRIP_ENERGY_BRANCH: "0" }), true);
  });

  it("缺省：骨架轮五条，含 ownership-task", async () => {
    assert.deepEqual(await agentsOf("e1"), ["drive-task", "hotel-task", "ownership-task", "tour-task", "transit-task"]);
  });

  it("off：骨架轮只有四条腿，不发 ownership-task", async () => {
    process.env.CABINHUG_TRIP_ENERGY_BRANCH = "off";
    assert.deepEqual(await agentsOf("e2"), ["drive-task", "hotel-task", "tour-task", "transit-task"]);
  });
});
