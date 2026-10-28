/**
 * 工具入参 schema 的形状约束。
 *
 * 顶层为 union（如 `z.discriminatedUnion`）的 schema 生成的 JSON Schema 是
 * `{anyOf: [...]}`，没有 `type: "object"`，注册工具表时被上游拒绝；
 * 持有该工具的 Agent 随之对所有问题回空字符串，且不报错。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { TOOL_REGISTRY, describeForPi, assertObjectSchema, type AgentName } from "../src/registry";

const AGENTS: AgentName[] = ["supervisor", "trip", "ownership", "service", "buying", "cabin"];

describe("每个工具的顶层入参 schema 都必须是 object", () => {
  for (const t of TOOL_REGISTRY) {
    it(`${t.name}`, () => {
      const json = zodToJsonSchema(t.schema, { target: "jsonSchema7" }) as Record<string, unknown>;
      assert.equal(json.type, "object", `${t.name} 顶层是 ${JSON.stringify(Object.keys(json))}`);
    });
  }
});

describe("六个 Agent 的工具表都能被取出来", () => {
  for (const agent of AGENTS) {
    it(`${agent} 的工具表不抛错`, () => {
      // schema 不合法时在取工具表这一步抛错，而不是让 Agent 静默回空。
      assert.doesNotThrow(() => describeForPi(agent));
    });
  }
});

describe("assertObjectSchema", () => {
  it("union 会被挡住", () => {
    const bad = zodToJsonSchema(
      z.discriminatedUnion("op", [z.object({ op: z.literal("a") }), z.object({ op: z.literal("b") })]),
      { target: "jsonSchema7" },
    );
    assert.throws(() => assertObjectSchema("demo", bad), /顶层 schema 必须是 object/);
  });

  it("扁平对象 + refine 通过——多态入参的正确写法", () => {
    const good = zodToJsonSchema(
      z.object({ op: z.enum(["a", "b"]), x: z.string().optional() }).refine(() => true),
      { target: "jsonSchema7" },
    );
    assert.doesNotThrow(() => assertObjectSchema("demo", good));
  });

  it("错误信息要指出怎么改，不是只说不合法", () => {
    const bad = zodToJsonSchema(z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]), {
      target: "jsonSchema7",
    });
    assert.throws(() => assertObjectSchema("demo", bad), /扁平对象.*refine/);
  });
});

/**
 * [F-18-15][AC-18-11] 行程快照 schema 不得把落库字段静默剥掉。
 *
 * zod 是 strip 模式：`trip_plan_commit` / `trip_plan_update` 的 schema 里没声明的字段，
 * 在落库时被无声丢掉，表现为服务端已算出、链路无报错、界面不显示。
 *
 * 测试逐字段对照契约：往 `TripPlanDaySnapshot` 加字段而未在 schema 声明时，这里失败。
 */
