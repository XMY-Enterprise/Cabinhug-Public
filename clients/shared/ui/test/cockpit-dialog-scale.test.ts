/**
 * 车机对话页的尺寸必须跟着 `--hud-unit` 走，不能写绝对 px。
 *
 * # 混写的后果
 *
 * 车机按 1672×941 基准等比缩放（design-system.md §6）：token 一律写成
 * `calc(N * var(--hud-unit))`，随屏幕等比放大。绝对 px 不随屏幕放大，
 * 与相邻的 token 字号混用时，大屏上会出现辅助文字比标题还大、会话行折成两行等错位。
 * 屏幕越大越明显，小窗口里两种写法看起来一样。
 *
 * # 判据
 *
 * `[data-surface="cockpit"]` 名下的每一条 `font-size`，要么是 `var(--hud-font-*)`，
 * 要么含 `var(--hud-unit)`。百分比与 `em` 也放行（它们本来就是相对的）。
 * 读 CSS 不渲染：`clients/shared/ui` 没有 jsdom。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

/* 先剥注释：注释里也可能写着 px 数值，不剥就匹配到注释。 */
const CSS = readFileSync(new URL("../src/dialog/dialog.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

describe("车机对话页：尺寸跟着 --hud-unit 缩放", () => {
  it("车机那一段里没有写死 px 的字号", () => {
    const bad: string[] = [];
    for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1].trim().split("\n").pop()!.trim();
      if (!selector.includes('[data-surface="cockpit"]')) continue;
      for (const d of m[2].matchAll(/(?:^|;)\s*font-size:\s*([^;]+)/g)) {
        const value = d[1].trim();
        const scaled =
          value.includes("var(--hud-font-") || value.includes("var(--hud-unit)") || /%|\bem\b/.test(value);
        if (!scaled) bad.push(`${selector} → font-size: ${value}`);
      }
    }
    assert.deepEqual(
      bad,
      [],
      "这些字号写死了 px，屏幕放大时它们不跟着走，会与相邻的 token 字号错开：\n  " + bad.join("\n  "),
    );
  });

  it("左栏宽度同时改了 width 与 flex：只改一个不会生效", () => {
    const rule = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(
      (m) => m[1].trim().split("\n").pop()!.trim() === '[data-surface="cockpit"] .dlg-sessions',
    );
    assert.ok(rule, "找不到车机左栏的规则");
    const body = rule[2];
    assert.match(body, /(?:^|;)\s*width:\s*calc\([^;]*var\(--hud-unit\)/, "左栏 width 要按基准单位写");
    assert.match(
      body,
      /(?:^|;)\s*flex:\s*0 0 calc\([^;]*var\(--hud-unit\)/,
      "基础规则写着 `flex: 0 0 268px`，只改 width 的话栏宽一个像素都不会变，而且不报错",
    );
  });
});
