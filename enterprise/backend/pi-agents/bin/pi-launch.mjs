/**
 * pi 启动器（ACR-058）：两个平台共用的启动逻辑。
 *
 * 入口：Unix 上 pi-acp 执行 `bin/pi-approved.sh`，Windows 上执行 `bin/pi-approved.cmd`
 * （pi-acp 0.0.33 对 `.cmd` 结尾的命令走 shell）。两个入口都只有一行，转给本文件。
 * 原来写在 sh 里的逻辑全部在这里，Windows 没有 sh。
 *
 * 【在本进程内加载 pi，不 spawn】pi 的 `dist/cli.js` 只是设置环境后调用
 * `main(process.argv.slice(2))`。这里设好环境与 `process.argv` 再 import 它，
 * 每个 pi 仍只有一个 Node 进程。若改为 spawn，按 Agent 与思考档位分出的每个 pi
 * 都会多一个 Node 进程，与单机版的内存预算冲突。
 *
 * 【--approve】pi 在非交互模式（`--mode rpc`，pi-acp 使用的模式）不弹项目信任提示，
 * 而 `defaultProjectTrust` 默认为 `ask`，结果是静默忽略项目级资源（含 `.pi/extensions/`）：
 * 工具一个都没注册，模型转而编造答案，且没有报错。
 * 不改 ~/.pi/agent/settings.json：那是用户全局设置，会信任本机所有项目，且不随仓库走。
 * `--approve` 只对本次运行生效，作用域限于本仓库的 pi-agents 目录。
 *
 * 【安全边界】被信任的只有本仓库的 `enterprise/backend/pi-agents/.pi/`，其内容在版本控制下可审查。
 * 它不放宽任何车辆控制能力，端侧 capability 白名单是独立的一道（§8.5）。
 * pi 只从本目录相邻的 node_modules 解析，不经 PATH：否则业务进程会接到使用者的全局 pi，
 * 版本、插件和凭据都随个人环境变化（ACR-005）。
 *
 * 【CABINHUG_PI_MODEL】按进程指定模型与思考档位（形如 `deepseek/deepseek-flash:off`）。
 * 思考档位是启动参数，不能按单次调用改，所以由 agent-runtime 的连接池按
 * (Agent, 档位) 分进程后从这里传入（见 shared/acp/src/pool.ts 的 processKey）。
 * 值由 Node 侧读 `.pi/settings.json` 拼出，模型 id 不在这里硬编。
 * 未设置时不加 --model，pi 用 settings.json 的默认值。
 *
 * 【CABINHUG_PI_TOOLS · --no-builtin-tools】
 * pi 默认给模型 read/bash/edit/write 四个内置工具；Cabinhug 的 Agent 只应看到 registry
 * 注册的那张表（§4.3 能力映射），内置工具既不在表里、也不过 §8.4 的权限门。
 * 所以 --no-builtin-tools 无条件加（扩展工具不受它影响）。
 * --tools 是 pi 侧的第二道 ACL：清单由 agent-runtime 从 listForAgent() 拼出，pi 对未知名静默忽略。
 * 为空时不加 --tools：`--tools ""` 的语义是"允许零个工具"，整个 Agent 会无工具且不报错；
 * 退到"扩展工具全量"更安全。
 *
 * 【CABINHUG_PI_APPEND_PROMPT】业务 prompt 走真正的系统提示词，由 agent-runtime 的
 * loadAgentPrompt() 按进程的 Agent 读入。它作为 argv 的一个元素交给 pi，不经任何 shell，
 * 反引号、`$`、中文引号、竖线逐字到达。为空时不加参数。
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const BIN_DIR = dirname(SELF);

/** pi 的包目录：本目录相邻的 node_modules，不经 PATH。 */
export function piPackageDir(binDir = BIN_DIR) {
  return resolve(binDir, "../node_modules/@earendil-works/pi-coding-agent");
}

/**
 * pi 的 CLI 入口。读包的 `bin` 字段，不经 `node_modules/.bin` 的包装：
 * 那是 sh 脚本（Windows 上是 `.cmd`），正是本启动器要绕开的东西。
 * 包没装或入口文件不在时返回 undefined。
 */
export function resolvePiCli(packageDir = piPackageDir()) {
  const pkgPath = join(packageDir, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
  if (typeof rel !== "string" || !rel) return undefined;
  const cli = resolve(packageDir, rel);
  return existsSync(cli) ? cli : undefined;
}

/**
 * 项目运行时的 pi 环境，只作用于这条启动链，不修改开发者全局 pi 或全局 settings.json。
 *
 * - `PI_SKIP_VERSION_CHECK` / `PI_OFFLINE`：版本固定在仓库内，不需要每次启动访问 pi.dev，
 *   也关掉包更新、安装遥测等其它启动联网动作；模型请求不受影响。
 * - `PI_CODING_AGENT_DIR`：models.json / sessions / auth.json 落在仓库内的 `.pi/agent/`，
 *   而不是使用者的 `~/.pi/agent/`。models.json 的模型覆盖随仓库走：pi 0.84.1 自带目录里没有
 *   `deepseek-flash`，且把 flash 的 low 档标成不支持（请求 low 会被静默抬成 high）。
 *   pi 的会话 jsonl 落在 `.pi/agent/sessions/`（已 gitignore）。
 */
export function piEnv(binDir = BIN_DIR) {
  return {
    PI_SKIP_VERSION_CHECK: "1",
    PI_OFFLINE: "1",
    PI_CODING_AGENT_DIR: resolve(binDir, "../.pi/agent"),
  };
}

/**
 * 交给 pi 的参数，与原 `pi-approved.sh` 同一顺序：
 * `--approve [--model M] [--tools T] [--append-system-prompt P] --no-builtin-tools <pi-acp 给的参数>`。
 */
export function buildPiArgs(env, passthrough) {
  const args = ["--no-builtin-tools", ...passthrough];
  if (env.CABINHUG_PI_APPEND_PROMPT) args.unshift("--append-system-prompt", env.CABINHUG_PI_APPEND_PROMPT);
  if (env.CABINHUG_PI_TOOLS) args.unshift("--tools", env.CABINHUG_PI_TOOLS);
  if (env.CABINHUG_PI_MODEL) args.unshift("--model", env.CABINHUG_PI_MODEL);
  return ["--approve", ...args];
}

/**
 * 是否被直接执行（而不是被用例 import）。比较真实路径：`import.meta.url` 已解析掉符号链接，
 * `process.argv[1]` 没有。macOS 的临时目录、单机版的安装目录都可能经过符号链接，
 * 按字面比较会静默跳过启动，pi 一个都起不来。
 */
function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(SELF);
  } catch {
    return false;
  }
}

// 被直接执行时才启动 pi；用例 import 本文件只取上面几个函数。
if (isDirectRun()) {
  const cli = resolvePiCli();
  if (!cli) {
    console.error(`❌ 仓库内 pi 不存在：${piPackageDir()} —— 先运行 corepack pnpm install`);
    process.exit(1);
  }
  Object.assign(process.env, piEnv());
  process.argv = [process.argv[0], cli, ...buildPiArgs(process.env, process.argv.slice(2))];
  await import(pathToFileURL(cli).href);
}
