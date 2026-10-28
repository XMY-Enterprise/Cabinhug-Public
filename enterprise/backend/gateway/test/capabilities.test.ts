/**
 * 能力开关在网关的三处（ACR-056）：下发端点、上传拒收、带附件的消息拒收。
 *
 * 入口隐藏是端上的事（ACR-057），拦截必须在这里：旧版端上、或开关在上传与发送之间被关上，
 * 照片都不能进对话。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import express from "express";

import type { Capability } from "@cabinhug/shared";

import { createHttpRouter } from "../src/http";
import { createCapabilitiesRouter, photoOffBody, voiceOffBody } from "../src/http/capabilities";
import { createTtsSpeechRouter } from "../src/http/tts-speech";
import { SessionBus } from "../src/stream/session-bus";
import { createUploadRouter } from "../src/upload";
import type { ObjectStore } from "../src/upload/storage";

async function call(
  app: express.Express,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  // 绑 127.0.0.1 而不是裸 listen(0)：并行跑时裸绑定会打到别的进程的同号端口上（TD-60）。
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, init);
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

function withUser(router: express.Router, userId: string | null = "u1"): express.Express {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = userId ?? undefined;
    next();
  });
  app.use(router);
  return app;
}

describe("[ACR-056] GET /v1/capabilities", () => {
  const off = (...c: Capability[]) => async () => new Set<Capability>(c);

  it("未鉴权 401", async () => {
    assert.equal((await call(withUser(createCapabilitiesRouter(off()), null), "/v1/capabilities")).status, 401);
  });

  it("缺省下发空清单（全开）与复查间隔", async () => {
    const r = await call(withUser(createCapabilitiesRouter(off())), "/v1/capabilities");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { off: [], refreshMs: 30_000 });
  });

  it("按闭集顺序下发，与配置里的书写顺序无关", async () => {
    const r = await call(withUser(createCapabilitiesRouter(off("service-qa", "photo-diagnosis"))), "/v1/capabilities");
    assert.deepEqual(r.body.off, ["photo-diagnosis", "service-qa"]);
  });

  it("读取抛错 → 503，端上沿用上一次的值，不替它决定全开", async () => {
    const router = createCapabilitiesRouter(async () => {
      throw new Error("config down");
    });
    assert.equal((await call(withUser(router), "/v1/capabilities")).status, 503);
  });
});

// ── 上传 ────────────────────────────────────────────────────────

function uploadApp(photoOff?: boolean) {
  const puts: string[] = [];
  const store = {
    async put(key: string) {
      puts.push(key);
    },
  } as unknown as ObjectStore;
  const repo = {
    async create() {},
    async findByIdempotencyKey() {
      return null;
    },
  } as never;
  const router = createUploadRouter(store, repo, photoOff === undefined ? {} : { photoOff: async () => photoOff });
  return { app: withUser(router), puts };
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt "), Buffer.alloc(20)]);
const upload = (type: string, body: Buffer): RequestInit => ({ method: "POST", headers: { "content-type": type }, body });

describe("[ACR-056] 上传：拍照问诊关闭时照片与视频不收", () => {
  it("声明 image/* → 403，读 body 之前就拒，不落对象存储", async () => {
    const { app, puts } = uploadApp(true);
    const r = await call(app, "/v1/session/s1/attachments", upload("image/jpeg", JPEG));
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { ...photoOffBody });
    assert.equal(puts.length, 0);
  });

  it("声明 video/* → 403", async () => {
    const { app } = uploadApp(true);
    assert.equal((await call(app, "/v1/session/s1/attachments", upload("video/mp4", Buffer.from("....ftypmp42")))).status, 403);
  });

  it("声明 octet-stream、魔数是 JPEG → 读完按纠正后的类型拒", async () => {
    const { app, puts } = uploadApp(true);
    const r = await call(app, "/v1/session/s1/attachments", upload("application/octet-stream", JPEG));
    assert.equal(r.status, 403);
    assert.equal(puts.length, 0);
  });

  it("音频不受影响：留档回听与拍照问诊无关", async () => {
    const { app, puts } = uploadApp(true);
    const r = await call(app, "/v1/session/s1/attachments", upload("audio/wav", WAV));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(puts.length, 1);
  });

  it("开关没关、或没注入 → 照片照收（现状）", async () => {
    for (const photoOff of [false, undefined]) {
      const { app } = uploadApp(photoOff);
      assert.equal((await call(app, "/v1/session/s1/attachments", upload("image/jpeg", JPEG))).status, 201, String(photoOff));
    }
  });
});

// ── 发消息 ──────────────────────────────────────────────────────

function messageApp(photoOff: boolean) {
  const repo = {
    async sessionExists() {
      return true;
    },
    async sessionState() {
      return { exists: true, closedAt: null, lastActiveAt: new Date() };
    },
    async sessionUserId() {
      return "u1";
    },
  } as never;
  // 附件仓储里什么都没有：开关开着时会走到 attachment_not_found（404），与 403 分得开。
  const attachments = {
    repo: { async get() { return null; } } as never,
    store: {} as ObjectStore,
    photoOff: async () => photoOff,
  };
  const router = createHttpRouter(repo, new SessionBus(), {} as never, undefined, undefined, undefined, undefined, undefined, attachments);
  return withUser(router);
}

const send = (json: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) });

describe("[ACR-056] 发消息：拍照问诊关闭时带附件的消息整条拒", () => {
  it("带句柄 → 403 capability_off，不静默丢掉照片后照常作答", async () => {
    const r = await call(messageApp(true), "/v1/session/s1/messages", send({ content: "看看这个灯", attachments: ["handle_aaaaaaaa"] }));
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "capability_off");
  });

  it("开关开着 → 照常进入附件解析（这里句柄不存在，回 404）", async () => {
    const r = await call(messageApp(false), "/v1/session/s1/messages", send({ content: "看看这个灯", attachments: ["handle_aaaaaaaa"] }));
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "attachment_not_found");
  });
});

// ── 语音（ACR-059）────────────────────────────────────────────────

function voiceApp(voiceOff?: boolean) {
  const repo = {
    async sessionExists() {
      return true;
    },
    async sessionState() {
      return { exists: true, closedAt: null, lastActiveAt: new Date() };
    },
    async sessionUserId() {
      return "u1";
    },
  } as never;
  const off = voiceOff === undefined ? undefined : async () => voiceOff;
  const router = createHttpRouter(
    repo,
    new SessionBus(),
    {} as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    off,
  );
  return withUser(router);
}

const audio = (meta: unknown = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "audio/wav", "x-audio-meta": JSON.stringify(meta) },
  body: new Uint8Array([1, 2, 3, 4]),
});

describe("[ACR-059] 语音关闭：语音消息、转写、播报三处都拒", () => {
  it("语音消息 → 403 capability_off，在解析录音元数据之前就拒", async () => {
    const r = await call(voiceApp(true), "/v1/session/s1/messages", audio());
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { ...voiceOffBody });
  });

  it("/v1/asr/transcribe → 403 capability_off", async () => {
    const r = await call(voiceApp(true), "/v1/asr/transcribe", audio());
    assert.equal(r.status, 403);
    assert.equal(r.body.capability, "voice");
  });

  it("/v1/tts/speech → 403 capability_off，不调合成供应商", async () => {
    let fetched = 0;
    const store = { async get() { return null; } } as never;
    const fetchImpl = (async () => {
      fetched += 1;
      return new Response("{}");
    }) as typeof fetch;
    const app = withUser(createTtsSpeechRouter(store, { fetchImpl, voiceOff: async () => true }));
    const r = await call(app, "/v1/tts/speech", send({ req_params: { text: "你好" } }));
    assert.equal(r.status, 403);
    assert.equal(r.body.capability, "voice");
    assert.equal(fetched, 0);
  });

  it("开关开着、或没注入 → 语音消息照常进入解析（这里元数据不合法，回 400）", async () => {
    for (const voiceOff of [false, undefined]) {
      const r = await call(voiceApp(voiceOff), "/v1/session/s1/messages", audio());
      assert.equal(r.status, 400, String(voiceOff));
      assert.equal(r.body.error, "invalid_audio_meta");
    }
  });
});
