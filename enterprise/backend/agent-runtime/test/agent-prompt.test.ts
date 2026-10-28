/**
 * 子 Agent 业务 prompt 的加载与投递。
 *
 * prompt 缺失或仍是占位骨架时没有报错，表现只是"回答啰嗦""偶尔跑题""分支超时"，
 * 难以归因到 prompt，因此由这份测试检查存在性、内容与投递。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TOOL_REGISTRY, listForAgent, type AgentName } from "@cabinhug/tools";

import {
  PLACEHOLDER_MARKER,
  canonicalAgent,
  loadAgentPrompt,
  resetAgentPromptCache,
  MissingAgentPromptError,
} from "../src/acp-client/agent-prompt";

const AGENTS = [
  "supervisor",
  "trip",
  "ownership",
  "service",
  "buying",
  "cabin",
  // 多天行程 fan-out 四专家。缺文件的症状只是"分支失败"，
  // 所以存在性断言必须覆盖到它们。
  "drive",
  "hotel",
  "tour",
  "transit",
] as const;

describe("十个 Agent 的业务 prompt 都必须真的存在", () => {
  for (const agent of AGENTS) {
    it(`${agent} 有非空 prompt`, () => {
      const p = loadAgentPrompt(agent);
      assert.ok(p.trim().length > 200, `${agent} 的 prompt 只有 ${p.trim().length} 字，不像写完了`);
    });

    it(`${agent} 不是占位骨架`, () => {
      // 路由指向的 Agent 必须有真实的业务 prompt，不能是占位文件。
      assert.ok(
        !loadAgentPrompt(agent).includes(PLACEHOLDER_MARKER),
        `${agent}.md 仍含「${PLACEHOLDER_MARKER}」`,
      );
    });
  }
});

describe("五个子 Agent 的硬约束要写在 prompt 里", () => {
  // 每条对应一个具体的行为约束。
  const SUB_AGENTS = ["trip", "ownership", "service", "buying", "cabin"] as const;

  for (const agent of SUB_AGENTS) {
    it(`${agent} 写明了长度上限——分支超时的直接成因`, () => {
      const p = loadAgentPrompt(agent);
      assert.match(p, /字以内/, `${agent} 没有长度约束，模型会写长文`);
    });
  }

  it("cabin 写明了 audible:false 的四种原因，而不是一句话盖过去", () => {
    // 出声位在车机端，"没接出声的部件"只是四种成因之一，prompt 须给出分辨依据。
    const p = loadAgentPrompt("cabin");
    assert.match(p, /sink\.kind/, "prompt 里没提 sink.kind，模型就没有分辨的依据");
    assert.match(p, /clientStatus/);
    assert.match(p, /车机还没接上播放/);
    assert.match(p, /不要把.*车机还没接上.*说成.*没有播放器件/s, "这一条正是走查那句话的反面");
  });

  it("trip 被要求加日历时如实说没有这个能力（FL-31 已下线）", () => {
    // 只删掉那一段时模型会自己补一句"稍后帮你加"，即没做却说做了。
    // 所以显式写明：说不能，并让车主自己记。
    const p = loadAgentPrompt("trip");
    assert.match(p, /没有写日历的能力/);
    assert.match(p, /不要假装写好了/);
  });

  it("trip 明确禁止编造路线数字：它手上没有 map_route/charging", () => {
    assert.match(loadAgentPrompt("trip"), /不要给具体的公里数/);
  });

  it("service 禁止确定性诊断与否定性安全保证", () => {
    const p = loadAgentPrompt("service");
    assert.match(p, /不给确定性故障诊断/);
    assert.match(p, /放心开/);
  });

  /**
   * 理赔那三件事由编排层预取（`runRepairContext`），pi 的 service 会话在这条路上
   * 不会被 prompt，写在工具表里不起作用。它们应位于「编排层已经替你查过了」一节；
   * 搬回工具表不会报错，只会让模型多背三条走不到的规则。
   */
  it("[F-20-02] service 的理赔三件事在「编排层已经替你查过了」，不在工具表里", () => {
    const p = loadAgentPrompt("service");
    const table = p.slice(p.indexOf("## 手上的工具"));
    const prefetched = p.slice(p.indexOf("## 编排层已经替你查过了"), p.indexOf("## 长度是硬约束"));
    for (const name of ["insurance_precheck", "claim_advisor", "claim_checklist"]) {
      assert.ok(!table.includes(name), `${name} 又回到工具表里了——那条路 pi 走不到`);
      assert.ok(prefetched.includes(name), `${name} 不在「编排层已经替你查过了」段里`);
    }
    // 三句转述约束逐字保留。
    assert.match(prefetched, /模拟测算，实际以保险公司核定为准/);
    assert.match(prefetched, /`leaning` 是\*\*倾向不是决定\*\*/);
    assert.match(prefetched, /48 小时报案与未经定损不修两条\*\*原样转述\*\*/);
  });

  it("buying 禁止用指导价推算落地价", () => {
    assert.match(loadAgentPrompt("buying"), /绝不拿指导价推算/);
  });

  it("cabin 禁止把降级说成「我还不太了解你」", () => {
    assert.match(loadAgentPrompt("cabin"), /绝不说.{0,2}我还不太了解你/);
  });
});

