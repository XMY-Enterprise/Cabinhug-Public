import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bridgeLegacyEnv,
  describeLegacyEnvNotice,
  LEGACY_ENV_NAMES,
  RENAMED_ENV_SUFFIXES,
} from "../src/config/legacy-env";
import { CONFIG_REGISTRY } from "../src/config/registry";

// 拼接写法：本仓的旧名扫描不该命中测试自己。
const OLD = "CAR" + "LIFE_";

describe("[M110-09] 旧环境变量名桥接", () => {
  it("只设旧名：新名得到同值，返回一条 copied", () => {
    const env: Record<string, string | undefined> = { [`${OLD}JWT_SECRET`]: "s3cret" };
    const notices = bridgeLegacyEnv(env);
    assert.equal(env.CABINHUG_JWT_SECRET, "s3cret");
    assert.deepEqual(notices, [
      { legacy: `${OLD}JWT_SECRET`, current: "CABINHUG_JWT_SECRET", action: "copied" },
    ]);
  });

  it("新旧都设且值不同：新名不被覆盖，返回一条 ignored", () => {
    const env: Record<string, string | undefined> = {
      [`${OLD}LLM`]: "fake",
      CABINHUG_LLM: "deepseek",
    };
    const notices = bridgeLegacyEnv(env);
    assert.equal(env.CABINHUG_LLM, "deepseek");
    assert.deepEqual(notices, [{ legacy: `${OLD}LLM`, current: "CABINHUG_LLM", action: "ignored" }]);
  });

  it("新旧都设且值相同（上游 shell 已桥接）：仍记为 copied，不误报冲突", () => {
    const env: Record<string, string | undefined> = {
      [`${OLD}TOOLS`]: "all",
      CABINHUG_TOOLS: "all",
    };
    assert.deepEqual(bridgeLegacyEnv(env), [
      { legacy: `${OLD}TOOLS`, current: "CABINHUG_TOOLS", action: "copied" },
    ]);
  });

  it("都不设：无记录、不写任何键", () => {
    const env: Record<string, string | undefined> = { CABINHUG_TOOLS: "all" };
    assert.deepEqual(bridgeLegacyEnv(env), []);
    assert.deepEqual(Object.keys(env), ["CABINHUG_TOOLS"]);
  });

  it("空串算显式设置，照样搬", () => {
    const env: Record<string, string | undefined> = { [`${OLD}WEATHER_CMA`]: "" };
    bridgeLegacyEnv(env);
    assert.equal(env.CABINHUG_WEATHER_CMA, "");
  });

  it("名单外的旧名不搬（不做前缀通配）", () => {
    const env: Record<string, string | undefined> = { [`${OLD}JWT_SECRT`]: "typo" };
    assert.deepEqual(bridgeLegacyEnv(env), []);
    assert.equal(env.CABINHUG_JWT_SECRT, undefined);
  });

  it("映射表无重复、新旧一一对应、退休变量不在表里", () => {
    assert.equal(new Set(RENAMED_ENV_SUFFIXES).size, RENAMED_ENV_SUFFIXES.length);
    for (const { legacy, current } of LEGACY_ENV_NAMES) {
      assert.equal(legacy.slice(OLD.length), current.slice("CABINHUG_".length));
    }
    assert.ok(!RENAMED_ENV_SUFFIXES.includes("ASR"));
    assert.ok(!RENAMED_ENV_SUFFIXES.includes("TTS"));
  });

  /*
   * 改名之后新增的键没有旧名可桥接（`legacy-env.ts`：「新增变量不用往这里加」），逐个点名放过。
   * 用点名而不是按日期或前缀放过：漏桥接的改名键仍会在这里红。
   */
  const ADDED_AFTER_RENAME = new Set(["CABINHUG_CAPABILITIES_OFF"]);

  it("注册表里新前缀的键都在映射表里（改名之后新增的除外）", () => {
    const suffixes = new Set(RENAMED_ENV_SUFFIXES);
    for (const def of CONFIG_REGISTRY) {
      if (!def.key.startsWith("CABINHUG_") || ADDED_AFTER_RENAME.has(def.key)) continue;
      assert.ok(suffixes.has(def.key.slice("CABINHUG_".length)), def.key);
    }
  });

  it("点名放过的键确实不在映射表里：已在表里的不该挂在这份名单上", () => {
    for (const key of ADDED_AFTER_RENAME) {
      assert.ok(CONFIG_REGISTRY.some((d) => d.key === key), `${key} 不在注册表里`);
      assert.ok(!RENAMED_ENV_SUFFIXES.includes(key.slice("CABINHUG_".length)), key);
    }
  });

  it("日志措辞不含变量值", () => {
    const env: Record<string, string | undefined> = { [`${OLD}ADMIN_TOKEN`]: "tok-xyz" };
    const [notice] = bridgeLegacyEnv(env);
    assert.ok(notice);
    const line = describeLegacyEnvNotice(notice);
    assert.ok(line.includes(`${OLD}ADMIN_TOKEN`));
    assert.ok(!line.includes("tok-xyz"));
  });
});
