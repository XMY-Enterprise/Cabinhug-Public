#!/usr/bin/env node
/**
 * 在原生 PostgreSQL 闭包上只验数据库（ACR-060）。不起任何业务服务、不调云端。
 *
 *   corepack pnpm probe:standalone-postgres <闭包目录> <报告.json>
 *
 * 逐项：
 *  1. 闭包与 manifest.json 逐文件一致、平台架构对得上；
 *  2. 随机口令 + 随机回环端口 initdb，只监听 127.0.0.1，错口令被拒；
 *  3. 仓库里全部 Prisma 迁移 deploy 一遍，名字与 SQL 指纹逐条核对；再 deploy 一次应无待执行项；
 *  4. pgvector 版本、HNSW 索引被查询计划用上、重启后数据还在、dump / restore 保留向量与迁移台账；
 *  5. 干净退出：postmaster.pid 消失。
 *
 * 数据目录在系统临时目录下、路径带中文与空格（安装目录与用户名都可能这样）；不碰任何现有数据库。
 * 移植自 Codex 原型（ACR-053，未进 main），改为直接用仓库内的 schema、迁移与 prisma CLI。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { arch, platform, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyManifest } from "../release/native-postgres-closure.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const pgRoot = process.argv[2] && resolve(process.argv[2]);
const output = process.argv[3] && resolve(process.argv[3]);
if (!pgRoot || !output) throw new Error("用法：verify-standalone-postgres.mjs <闭包目录> <报告.json>");

const dbPkg = join(repo, "enterprise/backend/shared/db");
const schema = join(dbPkg, "prisma/schema.prisma");
const migrationsDir = join(dbPkg, "prisma/migrations");
const prismaCli = createRequire(join(dbPkg, "package.json")).resolve("prisma/build/index.js");

const exe = process.platform === "win32" ? ".exe" : "";
const pgBin = join(pgRoot, "bin");
const work = mkdtempSync(join(tmpdir(), "Cabinhug 验证 空间-"));
const dataDir = join(work, "data");
const secret = randomBytes(24).toString("hex");
const baseEnv = {
  PATH: process.platform === "win32" ? `${pgBin};${process.env.SystemRoot}\\System32;${process.env.SystemRoot}` : `${pgBin}:/usr/bin:/bin`,
  HOME: work,
  TMPDIR: work,
  TMP: work,
  TEMP: work,
  LANG: "C",
  ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}),
};
const report = {
  timestamp: new Date().toISOString(),
  scope: "只验数据库：不含宿主、界面、安装包与云端",
  host: { platform: platform(), arch: arch(), release: release(), node: process.version },
  tests: [],
};
let port = 0;
let started = false;

function command(bin, args, extra = {}, timeout = 120_000) {
  const r = spawnSync(bin, args, { cwd: work, env: { ...baseEnv, ...extra }, encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${bin} 失败：${r.stderr ?? ""} ${r.stdout ?? ""}`.replaceAll(secret, "[已遮蔽]"));
  return r.stdout;
}
const pgEnv = (database = "postgres") => ({ PGHOST: "127.0.0.1", PGPORT: String(port), PGUSER: "cabinhug", PGPASSWORD: secret, PGDATABASE: database });
const sql = (query, database) => command(join(pgBin, `psql${exe}`), ["-X", "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", query], pgEnv(database)).trim();
const pgCtl = (...args) => command(join(pgBin, `pg_ctl${exe}`), ["-D", dataDir, ...args]);

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    report.tests.push({ name, status: "pass", ms: Date.now() - t0, detail });
  } catch (e) {
    report.tests.push({ name, status: "fail", ms: Date.now() - t0, error: String(e.message).replaceAll(secret, "[已遮蔽]") });
    throw e;
  }
}

try {
  await step("闭包与清单一致", async () => {
    const audit = verifyManifest(pgRoot);
    assert.equal(audit.manifest.platform, process.platform);
    assert.equal(audit.manifest.arch, process.arch);
    return { files: audit.verifiedFiles, symlinks: audit.verifiedSymlinks, postgres: audit.manifest.sources.postgres.version };
  });

  await step("回环端口 + 口令鉴权初始化", async () => {
    const reserve = createServer();
    await new Promise((r) => reserve.listen(0, "127.0.0.1", r));
    port = reserve.address().port;
    await new Promise((r) => reserve.close(r));
    const pwfile = join(work, "password");
    writeFileSync(pwfile, secret, { mode: 0o600 });
    command(join(pgBin, `initdb${exe}`), ["-D", dataDir, "-U", "cabinhug", "--pwfile", pwfile, "--auth-host=scram-sha-256", "--auth-local=reject", "--encoding=UTF8", "--locale=C"]);
    writeFileSync(join(dataDir, "postgresql.auto.conf"), `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories=''\nshared_buffers='32MB'\nmax_connections=40\n`);
    pgCtl("-l", join(work, "postgres.log"), "-w", "start");
    started = true;
    assert.equal(sql("SHOW listen_addresses"), "127.0.0.1");
    const bad = spawnSync(join(pgBin, `psql${exe}`), ["-X", "-c", "SELECT 1"], { env: { ...baseEnv, ...pgEnv(), PGPASSWORD: "wrong" }, encoding: "utf8", timeout: 10_000 });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /authentication failed/);
    return { version: sql("SELECT version()"), wrongPasswordRejected: true };
  });

  const migrations = readdirSync(migrationsDir).filter((n) => /^\d/.test(n)).sort();
  await step("全部 Prisma 迁移 + 重复 deploy", async () => {
    sql("CREATE DATABASE cabinhug");
    const url = `postgresql://cabinhug:${secret}@127.0.0.1:${port}/cabinhug`;
    const migrate = (action) => command(process.execPath, [prismaCli, "migrate", action, "--schema", schema], { DATABASE_URL: url }, 300_000);
    migrate("deploy");
    const rows = JSON.parse(sql("SELECT json_agg(x ORDER BY migration_name) FROM (SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations) x", "cabinhug"));
    assert.deepEqual(rows.map((r) => r.migration_name), migrations);
    for (const row of rows) {
      assert.ok(row.finished_at, row.migration_name);
      assert.equal(row.rolled_back_at, null);
      const sum = createHash("sha256").update(readFileSync(join(migrationsDir, row.migration_name, "migration.sql"))).digest("hex");
      assert.equal(row.checksum, sum, row.migration_name);
    }
    assert.match(migrate("deploy"), /No pending migrations/);
    assert.match(migrate("status"), /up to date/);
    return { migrations: migrations.length, checksumMatch: true, repeatDeploy: "no pending migrations" };
  });

  await step("向量索引、重启、备份恢复", async () => {
    const vectorVersion = sql("SELECT extversion FROM pg_extension WHERE extname='vector'", "cabinhug");
    assert.ok(vectorVersion, "迁移后应已装好 vector 扩展");
    sql("CREATE SCHEMA probe; CREATE TABLE probe.items(id int PRIMARY KEY, embedding vector(3)); INSERT INTO probe.items VALUES (1,'[1,0,0]'),(2,'[0,1,0]'); CREATE INDEX probe_idx ON probe.items USING hnsw (embedding vector_l2_ops)", "cabinhug");
    assert.match(sql("SET enable_seqscan=off; EXPLAIN SELECT id FROM probe.items ORDER BY embedding <-> '[1,0,0]' LIMIT 1", "cabinhug"), /probe_idx/);
    pgCtl("-m", "fast", "-w", "stop");
    started = false;
    pgCtl("-l", join(work, "postgres.log"), "-w", "start");
    started = true;
    assert.equal(sql("SELECT id FROM probe.items ORDER BY embedding <-> '[1,0,0]' LIMIT 1", "cabinhug"), "1");
    const dump = join(work, "snapshot.dump");
    command(join(pgBin, `pg_dump${exe}`), ["--format=custom", "--compress=0", "--dbname=cabinhug", "--file", dump], pgEnv("cabinhug"));
    sql("CREATE DATABASE restored");
    command(join(pgBin, `pg_restore${exe}`), ["--exit-on-error", "--no-owner", "--no-acl", "--dbname=restored", dump], pgEnv("restored"));
    assert.equal(sql("SELECT count(*) FROM probe.items", "restored"), "2");
    assert.equal(sql("SELECT count(*) FROM _prisma_migrations", "restored"), String(migrations.length));
    return { vector: vectorVersion, indexedPlan: true, restart: true, restoredMigrations: migrations.length };
  });
} catch (e) {
  report.error = String(e.message).replaceAll(secret, "[已遮蔽]");
} finally {
  let clean = true;
  if (started || existsSync(join(dataDir, "postmaster.pid"))) {
    try {
      pgCtl("-m", "fast", "-w", "stop");
    } catch (e) {
      clean = false;
      report.cleanupError = String(e.message);
    }
  }
  if (existsSync(join(dataDir, "postmaster.pid"))) clean = false;
  report.cleanup = { noPostmasterPid: clean, workDir: work };
  report.verdict = !report.error && clean ? "pass" : "fail";
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ verdict: report.verdict, tests: report.tests.map((t) => `${t.status} ${t.name}`), error: report.error }, null, 2));
  process.exitCode = report.verdict === "pass" ? 0 : 2;
}