describe("四个行程专家的诚实红线要写在 prompt 里", () => {
  // 每条对应设计文档"数据真实性红线"的一项，prompt 是模型唯一能看到的约束面。
  it("hotel 要求酒店名来自 hotel_search（钉死酒店的实例），估价必须带估算字样", () => {
    const p = loadAgentPrompt("hotel");
    assert.match(p, /hotel_search/);
    assert.doesNotMatch(p, /poi_search/, "hotel 手里已没有多类别搜索，提示词不该再提它");
    assert.match(p, /估算/);
  });
  it("tour 要求景点名来自 spot_search（钉死景点的实例）", () => {
    assert.match(loadAgentPrompt("tour"), /spot_search/);
    assert.doesNotMatch(loadAgentPrompt("tour"), /poi_search/, "tour 手里已没有多类别搜索，提示词不该再提它");
  });
  it("transit 的航班号红线在 transit_route 的 promptGuidelines", () => {
    // prompt 只留"飞机是估的"的职责框架；红线本体在工具注册里，由 prompt-meta.test.ts 检查。
    assert.match(loadAgentPrompt("transit"), /火车是真的，飞机是估的/);
  });
  it("drive 与 trip 的边界写明：单程即时出行归 trip", () => {
    assert.match(loadAgentPrompt("drive"), /单程即时出行归 trip/);
  });
  it("-task 会话默认思考档位 off", async () => {
    const { thinkingLevelFor } = await import("../src/acp-client/agent-prompt");
    for (const a of ["drive-task", "hotel-task", "tour-task", "transit-task", "ownership-task"]) {
      assert.equal(thinkingLevelFor(a), "off", a);
    }
  });
  it("tour-task 不钉 low：low 只是把推演挪进思考块、token 消耗约三倍", async () => {
    const { thinkingLevelFor } = await import("../src/acp-client/agent-prompt");
    assert.equal(thinkingLevelFor("tour-task"), "off");
    // 例外表为空时，规范名与其它后缀走默认规则。
    assert.equal(thinkingLevelFor("tour"), "high");
    assert.equal(thinkingLevelFor("tour-intent"), "off");
  });
});

