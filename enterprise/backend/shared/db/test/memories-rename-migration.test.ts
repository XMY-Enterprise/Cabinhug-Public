/**
 * 记忆表与来源控制方值的改名迁移（ACR-051）。连真实 PG，只在 `_test` 库跑。
 *
 * 三种库状态各一条：只有旧表 → 改名（连索引）；两张都在 → 不动；都不在 → 无操作。
 * 每条都在事务里做完再回滚：记忆表是 Mem0 自管的全局表，测试库里可能有别的用例留下的数据。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { PrismaClient, type Prisma } from "@prisma/client";

import { createChatRepository } from "../src/repositories/chat";

const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATION = new URL(
  "../prisma/migrations/20260926040000_rename_memories_table_and_source_control/migration.sql",
  import.meta.url,
);
// 拼接写法：本仓的旧名扫描不该命中测试自己。
const OLD_TABLE = "car" + "life_memories";
const NEW_TABLE = "cabinhug_memories";
const USER = "test-m110-10-user";

class Rollback extends Error {}

/** 按分号切语句，但 `$$ … $$` 里的分号不算（DO 块）；注释行先去掉。 */
function statementsOf(sql: string): string[] {
  const body = sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  const out: string[] = [];
  let current = "";
  let inDollar = false;
  for (let i = 0; i < body.length; i += 1) {
    if (body.startsWith("$$", i)) {
      inDollar = !inDollar;
      current += "$$";
      i += 1;
      continue;
    }
    if (body[i] === ";" && !inDollar) {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += body[i];
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

async function migrate(tx: Prisma.TransactionClient): Promise<void> {
  for (const statement of statementsOf(readFileSync(MIGRATION, "utf8"))) {
    await tx.$executeRawUnsafe(statement);
  }
}

async function tableExists(tx: Prisma.TransactionClient, name: string): Promise<boolean> {
  const rows = await tx.$queryRawUnsafe<Array<{ found: string | null }>>(
    `select to_regclass('public.${name}')::text as found`,
  );
  return rows[0]?.found != null;
}

async function createMemoryTable(tx: Prisma.TransactionClient, name: string): Promise<void> {
  // 与 Mem0 建的表同形的最小子集：主键 + payload；索引名沿用 Mem0 的"表名_hnsw_idx"。
  await tx.$executeRawUnsafe(`create table "${name}" (id uuid primary key, payload jsonb)`);
  await tx.$executeRawUnsafe(`create index "${name}_hnsw_idx" on "${name}" ((payload->>'user_id'))`);
}

/** 每条用例一个事务：先把两张表都清掉，做完回滚，库恢复原状。 */
async function inRolledBackTx(
  prisma: PrismaClient,
  body: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`drop table if exists "${OLD_TABLE}"`);
      await tx.$executeRawUnsafe(`drop table if exists "${NEW_TABLE}"`);
      await body(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

function isTestDb(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith("_test");
  } catch {
    return false;
  }
}

if (!DATABASE_URL || !isTestDb(DATABASE_URL)) {
  describe("[M110-10] 记忆表改名迁移", () => {
    it("跳过：DATABASE_URL 未设置或不是 _test 库（这组会动 Mem0 的全局表，只许在测试库跑）", () =>
      assert.ok(true));
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

  describe("[M110-10] 记忆表改名迁移", () => {
    it("只有旧表：连索引一起改名，行数不变，记忆面板按新表计数", async () => {
      const saved = process.env.MEM0_COLLECTION;
      delete process.env.MEM0_COLLECTION;
      try {
        await inRolledBackTx(prisma, async (tx) => {
          await createMemoryTable(tx, OLD_TABLE);
          for (const category of ["episodic", "episodic", "preference"]) {
            await tx.$executeRawUnsafe(
              `insert into "${OLD_TABLE}" (id, payload) values (gen_random_uuid(), $1::jsonb)`,
              JSON.stringify({ user_id: USER, category }),
            );
          }

          await migrate(tx);

          assert.equal(await tableExists(tx, OLD_TABLE), false);
          assert.equal(await tableExists(tx, NEW_TABLE), true);
          assert.equal(await tableExists(tx, `${NEW_TABLE}_hnsw_idx`), true, "索引跟着改名");
          assert.equal(await tableExists(tx, `${OLD_TABLE}_hnsw_idx`), false);

          const counts = await createChatRepository(tx as unknown as PrismaClient).memoryCounts(USER);
          assert.equal(counts.episodic, 2);
          assert.equal(counts.preference, 1);
        });
      } finally {
        if (saved === undefined) delete process.env.MEM0_COLLECTION;
        else process.env.MEM0_COLLECTION = saved;
      }
    });

    it("两张都在：不动任何一张", async () => {
      await inRolledBackTx(prisma, async (tx) => {
        await createMemoryTable(tx, OLD_TABLE);
        await createMemoryTable(tx, NEW_TABLE);
        await migrate(tx);
        assert.equal(await tableExists(tx, OLD_TABLE), true);
        assert.equal(await tableExists(tx, NEW_TABLE), true);
      });
    });

    it("两张都不在：无操作、不报错", async () => {
      await inRolledBackTx(prisma, async (tx) => {
        await migrate(tx);
        assert.equal(await tableExists(tx, OLD_TABLE), false);
        assert.equal(await tableExists(tx, NEW_TABLE), false);
      });
    });

    it("热配置里的旧表名与来源控制方旧值一并改掉", async () => {
      await inRolledBackTx(prisma, async (tx) => {
        await tx.configItem.deleteMany({ where: { key: "MEM0_COLLECTION" } });
        await tx.configItem.create({
          data: { key: "MEM0_COLLECTION", value: OLD_TABLE, isSecret: false, updatedBy: "m110-10" },
        });
        const OLD_CONTROL = "car" + "life";
        await tx.researchSource.create({
          data: {
            id: "test-m110-10-source",
            control: OLD_CONTROL,
            basis: "测试",
            access: "yes",
            collect: "yes",
            store: "yes",
            analyze: "yes",
            share: "no",
            display: "no",
            provenance: "simulated",
          },
        });

        await migrate(tx);

        const item = await tx.configItem.findUnique({ where: { key: "MEM0_COLLECTION" } });
        assert.equal(item?.value, NEW_TABLE);
        const source = await tx.researchSource.findUnique({ where: { id: "test-m110-10-source" } });
        assert.equal(source?.control, "cabinhug");
      });
    });

    it("重复执行无害", async () => {
      await inRolledBackTx(prisma, async (tx) => {
        await createMemoryTable(tx, OLD_TABLE);
        await migrate(tx);
        await migrate(tx);
        assert.equal(await tableExists(tx, NEW_TABLE), true);
        assert.equal(await tableExists(tx, OLD_TABLE), false);
      });
    });
  });

  // 所有用例共用一个连接池，结束时关掉，node --test 才会退出。
  describe("[M110-10] 收尾", () => {
    it("断开连接", async () => {
      await prisma.$disconnect();
    });
  });
}
