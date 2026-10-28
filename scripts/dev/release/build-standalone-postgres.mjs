#!/usr/bin/env node
/**
 * 构建单机版随包分发的 PostgreSQL + pgvector 闭包（ACR-060，macOS arm64）。只在构建机上跑，车主不跑。
 *
 *   corepack pnpm release:standalone-postgres <新的输出目录>
 *
 * 需要 Xcode 命令行工具；不装 Homebrew 包、不装系统服务、不碰全局环境。输出目录必须不存在，已有的一律不覆盖。
 *
 * 做的事：按源码锁（standalone-postgres-sources.json）下载并核对 sha256 → 编 PG 与 pgvector →
 * 把 Mach-O 里指向构建前缀的装载路径改成 `@loader_path` 相对路径 → 拒绝闭包外的非系统动态依赖 →
 * ad-hoc 签名（install_name_tool 改过的文件签名失效，必须重签；这不是发行签名）→ 写 manifest.json。
 *
 * 编译选项：
 *  - `--without-icu/readline/zlib`：闭包只依赖系统库。代价是没有压缩 dump，单机版备份用 `--compress=0`。
 *  - pgvector 不加 `-march=native`（`OPTFLAGS=`）：产物要在所有 Apple Silicon 上跑，不只是这台构建机。
 *
 * 移植自 Codex 原型（ACR-053，未进 main）；PG 由 16.14 升到 16.15。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MANIFEST_SCHEMA, inspectClosure } from "./native-postgres-closure.mjs";

const sources = JSON.parse(readFileSync(fileURLToPath(new URL("./standalone-postgres-sources.json", import.meta.url)), "utf8"));
const out = process.argv[2] && resolve(process.argv[2]);
if (!out) throw new Error("用法：build-standalone-postgres.mjs <新的输出目录>");
if (existsSync(out)) throw new Error(`输出目录已存在，不覆盖：${out}`);
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("本脚本只构建 macOS arm64；Windows 的闭包另走 ACR-060 第 2 步");
}

const MIN_MACOS = "15.0";
const root = mkdtempSync(join(tmpdir(), "cabinhug-pg-build-"));
const prefix = join(root, "installed");
// 环境从零拼：不让构建机上的 Homebrew、pkg-config 之类混进来，否则闭包会悄悄依赖它们。
const env = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: root,
  TMPDIR: root,
  LANG: "C",
  CC: "/usr/bin/clang",
  MACOSX_DEPLOYMENT_TARGET: MIN_MACOS,
  CFLAGS: `-O2 -mmacosx-version-min=${MIN_MACOS}`,
  LDFLAGS: `-mmacosx-version-min=${MIN_MACOS}`,
};
const steps = [];

function run(command, args, cwd = root) {
  const start = Date.now();
  const r = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
  const log = `${String(steps.length).padStart(2, "0")}-${command.split("/").at(-1)}.log`;
  writeFileSync(join(root, log), (r.stdout ?? "") + (r.stderr ?? ""));
  steps.push({ command, args, ms: Date.now() - start, status: r.status, log });
  if (r.status !== 0) throw new Error(`${command} 失败（${r.status}），日志：${join(root, log)}\n${(r.stderr ?? "").slice(-2500)}`);
  return r.stdout;
}

console.log(`构建目录：${root}`);
try {
  for (const [name, entry] of Object.entries(sources)) {
    const file = join(root, name === "postgres" ? "postgres.tar.bz2" : "pgvector.tar.gz");
    run("/usr/bin/curl", ["--fail", "--location", "--retry", "2", "--proto", "=https", "--tlsv1.2", entry.url, "-o", file]);
    const actual = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (actual !== entry.sha256) throw new Error(`${name} 源码 sha256 不符：期望 ${entry.sha256}，实得 ${actual}`);
    run("/usr/bin/tar", ["-xf", file]);
  }
  const pg = join(root, `postgresql-${sources.postgres.version}`);
  const vector = join(root, `pgvector-${sources.pgvector.version}`);
  const configure = ["--without-icu", "--without-readline", "--without-zlib"];
  run(join(pg, "configure"), [`--prefix=${prefix}`, ...configure], pg);
  run("/usr/bin/make", ["-j8"], pg);
  run("/usr/bin/make", ["install"], pg);
  run("/usr/bin/make", ["-j8", `PG_CONFIG=${join(prefix, "bin/pg_config")}`, "OPTFLAGS="], vector);
  run("/usr/bin/make", ["install", `PG_CONFIG=${join(prefix, "bin/pg_config")}`, "OPTFLAGS="], vector);

  mkdirSync(out, { recursive: true });
  for (const folder of ["bin", "lib", "share"]) {
    cpSync(join(prefix, folder), join(out, folder), {
      recursive: true,
      verbatimSymlinks: true,
      // 静态库与扩展开发用的 pgxs 不进闭包：运行期用不到，只增加体积。
      filter: (p) => !p.includes("/pgxs") && !p.endsWith(".a"),
    });
  }
  mkdirSync(join(out, "licenses"));
  cpSync(join(pg, "COPYRIGHT"), join(out, "licenses/PostgreSQL.txt"));
  cpSync(join(vector, "LICENSE"), join(out, "licenses/pgvector.txt"));

  // 装载路径重定位：PG 与 libpq 的 install name 里写着构建前缀，换到别的机器就找不到库。
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files.push(p);
    }
  };
  walk(out);
  const macho = files.filter((p) => run("/usr/bin/file", ["-b", p]).includes("Mach-O"));
  for (const p of macho) {
    const self = join(prefix, relative(out, p));
    for (const line of run("/usr/bin/otool", ["-L", p]).split("\n").slice(1)) {
      const dep = line.trim().split(" (")[0];
      if (!dep) continue;
      if (dep.startsWith(prefix + "/")) {
        const target = join(out, relative(prefix, dep));
        if (!existsSync(target)) throw new Error(`闭包里缺这个库：${dep}`);
        const replacement = "@loader_path/" + relative(dirname(p), target);
        if (dep === self) run("/usr/bin/install_name_tool", ["-id", replacement, p]);
        else run("/usr/bin/install_name_tool", ["-change", dep, replacement, p]);
      } else if (dep.startsWith("@loader_path/")) {
        const target = realpathSync(resolve(dirname(p), dep.slice("@loader_path/".length)));
        if (!target.startsWith(realpathSync(out) + "/")) throw new Error(`动态依赖指出闭包：${p} → ${dep}`);
      } else if (!dep.startsWith("/usr/lib/") && !dep.startsWith("/System/Library/")) {
        throw new Error(`闭包外的动态依赖：${p} → ${dep}`);
      }
    }
    run("/usr/bin/codesign", ["--force", "--sign", "-", p]);
  }

  const binaries = macho.map((p) => ({
    path: relative(out, p),
    architecture: run("/usr/bin/lipo", ["-archs", p]).trim(),
    libraries: run("/usr/bin/otool", ["-L", p]).split("\n").slice(1).map((l) => l.trim()).filter(Boolean),
  }));
  const wrongArch = binaries.filter((b) => b.architecture !== "arm64");
  if (wrongArch.length) throw new Error(`非 arm64 的二进制：${wrongArch.map((b) => b.path).join("、")}`);

  const manifest = {
    schema: MANIFEST_SCHEMA,
    builtAt: new Date().toISOString(),
    platform: "darwin",
    arch: "arm64",
    minimumOS: MIN_MACOS,
    sources,
    configure,
    vectorOptflags: "",
    signing: "ad-hoc，不是发行签名",
    limitations: ["无 TLS：只监听本机回环", "无 ICU / readline / zlib：备份用不压缩的 dump"],
    binaries,
    ...inspectClosure(out),
  };
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`已构建 ${out}：${binaries.length} 个 arm64 Mach-O，PostgreSQL ${sources.postgres.version}，pgvector ${sources.pgvector.version}`);
} finally {
  writeFileSync(join(root, "build-steps.json"), JSON.stringify(steps, null, 2) + "\n");
}
