/**
 * 配置页每个分区都要有保存入口。
 *
 * 保存按钮曾只挂在带探活目标的分区（LLM / ASR / TTS）上，「运行时开关」区的项
 * （CABINHUG_TOOLS、RESEARCH_ENABLED、CABINHUG_CAPABILITIES_OFF）能填、存不进去，且不报错。
 * 读源码守：页面依赖浏览器环境，node 里渲染不了。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const SRC = readFileSync(new URL("../src/pages/config/index.tsx", import.meta.url), "utf8");

describe("系统配置页的保存入口", () => {
  it("带探活的分区：保存并探活", () => {
    assert.match(SRC, /onClick=\{\(\) => void save\(scope\.id, scope\.probe\)\}[\s\S]{0,80}保存并探活/);
  });

  it("没有探活目标的分区（运行时开关）：也有保存按钮，不再是 null", () => {
    assert.match(SRC, /onClick=\{\(\) => void save\(scope\.id\)\}[\s\S]{0,80}>\s*保存\s*</);
    assert.doesNotMatch(SRC, /保存并探活\s*<\/button>\s*<\/>\s*\)\s*:\s*null\}/);
  });

  it("运行时开关分区在页面的分组表里", () => {
    assert.match(SRC, /\{ id: "runtime", label: "运行时开关" \}/);
  });
});
