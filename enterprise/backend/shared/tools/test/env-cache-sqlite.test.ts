/**
 * [ACR-064] ⑤环境缓存的 SQLite 后端。
 *
 * 守的是「换了后端、语义不变」：`withEnvCache` 分不出背后是 Redis 还是这个文件。
 * 三条最容易写歪的：过期的键必须读不到；查看（entry）不续期；文件打不开时退回直连而不是抛出。
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { envCacheKey, resetEnvCacheStats, setEnvCache, withEnvCache } from "../src/env-cache";
import { createSqliteEnvCache } from "../src/env-cache-sqlite";

const dir = () => mkdtempSync(join(tmpdir(), "env-cache-sqlite-"));

describe("[ACR-064] SQLite ⑤缓存", () => {
  afterEach(() => {
    setEnvCache(undefined);
    resetEnvCacheStats();
  });

  it("TTL 到期即读不到；到期前 entry 给剩余秒数且不续期", async () => {
    let t = 1_000_000;
    const cache = createSqliteEnvCache(":memory:", { now: () => t })!;
    const key = envCacheKey("route", ["a", "b"]);
    await cache.set(key, "v1", 10);
    t += 4_000;
    assert.equal(await cache.get(key), "v1");
    assert.deepEqual(await cache.entry!(key), { value: "v1", ttlSeconds: 6 });
    // 看了一眼不该延长寿命：再过 6 秒照样过期。
    t += 6_000;
    assert.equal(await cache.get(key), null);
    assert.equal(await cache.entry!(key), null);
  });

  it("覆盖写刷新值与过期时间；TTL 不足 1 秒按 1 秒存，不写永不过期的行", async () => {
    let t = 0;
    const cache = createSqliteEnvCache(":memory:", { now: () => t })!;
    const key = envCacheKey("geocode", ["杭州"]);
    await cache.set(key, "old", 5);
    await cache.set(key, "new", 60);
    t += 30_000;
    assert.equal(await cache.get(key), "new");
    await cache.set(key, "zero", 0);
    t += 1_001;
    assert.equal(await cache.get(key), null);
  });

  it("size / list 只数本前缀下没过期的键，分页与命名空间分布与 Redis 版同口径", async () => {
    let t = 0;
    const cache = createSqliteEnvCache(":memory:", { now: () => t })!;
    await cache.set(envCacheKey("route", ["1"]), '{"a":1}', 100);
    await cache.set(envCacheKey("route", ["2"]), '{"a":2}', 100);
    await cache.set(envCacheKey("geocode", ["x"]), '"x"', 100);
    await cache.set(envCacheKey("weather", ["soon"]), '"w"', 1);
    await cache.set("别处:直接写的键", "z", 100);
    t += 2_000;
    assert.equal(await cache.size!(), 3);
    const page = await cache.list!({ offset: 0, limit: 2, namespace: "route" });
    assert.equal(page.total, 2);
    assert.equal(page.totalAll, 3);
    assert.equal(page.truncated, false);
    assert.deepEqual(
      page.namespaces.map((n) => [n.namespace, n.count]),
      [
        ["route", 2],
        ["geocode", 1],
      ],
    );
    assert.equal(page.entries.length, 2);
    assert.ok(page.entries.every((e) => e.namespace === "route" && e.ttlSeconds === 98));
  });

  it("两个连接（两个进程）共用一个文件：一边写、另一边读得到", async () => {
    const path = join(dir(), "cache", "env-cache.sqlite");
    const a = createSqliteEnvCache(path)!;
    const b = createSqliteEnvCache(path)!;
    const key = envCacheKey("guide-brief", ["杭州", "清河坊"]);
    await a.set(key, '{"ok":true}', 60);
    assert.equal(await b.get(key), '{"ok":true}');
  });

  it("文件打不开时返回 undefined（调用方退回直连），不抛", () => {
    const d = dir();
    const blocker = join(d, "not-a-dir");
    writeFileSync(blocker, "x");
    const warned: string[] = [];
    const cache = createSqliteEnvCache(join(blocker, "env-cache.sqlite"), { warn: (m) => warned.push(m) });
    assert.equal(cache, undefined);
    assert.equal(warned.length, 1);
  });

  it("接进 withEnvCache：第二次命中，重开文件后仍命中（跨重启）", async () => {
    const path = join(dir(), "env-cache.sqlite");
    setEnvCache(createSqliteEnvCache(path));
    let calls = 0;
    const fetch = async () => ({ n: ++calls });
    const key = envCacheKey("destination-highlights", ["杭州", "2026-10-24"]);
    assert.deepEqual(await withEnvCache(key, 60, fetch), { value: { n: 1 }, cached: false });
    assert.deepEqual(await withEnvCache(key, 60, fetch), { value: { n: 1 }, cached: true });
    setEnvCache(createSqliteEnvCache(path));
    assert.deepEqual(await withEnvCache(key, 60, fetch), { value: { n: 1 }, cached: true });
    assert.equal(calls, 1);
  });
});
