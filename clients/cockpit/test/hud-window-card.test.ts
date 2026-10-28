/**
 * 提示卡窗口的两处渲染点。
 *
 * # 为什么是读源码而不是渲染
 *
 * `clients/cockpit` 没有 `react-dom` 依赖（渲染层的断言在 `@cabinhug/ui`，
 * 见 `clients/shared/ui/test/highlights-card.test.ts`）。这里守的是结构：
 * `HudScreen.tsx` 有两处悬浮层渲染（真实地图分支 / 默认分支），
 * 只改一处时表现为"有地图时能看到推荐卡、没地图时看不到"，且不报错。
 * `AssistantDock` 的挂载也有同样的两处约束。
 *
 * 判据：两类卡的分流只有一处（`windowCard`），并被用在两处。
 * 把三元判断复制回渲染点时本条失败。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/hud/HudScreen.tsx", import.meta.url), "utf8");

const count = (needle: string) => SRC.split(needle).length - 1;

describe("两类卡的分流只写一处、用两处", () => {
  it("`<TipsCard` 与 `<HighlightsCard` 各只出现一次——分流不许复制", () => {
    assert.equal(count("<TipsCard"), 1, "复制一份三元就会有一处忘了改");
    assert.equal(count("<HighlightsCard"), 1);
  });

  it("`{windowCard}` 出现两次——真实地图分支与默认分支都要挂上", () => {
    assert.equal(
      count("{windowCard}"),
      2,
      "漏一处的表现是「有地图时能看到推荐卡、没地图时看不到」，且不报错",
    );
  });

  it("分流走的是共享守卫 `isHighlightsPage`，不是自己判 `\"highlights\" in page`", () => {
    assert.ok(SRC.includes("isHighlightsPage(page)"));
    assert.equal(SRC.includes('"highlights" in page'), false);
  });

  it("两类卡共用同一套轮播状态：都吃 `tipsPage` / `tips.pages.length`", () => {
    // 各自持有一套轮播时，两张卡的页码会对不上，圆点仍正常闪动。
    assert.equal(count("page={tipsPage}"), 2);
    assert.equal(count("pageCount={tips.pages.length}"), 2);
    assert.equal(count("gestureProps={tipsGestureProps}"), 2);
  });
});
