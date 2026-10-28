/**
 * [F-07-03][AC-07-2] 样式里引用的每个 CSS 变量都必须真实存在。
 *
 * `var(--不存在的名字, fallback)` 不报错、不警告，只会永远取 fallback：切主题时
 * 这几块原地不动；fallback 多按深色写，浅色主题下会出现白描边配白卡、浅蓝横带。
 *
 * 读文件不渲染：`clients/mobile` 没有 jsdom，要守的是 token 名对不对得上。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOTS = [
  fileURLToPath(new URL("../src", import.meta.url)),
  fileURLToPath(new URL("../../shared/ui/src", import.meta.url)),
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const FILES = ROOTS.flatMap((r) => walk(r));
const STYLES = FILES.filter((f) => f.endsWith(".css"));

/**
 * 注释里的 token 既不算定义、也不算引用，扫描前一律剥掉。
 * 样式表注释里常写着 `var(--x)`，不剥的话守的是注释措辞而不是真实引用。
 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * 全部定义源：CSS 声明 + JS 侧的 `setProperty("--x", …)`。
 * 少算后者会把运行时注入的变量（如贴边夹持的 --clamp-x）全部误报成缺失。
 */
const DEFINED: ReadonlySet<string> = new Set(
  FILES.filter((f) => /\.(css|tsx?|)$/.test(f)).flatMap((f) => {
    const t = stripComments(readFileSync(f, "utf8"));
    return [
      ...Array.from(t.matchAll(/(--[\w-]+)\s*:/g), (m) => m[1]),
      ...Array.from(t.matchAll(/["'](--[\w-]+)["']/g), (m) => m[1]),
    ];
  }),
);

function referenced(css: string): string[] {
  return [...new Set(Array.from(stripComments(css).matchAll(/var\(\s*(--[\w-]+)/g), (m) => m[1]))];
}

describe("[F-07-03] CSS 变量都有定义", () => {
  for (const file of STYLES) {
    const short = file.slice(file.lastIndexOf("/src/") + 1);
    it(`${short} 引用的 token 都存在`, () => {
      const missing = referenced(readFileSync(file, "utf8")).filter((t) => !DEFINED.has(t));
      assert.deepEqual(missing, [], `全仓没有定义：${missing.join(", ")}`);
    });
  }

  /* 判据自身要有效：定义集若为空，上面每条都会假绿。 */
  it("定义集不为空（否则上面全是假绿）", () => {
    assert.ok(DEFINED.has("--hud-text"), "至少要认出主题里的 --hud-text");
    assert.ok(DEFINED.size > 50, `定义集只有 ${DEFINED.size} 个，扫描八成没跑对`);
  });
});

describe("[F-07-03] 登录门不留 fallback", () => {
  /*
   * 单独对登录门加严：它是第一屏。带 fallback 时拼错的变量名不会显现为缺失样式。
   */
  it("var() 一律不带 fallback", () => {
    const css = readFileSync(new URL("../src/features/auth/login.css", import.meta.url), "utf8");
    const withFallback = Array.from(css.matchAll(/var\(\s*--[\w-]+\s*,/g), (m) => m[0]);
    assert.deepEqual(withFallback, []);
  });
});
