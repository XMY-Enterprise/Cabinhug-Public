/**
 * 对话回复的引用来源：工具声明的署名随 turn_end 下发，不进正文。
 *
 * 跑真实的 `TurnRunner`（与 prompt-transcript 同一形态）。应答流进行中模拟一次
 * 工具观察者回调，锁住 threadId → 真会话 + 轮次的换算与收口时的键是一致的。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import type { SessionEvent } from "@cabinhug/shared";

import { __resetAnswerSources, peekAnswerSources, recordCitation } from "../src/answer-sources";
import { buildChatGraph } from "../src/graph/supervisor";
import type { ChatStreamer } from "../src/llm";
import { TurnRunner } from "../src/turn-runner";

const NOW = 1_700_000_000_000;
const THREAD = `sess-cite#${NOW}`;
const QWEATHER = { name: "和风天气", url: "https://www.qweather.com" };
const realWeather = { data: [], source: { kind: "real", provider: "qweather", fetchedAt: "" } };
const mockWeather = { data: [], source: { kind: "mock", provider: "qweather", fetchedAt: "" } };

async function runTurn(streamer: ChatStreamer): Promise<SessionEvent[]> {
  const graph = buildChatGraph(streamer, { enableIntent: false, enableRouting: true });
  const runner = new TurnRunner(graph, () => NOW);
  const events: SessionEvent[] = [];
  for await (const e of runner.run({ sessionId: "sess-cite", turnId: "turn-cite", content: "明天天气怎么样", source: "text" })) {
    events.push(e);
  }
  return events;
}

function turnEndOf(events: SessionEvent[]) {
  const end = events.at(-1);
  assert.ok(end && end.type === "update" && end.kind === "turn_end", "最后一条必须是 turn_end");
  return end;
}

afterEach(() => __resetAnswerSources());

describe("回复引用来源", () => {
  it("本轮用到真实天气：turn_end 带署名（同名去重），正文里没有它", async () => {
    const events = await runTurn(async function* () {
      recordCitation(THREAD, "weather", realWeather);
      recordCitation(THREAD, "weather", realWeather);
      yield "明天有小雨。";
    });
    const end = turnEndOf(events);
    assert.deepEqual(end.sources, [QWEATHER]);
    const text = events.map((e) => (e.type === "update" && e.kind === "delta" ? e.text : "")).join("");
    assert.ok(!text.includes("和风天气"), "来源不得进正文，否则会被念出来");
    assert.deepEqual(peekAnswerSources("sess-cite", "turn-cite"), [], "轮结束即清");
  });

  it("模拟数据或没有工具署名：turn_end 不带 sources，与老事件形状相同", async () => {
    const events = await runTurn(async function* () {
      recordCitation(THREAD, "weather", mockWeather);
      yield "好的。";
    });
    assert.equal("sources" in turnEndOf(events), false);
  });

  it("归不到进行中轮次的调用直接丢弃", () => {
    recordCitation("sess-other#1", "weather", realWeather);
    assert.deepEqual(peekAnswerSources("sess-other", "turn-x"), []);
  });
});
