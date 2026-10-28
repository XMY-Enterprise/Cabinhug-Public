/**
 * 提交类工具「收下但丢掉」的两个字段位。
 *
 * 模型会在提交里带上未声明的字段：tour 的景点带 lat/lon（提示词要求把坐标传给
 * route_audit，submit_guide_spots 的同名字段也接受坐标），guide 把每条的 sourceUrl
 * 提到顶层。pi 按 JSON Schema 的 `additionalProperties: false` 会在工具执行之前
 * 整次拒掉，模型只能重写整份提交（一次重写约 6 秒，占规划节点 22 秒的四分之一），
 * 且 trace 里没有这次工具调用。
 *
 * 做法：声明这几个名字（不打回），值一律丢弃（ADR-008：不采用模型给的坐标）。
 * 两者须同时成立。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getTool } from "../src/registry";

const jsonSchemaOf = (name: string): Record<string, any> =>
  zodToJsonSchema(getTool(name)!.schema as never, { target: "jsonSchema7" }) as Record<string, any>;

const tourSpotSchema = () =>
  jsonSchemaOf("submit_tour_days").properties.days.items.properties.spots.items;

describe("提交类工具：多余字段收下但丢掉", () => {
  it("pi 看到的 spots 里有 lat/lon：带坐标交上来不会被打回", () => {
    const spot = tourSpotSchema();
    assert.ok(spot.properties.lat, "lat 没声明的话 pi 会整次拒掉，模型要重写整份行程");
    assert.ok(spot.properties.lon);
  });

  it("坐标不进 parsed.data（ADR-008）", () => {
    const parsed = getTool("submit_tour_days")!.schema.parse({
      days: [{ day: 1, spots: [{ name: "南通狼山风景名胜区", lat: 31.948766, lon: 120.88776 }] }],
    }) as { days: Array<{ spots: Array<Record<string, unknown>> }> };
    const spot = parsed.days[0].spots[0];
    assert.equal(spot.name, "南通狼山风景名胜区");
    assert.ok(!("lat" in spot), "模型坐标必须在这里就被丢掉，不能流到落库/地图");
    assert.ok(!("lon" in spot));
  });

  it("已声明的字段照常收下，不被这个 transform 误伤", () => {
    const parsed = getTool("submit_tour_days")!.schema.parse({
      days: [{ day: 1, spots: [{ name: "啬园", indoor: false, estStart: "08:30", estEnd: "10:00" }] }],
    }) as { days: Array<{ spots: Array<Record<string, unknown>> }> };
    assert.deepEqual(parsed.days[0].spots[0], {
      name: "啬园",
      indoor: false,
      estStart: "08:30",
      estEnd: "10:00",
    });
  });

  it("不是改成 passthrough：拼错的字段仍然被 pi 打回", () => {
    // zod 对未知键是静默 strip，能报出拼错字段的只有 pi 按 JSON Schema 做的
    // additionalProperties 检查。写成 .passthrough() 后，`start` 之于 `estStart`
    // 这类拼错会被静默吞掉，时段整天消失且链路无报错。
    assert.equal(tourSpotSchema().additionalProperties, false);
    const allowed = Object.keys(tourSpotSchema().properties).sort();
    assert.deepEqual(allowed, ["estEnd", "estStart", "indoor", "lat", "lon", "name"]);
  });

  it("submit_guide_comfort：顶层 sourceUrl 收下（每条自己的那个照旧必填必验）", () => {
    const root = jsonSchemaOf("submit_guide_comfort");
    assert.ok(root.properties.sourceUrl, "模型把出处提到了顶层，不声明就要重写整份 entries");
    const entry = root.properties.entries.items;
    assert.ok(entry.properties.sourceUrl, "每条自己的出处不受影响");
    assert.ok(entry.required.includes("note"));
  });
});
