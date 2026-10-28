/**
 * [ACR-062] 会话行程只读端点。与 diagnosis.test.ts 同构：三态 + 鉴权 + 会话归属。
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import express from "express";

import { createTripDraftRouter } from "../src/http/trip-draft";

const PLAN = {
  status: "skeleton",
  origin: "上海",
  destination: "杭州",
  startDate: "2026-10-31",
  days: 2,
  skeleton: [{ day: 1, theme: "钱江新城", spots: [{ name: "钱江世纪公园" }] }],
  caveats: [],
};

let runtime: Server;
let runtimeMode: "ok" | "empty" | "down" = "ok";
const seenPaths: string[] = [];

before(async () => {
  runtime = createServer((req, res) => {
    seenPaths.push(req.url ?? "");
    if (runtimeMode === "down") {
      res.writeHead(500).end("{}");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(runtimeMode === "empty" ? { plan: null } : { plan: PLAN }));
  });
  await new Promise<void>((r) => runtime.listen(0, "127.0.0.1", r));
  const addr = runtime.address();
  process.env.AGENT_RUNTIME_URL = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
after(() => runtime.close());

function appWith(owner: string | null | undefined, userId: string | null) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = userId ?? undefined;
    next();
  });
  app.use(createTripDraftRouter({ async sessionUserId() { return owner; } }));
  return app;
}
async function get(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/session/sess-1/trip-draft`);
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

describe("[ACR-062] GET /v1/session/:id/trip-draft", () => {
  it("原样透传 runtime 给的行程，路径带会话号与请求者", async () => {
    runtimeMode = "ok";
    const r = await get(appWith("u1", "u1"));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.plan, PLAN);
    assert.equal(seenPaths.at(-1), "/internal/trip-draft/sess-1?userId=u1");
  });
  it("未鉴权 401", async () => {
    assert.equal((await get(appWith("u1", null))).status, 401);
  });
  it("会话不存在、或属于别人 → 一律 404", async () => {
    runtimeMode = "ok";
    assert.equal((await get(appWith(undefined, "u1"))).status, 404);
    assert.equal((await get(appWith("u2", "u1"))).status, 404);
  });
  it("还没排过行程 → 200 {plan:null}", async () => {
    runtimeMode = "empty";
    const r = await get(appWith("u1", "u1"));
    assert.equal(r.status, 200);
    assert.equal(r.body.plan, null);
  });
  it("runtime 不可用 → 502，不把「读不到」说成「没有」", async () => {
    runtimeMode = "down";
    assert.equal((await get(appWith("u1", "u1"))).status, 502);
  });
});
