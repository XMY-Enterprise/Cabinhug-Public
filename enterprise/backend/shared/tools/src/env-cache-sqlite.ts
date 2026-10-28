/**
 * ⑤环境缓存的 SQLite 后端（ACR-064）：单机版没有 Redis，缓存落在宿主数据目录下的一个文件里。
 *
 * 用 Node 内置的 `node:sqlite`：随运行时分发，不进 lockfile，没有原生编译（better-sqlite3 要按平台 × ABI 带预编译产物）。
 * 三个服务进程可以同时打开同一个文件：WAL 让读不挡写，`busy_timeout` 让并发写排队等，而不是立刻报 SQLITE_BUSY。
 *
 * 语义与 Redis 版一一对齐，调用方（`withEnvCache`）分不出是哪一个：
 *  - `set` 带 TTL（秒），过期的键对 `get` / `entry` / `list` / `size` 都不存在；
 *  - `entry` 不续期——查看不应延长条目寿命；
 *  - 只数本前缀（`KEY_PREFIX`）下的键。
 *
 * 过期行在读时跳过，物理删除按写入次数顺手清一批：不另起定时器，否则三个进程三个定时器各删一遍。
 *
 * 这不是「单机版改用 SQLite」（ARCH-002 否决的是整个数据层）：这里只是键值缓存的存储，没有 schema 迁移，
 * 文件删掉就是一次冷缓存。打不开文件（目录没权限、文件损坏）返回 undefined，调用方退回直连。
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  KEY_PREFIX,
  namespaceOf,
  paginateKeys,
  PREVIEW_CHARS,
  SCAN_CAP,
  type EnvCacheBackend,
  type EnvCacheEntry,
} from "./env-cache";
import { describeEnvCacheEntry } from "./env-cache-summary";

/** 并发写最多等多久（毫秒）。三个进程的写都是单行 UPSERT，排队远用不了这么久；超了才是真卡住。 */
const BUSY_TIMEOUT_MS = 5_000;
/** 每写这么多次清一次过期行。一轮行程规划约几十次写，清扫成本只是一条带索引的 DELETE。 */
const SWEEP_EVERY_WRITES = 200;

export interface SqliteEnvCacheOptions {
  /** 单测注入时钟；缺省 `Date.now`。 */
  now?: () => number;
  warn?: (msg: string, err?: unknown) => void;
}

/** 打开（必要时建）SQLite 文件并设好 WAL 与等锁；后面的台账实现共用这一段。 */
export function openSqliteFile(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  // 内存库不支持 WAL（返回 memory），不算错误。
  db.exec("PRAGMA journal_mode = WAL");
  // WAL 下 NORMAL 已能保证不损坏，只可能丢最后几次提交——缓存丢了就是重取一次。
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}

const prefixMatch = "substr(key, 1, length(:prefix)) = :prefix";

export function createSqliteEnvCache(path: string, opts: SqliteEnvCacheOptions = {}): EnvCacheBackend | undefined {
  const now = opts.now ?? (() => Date.now());
  const warn = opts.warn ?? ((m, e) => console.warn(m, e));
  let db: DatabaseSync;
  try {
    db = openSqliteFile(path);
    db.exec(`
      CREATE TABLE IF NOT EXISTS env_cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS env_cache_expires ON env_cache(expires_at);
    `);
  } catch (err) {
    warn(`[env-cache] SQLite 缓存文件打不开（${path}），外部调用将直连`, err);
    return undefined;
  }

  const getStmt = db.prepare("SELECT value FROM env_cache WHERE key = ? AND expires_at > ?");
  const entryStmt = db.prepare("SELECT value, expires_at FROM env_cache WHERE key = ? AND expires_at > ?");
  const setStmt = db.prepare(`
    INSERT INTO env_cache (key, value, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at
  `);
  const sweepStmt = db.prepare("DELETE FROM env_cache WHERE expires_at <= ?");
  const sizeStmt = db.prepare(`SELECT count(*) AS n FROM env_cache WHERE expires_at > :now AND ${prefixMatch}`);
  // 多取一行：取到 SCAN_CAP + 1 行即知道撞了上限，与 Redis 版的 `truncated` 同义。
  const keysStmt = db.prepare(
    `SELECT key FROM env_cache WHERE expires_at > :now AND ${prefixMatch} ORDER BY key LIMIT :cap`,
  );
  let writes = 0;

  const ttlLeft = (expiresAt: number): number => Math.max(0, Math.ceil((expiresAt - now()) / 1000));

  return {
    async get(key) {
      const row = getStmt.get(key, now()) as { value: string } | undefined;
      return row?.value ?? null;
    },
    async set(key, value, ttlSeconds) {
      // Redis 的 EX 不收 0 与负数；这里同样按至少 1 秒存，不写一条永不过期的。
      setStmt.run(key, value, now() + Math.max(1, ttlSeconds) * 1000);
      writes += 1;
      if (writes % SWEEP_EVERY_WRITES === 0) sweepStmt.run(now());
    },
    async entry(key) {
      const row = entryStmt.get(key, now()) as { value: string; expires_at: number } | undefined;
      return row ? { value: row.value, ttlSeconds: ttlLeft(row.expires_at) } : null;
    },
    async size() {
      const row = sizeStmt.get({ now: now(), prefix: KEY_PREFIX }) as { n: number };
      return Number(row.n);
    },
    async list({ offset, limit, namespace }) {
      const rows = keysStmt.all({ now: now(), prefix: KEY_PREFIX, cap: SCAN_CAP + 1 }) as Array<{ key: string }>;
      const truncated = rows.length > SCAN_CAP;
      const all = rows.slice(0, SCAN_CAP).map((r) => r.key);
      const { page, total, totalAll, namespaces } = paginateKeys(all, { offset, limit, namespace });
      const entries = page.map((key): EnvCacheEntry => {
        const row = entryStmt.get(key, now()) as { value: string; expires_at: number } | undefined;
        const raw = row?.value ?? null;
        const { title, summary } = describeEnvCacheEntry(key, raw);
        return {
          key,
          namespace: namespaceOf(key),
          ttlSeconds: row ? ttlLeft(row.expires_at) : 0,
          sizeBytes: raw ? Buffer.byteLength(raw, "utf8") : 0,
          preview: raw ? raw.slice(0, PREVIEW_CHARS) + (raw.length > PREVIEW_CHARS ? "…" : "") : "（读取时已过期）",
          title,
          summary,
        };
      });
      return { entries, total, totalAll, truncated, namespaces };
    },
  };
}
