/**
 * [ACR-062] runtime 的会话行程只读端点：只读检查点，不跑图。
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, it } from "node:test";

import { createRuntimeServer } from "../src/server";

async function call(runner: unknown, path: string) {
  const server = createRuntimeServer(runner as never).listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

describe("[ACR-062] GET /internal/trip-draft/:sessionId", () => {
  it("把会话号与 userId 交给 runner.tripDraftState，原样返回", async () => {
    const seen: string[] = [];
    const runner = {
      async tripDraftState(id: string, userId?: string) {
        seen.push(`${id}/${userId}`);
        return { plan: { status: "skeleton", destination: "杭州" } };
      },
      async run() {
        throw new Error("只读查询不该跑图");
      },
    };
    const r = await call(runner, "/internal/trip-draft/sess-1?userId=u1");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { plan: { status: "skeleton", destination: "杭州" } });
    assert.deepEqual(seen, ["sess-1/u1"]);
  });

  it("读检查点抛错 → 500，不吞成 null", async () => {
    const r = await call({ async tripDraftState() { throw new Error("pg down"); } }, "/internal/trip-draft/sess-1");
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "trip_draft_state_failed");
  });

  it("同族的拍照问诊、购车只读端点出错也回 500：先写 200 再出错时请求会挂着不回", async () => {
    const boom = async () => {
      throw new Error("pg down");
    };
    const dx = await call({ diagnosisState: boom }, "/internal/diagnosis/sess-1");
    assert.equal(dx.status, 500);
    assert.equal(dx.body.error, "diagnosis_state_failed");
    const buy = await call({ buyingState: boom }, "/internal/buying/sess-1");
    assert.equal(buy.status, 500);
  });
});