describe("行程快照 schema：契约里有的字段必须落得了库", () => {
  const commit = TOOL_REGISTRY.find((t) => t.name === "trip_plan_commit")!;
  const update = TOOL_REGISTRY.find((t) => t.name === "trip_plan_update")!;

  /** 每天所有可选字段都填满的快照，parse 之后逐个检查是否保留。 */
  const full = {
    status: "confirmed",
    destination: "苏州",
    origin: "上海",
    days: 2,
    skeleton: [
      {
        day: 1,
        theme: "一",
        spots: [
          {
            name: "苏州博物馆",
            lat: 31.32,
            lon: 120.63,
            poiKind: "museum",
            estStart: "09:00",
            estEnd: "11:00",
          },
        ],
        hotel: { name: "客栈", lat: 31.31, lon: 120.62, estPrice: "约300-500/晚（估算）" },
        lodging: { strategy: "checkin-evening", note: "行李放车上" },
      },
      {
        day: 2,
        theme: "二",
        spots: [{ name: "虎丘", estStart: "09:00", estEnd: "11:30" }],
        startLeg: { fromName: "客栈", driveMinutes: 22, computedAt: "2026-09-14T10:00:00.000Z" },
        endLeg: { toName: "客栈", driveMinutes: 18, computedAt: "2026-09-14T10:00:00.000Z" },
      },
    ],
    energyStops: ["某服务区充电站"],
    legs: [{ day: 1, fromStop: "上海", toStop: "客栈", driveMinutes: 86, reason: "rest" }],
    caveats: ["价格为估算"],
    updatedTurnId: "t",
  };

  for (const [label, tool, wrap] of [
    ["trip_plan_commit", commit, (p: unknown) => ({ userId: "demo-user", plan: p })],
    ["trip_plan_update", update, (p: unknown) => ({ userId: "demo-user", planId: "cmu0jbd0400028ofk3lrkfze2", plan: p })],
  ] as const) {
    it(`${label}：坐标、品类、时段、住宿策略、分段、补能点、startLeg 一个都不许被 strip`, () => {
      const parsed = tool.schema.parse(wrap(full)) as { plan: typeof full };
      const d1 = parsed.plan.skeleton[0]!;
      const d2 = parsed.plan.skeleton[1]!;
      assert.equal(d1.spots[0]!.lat, 31.32, "坐标（M13-06 那次）");
      assert.equal(d1.spots[0]!.poiKind, "museum", "贴纸品类（M13-07 那次）");
      assert.equal(d1.spots[0]!.estStart, "09:00", "建议时段（M34-01 那次）");
      assert.equal(d1.hotel!.lat, 31.31, "酒店坐标");
      assert.equal(d1.lodging!.strategy, "checkin-evening", "住宿策略");
      assert.deepEqual(parsed.plan.legs, full.legs, "行车分段（M77-01 那次）");
      assert.deepEqual(parsed.plan.energyStops, full.energyStops, "补能点");
      assert.deepEqual(
        d2.startLeg,
        { fromName: "客栈", driveMinutes: 22, computedAt: "2026-09-14T10:00:00.000Z" },
        "startLeg（M83 走查追修那次）——真跑里它就死在这一行之前",
      );
      assert.deepEqual(
        d2.endLeg,
        { toName: "客栈", driveMinutes: 18, computedAt: "2026-09-14T10:00:00.000Z" },
        "endLeg：最后一站到酒店的车程，与 startLeg 同一条",
      );
    });
  }

  it("契约里 TripPlanDaySnapshot 的每个字段，schema 里都有声明", () => {
    const src = readFileSync(
      new URL("../../../../../contracts/src/domain/trip-plan.ts", import.meta.url),
      "utf8",
    );
    const block = src.slice(
      src.indexOf("export interface TripPlanDaySnapshot {"),
      src.indexOf("/** 一段行车（M77-01）"),
    );
    const fields = [...block.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!);
    assert.ok(fields.includes("startLeg"), "夹具本身要跟着契约走");
    const declared = TOOL_REGISTRY.find((t) => t.name === "trip_plan_commit")!.schema.toString();
    void declared;
    // zod 对象拿不到键名列表（toString 不可靠），所以用 parse 兜底：
    // 逐字段塞一个可辨识的值，parse 之后还在就说明声明过。
    const probe: Record<string, unknown> = {
      day: 9,
      date: "2026-09-15",
      theme: "x",
      area: "古城",
      spots: [],
      hotel: { name: "h" },
      lodging: { strategy: "checkin-evening" },
      startLeg: { fromName: "h", driveMinutes: 1, computedAt: "t" },
      endLeg: { toName: "h", driveMinutes: 2, computedAt: "t" },
      notes: ["n"],
    };
    const out = commit.schema.parse({
      userId: "demo-user",
      plan: { ...full, skeleton: [probe] },
    }) as { plan: { skeleton: Array<Record<string, unknown>> } };
    const kept = Object.keys(out.plan.skeleton[0]!);
    for (const f of fields) {
      assert.ok(kept.includes(f), `契约有 \`${f}\`，schema 没声明——它会在落库时被静默剥掉`);
    }
  });
});
