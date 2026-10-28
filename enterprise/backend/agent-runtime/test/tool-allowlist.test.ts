/**
 * pi 侧工具允许清单。
 *
 * 守两件事：
 * 1. `toolListFor` 与 `listForAgent` 同源，不另写一份 ACL 清单。
 * 2. pi 启动器 `bin/pi-launch.mjs`（两个平台的入口都转给它，ACR-058）把三个 env 正确转成 CLI 参数，尤其是
 *    空清单不得变成 `--tools ""`（"允许零个工具"会让整个 Agent 无声失效）。
 *
 * 脚本用假 pi 替身验 argv，不真起 pi：这里测的是拼参数，不是 pi 对
 * `-nbt`/`--tools` 的行为。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { listForAgent } from "@cabinhug/tools";

import { toolListFor } from "../src/acp-client/connection";
import { loadAgentPrompt } from "../src/acp-client/agent-prompt";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_BIN = resolve(HERE, "../../pi-agents/bin");

describe("toolListFor：与 listForAgent 同源", () => {
  it("drive 的清单逐字等于 listForAgent，且含行车查询的五个工具", () => {
    assert.equal(toolListFor("drive"), listForAgent("drive").map((t) => t.name).join(","));
    for (const n of ["map_route", "weather", "refuel", "charging", "transit_route"]) {
      assert.ok(toolListFor("drive").split(",").includes(n), `drive 清单缺 ${n}`);
    }
  });

  it("会话后缀走规范名：trip-task ≡ trip", () => {
    assert.equal(toolListFor("trip-task"), toolListFor("trip"));
    assert.ok(toolListFor("trip").length > 0);
  });

  it("全部十一个 Agent 的清单非空且无空项", () => {
    for (const a of [
      "supervisor", "buying", "ownership", "trip", "cabin", "service",
      "test-drive", "drive", "hotel", "tour", "transit",
    ]) {
      const list = toolListFor(a);
      assert.ok(list.length > 0, `${a} 清单为空——包装脚本会因此退到扩展工具全量`);
      assert.ok(!list.split(",").some((n) => !n.trim()), `${a} 清单含空项：${list}`);
    }
  });
});


describe("pi 启动链：env → argv（ACR-058）", () => {
  /**
   * 在临时目录里搭一个 pi-agents：复制真实的入口与启动器，旁边放一个假的 pi 包，
   * 它的 CLI 把收到的 argv 与关键环境写盘。这样测的是启动器的契约（走本地包、
   * 拼参数、设环境），不是 pi 本身的行为。
   */
  function fixture(opts: { withPi?: boolean } = {}): { root: string; out: string } {
    const dir = mkdtempSync(join(tmpdir(), "pi-argv-"));
    const out = join(dir, "argv.json");
    const root = join(dir, "pi-agents");
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    for (const f of ["pi-approved.sh", "pi-approved.cmd", "pi-launch.mjs"]) copyFileSync(join(REAL_BIN, f), join(bin, f));
    chmodSync(join(bin, "pi-approved.sh"), 0o755);
    if (opts.withPi !== false) {
      const pkg = join(root, "node_modules/@earendil-works/pi-coding-agent");
      mkdirSync(join(pkg, "dist"), { recursive: true });
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ type: "module", bin: { pi: "dist/cli.js" } }));
      writeFileSync(
        join(pkg, "dist/cli.js"),
        `import { writeFileSync } from "node:fs";\n` +
          `writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), env: {` +
          ` PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK, PI_OFFLINE: process.env.PI_OFFLINE,` +
          ` PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR } }));\n`,
      );
    }
    // PATH 里放一个代表使用者全局安装的假 pi：启动器若错误地回落到 PATH，它以失败码退出。
    const globalPi = join(dir, "pi");
    writeFileSync(globalPi, "#!/bin/sh\nexit 99\n");
    chmodSync(globalPi, 0o755);
    return { root, out };
  }

  const baseEnv = (extra: Record<string, string>) => ({
    ...process.env,
    CABINHUG_PI_MODEL: "",
    CABINHUG_PI_TOOLS: "",
    CABINHUG_PI_APPEND_PROMPT: "",
    ...extra,
    CABINHUG_NODE_BIN: process.execPath,
  });

  /** 经 Unix 入口（pi-approved.sh）启动，返回假 CLI 记下的 argv 与环境。 */
  function viaSh(env: Record<string, string>): { argv: string[]; env: Record<string, string> } {
    const { root, out } = fixture();
    execFileSync("sh", [join(root, "bin/pi-approved.sh"), "--mode", "rpc"], {
      env: { ...baseEnv(env), PATH: `${dirname(root)}${delimiter}${process.env.PATH ?? ""}` },
    });
    return JSON.parse(readFileSync(out, "utf8"));
  }

  /** 直接 `node pi-launch.mjs`：两个平台的入口都落到这一步。 */
  function viaNode(env: Record<string, string>): { argv: string[]; env: Record<string, string> } {
    const { root, out } = fixture();
    execFileSync(process.execPath, [join(root, "bin/pi-launch.mjs"), "--mode", "rpc"], { env: baseEnv(env) });
    return JSON.parse(readFileSync(out, "utf8"));
  }

  it("--no-builtin-tools 无条件在场（两种入口一致）", () => {
    for (const run of [viaSh, viaNode]) {
      assert.ok(run({}).argv.includes("--no-builtin-tools"));
      assert.ok(run({ CABINHUG_PI_TOOLS: "weather" }).argv.includes("--no-builtin-tools"));
    }
  });

  it("关闭 pi 启动联网，agent 目录指向仓库内 .pi/agent，不依赖全局设置", () => {
    const { env } = viaNode({});
    assert.equal(env.PI_SKIP_VERSION_CHECK, "1");
    assert.equal(env.PI_OFFLINE, "1");
    assert.match(env.PI_CODING_AGENT_DIR, /pi-agents[\\/]\.pi[\\/]agent$/);
  });

  it("pi-acp 旁路的裸版本探针不应拿到版本（Unix 的 bin/pi）", () => {
    const shim = join(REAL_BIN, "pi");
    const result = execFileSync("sh", [shim, "--version"], { encoding: "utf8" });
    assert.equal(result, "");
  });

  it("清单非空 → --tools <清单>，值逐字到达", () => {
    const { argv } = viaSh({ CABINHUG_PI_TOOLS: "weather,map_route" });
    const i = argv.indexOf("--tools");
    assert.ok(i >= 0);
    assert.equal(argv[i + 1], "weather,map_route");
  });

  it("空清单不加 --tools（未设与空串两种形态）", () => {
    for (const env of [{}, { CABINHUG_PI_TOOLS: "" }]) {
      const { argv } = viaNode(env);
      assert.ok(!argv.includes("--tools"), `env=${JSON.stringify(env)} 时出现了 --tools`);
    }
  });

  it("CABINHUG_PI_APPEND_PROMPT → --append-system-prompt，真实 prompt 文件逐字到达（两种入口）", () => {
    // 用 trip.md 的真实内容当载荷：它含反引号、中文引号、表格竖线，最容易被 shell 二次展开或截断。
    const prompt = loadAgentPrompt("trip");
    for (const run of [viaSh, viaNode]) {
      const { argv } = run({ CABINHUG_PI_APPEND_PROMPT: prompt });
      const i = argv.indexOf("--append-system-prompt");
      assert.ok(i >= 0);
      assert.equal(argv[i + 1], prompt, "prompt 未逐字到达 argv");
    }
  });

  it("CABINHUG_PI_APPEND_PROMPT 为空 → 不加参数（回退形态 = pi 默认系统提示词）", () => {
    for (const env of [{}, { CABINHUG_PI_APPEND_PROMPT: "" }]) {
      assert.ok(!viaNode(env).argv.includes("--append-system-prompt"));
    }
  });

  it("参数顺序与原 sh 包装一致，pi-acp 的透传参数殿后", () => {
    const { argv } = viaSh({ CABINHUG_PI_TOOLS: "weather", CABINHUG_PI_MODEL: "deepseek/x:off", CABINHUG_PI_APPEND_PROMPT: "P" });
    assert.deepEqual(argv, [
      "--approve", "--model", "deepseek/x:off", "--tools", "weather",
      "--append-system-prompt", "P", "--no-builtin-tools", "--mode", "rpc",
    ]);
  });

  it("本地 pi 不在时明确报错退出，不回落到 PATH 上的全局 pi", () => {
    const { root } = fixture({ withPi: false });
    let failed: { status?: number; stderr?: string } | undefined;
    try {
      execFileSync(process.execPath, [join(root, "bin/pi-launch.mjs"), "--mode", "rpc"], {
        env: baseEnv({}),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const e = err as { status?: number; stderr?: Buffer };
      failed = { status: e.status, stderr: String(e.stderr ?? "") };
    }
    assert.equal(failed?.status, 1, "缺 pi 应以 1 退出，而不是 99（PATH 上的全局 pi）");
    assert.match(failed?.stderr ?? "", /仓库内 pi 不存在/);
  });

  it("Windows 入口：.cmd 转给同一个启动器，用传入的 CABINHUG_NODE_BIN，不含 sh", () => {
    const cmd = readFileSync(join(REAL_BIN, "pi-approved.cmd"), "utf8");
    assert.match(cmd, /%CABINHUG_NODE_BIN%/);
    assert.match(cmd, /%~dp0pi-launch\.mjs/);
    assert.doesNotMatch(cmd, /\bsh\b|\/bin\//);
  });

  it("Unix 入口只转给启动器：拼参数与设环境的逻辑不在 sh 里", () => {
    const sh = readFileSync(join(REAL_BIN, "pi-approved.sh"), "utf8").replace(/^#.*$/gm, "");
    assert.match(sh, /pi-launch\.mjs/);
    assert.doesNotMatch(sh, /--no-builtin-tools|PI_OFFLINE|--approve/);
  });
});
