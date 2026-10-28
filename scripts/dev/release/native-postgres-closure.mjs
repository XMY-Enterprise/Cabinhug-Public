/**
 * 原生 PostgreSQL 闭包的文件清单（ACR-060）。构建脚本与验证探针共用，不起任何数据库进程。
 *
 * 闭包 = 随单机版安装包分发的 `bin/ lib/ share/ licenses/`。清单逐文件记 sha256，
 * 符号链接只许指向闭包内部：指到外面的链接在用户机器上要么断、要么悄悄用上系统里的另一份库。
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export const MANIFEST_SCHEMA = "cabinhug-native-postgres/v1";

/** 走一遍闭包，返回 `{ files: {相对路径: sha256}, symlinks: {相对路径: 目标} }`。 */
export function inspectClosure(root) {
  const base = realpathSync(root);
  const files = {};
  const symlinks = {};
  const inside = (p) => {
    const rel = relative(base, p);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      const name = relative(base, path).split("\\").join("/");
      if (e.isSymbolicLink()) {
        const target = readlinkSync(path);
        if (isAbsolute(target) || !inside(realpathSync(path))) throw new Error(`符号链接指出闭包：${name}`);
        symlinks[name] = target;
      } else if (e.isDirectory()) walk(path);
      else if (e.isFile()) files[name] = createHash("sha256").update(readFileSync(path)).digest("hex");
      else throw new Error(`闭包里有不支持的文件类型：${name}`);
    }
  };
  walk(base);
  return { files, symlinks };
}

/** 按 `manifest.json` 逐项核对闭包，多一个、少一个、改一个都抛错。 */
export function verifyManifest(root) {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  if (manifest.schema !== MANIFEST_SCHEMA) throw new Error(`不认识的清单格式：${manifest.schema}`);
  const actual = inspectClosure(root);
  delete actual.files["manifest.json"];
  for (const key of ["files", "symlinks"]) {
    const expected = manifest[key] ?? {};
    if (Object.keys(expected).length !== Object.keys(actual[key]).length) throw new Error(`${key} 数量与清单不一致`);
    for (const [path, value] of Object.entries(expected)) {
      if (actual[key][path] !== value) throw new Error(`与清单不一致：${path}`);
    }
  }
  return { manifest, verifiedFiles: Object.keys(actual.files).length, verifiedSymlinks: Object.keys(actual.symlinks).length };
}
