/**
 * 控制台不许引 `@cabinhug/research` 的桶文件。
 *
 * # 只在 build 阶段出现的故障
 *
 * 桶文件 `src/index.ts` 把 `fingerprint.ts` 一起导出，而那个文件
 * `import { createHash } from "node:crypto"`。浏览器侧打包时：
 *  - vite 先给一句 warning（"Module node:crypto has been externalized"），
 *  - 然后 Rollup 才报错 `"createHash" is not exported by "__vite-browser-external"`。
 *
 * `typecheck` 与单测都不会报错，只有 `pnpm build` 失败，所以这里用源码扫描提前拦截。
 *
 * 正确写法是引子路径（包的 `exports` 里声明过的那几个）：
 *   import { capabilitiesFor } from "@cabinhug/research/capabilities";
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(new URL("..", import.meta.url).pathname.replace(/\/$/, ""), "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

/** 引了桶的写法：`from "@cabinhug/research"` 且后面没有子路径。 */
const BARREL = /from\s+["']@cabinhug\/research["']/;

describe("[M85-03] 控制台只引 @cabinhug/research 的子路径", () => {
  it("src/ 下没有一处引桶文件", () => {
    const hits: string[] = [];
    for (const file of sourceFiles(SRC)) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // 注释里解释为什么不许，不算违规
          if (BARREL.test(line)) hits.push(`${file.slice(SRC.length + 1)}:${i + 1}: ${line.trim()}`);
        });
    }
    assert.deepEqual(
      hits,
      [],
      `引了桶文件，浏览器侧打包会在 node:crypto 上失败：\n${hits.join("\n")}\n` +
        "改成 @cabinhug/research/capabilities 或 /red-team 或 /types",
    );
  });

  it("扫描本身可信：注入一行引桶的代码会被判出来", () => {
    assert.ok(BARREL.test(`import { capabilitiesFor } from "@cabinhug/research";`));
    assert.ok(BARREL.test(`import type { X } from '@cabinhug/research'`));
    // 子路径放过。
    assert.ok(!BARREL.test(`import { capabilitiesFor } from "@cabinhug/research/capabilities";`));
    assert.ok(!BARREL.test(`import type { RedTeamFinding } from "@cabinhug/research/red-team";`));
  });
});
