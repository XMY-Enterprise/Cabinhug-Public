/**
 * 工具的提示词元数据。
 *
 * 三条不变量：
 * 1. 每个工具的 promptSnippet 非空：pi 不把空 snippet 的工具写进系统提示词的
 *    `Available tools` 节，模型因此不知道有这个工具，且不报错。
 * 2. guidelines 每条以 `` `真实工具名` `` 开头：pi 把 bullets 平铺进
 *    Guidelines 节、无分组前缀，"此工具"指代不明（pi 文档有此警告）。
 * 3. describeForPi 原样透传 registry 里的元数据。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TOOL_REGISTRY, describeForPi, getTool } from "../src/registry";

describe("promptSnippet：31 个工具全必填", () => {
  for (const t of TOOL_REGISTRY) {
    it(`${t.name}`, () => {
      assert.ok(t.promptSnippet.trim().length > 0, `${t.name} 的 promptSnippet 为空——它不会出现在 Available tools 节`);
      assert.ok(t.promptSnippet.length <= 60, `${t.name} 的 snippet 过长（${t.promptSnippet.length} 字）——一行简介，纪律归 guidelines`);
      assert.ok(!t.promptSnippet.includes("\n"), `${t.name} 的 snippet 含换行`);
    });
  }
});

describe("promptGuidelines：每条点名真实工具", () => {
  const KNOWN = new Set(TOOL_REGISTRY.map((t) => t.name));

  it("每条 guideline 以 `<注册表内真实工具名>` 开头", () => {
    for (const t of TOOL_REGISTRY) {
      for (const g of t.promptGuidelines ?? []) {
        const m = g.match(/^`([a-z][a-z0-9_]*)`/);
        assert.ok(m, `${t.name} 的 guideline 不以 \`tool_name\` 开头：${g.slice(0, 40)}`);
        assert.ok(KNOWN.has(m![1]), `${t.name} 的 guideline 点名了不存在的工具 ${m![1]}`);
      }
    }
  });

  it("最小工具集都有 promptGuidelines", () => {
    for (const n of [
      "weather", "refuel", "charging", "poi_search", "spot_search", "hotel_search", "transit_route",
      "ragflow_retrieve", "insurance_quote", "loan_calc", "cost_calc",
    ]) {
      assert.ok((getTool(n)?.promptGuidelines?.length ?? 0) > 0, `${n} 缺 promptGuidelines`);
    }
  });

  // 以下红线从各 Agent prompt 文件迁入 registry，内容不得丢失。
  it("transit_route：禁止编造具体航班号（原 transit.md 红线）", () => {
    assert.match((getTool("transit_route")!.promptGuidelines ?? []).join("\n"), /禁止编造具体航班号/);
  });
  it("spot_search：一轮搜完的清单点名那三类，漏一类会多走一轮往返", () => {
    // 这几类在 tour.md 里出现得比"排草稿"晚，需在工具纪律里前置，否则模型第一批搜索会漏掉。
    const g = (getTool("spot_search")?.promptGuidelines ?? []).join("\n");
    assert.match(g, /一轮搜完/);
    // 单位是"轮"不是"调用"：三类挤进一个调用时高德结果整体偏向郊区。
    assert.match(g, /并发发 2~3 个|每个调用一组同类关键词/);
    assert.match(g, /别把它们挤进同一个调用/);
    for (const 类 of ["室内馆", "周边区县"]) assert.match(g, new RegExp(类));
    // 不让它单独搜夜市：spot_search 的类目只覆盖景区与文化场馆，夜市类关键词恒返回 1 条
    // （加商业类目码也一样），只会多出一轮空搜索。
    assert.match(g, /别单独搜夜市/);
    // 这条只给 spot_search：hotel_search 搜的是酒店，带这套清单是噪音。
    assert.doesNotMatch((getTool("hotel_search")?.promptGuidelines ?? []).join("\n"), /夜游|雨天备选/);
  });

  it("poi_search：无价格数据 + 估算标注（原 hotel.md 红线）", () => {
    const g = (getTool("poi_search")!.promptGuidelines ?? []).join("\n");
    assert.match(g, /不含任何价格数据/);
    assert.match(g, /估算/);
  });
  it("weather：预报窗口外不预报（原 drive.md/tour.md 红线）", () => {
    assert.match((getTool("weather")!.promptGuidelines ?? []).join("\n"), /窗口外的日期不要预报/);
  });
  it("refuel：不给剩余可行驶里程（原 drive.md/trip.md 红线）", () => {
    assert.match((getTool("refuel")!.promptGuidelines ?? []).join("\n"), /不给剩余可行驶里程/);
  });
  it("charging：能源类型二选一（原 drive.md/trip.md 红线）", () => {
    assert.match((getTool("charging")!.promptGuidelines ?? []).join("\n"), /能源类型二选一/);
  });
});

describe("describeForPi 透传", () => {
  it("snippet 与 guidelines 原样到达 descriptor", () => {
    const d = describeForPi("drive").find((t) => t.name === "weather")!;
    assert.equal(d.promptSnippet, getTool("weather")!.promptSnippet);
    assert.deepEqual(d.promptGuidelines, getTool("weather")!.promptGuidelines);
  });

  it("无 guidelines 的工具不带该字段（不传 undefined 占位）", () => {
    const d = describeForPi("buying").find((t) => t.name === "car_catalog")!;
    assert.ok(!("promptGuidelines" in d));
    assert.ok(d.promptSnippet.length > 0);
  });
});
