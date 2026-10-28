/**
 * 底座在接入第二个应用时的三处耦合（ACR-038）。
 *
 * 用研面加载车主面的扩展、扩展回调到车主面的工具端点、用量行记成车主面的
 * 模型名，这三种错误都不抛错，所以断言钉在"解析出来的目录与变量是哪个"上。
 *
 * 全部直测纯函数：`resolvePiCommands` 不碰文件系统（存在性检查在
 * `connect()` 里），`spawnEnvFor` 不 spawn，不需要启动 pi。平台差异经参数注入，
 * Windows 分支在任何平台上都能测（ACR-058）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, beforeEach } from "node:test";

import type { AcpApp, AcpTracer } from "../src/app";
import {
  piAcpEntryOf,
  piDefaultModel,
  resetPiModelCacheForTests,
  resolvePiCommands,
  spawnEnvFor,
  withPathPrefix,
} from "../src/connection";

const noopTracer: AcpTracer = {
  span: (_t, _n, fn) => fn(),
  recordSpan: () => {},
  recordPrompt: () => {},
  cancelled: (m) => new Error(m),
};

/** 最小可用的描述符；每条用例只改自己关心的那一两项。 */
function fakeApp(over: Partial<AcpApp> = {}): AcpApp {
  return {
    id: "research",
    piDir: "/repo/enterprise/backend/pi-research",
    promptsDir: "/repo/enterprise/backend/pi-research/prompts",
    agents: ["challenger"],
    toolsEndpoint: "http://localhost:8800",
    promptFor: async () => "（业务提示词）",
    thinkingFor: () => "off",
    toolNamesFor: () => ["findCounterEvidence"],
    tracer: noopTracer,
    ...over,
  };
}

/** 写一份只有 defaultModel 的 `.pi/settings.json`，返回它的 piDir。 */
function tempPiDir(defaultModel: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cabinhug-acp-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ defaultModel }));
  return dir;
}

describe("resolvePiCommands：项目目录与二进制目录是两件事", () => {
  it("不传 binDir 时二进制在 piDir 下（车主面走这一支）", () => {
    const app = fakeApp({ piDir: "/repo/enterprise/backend/pi-agents", binDir: undefined });
    const c = resolvePiCommands(app);

    assert.equal(c.binDir, app.piDir, "缺省必须回落到 piDir，否则车主面当场起不来");
    assert.equal(c.piDir, app.piDir);
    assert.equal(c.piAcpPackageDir, resolve(app.piDir, "node_modules/pi-acp"));
    assert.equal(c.piCommand, resolve(app.piDir, process.platform === "win32" ? "bin/pi-approved.cmd" : "bin/pi-approved.sh"));
  });

  it("传了 binDir：二进制用那一份，cwd 仍是自己的 piDir", () => {
    const app = fakeApp({
      piDir: "/repo/enterprise/backend/pi-research",
      binDir: "/repo/enterprise/backend/pi-agents",
    });
    const c = resolvePiCommands(app);

    // 借的是安装：pi-acp 与 pi 的入口都在 pi-agents 下。
    const unix = resolvePiCommands(app, undefined, "darwin");
    assert.equal(unix.piAcpPackageDir, "/repo/enterprise/backend/pi-agents/node_modules/pi-acp");
    assert.equal(unix.piCommand, "/repo/enterprise/backend/pi-agents/bin/pi-approved.sh");
    assert.equal(c.localBin, "/repo/enterprise/backend/pi-agents/node_modules/.bin");
    assert.equal(c.adapterBin, "/repo/enterprise/backend/pi-agents/bin");

    // 不借的是项目：cwd 若跟着 binDir 走，用研面会静默加载车主面的
    // `.pi/extensions` 与 prompts。
    assert.equal(c.piDir, "/repo/enterprise/backend/pi-research");
  });

  it("piAgentsDir（旧的覆盖入口）语义不变：两者都用它", () => {
    const app = fakeApp({ piDir: "/repo/pi-research", binDir: "/repo/pi-agents" });
    const c = resolvePiCommands(app, { piAgentsDir: "/tmp/fixture" });

    assert.equal(c.piDir, "/tmp/fixture");
    assert.equal(c.binDir, "/tmp/fixture");
  });
});

