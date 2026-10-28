/**
 * 启动期配置校验（AC-35-11）。
 *
 * 必填缺失或格式非法时进程立即退出并指明具体项，而不是在第一次真实调用时才失败。
 *
 * # 开发默认值（`devDefault`）与生产守卫
 *
 * `CABINHUG_JWT_SECRET` 等必填项在非生产环境可使用 `devDefault`：
 * 写回 env 并打一行告警，使刚 clone 的机器可以直接启动。
 *
 * 生产不使用 `devDefault`：写在公开仓库里的签名密钥等同于没有鉴权，
 * 任何拿到仓库的人都能签出通过校验的 token 冒充任意 userId，且不会有任何可见现象。
 * 因此生产维持"缺失即退出"。
 */

import { assertMasterKeyUsable, MasterKeyMissingError } from "./crypto";
import { CONFIG_REGISTRY } from "./registry";

export interface StartupIssue {
  key: string;
  reason: string;
}

/** 用了开发默认值的项。不影响退出码，但必须被看见。 */
export interface StartupWarning {
  key: string;
  reason: string;
}

export interface StartupReport {
  issues: StartupIssue[];
  warnings: StartupWarning[];
}

/**
 * 生产判定。取 `NODE_ENV`，它是仓库里唯一的生产信号
 * （`infra/images/Dockerfile` 的 `ENV NODE_ENV=production`）。
 * 不另设 `CABINHUG_ENV`，避免两个信号不一致。
 */
export function isProductionEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production";
}

/**
 * 校验并（在非生产下）把 `devDefault` 写回 env。
 *
 * 有意的副作用：写回后，所有读 `process.env` 的代码（`jwt.ts`、脚本与子进程）
 * 拿到同一个值，而不是各自再兜底。
 */
export function collectStartupReport(env: NodeJS.ProcessEnv = process.env): StartupReport {
  const issues: StartupIssue[] = [];
  const warnings: StartupWarning[] = [];
  const production = isProductionEnv(env);

  for (const def of CONFIG_REGISTRY) {
    // 只校验 env-only 的必填项：db 存储的项在库里，启动时不一定连得上库。
    if (def.storage !== "env-only") continue;
    const value = env[def.envFallback];
    if (def.required && (value === undefined || value === "")) {
      if (!production && def.devDefault !== undefined) {
        env[def.envFallback] = def.devDefault;
        warnings.push({
          key: def.key,
          reason:
            "未配置，正在使用**开发默认值**。生产环境（NODE_ENV=production）不提供默认值，" +
            "缺失即启动失败；部署前请生成一个：openssl rand -hex 32",
        });
        continue;
      }
      issues.push({ key: def.key, reason: `必填项缺失（${def.description}）` });
      continue;
    }
    if (value !== undefined && value !== "") {
      // 配了但不合法仍是 issue，不用 devDefault 顶替：
      // 静默顶替会让人误以为自己配置的那行已生效。
      const invalid = def.validate?.(value);
      if (invalid) issues.push({ key: def.key, reason: invalid });
    }
  }

  if (!issues.some((i) => i.key === "CABINHUG_CONFIG_MASTER_KEY")) {
    try {
      assertMasterKeyUsable(env.CABINHUG_CONFIG_MASTER_KEY);
    } catch (err) {
      issues.push({
        key: "CABINHUG_CONFIG_MASTER_KEY",
        reason: err instanceof MasterKeyMissingError ? err.message : String(err),
      });
    }
  }

  return { issues, warnings };
}

/** 旧签名保留：调用方（含测试）只关心"有没有拦下来的问题"。 */
export function collectStartupIssues(env: NodeJS.ProcessEnv = process.env): StartupIssue[] {
  return collectStartupReport(env).issues;
}

/** 有问题就打印清单并 `process.exit(1)`；服务入口在加载 env 之后立刻调用。 */
export function assertStartupConfig(env: NodeJS.ProcessEnv = process.env): void {
  const { issues, warnings } = collectStartupReport(env);
  for (const w of warnings) {
    console.warn(`⚠ [config] ${w.key}: ${w.reason}`);
  }
  if (issues.length === 0) return;
  console.error("[config] 启动配置校验失败：");
  for (const i of issues) console.error(`  - ${i.key}: ${i.reason}`);
  console.error("  参见仓库根 .env.example（施工单 M3-02）");
  process.exit(1);
}
