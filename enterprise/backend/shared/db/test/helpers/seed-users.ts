/**
 * 测试账号播种。
 *
 * # 连真库的测试都需要它
 *
 * `vehicles.owner_id` / `trips.user_id` 等归属列是指向 users 的外键，
 * "拥有一辆车的人必须是一个账号"是数据库级事实，与产品一致。
 *
 * # upsert 而不是 create
 *
 * 各测试文件并行跑（`node --test` 默认按文件并发），两个文件用同一个测试账号 id
 * 会撞主键，表现为无关测试偶发失败。
 *
 * # 不在 after 里删账号
 *
 * 删账号可能因 `vehicles.owner_id` 的 `onDelete: Restrict` 失败（清理顺序错时），
 * 或级联删掉别的并行测试正在用的行。测试账号留在测试库里没有代价：
 * 它们的 id 有 `test-` 前缀，与真实数据分开。
 */

import type { PrismaClient } from "@prisma/client";

/** 播种若干测试账号。id 即传入值，`username` 由 id 派生保证唯一。 */
export async function seedTestUsers(
  prisma: PrismaClient,
  ids: readonly string[],
): Promise<void> {
  for (const id of [...new Set(ids)]) {
    await prisma.user.upsert({
      where: { id },
      update: {},
      create: {
        id,
        username: `u_${id}`,
        // 锁定账号：bcrypt 永不与 '!' 匹配。测试不走登录路径。
        passwordHash: "!",
        displayName: id,
      },
    });
  }
}
