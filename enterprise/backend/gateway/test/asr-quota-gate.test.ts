/**
 * 日用量闸门在两个转写入口上的接线（ACR-016）。
 *
 * 覆盖三点：
 *  1. 不注入闸门时行为逐字节不变（"默认不限"）：新装的仓库、以及所有现有调用方
 *     （只传到第 3 个位置参数）都不因多了个闸而改变行为。
 *  2. 闸门给谁就用谁。超限降级的目标由装配层决定，路由层照单执行；
 *     否则超限后仍会打云端。
 *  3. 闸门给 null 即明确失败（503），不假装成功。返回 Fake 文本会把用户的话
 *     换成编造的文本，比报错更糟。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { once } from "node:events";
import express from "express";

import { createHttpRouter, type AsrGate } from "../src/http";
import { SessionBus } from "../src/stream/session-bus";
import type { AsrProvider } from "../src/asr";

/** 只回固定文本的 provider，用名字区分是哪一个被调了。 */
const providerOf = (text: string): AsrProvider => ({
  async transcribe() {
    return text;
  },
});

function appWith(gate: AsrGate | undefined, cloud: AsrProvider) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = "demo-user";
    next();
  });
  app.use(createHttpRouter({} as never, new SessionBus(), cloud, undefined, undefined, gate));
  return app;
}

/** 打哨兵转写入口（不建轮，不碰 repo——所以上面的 repo 可以是空对象）。 */
async function transcribe(app: express.Express): Promise<{ status: number; body: string }> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/asr/transcribe`, {
      method: "POST",
      headers: {
        // 必须是 audio/*：入口的 raw() 只吃这一类，别的 content-type body 不是
        // Buffer，会在闸门之前就被 400 挡掉。
        "content-type": "audio/pcm_s16le",
        "x-audio-meta": JSON.stringify({
          durationMs: 1200,
          format: "pcm_s16le",
          sampleRateHz: 16000,
          channels: 1,
        }),
      },
      body: new Uint8Array(32),
    });
    return { status: r.status, body: await r.text() };
  } finally {
    server.close();
  }
}

describe("哨兵转写入口的日用量闸门", () => {
  it("不注入闸门时走原 provider——现有调用方行为逐字节不变", async () => {
    const r = await transcribe(appWith(undefined, providerOf("云端识别")));
    assert.equal(r.status, 200);
    assert.match(r.body, /云端识别/);
  });

  it("闸门返回降级 provider 时就用它——超限后不该再打云端", async () => {
    const local = providerOf("本地识别");
    const r = await transcribe(appWith(async () => ({ provider: local, engine: "mock" }), providerOf("云端识别")));
    assert.equal(r.status, 200);
    assert.match(r.body, /本地识别/);
    assert.equal(r.body.includes("云端识别"), false);
  });

  it("闸门返回 null（超限且无兜底）时 503 明确失败，不返回任何文本", async () => {
    const r = await transcribe(appWith(async () => null, providerOf("云端识别")));
    assert.equal(r.status, 503);
    assert.match(r.body, /asr_quota_exceeded/);
    // 不能返回编造的文本。
    assert.equal(r.body.includes("云端识别"), false);
  });

  it("超限判定发生在调 provider 之前——一次都不许发给供应商", async () => {
    let called = 0;
    const cloud: AsrProvider = {
      async transcribe() {
        called += 1;
        return "云端识别";
      },
    };
    await transcribe(appWith(async () => null, cloud));
    assert.equal(called, 0, "超限时不该发生任何一次云端调用");
  });
});
