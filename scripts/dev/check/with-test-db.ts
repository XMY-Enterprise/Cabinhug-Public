/**
 * 把后面那条命令跑在测试库上。
 *
 *   tsx scripts/dev/check/with-test-db.ts corepack pnpm -r --if-present test
 *
 * # 为什么要这么一层
 *
 * `enterprise/backend/shared/db` 的测试文件读的是 `process.env.DATABASE_URL`，而本机 shell 里
 * `.env` 通常已 source，`pnpm test` 会连到开发库。
 * 这里把子进程的 `DATABASE_URL` 换成测试库，测试代码不用改，新增的测试也落在正确的库上。
 *
 * 解析与 `_test` 校验都在 `@cabinhug/db` 的 `resolveTestDatabaseUrl()` 里，只有一份。
 *
 * # 为什么是 .ts 而不是 .mjs
 *
 * `@cabinhug/db` 在仓库根解析不到（根 package.json 没有它这个依赖，根 node_modules
 * 里没有链接），直接用 node 跑 .mjs 会报 ERR_MODULE_NOT_FOUND。经 tsx 跑可以解析，
 * 与 `check-env-example.ts` 相同。
 *
 * # 每个包一份库（TD-60）
 *
 * 并行跑的各包原来共用这一个测试库，彼此的写入会打乱对方的计数断言，红点每次落在不同的包。
 * 现在先给每个有 `test` 脚本的 workspace 成员克隆一份（`prepareTestDatabaseClones`），
 * 再经 `NODE_OPTIONS=--import test-db-preload.mjs` 让各包的测试进程按包名换到自己那份。
 * `CABINHUG_TEST_DB_SHARED=1` 退回共用一个库（排查克隆本身的问题时用）。
 */

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { prepareTestDatabaseClones, resolveTestDatabaseUrl } from "@cabinhug/db";

import { listWorkspaceMembers } from "../lib/workspace-members";

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error("用法：tsx scripts/dev/check/with-test-db.ts <命令> [参数…]");
  process.exit(2);
}

let testUrl: string;
try {
  testUrl = resolveTestDatabaseUrl();
} catch (err) {
  // 安全闸拒绝时原样打印原因，其中已包含修改方法。
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
}

/** 给每个有 `test` 脚本的成员克隆一份测试库，返回子进程要用的环境变量。 */
async function perPackageEnv(testUrl: string): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: testUrl, TEST_DATABASE_URL: testUrl };
  if (process.env.CABINHUG_TEST_DB_SHARED === "1") return env;
  const here = dirname(fileURLToPath(import.meta.url));
  const packages = listWorkspaceMembers(resolve(here, "../../.."))
    .filter((m) => m.scripts.test)
    .map((m) => m.name);
  const byPackage = await prepareTestDatabaseClones(testUrl, packages);
  env.CABINHUG_TEST_DB_BY_PACKAGE = JSON.stringify(byPackage);
  // file URL 不含空格：NODE_OPTIONS 按空白切分，仓库路径带空格时裸路径会被切断。
  const preload = `--import=${pathToFileURL(join(here, "test-db-preload.mjs")).href}`;
  env.NODE_OPTIONS = [process.env.NODE_OPTIONS, preload].filter(Boolean).join(" ");
  console.log(`[with-test-db] ${packages.length} 个包各用一份测试库（克隆自 ${new URL(testUrl).pathname.slice(1)}）`);
  return env;
}

function run(env: NodeJS.ProcessEnv): void {
  const child = spawn(argv[0], argv.slice(1), { stdio: "inherit", env });

  // 透传退出码与信号，否则 CI 会把被信号杀死的进程当成通过。
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal as NodeJS.Signals);
    else process.exit(code ?? 0);
  });
  child.on("error", (err) => {
    console.error(`起不来：${argv[0]}——${err.message}`);
    process.exit(1);
  });
}

perPackageEnv(testUrl).then(run, (err: unknown) => {
  // 克隆失败不退回共用：退回去测试照常跑，但 TD-60 的抖动又回来了，且没人知道。
  console.error(`[with-test-db] 按包克隆测试库失败：${err instanceof Error ? err.message : String(err)}`);
  console.error("先确认测试库可连（corepack pnpm db:test:setup）；确需共用一个库时设 CABINHUG_TEST_DB_SHARED=1");
  process.exit(1);
});
