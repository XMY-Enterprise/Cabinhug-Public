/**
 * 建出测试库并把 migration 推上去。
 *
 *   corepack pnpm db:test:setup
 *
 * 幂等：库已存在就跳过建库，继续 migrate deploy。反复跑退出码都是 0。
 *
 * # vector 扩展在这里显式建
 *
 * `infra/postgres-init/01-vector.sql` 挂在容器的 `/docker-entrypoint-initdb.d`，
 * 只在首次建卷时对默认库执行，不作用于后建的 `carlife_test`。
 *
 * # CREATE DATABASE 单独连维护库
 *
 * PG 不允许在事务块里执行它，库名也不能参数化。这里连维护库 `postgres` 发一次性语句，
 * 库名来自 `resolveTestDatabaseUrl()` 的返回值，已经过 `_test` 闸校验。
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PrismaClient } from "@prisma/client";

import { resolveTestDatabaseUrl } from "../src/test-db";

const testUrl = resolveTestDatabaseUrl();
const parsed = new URL(testUrl);
const dbName = parsed.pathname.replace(/^\//, "");

/** 同实例的维护库连接：只用来发 CREATE DATABASE。 */
const adminUrl = new URL(testUrl);
adminUrl.pathname = "/postgres";

console.log(`目标测试库：${dbName}（${parsed.host}）`);

const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
try {
  const existing = await admin.$queryRawUnsafe<Array<{ datname: string }>>(
    "SELECT datname FROM pg_database WHERE datname = $1",
    dbName,
  );
  if (existing.length > 0) {
    console.log(`  ✓ 库已存在，跳过建库`);
  } else {
    // 库名来自已校验的 URL；引号包裹避免大小写与保留字问题。
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
    console.log(`  ✓ 已建库 ${dbName}`);
  }
} finally {
  await admin.$disconnect();
}

const target = new PrismaClient({ datasources: { db: { url: testUrl } } });
try {
  await target.$executeRawUnsafe("CREATE EXTENSION IF NOT EXISTS vector");
  console.log("  ✓ vector 扩展就绪（Mem0 的向量表落在同一台 PG）");
} finally {
  await target.$disconnect();
}

// migrate deploy 只认 DATABASE_URL，所以在子进程里把它换成测试库。
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
execFileSync("npx", ["prisma", "migrate", "deploy"], {
  cwd: packageRoot,
  env: { ...process.env, DATABASE_URL: testUrl },
  stdio: "inherit",
});

console.log(`\n✓ 测试库就绪：${dbName}`);
console.log("  开发库未被触碰——测试与演示数据从此互不影响。");
