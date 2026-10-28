/**
 * 测试库解析器与 `_test` 安全闸。
 *
 * 这组用例守的不变量：测试永远不会连上开发库。
 * 「不回落」那条单独成用例：回落写错不会报错，只会表现为开发库数据丢失。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_TEST_DATABASE_URL,
  resolveTestDatabaseUrl,
  TestDatabaseUrlError,
  testCloneDatabaseName,
  testCloneUrl,
} from "../src/test-db";

describe("测试库地址解析与安全闸", () => {
  it("未配置时用测试库默认值，库名是 carlife_test", () => {
    const url = resolveTestDatabaseUrl({});
    assert.equal(url, DEFAULT_TEST_DATABASE_URL);
    assert.equal(new URL(url).pathname, "/carlife_test");
  });

  it("配了 DATABASE_URL 也不回落：守的是隔离本身", () => {
    // 回落写错时其他测试照常通过，只有这条能发现。
    const url = resolveTestDatabaseUrl({
      DATABASE_URL: "postgresql://carlife:carlife@localhost:55433/carlife",
    });
    assert.equal(url, DEFAULT_TEST_DATABASE_URL);
    assert.ok(!url.endsWith("/carlife"), "回落到了开发库——隔离失效");
  });

  it("显式配置的 _test 库原样返回", () => {
    const given = "postgresql://u:p@db.example:5432/carlife_test";
    assert.equal(resolveTestDatabaseUrl({ TEST_DATABASE_URL: given }), given);
  });

  it("查询串不影响库名判定", () => {
    const given = "postgresql://u:p@localhost:5432/foo_test?schema=public&connection_limit=1";
    assert.equal(resolveTestDatabaseUrl({ TEST_DATABASE_URL: given }), given);
  });

  it("库名不以 _test 结尾时拒绝运行，且消息点名被拒的库", () => {
    let err: unknown;
    try {
      resolveTestDatabaseUrl({
        TEST_DATABASE_URL: "postgresql://carlife:carlife@localhost:55433/carlife",
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof TestDatabaseUrlError, "应抛 TestDatabaseUrlError");
    assert.match(err.message, /carlife/);
    assert.match(err.message, /_test/);
  });

  it("以 _test 为子串但不在结尾的库名同样拒绝", () => {
    assert.throws(
      () => resolveTestDatabaseUrl({ TEST_DATABASE_URL: "postgresql://l/carlife_test_backup" }),
      TestDatabaseUrlError,
    );
  });

  it("空串按未配置处理，落回默认值", () => {
    assert.equal(resolveTestDatabaseUrl({ TEST_DATABASE_URL: "   " }), DEFAULT_TEST_DATABASE_URL);
  });

  it("非法 URL 抛错而不是悄悄用默认值", () => {
    // 静默退回会让拼错的连接串悄悄指向默认库，测试实际连的不是预期的库。
    assert.throws(
      () => resolveTestDatabaseUrl({ TEST_DATABASE_URL: "不是一个 URL" }),
      TestDatabaseUrlError,
    );
  });
});

describe("[TD-60] 按包克隆的测试库名", () => {
  it("包名去掉作用域、非字母数字换成下划线，结尾仍是 _test", () => {
    assert.equal(testCloneDatabaseName("carlife_test", "@cabinhug/gateway"), "carlife_gateway_test");
    assert.equal(testCloneDatabaseName("carlife_test", "@cabinhug/agent-runtime"), "carlife_agent_runtime_test");
  });

  it("克隆库地址只换库名：主机、账号、参数不变，且照样过 _test 闸", () => {
    const url = testCloneUrl("postgresql://u:p@db.example:5432/carlife_test?connection_limit=5", "@cabinhug/worker");
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/carlife_worker_test");
    assert.equal(parsed.host, "db.example:5432");
    assert.equal(parsed.searchParams.get("connection_limit"), "5");
    assert.equal(resolveTestDatabaseUrl({ TEST_DATABASE_URL: url }), url);
  });

  it("超长包名截到 PG 标识符上限 63 以内，仍以 _test 结尾", () => {
    const name = testCloneDatabaseName("carlife_test", `@cabinhug/${"x".repeat(80)}`);
    assert.ok(name.length <= 63, String(name.length));
    assert.ok(name.endsWith("_test"));
  });
});
