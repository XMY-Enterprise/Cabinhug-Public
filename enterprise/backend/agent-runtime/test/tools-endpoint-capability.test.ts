/**
 * [ACR-059] 工具端点认能力开关。
 *
 * `listForAgent` 剔除之后，pi 进程若是开关改值之前起的，`--tools` 里还留着旧工具；
 * 执行端要拦住，并说清是「这一版没开放」，而不是「不属于这个 Agent」——后者会让模型换个说法重试。
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { PassThrough } from "node:stream";
import type { ServerResponse } from "node:http";

import { CAPABILITIES, type Capability } from "@cabinhug/shared";
import { setToolCapabilitiesOff } from "@cabinhug/tools";

import { handleToolsRequest, TOOLS_DESCRIBE_PATH, TOOLS_INVOKE_PATH } from "../src/tools-endpoint";

function fakeRes(): { res: ServerResponse; body: () => any; status: () => number } {
  const chunks: string[] = [];
  let status = 0;
  const stream = new PassThrough() as unknown as ServerResponse;
  stream.writeHead = ((code: number) => {
    status = code;
    return stream;
  }) as ServerResponse["writeHead"];
  stream.end = ((chunk?: unknown) => {
    if (typeof chunk === "string") chunks.push(chunk);
    return stream;
  }) as ServerResponse["end"];
  (stream as { setHeader: unknown }).setHeader = () => stream;
  return { res: stream, body: () => (chunks.length ? JSON.parse(chunks.join("")) : undefined), status: () => status };
}

function invokeReq(payload: unknown) {
  const req = new PassThrough();
  req.end(JSON.stringify(payload));
  return Object.assign(req, { method: "POST", url: TOOLS_INVOKE_PATH }) as never;
}

function describeReq(agent: string) {
  const req = new PassThrough();
  req.end();
  return Object.assign(req, { method: "GET", url: `${TOOLS_DESCRIBE_PATH}?agent=${agent}` }) as never;
}

const STANDALONE_OFF: ReadonlySet<Capability> = new Set(CAPABILITIES);

describe("[ACR-059] 工具端点认能力开关", () => {
  afterEach(() => setToolCapabilitiesOff(new Set()));

  it("关闭能力的工具 → 403 capability_off，并点名是哪项能力", async () => {
    setToolCapabilitiesOff(STANDALONE_OFF);
    const r = fakeRes();
    await handleToolsRequest(invokeReq({ name: "dealer_stores", agent: "supervisor", args: { model: "x", city: "杭州" } }), r.res);
    assert.equal(r.status(), 403);
    assert.equal(r.body().error, "capability_off");
    assert.equal(r.body().capability, "buying-advice");
    assert.match(r.body().reason, /不要换别的工具/);
  });

  it("describe 不再把关闭能力的工具发给 pi", async () => {
    setToolCapabilitiesOff(STANDALONE_OFF);
    const r = fakeRes();
    await handleToolsRequest(describeReq("supervisor"), r.res);
    const names = (r.body().tools as Array<{ name: string }>).map((t) => t.name);
    assert.ok(!names.includes("dealer_pricing"));
    assert.ok(names.includes("weather"));
  });

  it("缺省（什么都不关）→ 照旧走 ACL，不出现 capability_off", async () => {
    const r = fakeRes();
    await handleToolsRequest(invokeReq({ name: "dealer_stores", agent: "drive", args: {} }), r.res);
    assert.equal(r.status(), 403);
    assert.equal(r.body().error, "tool_not_allowed_for_agent", "drive 本来就没有门店工具");
  });
});
