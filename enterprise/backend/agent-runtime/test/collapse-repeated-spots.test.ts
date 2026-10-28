/**
 * [F-58-06] 同名相邻段并成一段。
 *
 * 两种形态名字相同、处理相反：
 *   09:30-12:00 唐闸 / 12:00-13:30 唐闸   → 一次游玩拆成两行，合并
 *   15:40-17:30 濠河 / …城隍庙… / 19:30-21:00 濠河 → 夜游压轴，保留
 * tour.md 规定「夜游/演出/夜市压轴，时段落在晚间」，后者是期望形态。
 * 仅凭名字无法区分，判据必须包含时段。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collapseRepeatedSpots, dayTimesValid } from "../src/graph/subgraphs/itinerary";

describe("[F-58-06] collapseRepeatedSpots", () => {
  it("首尾相接的同名两段并成 09:30-13:30", () => {
    const out = collapseRepeatedSpots([
      { name: "唐闸民族工业风情小镇", estStart: "09:30", estEnd: "12:00", indoor: false },
      { name: "唐闸民族工业风情小镇", estStart: "12:00", estEnd: "13:30", indoor: true },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.estStart, "09:30");
    assert.equal(out[0]!.estEnd, "13:30");
    // 室内属性取保守值：任一段为露天，合并结果即为露天。
    assert.equal(out[0]!.indoor, false);
  });

  it("隔开的两趟原样保留：那是夜游，不是重复", () => {
    const day = [
      { name: "南通濠河风景名胜区", estStart: "15:40", estEnd: "17:30" },
      { name: "城隍庙", estStart: "17:40", estEnd: "18:30" },
      { name: "南通濠河风景名胜区", estStart: "19:30", estEnd: "21:00" },
    ];
    assert.deepEqual(collapseRepeatedSpots(day), day);
  });

  it("同名但不相邻、且时段接得上也不并（中间隔着别的点就是两趟）", () => {
    const day = [
      { name: "A", estStart: "09:00", estEnd: "11:00" },
      { name: "B", estStart: "11:00", estEnd: "12:00" },
      { name: "A", estStart: "12:00", estEnd: "13:00" },
    ];
    assert.equal(collapseRepeatedSpots(day).length, 3);
  });

  it("相邻同名但中间空了一段时间：不并也不报，留两行", () => {
    const day = [
      { name: "A", estStart: "09:00", estEnd: "11:00" },
      { name: "A", estStart: "19:00", estEnd: "21:00" },
    ];
    assert.equal(collapseRepeatedSpots(day).length, 2);
  });

  it("重叠也算接得上：取最早开始与最晚结束", () => {
    const out = collapseRepeatedSpots([
      { name: "A", estStart: "09:00", estEnd: "12:30" },
      { name: "A", estStart: "11:00", estEnd: "13:00" },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.estStart, "09:00");
    assert.equal(out[0]!.estEnd, "13:00");
  });

  it("两边都没有时段：同名连着写只有拆行一种解释，并掉", () => {
    assert.equal(collapseRepeatedSpots([{ name: "A" }, { name: "A" }, { name: "B" }]).length, 2);
  });

  it("一有时段一没有：说不清，不并", () => {
    const day = [{ name: "A", estStart: "09:00", estEnd: "11:00" }, { name: "A" }];
    assert.equal(collapseRepeatedSpots(day).length, 2);
  });

  it("空名字不与空名字相并", () => {
    assert.equal(collapseRepeatedSpots([{ name: "  " }, { name: "" }]).length, 2);
  });

  it("三段连着接力也并成一段", () => {
    const out = collapseRepeatedSpots([
      { name: "A", estStart: "09:00", estEnd: "11:00" },
      { name: "A", estStart: "11:00", estEnd: "13:00" },
      { name: "A", estStart: "13:00", estEnd: "15:00" },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.estStart, "09:00");
    assert.equal(out[0]!.estEnd, "15:00");
  });

  it("并完的结果仍能过时段校验——否则整天时段会被后面那道闸丢掉", () => {
    const out = collapseRepeatedSpots([
      { name: "唐闸", estStart: "09:30", estEnd: "12:00" },
      { name: "唐闸", estStart: "12:00", estEnd: "13:30" },
      { name: "南通森林野生动物园", estStart: "13:40", estEnd: "16:00" },
    ]);
    assert.ok(dayTimesValid(out));
  });

  it("没有重复时原样返回，不制造新对象序列", () => {
    const day = [{ name: "A", estStart: "09:00", estEnd: "11:00" }, { name: "B" }];
    assert.deepEqual(collapseRepeatedSpots(day), day);
  });
});
