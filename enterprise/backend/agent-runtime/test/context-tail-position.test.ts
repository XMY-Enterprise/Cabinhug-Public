/**
 * [F-11-03][AC-11-2] 本轮尾区只能在最后一条 user 消息里（ACR-036 §4.9）。
 *
 * 判据分源码断言与运行期断言两道：把每轮变化的状态块插到 `state.messages` 前面，
 * 输出依然正确，只是该线程已累积的前缀缓存每轮失效，功能测试无法察觉。
 *
 * 与「状态行要在指令之前」的位置断言同一形态，这里约束的是"在历史之后"。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { CONTEXT_BLOCK_HEADER } from "@cabinhug/shared";

import { renderTurn, type TurnFact } from "../src/context/render";

const SUPERVISOR = readFileSync(new URL("../src/graph/supervisor.ts", import.meta.url), "utf8");
/*
 * 指向 `@cabinhug/acp` 的实现文件，不是 `src/acp-client/connection.ts`。
 *
 * 后者只是 re-export 垫片，不含源码文本；扫它时 `includes` 恒为 false。
 * 守的不变量：pi 会话的锚定块只在新建会话那一次拼。
 */
const CONNECTION = readFileSync(
  new URL("../../shared/acp/src/connection.ts", import.meta.url),
  "utf8",
);

describe("[F-11-03][AC-11-2] 尾区位置：源码里不得把状态块插到历史之前", () => {
  it("answerNode 的 messages 是 [...state.messages, 尾块]，不是 [尾块, ...state.messages]", () => {
    assert.ok(
      SUPERVISOR.includes("[...state.messages, { role: \"user\" as const, content: tail }]"),
      "应答的消息序列必须以历史开头、尾块结尾",
    );
    assert.ok(
      !/\[\s*turnBlock\s*,\s*\.\.\.state\.messages/.test(SUPERVISOR),
      "不得把状态块前置到历史之前——那会让整段历史的前缀缓存每轮作废",
    );
  });

  it("意图 probe 的状态块排在指令之前、历史之后（ADR-010 那条位置约束仍成立）", () => {
    const probeStart = SUPERVISOR.indexOf("const probe: ChatTurnMessage[] = [");
    assert.ok(probeStart > 0, "找不到 probe 的拼装处");
    const probe = SUPERVISOR.slice(probeStart, probeStart + 2_000);
    const history = probe.indexOf("...state.messages");
    const block = probe.indexOf("turnBlock");
    const instruction = probe.indexOf("buildIntentInstruction");
    assert.ok(history >= 0 && block > history, "状态块要排在历史之后");
    assert.ok(instruction > block, "状态块要排在指令之前（ADR-010）");
  });

  it("锚定块经 systemSuffix 走，不混进 messages", () => {
    assert.ok(SUPERVISOR.includes("systemSuffix"), "应答与 probe 都该用 systemSuffix 传锚定块");
    assert.ok(
      !/messages\.unshift\(/.test(SUPERVISOR),
      "不得往消息序列头部塞东西——那是前缀，塞了就等于换缓存",
    );
  });

  it("ACP 那条：锚定块只在 fresh 时拼，不是每轮", () => {
    assert.ok(
      CONNECTION.includes("fresh && args.anchor ?"),
      "pi 会话的锚定块必须只在新建会话那一次发；重发等于每轮换前缀，比不发更糟",
    );
  });
});

describe("[F-11-03][AC-11-2] 尾区渲染：形状与预算", () => {
  const facts: TurnFact[] = [
    { item: "dateline", text: "【今天是 2026-09-14（周日），北京时间】" },
    { item: "task-status", text: "他手上进行中的事：\n- 行程：有一份已经落库的" },
  ];

  it("带固定头部，且允许的项之外一律不出现", () => {
    const out = renderTurn(facts, ["dateline"]);
    assert.ok(out?.startsWith(CONTEXT_BLOCK_HEADER));
    assert.ok(out?.includes("今天是 2026-09-14"));
    assert.ok(!out?.includes("进行中的事"), "task-status 不在允许清单里就不该出现");
  });

  it("一项都不允许时返回 undefined——不产出一个只有头部的空块", () => {
    assert.equal(renderTurn(facts, []), undefined);
  });

  it("超预算时从后往前丢，并明说丢了", () => {
    const long: TurnFact[] = [
      { item: "dateline", text: "日期" },
      { item: "task-status", text: "状态".repeat(400) },
      { item: "task-draft", text: "草案正文" },
    ];
    const out = renderTurn(long, ["dateline", "task-status", "task-draft"]);
    assert.ok(out?.includes("日期"), "靠前的（判断要用的）必须留下");
    assert.ok(out?.includes("略去"), "丢了要说出来，不能静默截断");
    assert.ok(!out?.includes("草案正文"), "靠后的先丢");
  });
});
