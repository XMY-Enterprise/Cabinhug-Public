/**
 * [F-18-05][F-54-07] 实测满电续航作为事实进自驾分支的提示词。
 *
 * ④ 车辆档案里没有续航字段，drive 分支也没有能查到它的工具；没有事实时，
 * `charging` 的 rangeKm 会落在 400 / 450 / 500 这类整数档上。
 * 唯一有出处的续航是 ⑥ 用车画像的实测值。这里钉住：画像 → 事实的三档映射、
 * 事实只进 drive（与续航评估）的提示词、以及"没有"时的措辞是"不要编"而不是沉默。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { rangeFact, type VehicleRangeFacts } from "../src/graph/energy";
import { loadVehicleEnergyFacts, rangeFactsFromUsage } from "../src/graph/range-facts";
import { runItineraryFanout, type ItineraryInput } from "../src/graph/subgraphs/itinerary";
import type { ChatStreamer } from "../src/llm";

/*
 * 这些用例走不经 Plan 层的 fan-out 路径，Plan 层显式关掉（缺省是 `plan`）。
 * 不关的话 `maybeRunPlanLayer` 会去调 `city_districts` / `spot_search`；`CABINHUG_TOOLS` 缺省 real，单测会打真网络。
 */
process.env.CABINHUG_TRIP_PLAN_LAYER = "off";

const usable = {
  summary: {
    windowDays: 30,
    avgDailyKm: 38.6,
    commonChargeHours: [22],
    lowTempRangeKm: 268,
    mildTempRangeKm: 402.4,
    sampleSize: 24,
    staleDays: 1.2,
    derivation: [],
  },
  verdict: { usable: true as const },
  fetched: 24,
};

describe("画像 → 续航事实", () => {
  it("可用且有实测续航：两档都带上，连同样本量与窗口", () => {
    const r = rangeFactsFromUsage(usable);
    assert.deepEqual(r, { status: "measured", mildTempRangeKm: 402.4, lowTempRangeKm: 268, sampleSize: 24, windowDays: 30 });
  });

  it("画像不可用（样本不足 / 过期）：原因原样带出，不回落到任何默认值", () => {
    const r = rangeFactsFromUsage({ ...usable, verdict: { usable: false, reason: "样本不足（2 条，需要至少 5 条）" } });
    assert.deepEqual(r, { status: "unavailable", reason: "样本不足（2 条，需要至少 5 条）" });
  });

  it("画像可用但没有一条带实测续航的行程：也是「不可用」，且说清缺的是续航记录", () => {
    const r = rangeFactsFromUsage({ ...usable, summary: { ...usable.summary, lowTempRangeKm: undefined, mildTempRangeKm: undefined } });
    assert.equal(r.status, "unavailable");
    assert.match((r as { reason: string }).reason, /实测续航记录/);
  });

  it("0 km 当没有——否则会进提示词再被 charging 以「续航里程必须为正数」拒掉", () => {
    const r = rangeFactsFromUsage({ ...usable, summary: { ...usable.summary, lowTempRangeKm: 0, mildTempRangeKm: 0 } });
    assert.equal(r.status, "unavailable");
  });

  it("取数失败不阻塞：按「不可用」处理并带原因", async () => {
    const r = await loadVehicleEnergyFacts({ userId: "u1" }, { sessionId: "s" }, "bev", async () => {
      throw new Error("db down");
    });
    assert.deepEqual(r.range, { status: "unavailable", reason: "用车画像读取失败" });
  });
});

