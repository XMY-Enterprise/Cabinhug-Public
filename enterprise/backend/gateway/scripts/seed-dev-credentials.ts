/**
 * 开发账号口令播种。
 *
 * # 用途
 *
 * 迁移把 `demo-user` 种成锁定账号（口令散列 `!`，scrypt 永不匹配）：
 * 迁移里不写死任何口令的散列，否则等于把人人可读的凭证提交进仓库，
 * 并出现在每一个部署环境里。
 *
 * 因此本机迁移完没有任何账号能登录，这个脚本补上口令。
 *
 * # 它放在 gateway 而不是 enterprise/backend/shared/db
 *
 * 口令散列是鉴权层的事（`src/auth/password.ts`）。把脚本放进 `enterprise/backend/shared/db`
 * 会让数据层反向依赖服务层：data 层被 worker、agent-runtime 都引着，
 * 那条依赖会把 gateway 拖进它们的构建里。
 *
 * # 它不是生产工具
 *
 * 只在本机 / CI 用；生产账号走 `POST /console/users`（admin token）。
 * 不随机生成口令再打印：那会把口令写进终端历史与 CI 日志。
 *
 * 用法：
 *   corepack pnpm --filter @cabinhug/gateway seed:dev-credentials            # 只在账号仍是锁定态时播种
 *   corepack pnpm --filter @cabinhug/gateway seed:dev-credentials -- --force  # 已有口令也覆盖
 *   CABINHUG_DEV_PASSWORD=... 覆盖缺省口令（缺省 `carlife-dev`，仅本机）
 *
 * # 幂等：缺省只碰锁定账号
 *
 * dev:bootstrap 每次都会跑它。若每次都覆盖，开发者自己改过的口令会在下一次启动
 * 被静默改回缺省，所以缺省只在口令散列仍是迁移种下的 `!` 时写入；强制重置用 `--force`。
 */

import { getPrisma } from "@cabinhug/db";

import { hashPassword } from "../src/auth/password";

const DEV_USER_ID = "demo-user";
const DEFAULT_PASSWORD = "carlife-dev";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("缺少 DATABASE_URL");
    process.exit(2);
  }
  const password = process.env.CABINHUG_DEV_PASSWORD?.trim() || DEFAULT_PASSWORD;
  const force = process.argv.includes("--force");
  const prisma = getPrisma();
  try {
    const user = await prisma.user.findUnique({ where: { id: DEV_USER_ID } });
    if (!user) {
      console.error(
        `账号 ${DEV_USER_ID} 不存在——先跑迁移（db:migrate:safe / migrate deploy），它会种下这一行`,
      );
      process.exitCode = 1;
      return;
    }
    if (user.passwordHash !== "!" && !force) {
      console.log(`✓ ${DEV_USER_ID}（用户名 ${user.username}）已有口令，不覆盖；要重置加 --force`);
      return;
    }
    await prisma.user.update({
      where: { id: DEV_USER_ID },
      data: { passwordHash: await hashPassword(password) },
    });
    console.log(
      `✓ 已为 ${DEV_USER_ID}（用户名 ${user.username}）设置口令` +
        (process.env.CABINHUG_DEV_PASSWORD ? "（来自 CABINHUG_DEV_PASSWORD）" : "（缺省开发口令）"),
    );
  } finally {
    await prisma.$disconnect();
  }
}

await main();
