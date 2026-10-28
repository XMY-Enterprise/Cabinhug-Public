/**
 * pi 工具路径上的用户身份来源。
 *
 * `trip_plan_commit` / `contact_lookup` 这类工具的 schema 里 `userId` 必填，
 * 而模型不知道这个值，会从上下文里抓一个看起来像 id 的串（例如功能点编号 `F-23-09`）。
 * 这时权限门照常弹窗、工具照常执行，只是作用在一个不存在的用户身上，且不报错。
 *
 * 所以这条路径上会话身份压过入参：模型填什么都不作数。
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { PassThrough } from "node:stream";
import type { ServerResponse } from "node:http";

import {
  handleToolsRequest,
  setGuardGate,
  setSessionResolver,
  setSessionUserResolver,
  TOOLS_INVOKE_PATH,
} from "../src/tools-endpoint";

function fakeRes(): { res: ServerResponse; body: () => unknown } {
  const chunks: string[] = [];
  const stream = new PassThrough() as unknown as ServerResponse;
  stream.writeHead = (() => stream) as ServerResponse["writeHead"];
  stream.end = ((chunk?: unknown) => {
    if (typeof chunk === "string") chunks.push(chunk);
    return stream;
  }) as ServerResponse["end"];
  (stream as { setHeader: unknown }).setHeader = () => stream;
  return { res: stream, body: () => (chunks.length ? JSON.parse(chunks.join("")) : undefined) };
}

function fakeReq(payload: unknown) {
  const req = new PassThrough();
  req.end(JSON.stringify(payload));
  return Object.assign(req, { method: "POST", url: TOOLS_INVOKE_PATH }) as never;
}

describe("pi 路径的用户身份只来自会话", () => {
  let seenSummary = "";
  let seenArgs: Record<string, unknown> | undefined;

  beforeEach(() => {
    seenSummary = "";
    seenArgs = undefined;
    setSessionResolver(() => ({ cabinhugSessionId: "s-1", agent: "trip" }));
    setSessionUserResolver(async () => "demo-user");
    // 拦在权限门上就够了：要验的是"到达工具时手里的 userId 是谁"，
    // 而权限门看到的入参与工具拿到的是同一份。
    setGuardGate({
      check: async (input: { summary: string; args?: unknown }) => {
        seenSummary = input.summary;
        return { decision: "deny" as const, reason: "测试到此为止" };
      },
    } as never);
  });

  afterEach(() => {
    setSessionUserResolver(undefined);
    setGuardGate(undefined as never);
  });

  it("模型编的 userId 被会话身份覆盖，否则取消打在别人身上", async () => {
    const r = fakeRes();
    await handleToolsRequest(
      fakeReq({
        name: "trip_plan_cancel",
        args: { userId: "F-23-09" },
        sessionId: "pi-1",
        agent: "trip",
      }),
      r.res,
    );
    // 摘要是"取消已确认的行程"而不是工具描述 + 原始 JSON。
    assert.match(seenSummary, /取消已确认的行程/);
    assert.doesNotMatch(seenSummary, /F-23-09/, "编出来的 id 不该出现在给用户看的摘要里");
    assert.doesNotMatch(seenSummary, /\{|\}/, "弹窗标题里不该有原始 JSON");
  });

  it("查不到会话用户时不编一个，让工具自己按缺参报错", async () => {
    setSessionUserResolver(async () => undefined);
    const r = fakeRes();
    await handleToolsRequest(
      fakeReq({
        name: "trip_plan_cancel",
        args: {},
        sessionId: "pi-unknown",
        agent: "trip",
      }),
      r.res,
    );
    assert.match(seenSummary, /取消已确认的行程/);
  });

  it("确认落库的摘要带目的地与天数：用户批的是这份行程不是动作名", async () => {
    const r = fakeRes();
    await handleToolsRequest(
      fakeReq({
        name: "trip_plan_commit",
        args: { op: "commit", plan: { destination: "广州", days: 4 } },
        sessionId: "pi-1",
        agent: "trip",
      }),
      r.res,
    );
    assert.match(seenSummary, /确认多天行程并保存：广州 4天/);
  });

  void seenArgs;
});
