/**
 * 常用人员表单的可用性约束（[F-46-11][AC-46-1]）。
 *
 *  - 芯片的选中态要看得出来：`.own-chip--on` 若排在同权重的 `.own-chip` 之前，
 *    `color` 与 `border` 会被抹平，表现为点了没反应。层叠顺序只有排序断言拦得住。
 *  - 关系输入框给出候选，车主知道该填什么。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");
/**
 * 去注释：断言"源码里不该出现 X"时，对象是会跑起来的代码，
 * 不能匹配到解释「为什么不用 X」的注释。
 */
const stripComments = (t: string): string =>
  t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

const CSS = read("../src/features/ownership/ownership.css");
const FORM = read("../src/features/ownership/members.tsx");
const FORM_CODE = stripComments(FORM);

describe("[F-46-11][AC-46-1] 芯片的选中态看得出来", () => {
  it("`.own-chip--on` 排在最后一份 `.own-chip` 之后", () => {
    const lastBase = CSS.lastIndexOf("\n.own-chip {");
    const on = CSS.lastIndexOf("\n.own-chip--on {");
    assert.ok(lastBase >= 0 && on >= 0, "两条规则都要在");
    assert.ok(
      on > lastBase,
      "同权重（0,1,0）下后者胜：排在前面的话 color 与 border 会被抹平，" +
        "表现就是「点了没反应」——走查 W11 报的正是这个",
    );
  });

  it("选中态同时改颜色与边框", () => {
    const block = CSS.slice(CSS.lastIndexOf("\n.own-chip--on {"));
    const body = block.slice(0, block.indexOf("}"));
    assert.match(body, /color:/);
    assert.match(body, /border-color:/);
  });

  it("只有一份 `.own-chip--on` 定义", () => {
    assert.equal(CSS.split("\n.own-chip--on {").length - 1, 1);
  });
});

describe("[F-46-11][AC-46-1] 关系有候选也能自己打", () => {
  it("给了候选（datalist），不是空着让人猜", () => {
    assert.match(FORM, /list="own-relation-options"/);
    assert.match(FORM, /<datalist id="own-relation-options">/);
  });

  it("仍然是 input 不是 select，保留自定义输入", () => {
    const i = FORM_CODE.indexOf("与你的关系");
    const seg = FORM_CODE.slice(i, i + 500);
    assert.ok(!seg.includes("<select"), "下拉框逼人从别人的词表里挑，结果是干脆不填");
    assert.match(seg, /onChange=\{\(e\) => onChange\(\{ \.\.\.draft, relation: e\.target\.value \}\)\}/);
  });

  it("候选覆盖三代 + 同辈 + 非亲属（车会借出去）", () => {
    for (const r of ["父亲", "岳母", "配偶", "女儿", "孙子", "朋友", "同事"]) {
      assert.ok(FORM.includes(`"${r}"`), `候选里缺「${r}」`);
    }
  });
});

describe("[F-56-06][AC-56-7] 降级播报说得出为什么没响", () => {
  const CMD = read("../../cockpit/src-tauri/src/commands/device.rs");
  const MAIN = read("../../cockpit/src/main.tsx");

  it("入口记一行：字数 + 播报开关 + 引擎", () => {
    assert.match(CMD, /降级播报：/);
    assert.match(CMD, /state\.is_muted\(\)/);
    assert.match(CMD, /crate::tts::enabled\(\)/);
  });

  it("端上不静默吞掉 invoke 失败", () => {
    assert.match(MAIN, /announce_downgrade[\s\S]{0,400}console\.warn/);
    assert.ok(
      !/announce_downgrade[\s\S]{0,300}\.catch\(\(\) => \{\s*\/\/[^\n]*\n\s*\}\)/.test(MAIN),
      "空 catch 让「到底调没调成」无从查起——走查 W10 就卡在这里",
    );
  });
});
