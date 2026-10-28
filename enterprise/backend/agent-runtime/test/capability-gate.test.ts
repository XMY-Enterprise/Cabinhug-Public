/**
 * 能力开关在编排层的收口（ACR-056）。
 *
 * 单测 `closeRoute` 全绿时，开关仍可能没接进图里，所以第二组一律经 `buildChatGraph(...).invoke()`，
 * 与 `risk-gate.test.ts` 同一个做法：断言被收口的那一轮只有意图那一次模型调用。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Capability } from "@cabinhug/shared";

import { capabilityOffReply, capabilityOfRoute, closeRoute } from "../src/graph/capability-gate";
import { buildChatGraph } from "../src/graph/supervisor";
import type { RouteDecision } from "../src/graph/state";
import type { ChatStreamer } from "../src/llm";

const OFF_ALL: ReadonlySet<Capability> = new Set(["photo-diagnosis", "ownership-qa", "service-qa"]);

describe("[ACR-056] closeRoute", () => {
  it("清单为空 → 原样返回（分离部署的缺省）", () => {
    const r: RouteDecision = { agent: "ownership", reason: "x" };
    assert.equal(closeRoute(r, new Set()), r);
  });

  it("主目标关闭 → 改落 general、记下 closedBy、清空副任务", () => {
    const r: RouteDecision = { agent: "service", reason: "要修车", secondary: [{ route: "itinerary", goal: "去杭州" }] };
    const out = closeRoute(r, OFF_ALL);
    assert.equal(out.agent, "general");
    assert.equal(out.closedBy, "service-qa");
    assert.equal(out.secondary, undefined);
    assert.match(out.reason, /要修车/, "原因保留原判据，轨迹里看得出本来要去哪");
    assert.equal(r.agent, "service", "不改入参");
  });

  it("主目标开着 → 只剔除副任务里关闭的那几件", () => {
    const r: RouteDecision = {
      agent: "itinerary",
      reason: "多天",
      secondary: [
        { route: "ownership", goal: "胎压灯" },
        { route: "buying", goal: "看看新车" },
      ],
    };
    const out = closeRoute(r, OFF_ALL);
    assert.equal(out.agent, "itinerary");
    assert.equal(out.closedBy, undefined);
    assert.deepEqual(out.secondary, [{ route: "buying", goal: "看看新车" }]);
  });

  it("副任务全被剔除时不留空数组", () => {
    const r: RouteDecision = { agent: "general", reason: "闲聊", secondary: [{ route: "service", goal: "约保养" }] };
    assert.equal("secondary" in closeRoute(r, OFF_ALL), false);
  });

  it("受开关管的路由目标：用车、售后（ACR-056）与购车、试驾、座舱（ACR-059）；行程与通用不受影响", () => {
    assert.equal(capabilityOfRoute("ownership"), "ownership-qa");
    assert.equal(capabilityOfRoute("service"), "service-qa");
    assert.equal(capabilityOfRoute("buying"), "buying-advice");
    assert.equal(capabilityOfRoute("testDrive"), "test-drive");
    assert.equal(capabilityOfRoute("cabin"), "cabin-control");
    for (const other of ["itinerary", "general", undefined]) {
      assert.equal(capabilityOfRoute(other), undefined, String(other));
    }
  });

  it("[ACR-059] 购车、试驾、座舱的话术说清这一版没有，并指回行程", () => {
    for (const c of ["buying-advice", "test-drive", "cabin-control"] as const) {
      const reply = capabilityOffReply(c);
      assert.match(reply, /还没有开放/);
      assert.match(reply, /行程规划、天气和地图/);
    }
  });

  it("话术给出下一步：先安全停车，再告诉能帮什么", () => {
    for (const c of ["ownership-qa", "service-qa"] as const) {
      const reply = capabilityOffReply(c);
      assert.match(reply, /还没有开放/);
      assert.match(reply, /安全的地方停车/);
      assert.match(reply, /行程规划、天气和地图/);
    }
  });
});

// ── 图接线：开关必须真的在路上 ────────────────────────────────────

function streamerFor(route: string, seen: string[]): ChatStreamer {
  return async function* (_messages, hooks) {
    const agent = hooks?.agent ?? "?";
    seen.push(agent);
    if (agent === "supervisor-intent") {
      yield JSON.stringify({ goal: "问车况", constraints: [], context: "", riskBoundary: "", riskCategory: "none", route });
      return;
    }
    yield "[答案]";
  };
}

let seq = 0;
async function runTurn(route: string, text: string, off?: ReadonlySet<Capability>) {
  const seen: string[] = [];
  const traces: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const graph = buildChatGraph(streamerFor(route, seen), {
    enableIntent: true,
    ...(off ? { capabilitiesOff: async () => off } : {}),
  });
  let out = "";
  seq += 1;
  await graph.invoke(
    { messages: [{ role: "user", content: text }] },
    {
      configurable: {
        thread_id: `capability-${seq}`,
        emit: { onDelta: (t: string) => (out += t) },
        onTrace: (e: { kind: string; data: Record<string, unknown> }) => traces.push(e),
      },
    },
  );
  return { out, seen, traces };
}

describe("[ACR-056] 能力开关在图里", () => {
  it("用车问答关闭 → 固定话术直接下发，不进双路、不调表述模型", async () => {
    const { out, seen, traces } = await runTurn("ownership", "胎压灯亮了正常吗", OFF_ALL);
    assert.equal(out, capabilityOffReply("ownership-qa"));
    assert.deepEqual(seen, ["supervisor-intent"], `收口之后不该再有模型调用，实际：${seen.join(" / ")}`);
    const route = traces.find((t) => t.kind === "route");
    assert.equal(route?.data.closedBy, "ownership-qa", "收口要落轨迹，回放时看得出这一轮为什么只回一句");
  });

  it("售后问答关闭 → 售后那句话术", async () => {
    const { out, seen } = await runTurn("service", "帮我约周六的保养", OFF_ALL);
    assert.equal(out, capabilityOffReply("service-qa"));
    assert.deepEqual(seen, ["supervisor-intent"]);
  });

  it("[ACR-059] 单机版整串关闭：购车、试驾、座舱各回各的话术，不进分支", async () => {
    const standalone: ReadonlySet<Capability> = new Set([
      ...OFF_ALL,
      "buying-advice",
      "test-drive",
      "cabin-control",
      "voice",
    ] as Capability[]);
    for (const [route, text, cap] of [
      ["buying", "20 万左右买哪款电车好", "buying-advice"],
      ["testDrive", "帮我约周六试驾", "test-drive"],
      ["cabin", "空调调到 22 度", "cabin-control"],
    ] as const) {
      const { out, seen } = await runTurn(route, text, standalone);
      assert.equal(out, capabilityOffReply(cap), route);
      assert.deepEqual(seen, ["supervisor-intent"], `${route} 收口之后不该再有模型调用，实际：${seen.join(" / ")}`);
    }
  });

  it("不传开关 → 照常路由，子图与应答都跑", async () => {
    const { out, seen } = await runTurn("ownership", "胎压灯亮了正常吗");
    assert.notEqual(out, capabilityOffReply("ownership-qa"));
    assert.ok(seen.length > 1, `应当继续走到应答，实际：${seen.join(" / ")}`);
  });

  it("开关只关拍照问诊 → 用车问答照常", async () => {
    const { out, seen } = await runTurn("ownership", "胎压灯亮了正常吗", new Set(["photo-diagnosis"]));
    assert.notEqual(out, capabilityOffReply("ownership-qa"));
    assert.ok(seen.length > 1);
  });

  it("读开关抛错 → 按都不关处理，整轮照常", async () => {
    const seen: string[] = [];
    const graph = buildChatGraph(streamerFor("ownership", seen), {
      enableIntent: true,
      capabilitiesOff: async () => {
        throw new Error("config down");
      },
    });
    let out = "";
    await graph.invoke(
      { messages: [{ role: "user", content: "胎压灯亮了正常吗" }] },
      { configurable: { thread_id: `capability-${++seq}`, emit: { onDelta: (t: string) => (out += t) } } },
    );
    assert.notEqual(out, "");
    assert.ok(seen.length > 1);
  });

  it("下一轮换成开放的话题，上一轮的收口不残留", async () => {
    const seen: string[] = [];
    let route = "ownership";
    const streamer: ChatStreamer = async function* (_m, hooks) {
      const agent = hooks?.agent ?? "?";
      seen.push(agent);
      if (agent === "supervisor-intent") {
        yield JSON.stringify({ goal: "x", constraints: [], context: "", riskBoundary: "", riskCategory: "none", route });
        return;
      }
      yield "[答案]";
    };
    const graph = buildChatGraph(streamer, { enableIntent: true, capabilitiesOff: async () => OFF_ALL });
    const thread_id = `capability-${++seq}`;
    let out = "";
    const config = { configurable: { thread_id, emit: { onDelta: (t: string) => (out += t) } } };
    await graph.invoke({ messages: [{ role: "user", content: "胎压灯亮了" }] }, config);
    assert.equal(out, capabilityOffReply("ownership-qa"));

    route = "general";
    out = "";
    seen.length = 0;
    await graph.invoke({ messages: [{ role: "user", content: "讲个笑话" }] }, config);
    assert.equal(out, "[答案]");
    assert.ok(seen.length > 1);
  });
});
