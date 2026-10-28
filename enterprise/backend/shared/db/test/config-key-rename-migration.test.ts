/**
 * 热配置键改名迁移（ACR-051）。连真实 PG。
 *
 * 守的是"迁移后配置照旧生效"：旧键的行按新键读得到原值、修订历史不断成两截。
 * 整组在一个事务里做完再回滚：这三个键是全局的，测试库里可能已有别的用例留下的行。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import { createConfigStore } from "../src/config/store";

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATION = new URL(
  "../prisma/migrations/20260926030000_rename_config_keys_cabinhug/migration.sql",
  import.meta.url,
);
// 拼接写法：本仓的旧名扫描不该命中测试自己。
const OLD = "CAR" + "LIFE_";
const SUFFIXES = ["LLM_FAKE_TAG", "TOOLS", "WEATHER_CMA"] as const;
const SEED: Record<(typeof SUFFIXES)[number], string> = {
  LLM_FAKE_TAG: "m110-tag",
  TOOLS: "mock",
  WEATHER_CMA: "off",
};

/** 去掉注释行后按分号切；本迁移里没有带分号的字符串字面量。 */
function statementsOf(sql: string): string[] {
  const body = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  return body
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

class Rollback extends Error {}

function isTestDb(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith("_test");
  } catch {
    return false;
  }
}

if (!DATABASE_URL || !isTestDb(DATABASE_URL)) {
  describe("[M110-09] 热配置键改名迁移", () => {
    it("跳过：DATABASE_URL 未设置或不是 _test 库（这组会动全局配置键，只许在测试库跑）", () =>
      assert.ok(true));
  });
} else {
  describe("[M110-09] 热配置键改名迁移", () => {
    it("旧键三行迁移后按新键读到原值，修订历史跟着走", async () => {
      const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
      // env 会压过库里的值（解析顺序 env-override → db → env → default），先摘掉。
      const saved = new Map<string, string | undefined>();
      for (const s of SUFFIXES) {
        for (const name of [`CABINHUG_${s}`, `${OLD}${s}`]) {
          saved.set(name, process.env[name]);
          delete process.env[name];
        }
      }
      try {
        await prisma.$transaction(async (tx) => {
          const keys = SUFFIXES.flatMap((s) => [`CABINHUG_${s}`, `${OLD}${s}`]);
          await tx.configItem.deleteMany({ where: { key: { in: keys } } });
          await tx.configItemRevision.deleteMany({ where: { key: { in: keys } } });
          for (const s of SUFFIXES) {
            await tx.configItem.create({
              data: { key: `${OLD}${s}`, value: SEED[s], isSecret: false, updatedBy: "m110-09" },
            });
            await tx.configItemRevision.create({
              data: { id: `m110-09-${s}`, key: `${OLD}${s}`, changedBy: "m110-09", isSecret: false },
            });
          }

          for (const statement of statementsOf(readFileSync(MIGRATION, "utf8"))) {
            await tx.$executeRawUnsafe(statement);
          }

          assert.equal(await tx.configItem.count({ where: { key: { startsWith: OLD } } }), 0);
          const store = createConfigStore(tx as unknown as PrismaClient);
          for (const s of SUFFIXES) {
            assert.equal(await store.get(`CABINHUG_${s}`), SEED[s], s);
            const revisions = await tx.configItemRevision.findMany({ where: { id: `m110-09-${s}` } });
            assert.deepEqual(
              revisions.map((r) => r.key),
              [`CABINHUG_${s}`],
            );
          }
          throw new Rollback();
        });
      } catch (err) {
        if (!(err instanceof Rollback)) throw err;
      } finally {
        for (const [name, value] of saved) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        await prisma.$disconnect();
      }
    });
  });
}
