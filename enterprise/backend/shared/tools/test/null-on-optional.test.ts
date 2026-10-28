/**
 * [F-13-02] 可选字段填 null 当作没填。
 *
 * 模型常对可选字段写 `null`（如连住日 `"lodging": null`）。pi 按发出去的 JSON Schema
 * 校验，`.optional()` 不接受 null，会在工具执行之前整次拒掉，模型只能整份重写
 * （222 个分支会话中 9 次因此被打回，合计 51.4 秒）。
 *
 * 这与"容忍多余字段"无关：拼错的键有歧义，吞掉就是字段凭空消失；
 * 而可选字段上的 null 与"键不存在"表达同一件事。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allowNullOnOptional, describeForPi, getTool, stripNulls, TOOL_REGISTRY } from "../src/registry";

const tourParams = () => describeForPi("tour").find((t) => t.name === "submit_tour_days")!.parameters as any;

/*
 * 发给 pi 的 schema 里不能有 `$ref`：可选字段被套进 `anyOf` 之后，指针指向的路径不再存在，
 * DeepSeek 整次回 400（`Pointer '…/spots/items/properties/lat' does not exist`），
 * 该 Agent 每一轮都是空输出，行程只剩路线、逐天骨架为 0 天。
 */
describe("发给 pi 的 schema 不含 $ref", () => {
  const agents = [...new Set(TOOL_REGISTRY.flatMap((t) => t.agents))];

  for (const agent of agents) {
    it(`${agent}：每个工具的 parameters 都没有 $ref`, () => {
      for (const t of describeForPi(agent)) {
        assert.ok(!JSON.stringify(t.parameters).includes('"$ref"'), `${t.name} 的 schema 里有 $ref`);
      }
    });
  }

  it("submit_tour_days 的 lon 原样展开，不指向 lat", () => {
    const spot = tourParams().properties.days.items.properties.spots.anyOf[0].items;
    assert.equal(spot.properties.lon.anyOf?.[0]?.type, "number");
  });
});

describe("[F-13-02] 发给 pi 的 schema：可选可 null、必填不动", () => {
  it("可选字段成了「原类型 或 null」", () => {
    const day = tourParams().properties.days.items;
    assert.deepEqual(day.properties.day.anyOf?.[1], { type: "null" });
    assert.ok(JSON.stringify(day.properties.lodging.anyOf?.[1]) === '{"type":"null"}');
  });

  it("必填字段仍然不许 null", () => {
    const spot = tourParams().properties.days.items.properties.spots.anyOf[0].items;
    assert.deepEqual(spot.required, ["name"]);
    assert.equal(spot.properties.name.anyOf, undefined, "name 是必填，不该被套上 null");
    assert.ok(spot.properties.indoor.anyOf, "indoor 可选，该可以是 null");
  });

  it("additionalProperties 仍然是 false：拼错的键照旧打回", () => {
    const spot = tourParams().properties.days.items.properties.spots.anyOf[0].items;
    assert.equal(spot.additionalProperties, false);
  });

  it("已经允许 null 的不再套第二层", () => {
    const out: any = allowNullOnOptional({
      type: "object",
      properties: { x: { anyOf: [{ type: "string" }, { type: "null" }] } },
      required: [],
    });
    assert.equal(out.properties.x.anyOf.length, 2);
  });

  it("嵌套结构逐层处理：items 与 anyOf 里的对象也生效", () => {
    const out: any = allowNullOnOptional({
      type: "object",
      properties: { list: { type: "array", items: { type: "object", properties: { a: { type: "string" } }, required: [] } } },
      required: ["list"],
    });
    assert.deepEqual(out.properties.list.items.properties.a.anyOf[1], { type: "null" });
    assert.equal(out.properties.list.anyOf, undefined, "list 是必填，不套");
  });

  it("入参不被就地改写", () => {
    const src = { type: "object", properties: { a: { type: "string" } }, required: [] };
    allowNullOnOptional(src);
    assert.deepEqual(src.properties.a, { type: "string" });
  });
});

describe("[F-13-02] stripNulls：zod 与下游永远见不到 null", () => {
  it("删掉值为 null 的键，保留其它", () => {
    assert.deepEqual(stripNulls({ a: 1, b: null, c: { d: null, e: 2 } }), { a: 1, c: { e: 2 } });
  });

  it("数组里的 null 保留：那是位置，删了会错位", () => {
    assert.deepEqual(stripNulls({ xs: [1, null, 3] }), { xs: [1, null, 3] });
  });

  it("undefined 与 0 / 空串 / false 不受影响", () => {
    assert.deepEqual(stripNulls({ a: 0, b: "", c: false }), { a: 0, b: "", c: false });
  });
});

describe("[F-13-02] 连住日 lodging 为 null 的提交可以通过", () => {
  const parse = (args: unknown) => getTool("submit_tour_days")!.schema.safeParse(stripNulls(args));

  it("第 2 天 lodging: null → 通过，且解析结果里没有 lodging 这个键", () => {
    const r = parse({
      destination: "南通",
      days: [
        { day: 1, theme: "a", area: "崇川", spots: [{ name: "濠河" }], lodging: { strategy: "checkin-evening" } },
        { day: 2, theme: "b", area: "狼山", spots: [{ name: "狼山" }], lodging: null },
      ],
    });
    assert.ok(r.success, `应通过，实际 ${JSON.stringify(r.success ? "" : r.error.issues)}`);
    const days = (r as { data: { days: Array<Record<string, unknown>> } }).data.days;
    assert.ok(!("lodging" in days[1]!), "null 要被当成没填，不能留个 null 给下游");
    assert.ok("lodging" in days[0]!, "真填了的那天照旧");
  });

  it("必填字段填 null 仍然失败：lodging.strategy 是必填", () => {
    const r = parse({ days: [{ day: 1, spots: [], lodging: { strategy: null } }] });
    assert.equal(r.success, false);
  });

  it("景点名填 null 仍然失败", () => {
    assert.equal(parse({ days: [{ day: 1, spots: [{ name: null }] }] }).success, false);
  });
});
