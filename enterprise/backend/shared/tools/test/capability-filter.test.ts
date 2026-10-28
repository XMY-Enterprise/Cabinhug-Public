/**
 * [ACR-059] 工具按能力剔除。
 *
 * 单机版只做行程：通用对话不能再拿到调门店、保险 mock 的工具，行程里的续航评估也不该白调知识库。
 * 剔除落在 `listForAgent`，describe、执行端 ACL、pi 的 `--tools` 三处共用它。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { CAPABILITIES, type Capability } from "@cabinhug/shared";

import {
  TOOL_REGISTRY,
  capabilityOffFor,
  describeForPi,
  listForAgent,
  setToolCapabilitiesOff,
  type AgentName,
} from "../src/registry";

/** 单机版的整串关闭清单：除行程外全部关闭。 */
const STANDALONE_OFF: ReadonlySet<Capability> = new Set(CAPABILITIES);

const names = (agent: AgentName) => listForAgent(agent).map((t) => t.name);

describe("[ACR-059] 工具按能力剔除", () => {
  afterEach(() => setToolCapabilitiesOff(new Set()));

  it("缺省什么都不剔除：每个 Agent 的工具表与注册表的 agents 一致", () => {
    const agents = [...new Set(TOOL_REGISTRY.flatMap((t) => t.agents))];
    for (const agent of agents) {
      const expected = TOOL_REGISTRY.filter((t) => t.agents.includes(agent)).map((t) => t.name);
      assert.deepEqual(names(agent), expected, agent);
    }
  });

  it("单机配置下，通用对话拿不到调门店、保险 mock 与购车测算的工具", () => {
    setToolCapabilitiesOff(STANDALONE_OFF);
    const supervisor = names("supervisor");
    for (const gone of ["dealer_stores", "dealer_slots", "dealer_pricing", "insurance_quote", "cost_calc", "loan_calc", "trim_compare", "contact_lookup", "contact_update"]) {
      assert.ok(!supervisor.includes(gone), `supervisor 不该再有 ${gone}`);
    }
    for (const kept of ["weather", "charging", "refuel", "transit_route", "poi_search", "trip_plan_list"]) {
      assert.ok(supervisor.includes(kept), `supervisor 该保留 ${kept}`);
    }
  });

  it("单机配置下，续航评估（ownership）不再拿到 ragflow_retrieve；行程四专家的工具一个不少", () => {
    const before = Object.fromEntries((["drive", "hotel", "tour", "transit", "tour-plan"] as const).map((a) => [a, names(a)]));
    setToolCapabilitiesOff(STANDALONE_OFF);
    assert.ok(!names("ownership").includes("ragflow_retrieve"));
    assert.ok(names("ownership").includes("submit_range_assessment"));
    for (const [agent, list] of Object.entries(before)) {
      assert.deepEqual(names(agent as AgentName), list, `${agent} 的工具不受能力开关影响`);
    }
  });

  it("任一服务的能力开着就保留：只关购车时，试驾仍拿得到门店查询", () => {
    setToolCapabilitiesOff(new Set<Capability>(["buying-advice"]));
    assert.ok(names("test-drive").includes("dealer_stores"));
    assert.ok(!names("buying").includes("car_catalog"));
  });

  it("capabilityOffFor 报出关闭的能力；describeForPi 同样剔除", () => {
    setToolCapabilitiesOff(STANDALONE_OFF);
    const dealer = TOOL_REGISTRY.find((t) => t.name === "dealer_stores")!;
    assert.equal(capabilityOffFor(dealer), "buying-advice");
    assert.equal(capabilityOffFor(TOOL_REGISTRY.find((t) => t.name === "weather")!), undefined);
    assert.ok(!describeForPi("supervisor").some((t) => t.name === "dealer_stores"));
  });

  it("标注的能力都在闭集里", () => {
    for (const t of TOOL_REGISTRY) {
      for (const c of t.capabilities ?? []) {
        assert.ok((CAPABILITIES as readonly string[]).includes(c), `${t.name} 标注了不存在的能力 ${c}`);
      }
    }
  });
});
