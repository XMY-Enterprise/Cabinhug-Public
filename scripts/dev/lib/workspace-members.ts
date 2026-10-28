/**
 * workspace 成员枚举，唯一真相源是 `pnpm-workspace.yaml`。
 *
 * 手写的目录清单过期时不报错，只会静默漏掉成员（例如零测试成员检查少算一个）。
 * coverage-js / test-inventory / demo-verify 等都从 workspace 定义展开，
 * 目录调整时无需同步修改。
 *
 * 只认两种写法：`dir/*`（枚举一层子目录）与字面目录名。pnpm 支持更复杂的
 * glob，但本仓没用到；遇到认不出的写法直接抛，不静默跳过。
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface WorkspaceMember {
  /** package.json 里的 name */
  name: string;
  /** 相对仓库根的目录 */
  dir: string;
  /** 它所在的 workspace 条目（`enterprise/backend/*` 这样的原文，去掉 `/*`），报告分组用 */
  group: string;
  scripts: Record<string, string>;
}

export function workspacePatterns(root: string): string[] {
  const text = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const m = /^\s*-\s*["']?([^"'#\s]+)["']?\s*$/.exec(raw);
    if (m) out.push(m[1]);
  }
  return out;
}

export function listWorkspaceMembers(root: string): WorkspaceMember[] {
  const members: WorkspaceMember[] = [];
  const push = (dir: string, group: string) => {
    const pkgPath = join(root, dir, "package.json");
    if (!existsSync(pkgPath)) return;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string; scripts?: Record<string, string> };
    if (!pkg.name) return;
    members.push({ name: pkg.name, dir, group, scripts: pkg.scripts ?? {} });
  };
  for (const pat of workspacePatterns(root)) {
    if (pat.endsWith("/*")) {
      const base = pat.slice(0, -2);
      const abs = join(root, base);
      if (!existsSync(abs)) continue;
      for (const entry of readdirSync(abs).sort()) {
        if (statSync(join(abs, entry)).isDirectory()) push(`${base}/${entry}`, base);
      }
    } else if (!pat.includes("*")) {
      push(pat, pat);
    } else {
      throw new Error(`pnpm-workspace.yaml 里的写法本仓不认：${pat}（只支持 dir/* 与字面目录）`);
    }
  }
  return members;
}
