/**
 * 「被限流」必须能和「高德说没有这个地方」分开。
 *
 * 高德一律回 200，失败信息只在 `infocode` 里。若只保留给人看的 message，
 * 调用方的 `catch` 里无法区分两件事：
 *
 *   - 10021 QPS 超限 → 这个地方存在，只是这一刻问不到
 *   - 高德回空结果   → 高德明确说没有
 *
 * 混在一起时限流被当成"查不到"，按「不标不猜」纪律不落坐标，HUD 上会缺点且不报错。
 * 所以码结构化带在错误上，判据只看码、不解析 message。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAmapClient, isRateLimited } from "../src/amap";
import { ToolError } from "../src/external";

function client(body: unknown) {
  const impl = (async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response) as unknown as typeof fetch;
  return createAmapClient({ key: "k", fetchImpl: impl });
}
const fail = (infocode: string, info = "x") => ({ status: "0", infocode, info });

describe("infocode 结构化带在 ToolError 上", () => {
  it("限流码原样带上来，不从 message 里解析", async () => {
    const err = await client(fail("10021", "CUQPS_HAS_EXCEEDED_THE_LIMIT"))
      .textSearch({ keywords: "甲", region: "苏州", limit: 1 })
      .then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof ToolError);
    assert.equal(err.code, "10021");
    assert.equal(err.retryable, true);
    assert.equal(isRateLimited(err), true);
  });

  it("参数非法不是限流，也不该重试", async () => {
    const err = await client(fail("20000"))
      .textSearch({ keywords: "甲", region: "苏州", limit: 1 })
      .then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof ToolError);
    assert.equal(err.code, "20000");
    assert.equal(err.retryable, false);
    assert.equal(isRateLimited(err), false);
  });

  it("引擎偶发异常可重试但不是限流——两种重试的理由不同", async () => {
    const err = await client(fail("30000"))
      .textSearch({ keywords: "甲", region: "苏州", limit: 1 })
      .then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof ToolError);
    assert.equal(err.retryable, true, "值得重试");
    assert.equal(isRateLimited(err), false, "但它不是被限流");
  });

  it("配额用尽（10003）既不重试也不算限流——当天重试结果不变", async () => {
    const err = await client(fail("10003"))
      .textSearch({ keywords: "甲", region: "苏州", limit: 1 })
      .then(() => undefined, (e: unknown) => e);
    assert.ok(err instanceof ToolError);
    assert.equal(err.retryable, false);
    assert.equal(isRateLimited(err), false);
    assert.match(err.message, /配额用尽/, "人话解释要留着，排查的人不必翻高德文档");
  });

  it("限流那一族整族都算——10021 之外还有并发超限与短时封禁", async () => {
    for (const code of ["10004", "10014", "10015", "10020", "10021", "10022", "10023", "10029"]) {
      assert.equal(isRateLimited(new ToolError("amap", "upstream", "x", true, code)), true, code);
    }
    for (const code of ["10019", "20800", "30000", "30001", "30002", "30003"]) {
      assert.equal(isRateLimited(new ToolError("amap", "upstream", "x", true, code)), false, code);
    }
  });

  it("判据只看 code，不看 message——文案一改就漂移的东西不能当判据", () => {
    assert.equal(isRateLimited(new ToolError("amap", "upstream", "CUQPS_HAS_EXCEEDED_THE_LIMIT 10021", true)), false);
    assert.equal(isRateLimited(new Error("10021")), false);
    assert.equal(isRateLimited(undefined), false);
  });
});