/**
 * prompt 点名的工具，ACL 必须真的给它。
 *
 * # 约束
 *
 * 工具表按 Agent 裁剪（`registry.ts` 的 `agents` 字段，§4.3 能力映射），
 * 而职责说明是另一份手写文件，两者可能不一致。
 *
 * 不一致时没有任何报错：pi 的工具表里没有这个名字，模型不会说"我没有这个工具"，
 * 而是按常识编出里程、服务区、天气，正是 `drive.md` 要禁止的输出。
 *
 * # 规则
 *
 * 职责说明里以反引号写出的名字，只要它是注册表里真实存在的工具，
 * 该 Agent 的 ACL 就必须包含它。要让某个 Agent 不用某工具，就不要在它的
 * prompt 里用反引号提这个名字（写成普通文字即可）：反引号在这里等于"我要用它"。
 */
describe("职责说明点名的工具，ACL 里必须真的有", () => {
  const KNOWN = new Set(TOOL_REGISTRY.map((t) => t.name));

  /** 只认反引号里的标识符；`source` 这类非工具名会被 KNOWN 过滤掉。 */
  function toolsNamedIn(prompt: string): string[] {
    const hits = prompt.match(/`[a-z][a-z0-9_]{2,}`/g) ?? [];
    return [...new Set(hits.map((h) => h.slice(1, -1)))].filter((n) => KNOWN.has(n));
  }

  // 比上面那张表多一个 `test-drive`（第六个业务 Agent，也有自己的 prompt）。
  const ALL = [...AGENTS, "test-drive"] as const;

  for (const agent of ALL) {
    it(`${agent}`, () => {
      const granted = new Set(listForAgent(agent as AgentName).map((t) => t.name));
      const named = toolsNamedIn(loadAgentPrompt(agent));
      const missing = named.filter((n) => !granted.has(n));
      assert.deepEqual(
        missing,
        [],
        `${agent}.md 点名了 ${missing.join("/")}，但 registry.ts 的 agents 里没给它——` +
          `模型看不到这些工具，也不会报错，只会把答案编出来`,
      );
    });
  }

  it("drive 拿得到它 prompt 里点名的全部五个工具", () => {
    // 单列一条：回归时能直接看出是哪个工具缺失。
    const granted = new Set(listForAgent("drive").map((t) => t.name));
    for (const n of ["map_route", "weather", "refuel", "charging", "transit_route"]) {
      assert.ok(granted.has(n), `drive 缺 ${n}`);
    }
  });
});

describe("fan-out 分支用的是同一份职责说明", () => {
  it("`trip-task` / `ownership-task` 落到 trip.md / ownership.md", () => {
    // 分支名须归一到规范名，否则 `trip-task.md` 不存在、loadAgentPrompt 抛错，
    // 外部症状只是"分支失败"。
    assert.equal(canonicalAgent("trip-task"), "trip");
    assert.equal(canonicalAgent("ownership-task"), "ownership");
    // 两者读同一个文件，但返回值不逐字相等：`-task` 的产出被 `merge.ts`
    // 正则解析，所以既不拼身份段、也不拼关键信息标注规则（见 loadAgentPrompt）。
    // 因此比的是包含，不是前后缀：应答那份的形状是
    // 「身份段 + 这个文件 + 排版规则」。
    assert.ok(loadAgentPrompt("trip").includes(loadAgentPrompt("trip-task")));
    assert.ok(loadAgentPrompt("ownership").includes(loadAgentPrompt("ownership-task")));
  });

  it("非分支名不受影响", () => {
    assert.equal(canonicalAgent("supervisor"), "supervisor");
    assert.equal(canonicalAgent("cabin"), "cabin");
  });
});

describe("投递（走系统提示词）", () => {
  // 职责说明经 `--append-system-prompt` 进系统提示词
  // （env 拼装在 connection.ts 的 connect()，argv 逐字性由 tool-allowlist.test.ts 的
  // 假 pi 替身守着）。本文件只守加载语义。

  it("读不到时抛错，不静默降级成空 prompt", () => {
    resetAgentPromptCache();
    assert.throws(
      () => loadAgentPrompt("nonexistent" as never),
      MissingAgentPromptError,
      "静默返回空串正是此前那半年的状态，而它的症状看起来完全像模型能力问题",
    );
  });
});
