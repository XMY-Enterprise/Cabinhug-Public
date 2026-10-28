/**
 * 「我的行程」标题右上角那枚角标：里面要有数字，而且永远不红。
 *
 * # 为什么要守数字
 *
 * 产品要求角标显示当前行程条数，形态照 iOS 未读角标；不带数字的小点不满足要求。
 *
 * # 为什么要守不红
 *
 * design-system.md §4 的红色纪律：红只给「拥堵」和「读不到」两个判定，
 * 不给强调、不给未读角标、不给删除按钮。这枚角标属于未读角标。
 *
 * 本包没有 jsdom，组件无法渲染：数字那一条只检查源码形状。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("../src/hud/hud.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const TSX = readFileSync(new URL("../src/hud/TripCalendarCard.tsx", import.meta.url), "utf8").replace(
  /\{\/\*[\s\S]*?\*\/\}/g,
  "",
);

describe("行程数角标", () => {
  it("角标里渲染的是行程条数，不是一个空的点", () => {
    /*
     * 只看标签之间的内容，不对整段做正则：开标签的 aria-label 里含 `${entries.length}`，
     * 宽松的正则在数字被删成自闭合标签后仍会命中 aria-label。
     */
    const open = TSX.match(/<span className="hud-trips__title-count"[^>]*?(\/?)>/);
    assert.ok(open, "找不到 hud-trips__title-count 这个元素——角标又被收成不带数字的点了？");
    assert.notEqual(open[1], "/", "角标写成了自闭合标签，里面什么都没有");
    const after = TSX.slice(open.index! + open[0].length);
    const children = after.slice(0, after.indexOf("</span>"));
    assert.match(
      children,
      /\{entries\.length\}/,
      "角标里没有 {entries.length}：用户 2026-09-11 明确要求点里写着现在有几程",
    );
  });

  it("一程都没有时不画角标", () => {
    assert.match(
      TSX,
      /\{entries\.length > 0 && \(\s*<span className="hud-trips__title-count"/,
      "没有行程时应该整个不画——一个空的或写着 0 的角标比没有角标更让人找原因",
    );
  });

  it("角标恒为琥珀，任何一档都不许用 danger 红", () => {
    const red: string[] = [];
    for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = m[1].trim().split("\n").pop()!.trim();
      if (!selector.includes("hud-trips__title-count")) continue;
      if (/--hud-danger|#[Cc]0392[Bb]/.test(m[2])) red.push(selector);
    }
    assert.deepEqual(
      red,
      [],
      "红色纪律（design-system.md §4）明写着红不给未读角标；要表达变化等级，用清单行上的变化点：\n  " +
        red.join("\n  "),
    );
  });
});
