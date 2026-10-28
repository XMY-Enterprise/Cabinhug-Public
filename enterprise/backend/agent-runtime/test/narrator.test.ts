/**
 * 表述路径接管判据：什么时候不能接管。
 *
 * 直连模型没有工具。分支已经把活干完时它只需转述；
 * 但 general 路由那类没有分支的轮次，应答就是这一轮唯一的一步，
 * 可能需要调工具，交给直连模型只会让它编造。
 *
 * 面对求解结果里没有答案的问题，直连模型会稳定输出「我帮您查了」一类说法，
 * 所以判据是"有没有求解结果"，而不是"路由到了哪个 Agent"。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildChatGraph } from "../src/graph/supervisor";
import { canonicalAgent } from "../src/acp-client/agent-prompt";
import type { ChatStreamer } from "../src/llm";

/** 记下每次调用用的 agent 标签，用来断言走了哪条路。 */
function spy(tag: string, seen: string[]): ChatStreamer {
  return async function* (_messages, hooks) {
    seen.push(`${tag}:${hooks?.agent ?? "?"}`);
    yield `[${tag}]`;
  };
}

async function runTurn(opts: {
  narrator?: ChatStreamer;
  text: string;
  seen: string[];
}): Promise<string> {
  const graph = buildChatGraph(spy("main", opts.seen), {
    enableIntent: false, // 不问模型要 JSON——这组测试与意图理解无关
    narrator: opts.narrator,
  });
  let out = "";
  await graph.invoke(
    { messages: [{ role: "user", content: opts.text }] },
    {
      configurable: {
        thread_id: `t-${opts.text.slice(0, 6)}-${opts.seen.length}`,
        emit: { onDelta: (t: string) => (out += t) },
      },
    },
  );
  return out;
}

test("有求解结果 → 表述路径接管，且带 -voice 标签", async () => {
  const seen: string[] = [];
  // 座舱路由：cabinCompanion 节点会写 agentResults.cabin，于是 solved 存在。
  await runTurn({ narrator: spy("voice", seen), text: "讲个笑话吧我有点无聊", seen });

  const answer = seen.filter((s) => !s.includes("-task"));
  assert.ok(
    answer.some((s) => s.startsWith("voice:")),
    `应答该走表述路径，实际：${seen.join(" / ")}`,
  );
  assert.ok(
    answer.some((s) => s.endsWith("-voice")),
    `表述路径的 agent 标签该带 -voice（轨迹要能与 ACP 那条分开），实际：${seen.join(" / ")}`,
  );
});

test("没有求解结果（general 路由）→ 不接管，仍走主 streamer", async () => {
  const seen: string[] = [];
  // 不命中任何专项规则 → general → 没有分支节点 → agentResults 为空。
  // 这一轮应答是唯一的一步，它可能真的需要工具，必须留在 pi 上。
  await runTurn({ narrator: spy("voice", seen), text: "嗯", seen });

  assert.ok(
    !seen.some((s) => s.startsWith("voice:")),
    `general 路由不该被表述路径接管，实际：${seen.join(" / ")}`,
  );
  assert.ok(seen.some((s) => s.startsWith("main:")), `应走主 streamer，实际：${seen.join(" / ")}`);
});

test("未注入 narrator → 完全保持原行为，且不带 -voice 后缀", async () => {
  const seen: string[] = [];
  await runTurn({ text: "讲个笑话吧我有点无聊", seen });

  assert.ok(seen.every((s) => s.startsWith("main:")), `实际：${seen.join(" / ")}`);
  // 后缀不能无条件加：回落到 ACP 时带着它，`loadAgentPrompt` 会去找
  // `cabin-voice.md` 并抛错，外部表现为"应答失败"。
  assert.ok(
    !seen.some((s) => s.endsWith("-voice")),
    `回落到 ACP 时不能带 -voice，实际：${seen.join(" / ")}`,
  );
});

test("分支跑挂时不接管，回落到有工具的那条路", async () => {
  /*
   * 分支全部失败或超时时，求解结果里只剩一行能源类型，表述路径没有工具，
   * 只能逐条报告"没拿到"。判据不能是 `Boolean(solved)`：`describeMerged` 恒定输出一行，
   * 对出行路由永远为真，表达的是"路由到了分支"，不是"分支交出了结果"。
   * 分支非 ok 时 tripNode 置 solverDegraded，应答回落到主 streamer。
   */
  const seen: string[] = [];
  // 用失败而不是超时来复现：`runBranch` 对两者都收敛成 status !== "ok"，
  // 判据看的正是这个；失败省去等待 60 秒超时。
  const failing: ChatStreamer = async function* (_m, hooks) {
    seen.push(`main:${hooks?.agent ?? "?"}`);
    if (hooks?.agent?.endsWith("-task")) throw new Error("分支挂了");
    yield "[main]";
  };

  const graph = buildChatGraph(failing, { enableIntent: false, narrator: spy("voice", seen) });
  await graph.invoke(
    { messages: [{ role: "user", content: "帮我规划一下自驾行程去黄山" }] },
    { configurable: { thread_id: "t-degraded", emit: { onDelta: () => {} } } },
  );

  assert.ok(
    !seen.some((s) => s.startsWith("voice:")),
    `分支跑挂时不该让无工具的表述路径接管，实际：${seen.join(" / ")}`,
  );
});

test("canonicalAgent 认识 -voice", () => {
  // 表述路径若回落到 ACP，不能去找 trip-voice.md。
  assert.equal(canonicalAgent("trip-voice"), "trip");
  assert.equal(canonicalAgent("ownership-voice"), "ownership");
  // 既有的两个后缀不受影响
  assert.equal(canonicalAgent("trip-task"), "trip");
  assert.equal(canonicalAgent("supervisor-intent"), "supervisor");
  // 不是后缀的不能误伤
  assert.equal(canonicalAgent("cabin"), "cabin");
});