describe("spawnEnvFor：扩展回调地址", () => {
  it("注入 CABINHUG_TOOLS_ENDPOINT，且保留 AGENT_RUNTIME_URL", () => {
    const app = fakeApp({ toolsEndpoint: "http://localhost:8800" });
    const env = spawnEnvFor(app, { agent: "challenger" });

    assert.equal(env.CABINHUG_TOOLS_ENDPOINT, app.toolsEndpoint);
    // 车主面扩展 cabinhug-tools.ts 读这个键，缺了它工具表回调无处可去。
    assert.ok("AGENT_RUNTIME_URL" in env, "AGENT_RUNTIME_URL 必须仍在");
    assert.ok((env.AGENT_RUNTIME_URL ?? "").length > 0);
    assert.equal(env.CABINHUG_PI_AGENT, "challenger");
  });

  it("空串照传：扩展在启动时明确报错，而不是回落到另一个进程", () => {
    const env = spawnEnvFor(fakeApp({ toolsEndpoint: "" }));

    assert.equal(env.CABINHUG_TOOLS_ENDPOINT, "");
    assert.ok("CABINHUG_TOOLS_ENDPOINT" in env, "键必须在，不能因为空串就整项消失");
  });

  it("PATH 前置的是 binDir 下的两个目录，PI_ACP_PI_COMMAND 指借来的包装脚本", () => {
    const env = spawnEnvFor(
      fakeApp({ piDir: "/repo/pi-research", binDir: "/repo/pi-agents" }),
    );

    assert.ok(env.PATH?.startsWith("/repo/pi-agents/bin:/repo/pi-agents/node_modules/.bin:"));
    assert.equal(env.PI_ACP_PI_COMMAND, "/repo/pi-agents/bin/pi-approved.sh");
  });

  it("入口用本进程的 node（CABINHUG_NODE_BIN），不依赖 PATH 上的 node", () => {
    assert.equal(spawnEnvFor(fakeApp()).CABINHUG_NODE_BIN, process.execPath);
  });
});

describe("跨平台（ACR-058）：Windows 不经 sh、不直启 .cmd", () => {
  const app = fakeApp({ piDir: "/repo/pi-research", binDir: "/repo/pi-agents" });

  it("Windows 的 pi 入口是 .cmd（pi-acp 对 .cmd 走 shell），Unix 是 .sh", () => {
    assert.equal(resolvePiCommands(app, undefined, "win32").piCommand, resolve("/repo/pi-agents", "bin/pi-approved.cmd"));
    assert.equal(resolvePiCommands(app, undefined, "linux").piCommand, resolve("/repo/pi-agents", "bin/pi-approved.sh"));
    assert.equal(spawnEnvFor(app, undefined, "", "win32").PI_ACP_PI_COMMAND, resolve("/repo/pi-agents", "bin/pi-approved.cmd"));
  });

  it("PATH 按平台分隔符拼接：Windows 用分号", () => {
    const env = spawnEnvFor(app, undefined, "", "win32");
    assert.ok(env.PATH?.startsWith(`${resolve("/repo/pi-agents", "bin")};${resolve("/repo/pi-agents", "node_modules/.bin")};`));
  });

  it("Windows 上原有的 Path 键被替换，不会出现 Path 与 PATH 两个键", () => {
    const env = withPathPrefix({ Path: "C:\\Windows", OTHER: "x" }, ["C:\\a", "C:\\b"], "C:\\Windows", "win32");
    assert.deepEqual(Object.keys(env).filter((k) => k.toUpperCase() === "PATH"), ["PATH"]);
    assert.equal(env.PATH, "C:\\a;C:\\b;C:\\Windows");
    assert.equal(env.OTHER, "x");
  });

  it("pi-acp 的 JS 入口从包的 bin 字段读出，文件确实存在", () => {
    const realBin = resolve(new URL(".", import.meta.url).pathname, "../../../pi-agents");
    const entry = piAcpEntryOf(resolvePiCommands(fakeApp({ piDir: realBin }), undefined).piAcpPackageDir);
    assert.ok(entry && /pi-acp[\\/]dist[\\/]index\.js$/.test(entry), String(entry));
  });

  it("pi-acp 没装 → undefined，由 connect() 报出查找目录", () => {
    assert.equal(piAcpEntryOf("/nonexistent/node_modules/pi-acp"), undefined);
  });
});

describe("piDefaultModel：缓存按 piDir 分键", () => {
  beforeEach(() => resetPiModelCacheForTests());

  it("两个目录各读各的模型名，缓存不串", () => {
    const first = tempPiDir("deepseek-flash");
    const second = tempPiDir("qwen-max");

    assert.equal(piDefaultModel(first), "deepseek-flash");
    assert.equal(piDefaultModel(second), "qwen-max", "串台时这里会是 deepseek-flash");
    // 反向再读一次：缓存命中路径也必须分键。
    assert.equal(piDefaultModel(first), "deepseek-flash");
  });

  it("读不到仍返回 undefined，且只失败一次（调用方回落到会话名）", () => {
    const missing = join(tmpdir(), "cabinhug-acp-not-here-" + Date.now());

    assert.equal(piDefaultModel(missing), undefined);
    assert.equal(piDefaultModel(missing), undefined);
    // 读不到的目录不该污染别人。
    assert.equal(piDefaultModel(tempPiDir("deepseek-flash")), "deepseek-flash");
  });
});
