/**
 * 给每个包克隆一份测试库（TD-60）。只被 `scripts/dev/check/with-test-db.ts` 调用。
 *
 * 每次测试前重建：`DROP … WITH (FORCE)` 再 `CREATE DATABASE … TEMPLATE <测试库>`。
 * 克隆 20 MB 的库约 0.3 秒，比让上一轮的残留数据留着、各包再各自清理可靠。
 * schema 跟着测试库走：迁移仍只推到测试库（`db:test:setup`），克隆自然带上。
 */

import { PrismaClient } from "@prisma/client";

import { resolveTestDatabaseUrl, testCloneDatabaseName, testCloneUrl } from "./test-db";

/** 返回 `{ 包名: 克隆库地址 }`。`baseUrl` 必须已过 `resolveTestDatabaseUrl()` 的 `_test` 闸。 */
export async function prepareTestDatabaseClones(
  baseUrl: string,
  packageNames: readonly string[],
): Promise<Record<string, string>> {
  // 再过一次闸：克隆会先 DROP，库名算错时不能落到开发库上。
  const checked = resolveTestDatabaseUrl({ TEST_DATABASE_URL: baseUrl });
  const base = new URL(checked).pathname.replace(/^\//, "");
  const admin = new URL(checked);
  admin.pathname = "/postgres";
  const client = new PrismaClient({ datasources: { db: { url: admin.toString() } } });
  const out: Record<string, string> = {};
  try {
    // 模板库上不能有别的连接；残留的只可能是上一轮被杀掉的测试进程。
    await client.$queryRawUnsafe(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      base,
    );
    for (const name of packageNames) {
      const clone = testCloneDatabaseName(base, name);
      if (!clone.endsWith("_test") || clone === base) throw new Error(`克隆库名不合规：${clone}`);
      await client.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${clone}" WITH (FORCE)`);
      await client.$executeRawUnsafe(`CREATE DATABASE "${clone}" TEMPLATE "${base}"`);
      out[name] = testCloneUrl(checked, name);
    }
  } finally {
    await client.$disconnect();
  }
  return out;
}
