/**
 * 能力条的渲染结果。
 *
 * `capability-rail.test.ts` 验决策；这里验决策被 JSX 落实。两者可能分叉：
 * 模型给出 `disabled: true`，组件却没把它接到 `disabled` 属性上，页面按钮可点、
 * 点完回 501，而纯模型单测仍是绿的。
 *
 * 不做渲染快照、不比对整段 HTML（改一行样式就红），只查不变的事实：抑制态零
 * `<button>`、禁用按钮带 `disabled` 且 title 说明原因。
 *
 * 运行约束：
 *  ① 用 `createElement` 而不是 JSX，文件留在 `.ts`——本包的测试入口是
 *     `node --import tsx --test test/*.test.ts`，`.tsx` 不在该 glob 内。
 *  ② 须在本包目录下跑（`pnpm --filter @cabinhug/web test` 即是）。
 *     从仓库根跑时 tsx 读到根 tsconfig，那里没有 `jsx: react-jsx`，
 *     组件按经典变换编译，报 `React is not defined`。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { SelectionScope } from "@cabinhug/research/capabilities";

import { CapabilityRail, RailBtn } from "../src/pages/research/evidence-matrix/CapabilityRail";
import { railModel, SUPPRESSED_NOTE, type RailButton } from "../src/pages/research/evidence-matrix/rail-model";

const cell = (over: Partial<Extract<SelectionScope, { kind: "cell" }>> = {}): SelectionScope => ({
  kind: "cell",
  needPainCode: "cold-range-loss",
  sceneCode: "charging",
  suppressed: false,
  catchAll: false,
  hasDirection: false,
  ...over,
});

const render = (scope: SelectionScope | null, suppressedReason: string | null): string =>
  renderToStaticMarkup(
    createElement(CapabilityRail, { scope, suppressedReason, onRun: () => undefined }),
  );

/** 数一数真的渲染出了几个 `<button>`。 */
const buttonCount = (html: string): number => (html.match(/<button/g) ?? []).length;

describe("[M85-04] 渲染：被抑制的格上真的一个按钮都没有", () => {
  it("零 <button>，只有那句文案", () => {
    const html = render(cell({ suppressed: true }), "小单元抑制：这一格只覆盖 3 台车");
    assert.equal(buttonCount(html), 0, `抑制态渲染出了按钮：${html}`);
    assert.ok(html.includes(SUPPRESSED_NOTE));
  });

  it("位置留着——整块不渲染会被当成「还没加载出来」", () => {
    const html = render(cell({ suppressed: true }), "小单元抑制");
    assert.match(html, /rm-cap-rail/);
    assert.match(html, /is-suppressed/);
  });

  it("同一格不抑制时按钮是真的在的——证明上面两条不是恒空", () => {
    assert.ok(buttonCount(render(cell(), null)) > 0);
  });

  it("scope 为 null 时整条不渲染", () => {
    assert.equal(render(null, null), "");
  });
});

