/**
 * 旧环境变量名桥接的 shell 实现（ACR-051）。
 *
 * 服务端（TS）与 shell 各有一份改名名单，这里守两件事：
 * 两份名单逐项相同；shell 的 `bridge_legacy_env` 与 TS 的 `bridgeLegacyEnv` 行为一致。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { RENAMED_ENV_SUFFIXES } from "../../../enterprise/backend/shared/db/src/config/legacy-env";

const HELPER = new URL("../../../infra/scripts/_legacy-env.sh", import.meta.url).pathname;
// 拼接写法：本仓的旧名扫描不该命中测试自己。
const OLD = "CAR" + "LIFE_";

function shellSuffixes(): string[] {
  const text = readFileSync(HELPER, "utf8");
  const match = /LEGACY_ENV_SUFFIXES="([^"]*)"/.exec(text);
  if (!match) throw new Error("_legacy-env.sh 里找不到 LEGACY_ENV_SUFFIXES");
  return match[1].split(/\s+/).filter(Boolean);
}

/** 在干净的 bash 里跑一次桥接再执行 probe，返回 stdout 与 stderr（桥接的提示走 stderr）。 */
function runBridge(env: Record<string, string>, probe: string): { out: string; err: string } {
  const result = spawnSync("/bin/bash", ["-c", `. "${HELPER}"; bridge_legacy_env; ${probe}`], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return { out: result.stdout, err: result.stderr };
}

describe("[M110-09] 旧环境变量名：shell 与服务端同一份名单、同一种行为", () => {
  it("两份名单逐项相同", () => {
    assert.deepEqual(shellSuffixes(), [...RENAMED_ENV_SUFFIXES]);
  });

  it("只设旧名：新名得到同值并导出给子进程，stderr 点名旧名、不含值", () => {
    const { out, err } = runBridge({ [`${OLD}JWT_SECRET`]: "s3cret" }, "bash -c 'echo $CABINHUG_JWT_SECRET'");
    assert.equal(out.trim(), "s3cret");
    assert.match(err, new RegExp(`${OLD}JWT_SECRET`));
    assert.ok(!err.includes("s3cret"));
  });

  it("新旧都设且值不同：新名不被覆盖，提示旧名被忽略", () => {
    const { out, err } = runBridge(
      { [`${OLD}LLM`]: "fake", CABINHUG_LLM: "deepseek" },
      "echo $CABINHUG_LLM",
    );
    assert.equal(out.trim(), "deepseek");
    assert.match(err, /被忽略/);
  });

  it("都不设：无输出", () => {
    const { out, err } = runBridge({}, "echo \"[${CABINHUG_TOOLS:-}]\"");
    assert.equal(out.trim(), "[]");
    assert.equal(err, "");
  });

  it("重复调用不误报冲突（dev-bootstrap 与它拉起的 dev.sh 各调一次）", () => {
    const { err } = runBridge({ [`${OLD}TOOLS`]: "mock" }, "bridge_legacy_env");
    assert.ok(!/被忽略/.test(err));
  });
});
