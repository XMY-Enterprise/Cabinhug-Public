/**
 * 手册目录里那 28 枚指示灯图标，端上按 `symbolId` 取。
 *
 * # 为什么不是再画一套
 *
 * 观察层认出来的名称和级别来自**手册图标目录**，而那份目录里每个符号
 * 都存着一张图（`data/kb-src/icons/tesla-model3/<symbolId>.png`）。
 * 端上再画一套"像的"，等于让同一个符号在两个地方各有一个真相源，画出来的那套
 * 终会与手册对不上；而这一屏的价值就是"你看到的这个灯，手册里叫它什么"。
 *
 * 这里的文件是那份原图 `sips -Z 96` 缩出来的，逐字同名，别手动改名：文件名就是键，
 * `lamp-assets.test.ts` 按目录表对文件名，改了名就是端上少一枚图标而不报错。
 *
 * # 一枚例外：`fog_lamp_front`
 *
 * 目录的表里有它，图片抽取时漏了（`fog_lamp_rear` 在，前雾灯不在）。这一枚的形状取自
 * 评测集里的合成图（`evals/vision-observe/datasets/synth-tesla01/icons/`）抠底后的字形，
 * 颜色换成手册那支绿（`low_beam.png` 量出来的 `rgb(0,248,0)`）——**同一屏里 28 枚灯必须是一套**，
 * 一枚发灰的混在里面比缺一枚更显眼。手册那张图补回来时，直接覆盖这个文件即可。
 *
 * # 取不到就不画
 *
 * `lampArt()` 返回 `undefined` 时，`LampGlyph` 回落到按颜色着色的三角块。
 * 没有这个回落的话，手册目录里新增一个符号就会在观察卡上留一个破图。
 */

/*
 * 按目录取，不逐个静态 import：这 28 枚图取自特斯拉车主手册，版权属于厂商，`assets/lamps/`
 * 可能不在本树。静态 import 缺一个文件 vite 构建就失败；按目录取时缺图得到空表，
 * 观察卡整列回落到三角块。
 */
const LAMP_FILES = import.meta.glob<string>("./assets/lamps/*.png", { eager: true, import: "default" });

/** `symbolId` → 图片 URL。键是文件名去掉 `.png`，逐字等于手册图标目录里的 `symbol_id`。 */
const LAMP_ART: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(LAMP_FILES).map(([path, url]) => [path.slice(path.lastIndexOf("/") + 1, -".png".length), url]),
);

/** 手册里有这枚图标就给出来；没有（或压根没对上符号）返回 undefined，由调用方回落。 */
export function lampArt(symbolId: string | null | undefined): string | undefined {
  return symbolId ? LAMP_ART[symbolId] : undefined;
}

/** 仅供守卫测试：端上带了哪些符号。 */
export const LAMP_SYMBOL_IDS: ReadonlyArray<string> = Object.keys(LAMP_ART);
