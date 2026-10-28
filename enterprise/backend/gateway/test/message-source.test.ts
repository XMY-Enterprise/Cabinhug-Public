/**
 * 文本消息的 `source` 声明。
 *
 * 「内容是文本」不等于「来源是打字」：唤醒词那条链是端上本地转写完再发文本，
 * 不把音频再传一遍。控制台会话详情按这个字段标「🎙 语音 / ⌨ 文字」，
 * 按端拆解用量的账（US-38 AC-38-8）也依赖它。
 *
 * 三条约束：认 voice；缺省仍是 text（老调用方行为不变）；
 * 非法值 400 而不是静默回落成 text。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { once } from "node:events";
import express from "express";

import { createHttpRouter } from "../src/http";
import { SessionBus } from "../src/stream/session-bus";

/** 记下 accept 收到的 source，其余按用不到处理。 */
function harness() {
  const seen: { content: string; source: string }[] = [];
  const repo = {
    async sessionExists() {
      return true;
    },
    async sessionState() {
      return { exists: true, closedAt: null, lastActiveAt: new Date() };
    },
    async appendMessage(m: { content: string; source: string }) {
      seen.push({ content: m.content, source: m.source });
    },
    async sessionTitle() {
      return "t";
    },
    async createSession() {},
    async closeSession() {
      return null;
    },
    // 发消息时归属取会话的（车机上请求里没有人）。桩里回 demo 身份。
    async sessionUserId() {
      return "demo-user";
    },
    async historyPage() {
      return { messages: [], hasMore: false, nextBefore: null };
    },
  } as never;
  return { seen, repo };
}

async function post(
  repo: never,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = "u1";
    next();
  });
  app.use(createHttpRouter(repo, new SessionBus(), { transcribe: async () => "x" } as never));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/session/s1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

describe("文本消息的 source 声明", () => {
  it("source=voice 被认下来——端上本地转写的指令要能标成语音", async () => {
    const { seen, repo } = harness();
    const r = await post(repo, { content: "帮我开氛围灯", source: "voice" });
    assert.equal(r.status, 202);
    assert.deepEqual(seen[0], { content: "帮我开氛围灯", source: "voice" });
  });

  it("不给 source 时仍是 text——老调用方（打字输入框）行为不变", async () => {
    const { seen, repo } = harness();
    const r = await post(repo, { content: "帮我开氛围灯" });
    assert.equal(r.status, 202);
    assert.equal(seen[0].source, "text");
  });

  it("显式 source=text 也认", async () => {
    const { seen, repo } = harness();
    assert.equal((await post(repo, { content: "x", source: "text" })).status, 202);
    assert.equal(seen[0].source, "text");
  });

  it("非法 source 报 400，不静默回落 text", async () => {
    const { seen, repo } = harness();
    for (const bad of ["Voice", "VOICE", "audio", "", 1, null, {}]) {
      const r = await post(repo, { content: "x", source: bad });
      assert.equal(r.status, 400, `source=${JSON.stringify(bad)} 应当拒绝`);
      assert.equal(r.body.error, "invalid_source");
    }
    assert.equal(seen.length, 0, "被拒的请求一条都不该落库");
  });
});