describe("[M85-04] 渲染：决策被 JSX 落实了", () => {
  /*
   * 十二条能力均已实现，这一层的禁用靶子取整列上的 C4：它禁用的理由是
   * "这个范围上答不了"（分群切分按主题做，主题不带场景维度），服务端对这种请求
   * 回 400 `scope_not_supported`。该理由不随排期变化。
   *
   * 单独渲染 `RailBtn` 而不是整条能力条：禁用按钮按「能点的排前面」被排进
   * 折叠着的 `⋯`，整条渲染时不在 HTML 里。
   */
  const unsupportedBtn = (): RailButton => {
    const m = railModel({ kind: "col", sceneCode: "charging" }, null);
    if (m.kind !== "rail") throw new Error("应当是 rail");
    const b = [...m.primary, ...m.overflow].find((x) => x.id === "c4");
    assert.ok(b, "整列上没有 C4 了——能力目录改过，这两条用例要跟着换靶子");
    assert.ok(b.disabled, "整列上的 C4 变成可点的了：点下去拿到的是 400 scope_not_supported");
    return b;
  };

  it("按不下去的能力带 disabled 属性，不只是模型里写着", () => {
    const html = renderToStaticMarkup(createElement(RailBtn, { b: unsupportedBtn(), onRun: () => undefined }));
    assert.match(html, /disabled/, `按钮没有 disabled 属性：${html}`);
    assert.match(html, /is-off/);
  });

  it("禁用按钮的 title 说的是「为什么按不下去」，且直接出现在 HTML 里", () => {
    const b = unsupportedBtn();
    // 禁用按钮须说明原因，否则看起来正常却毫无反应。
    assert.match(b.title, /整列答不了/, `模型给的 title 没说原因：${b.title}`);
    const html = renderToStaticMarkup(createElement(RailBtn, { b, onRun: () => undefined }));
    assert.match(html, /title="[^"]*整列答不了/);
  });

  it("十二条全实现后，普通格与兜底桶格上不该再有「还没做」的按钮", () => {
    /*
     * 反向守：`IMPLEMENTED` 漏填某一条时，表现是后端可用而界面按钮仍为灰色。
     */
    for (const scope of [cell(), cell({ catchAll: true, hasDirection: true })]) {
      const m = railModel(scope, null);
      if (m.kind !== "rail") throw new Error("应当是 rail");
      for (const b of [...m.primary, ...m.overflow]) {
        assert.ok(!/还没做/.test(b.title), `${b.id} 还被当成没实现：${b.title}`);
      }
    }
  });

  it("正在跑的那条能力在整条能力条上也按不动", () => {
    // 渲染完整的 `CapabilityRail`：`busy` 分支自行生成禁用按钮，
    // 不依赖任何能力是否已实现，是这一层不随排期漂移的端到端检出点。
    const html = renderToStaticMarkup(
      createElement(CapabilityRail, {
        scope: cell(),
        suppressedReason: null,
        onRun: () => undefined,
        busy: "summarize-cell",
      }),
    );
    const btn = html.slice(html.indexOf("<button"), html.indexOf("</button>"));
    assert.match(btn, /disabled/, `跑着的能力还能再点一次：${btn}`);
    assert.ok(btn.includes("归纳这一格…"), "跑着的按钮没有显示成「跑着呢」");
  });

  it("[M85-07] 卡片范围上的能力可点，title 说的是耗时不是工单号", () => {
    /*
     * 漏填 `IMPLEMENTED` 时后端可用而界面按钮仍为灰色，且不报错。
     *
     * 卡片上是四条（c6 / c7 / c10 / c12），主区只露 3 个，
     * 第四条落进 `⋯`，渲染出 3 + 1 个 `<button>`。
     */
    const html = render({ kind: "card", insightId: "insight-1" }, null);
    const buttons = html.split("<button").slice(1);
    assert.equal(buttons.length, 4, `卡片范围上应当是 c6 / c7 / c10 三个按钮 + 一个 ⋯：${html}`);
    for (const b of buttons) {
      assert.ok(!b.includes("disabled"), `已实现的能力被渲染成禁用：<button${b.slice(0, 120)}`);
      assert.ok(!/M85-\d\d/.test(b), `可点的按钮上却写着工单号：<button${b.slice(0, 120)}`);
    }
    // c6 是 ✎（10–60 秒）、c7 是 💬（多轮对话），两档图标都须出现。
    assert.match(html, /<span class="rm-cap-icon">✎<\/span>挑战这张卡/);
    assert.match(html, /<span class="rm-cap-icon">💬<\/span>追问/);
  });

  /*
   * 普通格上的三条查类能力须可点。
   * 漏填 `IMPLEMENTED` 时后端可用而界面按钮仍为灰色，且不报错。
   */
  it("[M85-05] 普通格上的能力可点，且 title 说的是耗时不是工单号", () => {
    const html = render(cell(), null);
    const buttons = html.split("<button").slice(1).slice(0, 3);
    for (const b of buttons) {
      assert.ok(!b.includes("disabled"), `已实现的能力被渲染成禁用：<button${b.slice(0, 120)}`);
      assert.ok(!/M85-\d\d/.test(b), `可点的按钮上却写着工单号：<button${b.slice(0, 120)}`);
    }
    /*
     * 普通格上是 c1（✎，10–60 秒）+ c2/c4/c5（🔍，即点即出），均已实现；
     * 主区三个按「能点的排前面」保持原顺序，第一个是 c1。
     * 两档耗时预期都须出现，防止耗时标注与实际能力对调。
     */
    assert.match(html, /要跑 10–60 秒/);
    assert.match(html, /即点即出/);
  });

  it("已实现的能力（整屏的红队清单）按钮可点，且 title 不是工单号", () => {
    const html = render({ kind: "page" }, null);
    const btn = html.slice(html.indexOf("<button"), html.indexOf("</button>"));
    assert.ok(!btn.includes("disabled"), `唯一实现了的能力被渲染成禁用：${btn}`);
    assert.match(btn, /即点即出/);
    assert.match(btn, /这一屏的红队清单/);
  });

  it("层图标在按钮内，不另起一列", () => {
    assert.match(render({ kind: "page" }, null), /<span class="rm-cap-icon">🔍<\/span>/);
  });

  it("装不下的落进 ⋯，而 ⋯ 自己是一个可点的按钮", () => {
    const html = render(cell({ hasDirection: true, catchAll: true }), null);
    assert.match(html, /rm-cap-more/);
    assert.match(html, /⋯/);
    // 折叠着时里面的条目不渲染——展开才出。
    assert.ok(!html.includes("rm-cap-menu"));
  });
});
