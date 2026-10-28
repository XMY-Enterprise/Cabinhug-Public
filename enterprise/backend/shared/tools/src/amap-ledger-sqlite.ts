/**
 * 高德额度台账的 SQLite 实现（ACR-064）：单机版没有 Redis，三个进程记到宿主数据目录下的同一个文件里，
 * 网关的费用页（ACR-066）读得到 runtime 记的账，重启也不清零。
 *
 * 行为与内存版 / Redis 版一一对齐（`amap-ledger-sqlite.test.ts` 用同一组断言对照）：
 *  - 计数按（北京日 × key 指纹 × field）原子自增，`record` 返回这一族今日累计；
 *  - 用量保留 3 天（`AMAP_USAGE_TTL_S`），退役记录兜底保留 36 小时（`AMAP_RETIRED_TTL_S`）；
 *  - 「退役 → 复活」观测最新在前、至多 `AMAP_RESET_OBSERVATIONS_MAX` 条。
 *
 * 写失败按台账的约定吞掉并 warn（计数丢一次好过请求失败），文件打不开返回 undefined，调用方退回进程内的账。
 */

import type { DatabaseSync } from "node:sqlite";

import {
  AMAP_RESET_OBSERVATIONS_MAX,
  AMAP_RETIRED_TTL_S,
  AMAP_USAGE_TTL_S,
  amapUsageField,
  beijingDay,
  type AmapResetObservation,
  type AmapRetiredInfo,
  type AmapUsageLedger,
  type AmapUsageSnapshot,
} from "./amap-ledger";
import { openSqliteFile } from "./env-cache-sqlite";

/** 每记这么多次清一次过期的用量与退役行；与⑤缓存的清扫同一取向，不另起定时器。 */
const SWEEP_EVERY_RECORDS = 500;

export interface SqliteAmapLedgerOptions {
  now?: () => number;
  warn?: (msg: string, err?: unknown) => void;
}

export function createSqliteAmapLedger(path: string, opts: SqliteAmapLedgerOptions = {}): AmapUsageLedger | undefined {
  const now = opts.now ?? (() => Date.now());
  const warn = opts.warn ?? ((m, e) => console.warn(m, e));
  let db: DatabaseSync;
  try {
    db = openSqliteFile(path);
    db.exec(`
      CREATE TABLE IF NOT EXISTS amap_usage (
        day TEXT NOT NULL,
        fp TEXT NOT NULL,
        field TEXT NOT NULL,
        n INTEGER NOT NULL,
        PRIMARY KEY (day, fp, field)
      );
      CREATE TABLE IF NOT EXISTS amap_retired (
        fp TEXT PRIMARY KEY,
        info TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS amap_reset_observed (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        obs TEXT NOT NULL
      );
    `);
  } catch (err) {
    warn(`[amap] SQLite 台账文件打不开（${path}），退回进程内的账`, err);
    return undefined;
  }

  const incStmt = db.prepare(`
    INSERT INTO amap_usage (day, fp, field, n) VALUES (?, ?, ?, 1)
    ON CONFLICT(day, fp, field) DO UPDATE SET n = n + 1
  `);
  const familyTotalStmt = db.prepare(
    "SELECT coalesce(sum(n), 0) AS total FROM amap_usage WHERE day = ? AND fp = ? AND substr(field, 1, length(?)) = ?",
  );
  const snapshotStmt = db.prepare("SELECT fp, field, n FROM amap_usage WHERE day = ?");
  const sweepUsageStmt = db.prepare("DELETE FROM amap_usage WHERE day < ?");
  const retireStmt = db.prepare(`
    INSERT INTO amap_retired (fp, info, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(fp) DO UPDATE SET info = excluded.info, expires_at = excluded.expires_at
  `);
  const retiredStmt = db.prepare("SELECT fp, info FROM amap_retired WHERE expires_at > ?");
  const oneRetiredStmt = db.prepare("SELECT info FROM amap_retired WHERE fp = ? AND expires_at > ?");
  const unretireStmt = db.prepare("DELETE FROM amap_retired WHERE fp = ?");
  const sweepRetiredStmt = db.prepare("DELETE FROM amap_retired WHERE expires_at <= ?");
  const observeStmt = db.prepare("INSERT INTO amap_reset_observed (obs) VALUES (?)");
  const trimObservedStmt = db.prepare(
    "DELETE FROM amap_reset_observed WHERE id NOT IN (SELECT id FROM amap_reset_observed ORDER BY id DESC LIMIT ?)",
  );
  const observedStmt = db.prepare("SELECT obs FROM amap_reset_observed ORDER BY id DESC LIMIT ?");
  let records = 0;

  return {
    async record(fp, family, outcome, at) {
      const day = beijingDay(at);
      try {
        incStmt.run(day, fp, amapUsageField(family, outcome));
        records += 1;
        if (records % SWEEP_EVERY_RECORDS === 0) {
          sweepUsageStmt.run(beijingDay(now() - AMAP_USAGE_TTL_S * 1000));
          sweepRetiredStmt.run(now());
        }
        const row = familyTotalStmt.get(day, fp, `${family}:`, `${family}:`) as { total: number };
        return Number(row.total);
      } catch (err) {
        warn("[amap] SQLite 台账记账失败（这一次不计）", err);
        return 0;
      }
    },
    async snapshot(day) {
      const out: AmapUsageSnapshot = {};
      for (const r of snapshotStmt.all(day) as Array<{ fp: string; field: string; n: number }>) {
        (out[r.fp] ??= {})[r.field] = Number(r.n);
      }
      return out;
    },
    async retire(fp, info) {
      retireStmt.run(fp, JSON.stringify(info), now() + AMAP_RETIRED_TTL_S * 1000);
    },
    async retired() {
      const out: Record<string, AmapRetiredInfo> = {};
      for (const r of retiredStmt.all(now()) as Array<{ fp: string; info: string }>) {
        out[r.fp] = JSON.parse(r.info) as AmapRetiredInfo;
      }
      return out;
    },
    async revive(fp, at) {
      const row = oneRetiredStmt.get(fp, now()) as { info: string } | undefined;
      unretireStmt.run(fp);
      if (!row) return;
      const info = JSON.parse(row.info) as AmapRetiredInfo;
      const obs: AmapResetObservation = { fp, retiredAt: info.at, revivedAt: at, hours: (at - info.at) / 3_600_000 };
      observeStmt.run(JSON.stringify(obs));
      trimObservedStmt.run(AMAP_RESET_OBSERVATIONS_MAX);
    },
    async observations() {
      return (observedStmt.all(AMAP_RESET_OBSERVATIONS_MAX) as Array<{ obs: string }>).map(
        (r) => JSON.parse(r.obs) as AmapResetObservation,
      );
    },
  };
}
