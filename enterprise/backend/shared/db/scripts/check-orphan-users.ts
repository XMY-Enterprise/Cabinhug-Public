/**
 * 迁移前的孤儿数据检查（设计
 * 用户体系 §2.5 第 2 步）。
 *
 * # 必须在加外键之前运行，并由人确认结果
 *
 * 迁移把五处裸字符串列（`sessions.user_id` / `trips.user_id` / `vehicles.owner_id` /
 * `owner_profiles.user_id` / `vehicle_members.owner_id`）变成 `users.id` 外键，
 * 且只插入一行 `users('demo-user', …)`。任何指向其他字符串的存量行都会让
 * ADD CONSTRAINT 失败，而 Postgres 的报错只给约束名，不指出具体表与行。
 *
 * # 不自动归并
 *
 * 把孤儿行一律 UPDATE 成 demo-user 等于替人决定数据归属；若孤儿不是测试残留，
 * 静默归并会把某个用户的行程挂到另一个账号下。
 * 因此这里只报告与返回退出码，处置由人决定（删除 / 建对应账号 / 显式归并）。
 *
 * 用法：
 *   node --import tsx enterprise/backend/shared/db/scripts/check-orphan-users.ts
 *   TEST_DATABASE_URL=... node --import tsx enterprise/backend/shared/db/scripts/check-orphan-users.ts --test-db
 *
 * 退出码：0 = 干净（全部归 demo-user）；1 = 有孤儿或有 NULL，不得继续迁移。
 */

import { PrismaClient } from "@prisma/client";

import { resolveTestDatabaseUrl } from "../src/test-db";

/** 迁移会插入的第一个账号 id。与迁移脚本里的字面量必须一致。 */
const SEED_USER_ID = "demo-user";

/** 要检查的五处归属列：表名 → 列名。顺序与迁移里 ADD CONSTRAINT 的顺序一致。 */
const OWNERSHIP_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: "sessions", column: "user_id" },
  { table: "trips", column: "user_id" },
  { table: "vehicles", column: "owner_id" },
  { table: "owner_profiles", column: "user_id" },
  { table: "vehicle_members", column: "owner_id" },
];

interface Finding {
  table: string;
  column: string;
  /** 不等于 seed 账号的取值及其行数。 */
  offenders: Array<{ value: string | null; rows: number }>;
  /** 该表总行数，用于判断"是不是整张表都错了"。 */
  total: number;
}

/**
 * 表不存在时返回 null 而不是抛。
 *
 * 全新库（尚未跑过任何迁移）上"表不存在"即"没有存量数据"，不算故障。
 */
async function inspect(
  prisma: PrismaClient,
  table: string,
  column: string,
): Promise<Finding | null> {
  const exists = await prisma.$queryRawUnsafe<Array<{ ok: boolean }>>(
    `SELECT to_regclass('public.${table}') IS NOT NULL AS ok`,
  );
  if (!exists[0]?.ok) return null;

  const rows = await prisma.$queryRawUnsafe<Array<{ value: string | null; rows: bigint }>>(
    `SELECT ${column} AS value, COUNT(*)::bigint AS rows
       FROM ${table}
      WHERE ${column} IS DISTINCT FROM $1
      GROUP BY ${column}
      ORDER BY rows DESC`,
    SEED_USER_ID,
  );
  const total = await prisma.$queryRawUnsafe<Array<{ rows: bigint }>>(
    `SELECT COUNT(*)::bigint AS rows FROM ${table}`,
  );

  return {
    table,
    column,
    offenders: rows.map((r) => ({ value: r.value, rows: Number(r.rows) })),
    total: Number(total[0]?.rows ?? 0),
  };
}

async function main(): Promise<void> {
  const useTestDb = process.argv.includes("--test-db");
  const url = useTestDb ? resolveTestDatabaseUrl() : process.env.DATABASE_URL;
  if (!url) {
    console.error("缺少 DATABASE_URL（或用 --test-db 走 TEST_DATABASE_URL）");
    process.exit(2);
  }

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const findings: Finding[] = [];
    let missingTables = 0;
    for (const { table, column } of OWNERSHIP_COLUMNS) {
      const f = await inspect(prisma, table, column);
      if (!f) {
        missingTables += 1;
        console.log(`· ${table}.${column}  表不存在（全新库，无存量数据）`);
        continue;
      }
      console.log(
        `· ${table}.${column}  共 ${f.total} 行，非 ${SEED_USER_ID} 的 ${f.offenders.length} 种取值`,
      );
      if (f.offenders.length > 0) findings.push(f);
    }

    if (findings.length === 0) {
      console.log(
        `\n✓ 孤儿检查通过：${OWNERSHIP_COLUMNS.length - missingTables} 张表的归属列全部指向 ${SEED_USER_ID}，可以迁移`,
      );
      return;
    }

    console.error("\n✗ 发现孤儿数据，**不要继续迁移**。逐条处置后重跑：\n");
    for (const f of findings) {
      console.error(`  ${f.table}.${f.column}（共 ${f.total} 行）`);
      for (const o of f.offenders) {
        const shown = o.value === null ? "NULL" : `"${o.value}"`;
        console.error(`    ${shown} → ${o.rows} 行`);
      }
    }
    console.error(
      "\n处置选项（由人决定，脚本不代做）：" +
        "\n  a) 测试残留 → DELETE 掉那些行；" +
        "\n  b) 真实数据 → 先在 users 表建对应账号，再迁移；" +
        "\n  c) 确认应归 demo-user → 显式 UPDATE 后重跑本脚本。",
    );
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

await main();
