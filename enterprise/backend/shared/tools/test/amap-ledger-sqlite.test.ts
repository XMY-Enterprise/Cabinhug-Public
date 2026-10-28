/**
 * [ACR-064] 高德额度台账的 SQLite 实现：与内存版同一组操作、同一组结果，另加跨进程共享与保留期。
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  AMAP_RESET_OBSERVATIONS_MAX,
  AMAP_RETIRED_TTL_S,
  AMAP_USAGE_TTL_S,
  beijingDay,
  createMemoryAmapLedger,
  type AmapUsageLedger,
} from "../src/amap-ledger";
import { createSqliteAmapLedger } from "../src/amap-ledger-sqlite";

const T0 = Date.UTC(2026, 9, 27, 4, 0, 0);

async function script(ledger: AmapUsageLedger): Promise<unknown> {
  const totals = [
    await ledger.record("fpA", "place", "ok", T0),
    await ledger.record("fpA", "place", "rate_limited", T0 + 1),
    await ledger.record("fpA", "route", "ok", T0 + 2),
    await ledger.record("fpB", "place", "ok", T0 + 3),
    await ledger.record("fpA", "place", "ok", T0 + 4),
  ];
  return { totals, snapshot: await ledger.snapshot(beijingDay(T0)) };
}

describe("[ACR-064] SQLite 高德台账", () => {
  it("记账与快照：与内存版逐项相同", async () => {
    const sqlite = createSqliteAmapLedger(":memory:", { now: () => T0 })!;
    assert.deepEqual(await script(sqlite), await script(createMemoryAmapLedger()));
  });

  it("退役 / 复活：复活时留一条观测，退役记录随之消失", async () => {
    let t = T0;
    const ledger = createSqliteAmapLedger(":memory:", { now: () => t })!;
    await ledger.retire("fpA", { at: T0, family: "place", infocode: "10044" });
    assert.deepEqual(Object.keys(await ledger.retired()), ["fpA"]);
    t = T0 + 3 * 3_600_000;
    await ledger.revive("fpA", t);
    assert.deepEqual(await ledger.retired(), {});
    const [obs] = await ledger.observations();
    assert.deepEqual(obs, { fp: "fpA", retiredAt: T0, revivedAt: t, hours: 3 });
  });

  it("退役兜底保留 36 小时；观测至多留上限条，最新在前", async () => {
    let t = T0;
    const ledger = createSqliteAmapLedger(":memory:", { now: () => t })!;
    await ledger.retire("fpA", { at: T0, family: "place", infocode: "10044" });
    t = T0 + AMAP_RETIRED_TTL_S * 1000 + 1;
    assert.deepEqual(await ledger.retired(), {});
    for (let i = 0; i < AMAP_RESET_OBSERVATIONS_MAX + 5; i += 1) {
      await ledger.retire(`fp${i}`, { at: t, family: "route", infocode: "10044" });
      await ledger.revive(`fp${i}`, t + i);
    }
    const obs = await ledger.observations();
    assert.equal(obs.length, AMAP_RESET_OBSERVATIONS_MAX);
    assert.equal(obs[0]!.fp, `fp${AMAP_RESET_OBSERVATIONS_MAX + 4}`);
  });

  it("三个进程记同一个文件：计数累加在一起", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "amap-ledger-sqlite-")), "cache.sqlite");
    const runtime = createSqliteAmapLedger(path)!;
    const worker = createSqliteAmapLedger(path)!;
    await runtime.record("fpA", "place", "ok", T0);
    assert.equal(await worker.record("fpA", "place", "ok", T0), 2);
    const gateway = createSqliteAmapLedger(path)!;
    assert.deepEqual(await gateway.snapshot(beijingDay(T0)), { fpA: { "place:ok": 2 } });
  });

  it("用量保留 3 天：清扫后更早的日子不在了", async () => {
    let t = T0;
    const ledger = createSqliteAmapLedger(":memory:", { now: () => t })!;
    await ledger.record("fpA", "place", "ok", T0);
    t = T0 + AMAP_USAGE_TTL_S * 1000 + 86_400_000;
    // 清扫按记账次数触发：记够一轮。
    for (let i = 0; i < 500; i += 1) await ledger.record("fpA", "weather", "ok", t);
    assert.deepEqual(await ledger.snapshot(beijingDay(T0)), {});
    assert.equal((await ledger.snapshot(beijingDay(t))).fpA?.["weather:ok"], 500);
  });
});
