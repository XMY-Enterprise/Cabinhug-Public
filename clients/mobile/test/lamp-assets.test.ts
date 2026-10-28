/**
 * [F-20-06][AC-20-2] 观察卡上那一列图标必须是手册里对应的那枚。
 *
 * 同一个三角感叹号只按颜色着色时，「安全带未系」与「胎压报警」在屏幕上无法区分。
 * 图标按 `symbolId` 取手册目录里的图（`data/kb-src/icons/tesla-model3/<symbolId>.png`
 * 缩到 96px）。
 *
 * 读源码与目录，不渲染（本包无 jsdom）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const LAMPS = readFileSync(new URL("../src/features/service/lamps.ts", import.meta.url), "utf8");
const GUIDED = readFileSync(new URL("../src/features/service/guided.tsx", import.meta.url), "utf8");
const DEMO = readFileSync(new URL("../src/features/service/demo.ts", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../src/features/service/diagnosis.css", import.meta.url), "utf8");
const DIR = new URL("../src/features/service/assets/lamps/", import.meta.url);
/** 手册图标目录的表：`symbol_id` 这一列就是观察层能给出的全部符号。 */
const CATALOG_URL = new URL("../../../data/kb-src/icons/tesla-model3-indicators.md", import.meta.url);
/**
 * 图标与目录表都取自特斯拉车主手册，可能不在本树。
 * 两者不在时：对表的用例跳过，接线与回落的用例照常跑。
 */
const MANUAL_ASSETS_ABSENT = existsSync(DIR) && existsSync(CATALOG_URL) ? false : "手册图标与目录表不在本树";
const CATALOG = MANUAL_ASSETS_ABSENT ? "" : readFileSync(CATALOG_URL, "utf8");
/**
 * 目录表里有、但手册图片目录里缺图的符号。
 *
 * 端上这一枚由评测集的合成字形抠底、换成手册的绿色补成（见 `lamps.ts` 文件头）。
 * 手册原图补齐后从这张表里删除。
 */
const FILLED_IN = ["fog_lamp_front"];

const onDisk = MANUAL_ASSETS_ABSENT ? [] : readdirSync(DIR).filter((f) => f.endsWith(".png")).map((f) => f.slice(0, -4)).sort();

describe("[F-20-06][AC-20-2] symbolId → 手册图标：表与文件一一对上", { skip: MANUAL_ASSETS_ABSENT }, () => {
  /** 键就是文件名：lamps.ts 按目录取图，不另写一张会与文件漂移的表。 */
  it("目录里的图都带上了", () => {
    assert.ok(onDisk.length >= 20, `手册目录有 27 个符号，端上只带了 ${onDisk.length} 个`);
  });

  /**
   * 按目录的表对，不按目录里的图片文件对：观察层能给出的符号来自那张表，
   * 表里新增一行而没有图时，端上会退回三角块。
   */
  it("目录表里的每个 symbol_id 端上都有图", () => {
    const rows = [...CATALOG.matchAll(/^\|\s*`?([a-z][a-z0-9_]+)`?\s*\|/gm)].map((m) => m[1]).filter((id) => id !== "symbol_id");
    const missing = rows.filter((id) => !onDisk.includes(id));
    assert.deepEqual(missing, [], `目录里这些符号端上没图：${missing.join("、")}（切一张 sips -Z 96，或补进 FILLED_IN 并说明来源）`);
    for (const id of FILLED_IN) assert.ok(rows.includes(id), `${id} 已经不在目录表里了，端上这枚补图可以删`);
  });

  it("安全带未系、胎压报警两盏灯都有图", () => {
    for (const id of ["seatbelt_unfastened", "tpms_warning"]) {
      assert.ok(onDisk.includes(id), `缺 ${id}`);
    }
  });
});

describe("接线：观察卡取图，取不到才回落", () => {
  it("lamps.ts 按目录取图（缺文件时得到空表，照样能构建）", () => {
    assert.match(LAMPS, /import\.meta\.glob<string>\("\.\/assets\/lamps\/\*\.png", \{ eager: true, import: "default" \}\)/);
    assert.doesNotMatch(LAMPS, /^import .+ from "\.\/assets\/lamps\//m, "不能逐个静态 import：缺一个文件 vite 就构建失败");
  });
  it("LampGlyph 按 symbolId 取图，有图就画图", () => {
    assert.match(GUIDED, /const art = lampArt\(item\.symbolId\);/);
    assert.match(GUIDED, /art \? \(\s*<img className="dx-lamp__art"/);
  });

  it("取不到仍有回落，不留破图", () => {
    assert.ok(GUIDED.includes("<svg viewBox=\"0 0 24 24\">"), "回落的三角块还在");
  });

  it("图标按比例放，不拉伸——手册图标宽高比从 219×256 到 488×256 都有", () => {
    assert.match(CSS, /\.dx-lamp__art \{[^}]*object-fit: contain/);
  });

  it("演示数据也带真 symbolId：版式截图走的就是这条路", () => {
    assert.match(DEMO, /symbolId: "seatbelt_unfastened"/);
  });
});
