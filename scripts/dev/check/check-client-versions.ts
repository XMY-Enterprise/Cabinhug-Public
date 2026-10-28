/**
 * 客户端版本号一致性检查。
 *
 * # 为什么需要它
 *
 * 每个客户端的版本号分布在三个文件里：`package.json`（前端包）、
 * `src-tauri/tauri.conf.json`（打进安装包与 About 面板的那一个）、
 * `src-tauri/Cargo.toml`（crate 版本）。三者必须相等，构建本身不校验。
 *
 * 改漏一处时构建与打包都不报错，但 About 面板与崩溃报告会写着不同的版本号，
 * 排查线上问题时无法确定版本。
 *
 * # 它不管客户端与根仓库的关系
 *
 * 客户端有独立的版本线，与根 `package.json` 无关。
 * 根仓库的版本记录服务端与整仓的节奏，客户端有自己的发布周期
 * （车机与手机走 TestFlight / 分发通道，不随服务端每次上线而发版）。
 * 因此这里不比较客户端与根的版本。
 *
 * 运行：`corepack pnpm check:versions`（已进 `check:all`）
 */

import { readFileSync } from "node:fs";
import { relative } from "node:path";

const ROOT = new URL("../../../", import.meta.url);

/** 受管的客户端。新增一个端需在这里显式加一行。 */
export const CLIENTS = ["cockpit", "mobile"] as const;
export type ClientName = (typeof CLIENTS)[number];

export interface VersionSource {
  /** 相对仓库根的路径，报错时要指得出来。 */
  file: string;
  version: string | undefined;
}

/** 从 `Cargo.toml` 的 `[package]` 段取 version。只认第一处，与 cargo 的行为一致。 */
export function cargoVersion(text: string): string | undefined {
  // 取 `[package]` 之后、下一个 section 之前的 version。单条正则会误匹配
  // `[dependencies]` 里带 version 的行。
  const pkg = /^\[package\]\s*$/m.exec(text);
  if (!pkg) return undefined;
  const rest = text.slice(pkg.index + pkg[0].length);
  const nextSection = /^\[/m.exec(rest);
  const body = nextSection ? rest.slice(0, nextSection.index) : rest;
  return /^\s*version\s*=\s*"([^"]+)"/m.exec(body)?.[1];
}

/** 一个端的三处版本号。读不到的项 version 为 undefined，由调用方报缺。 */
export function readClientVersions(app: ClientName): VersionSource[] {
  const read = (rel: string): string => readFileSync(new URL(rel, ROOT), "utf8");
  const json = (rel: string): string | undefined => {
    try {
      return (JSON.parse(read(rel)) as { version?: string }).version;
    } catch {
      return undefined;
    }
  };
  const cargoRel = `clients/${app}/src-tauri/Cargo.toml`;
  let cargo: string | undefined;
  try {
    cargo = cargoVersion(read(cargoRel));
  } catch {
    cargo = undefined;
  }
  return [
    { file: `clients/${app}/package.json`, version: json(`clients/${app}/package.json`) },
    {
      file: `clients/${app}/src-tauri/tauri.conf.json`,
      version: json(`clients/${app}/src-tauri/tauri.conf.json`),
    },
    { file: cargoRel, version: cargo },
  ];
}

export interface ClientVersionIssue {
  app: ClientName;
  detail: string;
}

/** 纯判定（可单测）：三处必须都读得到、且完全相等，且是 semver 形状。 */
export function checkOne(app: ClientName, sources: VersionSource[]): ClientVersionIssue[] {
  const issues: ClientVersionIssue[] = [];
  const missing = sources.filter((s) => !s.version);
  for (const m of missing) {
    issues.push({ app, detail: `读不到版本号：${m.file}` });
  }
  const found = sources.filter((s) => s.version);
  const distinct = new Set(found.map((s) => s.version));
  if (distinct.size > 1) {
    issues.push({
      app,
      detail:
        `三处版本号不一致 —— ` +
        found.map((s) => `${s.file}=${s.version}`).join("，") +
        `。改漏一处不会报错，只会让 About 面板与崩溃报告写着两个数字`,
    });
  }
  for (const s of found) {
    if (!/^\d+\.\d+\.\d+$/.test(s.version!)) {
      issues.push({ app, detail: `${s.file} 的 ${s.version} 不是 X.Y.Z 形状（Tauri 打包要求）` });
    }
  }
  return issues;
}

function main(): void {
  const all: ClientVersionIssue[] = [];
  for (const app of CLIENTS) {
    const sources = readClientVersions(app);
    const issues = checkOne(app, sources);
    if (issues.length === 0) {
      console.log(`✓ ${app.padEnd(8)} ${sources[0].version}（三处一致）`);
    }
    all.push(...issues);
  }

  if (all.length > 0) {
    console.error("\n✗ 客户端版本号检查失败：");
    for (const i of all) console.error(`    ${i.app}: ${i.detail}`);
    console.error(`\n  改版本号请用：corepack pnpm release:client <端> <patch|minor|major|X.Y.Z>`);
    console.error(`  它会把三处一起改掉，正是为了不再出现这条报错。`);
    process.exit(1);
  }
  console.log(`\n客户端版本号：${CLIENTS.length} 个端各自一致`);
}

// 被单测 import 时不执行 main（`import.meta.main` 在本仓 Node 基线上可用）。
const invokedDirectly =
  process.argv[1] !== undefined &&
  relative(new URL(".", import.meta.url).pathname, process.argv[1]).replace(/^\.\//, "") ===
    "check-client-versions.ts";
if (invokedDirectly) main();
