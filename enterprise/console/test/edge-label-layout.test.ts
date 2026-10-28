/**
 * 流程图边标签的纯布局规则。
 *
 * 不启动浏览器，只守两条易回归的事实：结构化长标签能换行，
 * 汇聚走廊按稳定顺序分道；另守布局投影不改动边的端点。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WORKFLOW_EDGES } from "../src/pages/workflow/graph-model";
import {
  LABEL_CLEARANCE,
  planEdgeLabelLayouts,
  splitEdgeLabel,
  toEdges,
} from "../src/pages/workflow/layout";

function edgeIndex(from: string, to: string): number {
  const index = WORKFLOW_EDGES.findIndex((edge) => edge.from === from && edge.to === to);
  assert.notEqual(index, -1, `${from} → ${to} 不在流程图定义中`);
  return index;
}

describe("流程图边标签布局", () => {
  it("按工具分隔符换行，已有换行和短标签保持稳定", () => {
    assert.deepEqual(splitEdgeLabel("car_catalog / cost_calc / insurance_quote"), [
      "car_catalog /",
      "cost_calc /",
      "insurance_quote",
    ]);
    assert.deepEqual(splitEdgeLabel("确认 / 取消前，子图直调"), [
      "确认 /",
      "取消前，子图直调",
    ]);
    assert.deepEqual(splitEdgeLabel("第一行\n第二行"), ["第一行", "第二行"]);
    assert.deepEqual(splitEdgeLabel("购车"), ["购车"]);
  });

  it("汇聚走廊使用稳定的语义通道", () => {
    // 这里量通道本身，所以关掉躲方框的那一层偏移：后者把个别标签挪进旁边的空当
    // （见 layout.ts 的 LABEL_CLEARANCE），挪完后同一走廊里的 X 有意不再相等。
    const layouts = planEdgeLabelLayouts(WORKFLOW_EDGES, { clearance: false });
    const itineraryTools = layouts.get(edgeIndex("itineraryPlan", "tools"));
    const ownershipTools = layouts.get(edgeIndex("ownershipDual", "tools"));
    const buyingTools = layouts.get(edgeIndex("buyingCatalog", "tools"));
    const dispatchAnswer = layouts.get(edgeIndex("dispatch", "answer"));
    // 主分支先汇到 join 再到 answer（ACR-023）；汇合走廊的语义通道不变。
    const itineraryAnswer = layouts.get(edgeIndex("itineraryPlan", "join"));
    const ownershipAnswer = layouts.get(edgeIndex("ownershipDual", "join"));

    assert.ok(itineraryTools && ownershipTools && buyingTools);
    assert.equal(itineraryTools.offsetX, ownershipTools.offsetX);
    assert.equal(ownershipTools.offsetX, buyingTools.offsetX);
    assert.ok(itineraryTools.offsetY < ownershipTools.offsetY);
    assert.ok(ownershipTools.offsetY < buyingTools.offsetY);
    assert.ok(dispatchAnswer);
    assert.ok(dispatchAnswer.offsetX > 0, "主链路旁路标签要避开中间节点");
    assert.ok(itineraryAnswer && ownershipAnswer);
    assert.ok(itineraryAnswer.offsetY < ownershipAnswer.offsetY);
  });

  it("躲方框的偏移只叠加、不顶掉通道偏移，且每条都指向图里真有的边", () => {
    const lanes = planEdgeLabelLayouts(WORKFLOW_EDGES, { clearance: false });
    const placed = planEdgeLabelLayouts(WORKFLOW_EDGES);

    // 表里的每一条都须对应一条真实的边：改图后这张表会失效，
    // 表现只是某张标签又压回方框上，不易察觉。
    const edgeKeys = new Set(WORKFLOW_EDGES.map((e) => `${e.from}->${e.to}`));
    for (const key of Object.keys(LABEL_CLEARANCE)) {
      assert.ok(edgeKeys.has(key), `LABEL_CLEARANCE 里的 ${key} 在流程图里没有这条边`);
    }

    // 叠加而不是覆盖：通道给的偏移在躲完方框之后仍保留。
    const toolsX = lanes.get(edgeIndex("buyingCatalog", "tools"))?.offsetX ?? 0;
    const placedTools = placed.get(edgeIndex("buyingCatalog", "tools"));
    const nudge = LABEL_CLEARANCE["buyingCatalog->tools"];
    assert.ok(nudge?.dx !== undefined);
    assert.equal(placedTools?.offsetX, toolsX + nudge.dx);

    // 没有通道分组的边（如五条「副任务」）在这一层才第一次拿到布局，换行也要补上。
    const sideTask = placed.get(edgeIndex("dispatch", "sideItineraryPlan"));
    assert.ok(sideTask, "副任务那几条边要有布局，否则长标签仍然一行拉过去");
    assert.deepEqual(sideTask.lines, splitEdgeLabel("副任务：出行（与主 lane 并行）"));
  });

  it("布局投影不改变边端点，且只给有标签的边附加布局", () => {
    const edges = toEdges(WORKFLOW_EDGES, "test-");
    assert.equal(edges.length, WORKFLOW_EDGES.length);
    assert.deepEqual(
      edges.map((edge) => `${edge.source}→${edge.target}`),
      WORKFLOW_EDGES.map((edge) => `${edge.from}→${edge.to}`),
    );
    assert.equal(edges[0].data, undefined, "无标签的起点边不应生成空布局");
    const longTool = edges[edgeIndex("buyingCatalog", "tools")].data?.labelLayout;
    assert.deepEqual(longTool?.lines, [
      "car_catalog /",
      "cost_calc /",
      "insurance_quote",
    ]);
  });
});
