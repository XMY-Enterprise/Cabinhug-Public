/**
 * 按包选测试库（TD-60）。`with-test-db.ts` 经 `NODE_OPTIONS=--import` 把它挂进每个 Node 进程。
 *
 * `pnpm -r test` 给所有包的测试进程同一份环境变量，按包分库只能在进程里做：从当前目录往上找最近的
 * package.json，按包名查 `CABINHUG_TEST_DB_BY_PACKAGE`，命中就把 `DATABASE_URL` 与 `TEST_DATABASE_URL`
 * 换成该包的克隆库。没命中（仓库根上的 pnpm 本身、不在表里的工具）就什么都不改，退回原来那份测试库。
 *
 * 只用 node 内置模块、不打印任何东西：它会被每一个 Node 进程加载，包括 pnpm、tsx 与 prisma CLI。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const raw = process.env.CABINHUG_TEST_DB_BY_PACKAGE;
if (raw) {
  let byPackage;
  try {
    byPackage = JSON.parse(raw);
  } catch {
    byPackage = undefined;
  }
  let dir = process.cwd();
  for (;;) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      let name;
      try {
        name = JSON.parse(readFileSync(pkgPath, "utf8")).name;
      } catch {
        name = undefined;
      }
      const url = byPackage && name ? byPackage[name] : undefined;
      if (url) {
        process.env.DATABASE_URL = url;
        process.env.TEST_DATABASE_URL = url;
      }
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
