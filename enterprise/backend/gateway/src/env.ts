/**
 * 仓库根 `.env` 自动加载（开发便利）。
 *
 * 真实密钥只放 `.env`（gitignore 覆盖），样例见 `.env.example`。
 * 已存在的环境变量优先——CI/容器注入不会被文件覆盖。
 * 生产部署由编排层注入环境，不依赖本文件。
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export function loadRootEnv(): void {
  // 单机版宿主（ACR-062）在仓库检出里调试时也走到这里：它已经给全了环境，再读开发者的 .env 会混进
  // mock 地址、RAGFlow、对象存储这类单机版没有的东西。宿主设这个变量跳过；安装包里本来就没有 .env。
  if (process.env.CABINHUG_SKIP_ROOT_ENV === "1") return;
  const here = dirname(fileURLToPath(import.meta.url));
  // enterprise/backend/<name>/src → 仓库根
  const rootEnv = resolve(here, "../../../../.env");
  if (!existsSync(rootEnv)) return;

  const before = new Set(Object.keys(process.env));
  try {
    process.loadEnvFile(rootEnv);
  } catch {
    return; // 解析失败不阻塞启动
  }
  // loadEnvFile 会覆盖已有变量，这里恢复"已存在者优先"
  for (const key of before) {
    const original = originalValues.get(key);
    if (original !== undefined) process.env[key] = original;
  }
}

// 在模块加载最早时刻快照，供上面的"已存在者优先"还原
const originalValues = new Map<string, string>(
  Object.entries(process.env).filter(([, v]) => v !== undefined) as Array<[string, string]>,
);