describe("rangeFact 的措辞", () => {
  it("有实测：数字、出处、以及「拿它填 rangeKm」的动作都在，并明说不要用整数档顶替", () => {
    const line = rangeFact({ status: "measured", mildTempRangeKm: 402.4, lowTempRangeKm: 268, sampleSize: 24, windowDays: 30 })!;
    assert.match(line, /常温约 402 km/);
    assert.match(line, /低温约 268 km/);
    assert.match(line, /24 条行程/);
    assert.match(line, /rangeKm 取这里的数/);
    assert.match(line, /startSoc 按满电 1\.0/);
    assert.match(line, /不要用标称值/);
  });

  it("只有一档时只写那一档", () => {
    const line = rangeFact({ status: "measured", mildTempRangeKm: 402, sampleSize: 8, windowDays: 30 })!;
    assert.match(line, /常温约 402 km/);
    assert.ok(!line.includes("低温"));
  });

  it("没有实测：说的是「不要编一个 rangeKm 去调 charging」，不是沉默", () => {
    const line = rangeFact({ status: "unavailable", reason: "还没有任何用车流水" })!;
    assert.match(line, /还没有任何用车流水/);
    assert.match(line, /不要编一个 rangeKm/);
    assert.match(line, /提交空数组/);
  });

  it("燃油车 / 能源类型未知（缺省）：一行都不加", () => {
    assert.equal(rangeFact(undefined), undefined);
  });
});

describe("事实只进 drive 与续航评估的提示词（端到端形态）", () => {
  async function promptsFor(range: VehicleRangeFacts | undefined) {
    const seen: Record<string, string> = {};
    const streamer: ChatStreamer = async function* (messages, hooks) {
      seen[hooks?.agent ?? "?"] = messages[messages.length - 1]?.content ?? "";
      yield "";
    };
    const input: ItineraryInput = {
      goal: "南通三天",
      constraints: [],
      userText: "南通三天",
      energyType: "bev",
      ...(range ? { range } : {}),
      turnId: "t1",
    };
    await runItineraryFanout(streamer, input, { threadId: "s-range", highlights: { fetch: async () => undefined } });
    return seen;
  }

  it("drive 与 ownership-task 拿到实测续航；hotel / tour / transit 不拿（对它们只是噪音）", async () => {
    const seen = await promptsFor({ status: "measured", mildTempRangeKm: 402, lowTempRangeKm: 268, sampleSize: 24, windowDays: 30 });
    assert.match(seen["drive-task"] ?? "", /常温约 402 km/);
    assert.match(seen["ownership-task"] ?? "", /常温约 402 km/);
    for (const a of ["hotel-task", "tour-task", "transit-task"]) {
      assert.ok(!(seen[a] ?? "").includes("满电续航"), `${a} 不该收到续航事实`);
    }
  });

  it("ownership 拿到的是不指派 charging 的那一档：它的工具表里没有 charging", async () => {
    const seen = await promptsFor({ status: "measured", mildTempRangeKm: 402, lowTempRangeKm: 268, sampleSize: 24, windowDays: 30 });
    const own = seen["ownership-task"] ?? "";
    /*
     * 同一份提示词若既说"你手里没有充电站工具"、又教它填 charging 的 rangeKm / startSoc，
     * 模型会把续航数塞进它手里唯一吃这个数的工具 `energy_gap`，当成百公里能耗。
     */
    for (const forbidden of ["rangeKm 取这里的数", "startSoc"]) {
      assert.ok(!own.includes(forbidden), `ownership 不该收到 ${forbidden}`);
    }
    assert.match(own, /不是百公里能耗/);
    // drive 那一档一个字没变。
    assert.match(seen["drive-task"] ?? "", /rangeKm 取这里的数/);
  });

  it("没有实测续航时 drive 被明确告知不要编 rangeKm", async () => {
    const seen = await promptsFor({ status: "unavailable", reason: "样本不足（2 条，需要至少 5 条）" });
    assert.match(seen["drive-task"] ?? "", /不要编一个 rangeKm/);
  });

  it("没给 range（燃油车那条路）：提示词逐字不含续航那一行", async () => {
    const seen = await promptsFor(undefined);
    assert.ok(!(seen["drive-task"] ?? "").includes("满电续航"));
  });
});
