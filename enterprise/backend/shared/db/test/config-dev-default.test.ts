/**
 * 开发默认值与生产守卫（F-07-01 / AC-07-1）。
 *
 * 这组用例守的是一条不对称规则：同一个缺失，在开发是"给默认值继续跑"，
 * 在生产是"立刻退出"。开发侧出错表现为起不来，当场可见；
 * 生产侧出错则是用仓库里的密钥做鉴权，不会被察觉。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collectStartupReport,
  collectStartupIssues,
  isProductionEnv,
} from "../src/config/startup";
import { CONFIG_REGISTRY, DEV_JWT_SECRET } from "../src/config/registry";

/**
 * 造一份"除了被测项之外全都齐活"的 env。
 *
 * 不用 `process.env`：`collectStartupReport` 按设计会写回传入的对象，
 * 用真 env 会污染同进程里的其它用例。
 */
function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const def of CONFIG_REGISTRY) {
    if (def.storage !== "env-only" || !def.required) continue;
    // 32 字符，过得了所有"至少 16 字符"的 validate
    env[def.envFallback] = "test-value-0123456789abcdef-0123";
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

describe("[F-07-01][AC-07-1] CABINHUG_JWT_SECRET 的开发默认值", () => {
  it("注册表里挂着 devDefault，且只有它挂（主密钥不许有）", () => {
    const jwt = CONFIG_REGISTRY.find((d) => d.key === "CABINHUG_JWT_SECRET");
    assert.ok(jwt);
    assert.equal(jwt.devDefault, DEV_JWT_SECRET);

    /*
     * 可以有 devDefault 的项是一份白名单，新增项需要按下面的判据评估，
     * 不能只改断言。
     *
     * 判据：默认值泄漏后的最坏后果。
     *   - JWT 签名密钥 / 后台角色 token：能冒充身份，但生产缺失即退出
     *     （`isProductionEnv` 那条），所以泄漏面只到开发机。
     *   - 落盘加密主密钥：仓库里的密钥能解开任何一台机器上已经落盘的库，
     *     后果不随环境收敛，因此不得有默认值。
     *
     * 后台角色 token 的默认值放在注册表里，由生产退出规则约束，
     * 不在 `auth/console.ts` 里另设对生产也生效的兜底。
     */
    const withDevDefault = CONFIG_REGISTRY.filter((d) => d.devDefault !== undefined)
      .map((d) => d.key)
      .sort();
    assert.deepEqual(
      withDevDefault,
      ["CABINHUG_ADMIN_TOKEN", "CABINHUG_JWT_SECRET", "CABINHUG_OPS_TOKEN"],
      "落盘加密主密钥不得有开发默认值——仓库里的钥匙能解开任何一台机器上的库",
    );

    // 三项都必须是 required：否则生产的"缺失即退出"不会触发，
    // devDefault 会成为在生产静默生效的公开默认值。
    for (const key of withDevDefault) {
      const def = CONFIG_REGISTRY.find((d) => d.key === key);
      assert.equal(def?.required, true, `${key} 有 devDefault 就必须 required`);
    }
  });

  it("默认值本身过得了它自己的 validate（≥16 字符）", () => {
    const jwt = CONFIG_REGISTRY.find((d) => d.key === "CABINHUG_JWT_SECRET");
    assert.equal(jwt?.validate?.(DEV_JWT_SECRET), null);
  });

  it("默认值命中密钥扫描的放行词，否则 check:secrets 会把它报出来", () => {
    assert.match(DEV_JWT_SECRET, /changeme/);
    assert.match(DEV_JWT_SECRET, /insecure/, "名字要在代码审查里刺眼");
  });

  it("非生产 + 缺失 → 不是 issue，是 warning，且值被写回 env", () => {
    const env = baseEnv({ CABINHUG_JWT_SECRET: undefined, NODE_ENV: "development" });
    const { issues, warnings } = collectStartupReport(env);

    assert.equal(
      issues.find((i) => i.key === "CABINHUG_JWT_SECRET"),
      undefined,
      "开发环境不该被这一项挡住",
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.key, "CABINHUG_JWT_SECRET");
    assert.equal(
      env.CABINHUG_JWT_SECRET,
      DEV_JWT_SECRET,
      "写回是故意的：后续读 env 的代码由此拿到同一个值，不用各自再兜一次底",
    );
  });

  it("生产 + 缺失 → issue，进程该退出", () => {
    const env = baseEnv({ CABINHUG_JWT_SECRET: undefined, NODE_ENV: "production" });
    const { issues, warnings } = collectStartupReport(env);

    const hit = issues.find((i) => i.key === "CABINHUG_JWT_SECRET");
    assert.ok(hit, "生产环境必须被挡住");
    assert.match(hit.reason, /必填项缺失/);
    assert.equal(warnings.length, 0, "生产不该有'我给你垫了个默认值'这种事");
    assert.equal(env.CABINHUG_JWT_SECRET, undefined, "生产环境下一个字节都不许写回");
  });

  it("生产 + 显式配好 → 既无 issue 也无 warning", () => {
    const env = baseEnv({ NODE_ENV: "production" });
    const { issues, warnings } = collectStartupReport(env);
    assert.equal(issues.find((i) => i.key === "CABINHUG_JWT_SECRET"), undefined);
    assert.equal(warnings.length, 0);
  });

  it("非生产 + 显式配好 → 不打告警", () => {
    const env = baseEnv({ NODE_ENV: "development" });
    assert.equal(collectStartupReport(env).warnings.length, 0);
  });

  it("非生产 + 配了个过短的值 → 仍然是 issue，不被默认值顶替", () => {
    const env = baseEnv({ CABINHUG_JWT_SECRET: "abc", NODE_ENV: "development" });
    const { issues } = collectStartupReport(env);

    const hit = issues.find((i) => i.key === "CABINHUG_JWT_SECRET");
    assert.ok(hit, "配错了比没配更需要被指出来");
    assert.match(hit.reason, /至少 16 字符/);
    assert.equal(env.CABINHUG_JWT_SECRET, "abc", "不许把用户写的值改掉");
  });

  it("空字符串按'没配'算（.env.example 里就是空的）", () => {
    const env = baseEnv({ CABINHUG_JWT_SECRET: "", NODE_ENV: "development" });
    assert.equal(collectStartupReport(env).warnings.length, 1);
    assert.equal(env.CABINHUG_JWT_SECRET, DEV_JWT_SECRET);
  });

  it("旧签名 collectStartupIssues 仍只返回 issues", () => {
    const env = baseEnv({ CABINHUG_JWT_SECRET: undefined, NODE_ENV: "development" });
    assert.equal(collectStartupIssues(env).find((i) => i.key === "CABINHUG_JWT_SECRET"), undefined);
  });
});

describe("[F-07-01][AC-07-1] 生产判定", () => {
  it("只认 NODE_ENV=production，不认别的写法", () => {
    assert.equal(isProductionEnv({ NODE_ENV: "production" }), true);
    assert.equal(isProductionEnv({ NODE_ENV: "prod" }), false);
    assert.equal(isProductionEnv({ NODE_ENV: "Production" }), false);
    assert.equal(isProductionEnv({}), false);
    // 只有一个环境判定变量，避免两个变量不一致时的歧义
    assert.equal(isProductionEnv({ CABINHUG_ENV: "production" } as NodeJS.ProcessEnv), false);
  });
});
