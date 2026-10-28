/**
 * [ACR-069] 图像库适配层：把底层库与直觉不同的几处行为钉住——
 * EXIF 要显式读、Inside 会放大、SVG 会被放大光栅化、rawPixels 按源颜色类型给字节、
 * 链式调用不按顺序执行。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  compositeLayers,
  cropTo,
  encodeUpright,
  rasterizeSvg,
  readRasterInfo,
  resizeTo,
  rgbaPixels,
  sameFormatAs,
} from "../src/media/raster";
import { rectsImage, solidGif, solidImage, withExifOrientation } from "./helpers/image-fixtures";

const RED = [224, 32, 32] as const;
const BLUE = [32, 32, 224] as const;
const WHITE = [244, 244, 244] as const;

/** 左半红、右半蓝的 200×100。 */
const halves = (format: "png" | "jpeg" = "png") =>
  rectsImage(200, 100, BLUE, [{ x: 0, y: 0, width: 100, height: 100, color: RED }], format);

const pixelAt = async (bytes: Buffer, x: number, y: number): Promise<number[]> => {
  const { data, width } = await rgbaPixels(bytes);
  const o = (y * width + x) * 4;
  return [data[o], data[o + 1], data[o + 2], data[o + 3]];
};

const near = (actual: readonly number[], expected: readonly number[], tol = 12): boolean =>
  expected.every((v, i) => Math.abs(actual[i] - v) <= tol);

describe("[ACR-069] readRasterInfo", () => {
  it("读出宽高、格式与 EXIF 方向；没有标签时方向为 1", async () => {
    const jpeg = await solidImage(120, 60, RED, "jpeg");
    assert.deepEqual(await readRasterInfo(jpeg), { width: 120, height: 60, format: "jpeg", orientation: 1 });
    assert.equal((await readRasterInfo(withExifOrientation(jpeg, 6))).orientation, 6);
  });

  it("解不开的字节与 GIF 抛错，由调用方决定兜底", async () => {
    await assert.rejects(() => readRasterInfo(Buffer.from("not an image")));
    await assert.rejects(() => readRasterInfo(solidGif(4, 2, RED)));
  });
});

describe("[ACR-069] encodeUpright", () => {
  it("EXIF 6 摆正后宽高互换、产物不带 Orientation", async () => {
    const sideways = withExifOrientation(await solidImage(120, 60, RED, "jpeg"), 6);
    const out = await encodeUpright(sideways, {}, { format: "jpeg", quality: 88 });
    assert.equal(out.width, 60);
    assert.equal(out.height, 120);
    assert.equal((await readRasterInfo(out.bytes)).orientation, 1);
  });

  it("超过 maxSide 等比缩进方框；不超过时不放大", async () => {
    const wide = await solidImage(500, 100, RED, "png");
    const shrunk = await encodeUpright(wide, { maxSide: 250 }, { format: "png" });
    assert.deepEqual([shrunk.width, shrunk.height], [250, 50]);
    const kept = await encodeUpright(wide, { maxSide: 1000 }, { format: "png" });
    assert.deepEqual([kept.width, kept.height], [500, 100]);
  });

  it("sameFormatAs：JPEG / WebP 沿用，其它落 PNG", () => {
    assert.deepEqual(sameFormatAs("jpeg", 80), { format: "jpeg", quality: 80 });
    assert.deepEqual(sameFormatAs("webp", 80), { format: "webp", quality: 80 });
    assert.deepEqual(sameFormatAs("heic", 80), { format: "png" });
  });
});

describe("[ACR-069] resizeTo / cropTo", () => {
  it("cover 居中裁：200×100 缩成 50×50 后左缘是红、右缘是蓝", async () => {
    const out = await resizeTo(await halves(), { width: 50, height: 50, fit: "cover" }, { format: "png" });
    assert.deepEqual([out.width, out.height], [50, 50]);
    assert.ok(near(await pixelAt(out.bytes, 0, 25), [...RED, 255]));
    assert.ok(near(await pixelAt(out.bytes, 49, 25), [...BLUE, 255]));
  });

  it("fill 按给定宽高拉伸", async () => {
    const out = await resizeTo(await halves(), { width: 40, height: 80, fit: "fill" }, { format: "png" });
    assert.deepEqual([out.width, out.height], [40, 80]);
  });

  it("裁切坐标按像素：从红蓝交界右侧裁下的是蓝", async () => {
    const out = await cropTo(await halves(), { left: 120, top: 10, width: 30, height: 20 }, { format: "png" });
    assert.deepEqual([out.width, out.height], [30, 20]);
    assert.ok(near(await pixelAt(out.bytes, 0, 0), [...BLUE, 255], 0));
  });
});

describe("[ACR-069] rgbaPixels", () => {
  it("RGB 源统一成 RGBA，alpha 补 255", async () => {
    const { data, width, height } = await rgbaPixels(await solidImage(3, 2, RED, "png"));
    assert.deepEqual([width, height, data.length], [3, 2, 24]);
    assert.deepEqual([...data.subarray(0, 4)], [...RED, 255]);
  });
});

describe("[ACR-069] rasterizeSvg / compositeLayers", () => {
  it("SVG 按声明尺寸出图（底层会先放大，这里缩回来）", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="30"><rect width="80" height="30" fill="#e02020"/></svg>`;
    const png = await rasterizeSvg(svg, 80, 30);
    const info = await readRasterInfo(png);
    assert.deepEqual([info.width, info.height], [80, 30]);
    assert.ok(near(await pixelAt(png, 40, 15), [...RED, 255]));
  });

  it("SVG 的文字用系统字体光栅化：白字在黑底上有亮像素", { skip: process.platform === "darwin" ? false : "只在开发机（macOS）断言字体：生产镜像不装字体" }, async () => {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="#000"/>` +
      `<text x="6" y="30" font-family="Helvetica, Arial, sans-serif" font-size="24" font-weight="600" fill="#ffffff">00:24</text></svg>`;
    const { data } = await rgbaPixels(await rasterizeSvg(svg, 120, 40));
    let bright = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] > 200) bright += 1;
    assert.ok(bright > 50, `亮像素 ${bright}`);
  });

  it("纯色底上叠加：未覆盖处是底色，覆盖处是上层", async () => {
    const tile = await solidImage(10, 10, RED, "png");
    const out = await compositeLayers({ width: 30, height: 10, background: [16, 16, 16] }, [{ bytes: tile, left: 20, top: 0 }], { format: "png" });
    assert.deepEqual([out.width, out.height], [30, 10]);
    assert.ok(near(await pixelAt(out.bytes, 0, 0), [16, 16, 16, 255], 0));
    assert.ok(near(await pixelAt(out.bytes, 25, 5), [...RED, 255], 0));
  });

  it("多层按传入顺序叠：后叠的在上面", async () => {
    const red = await solidImage(10, 10, RED, "png");
    const blue = await solidImage(10, 10, BLUE, "png");
    const canvas = { width: 10, height: 10, background: [0, 0, 0] as const };
    const redOnTop = await compositeLayers(canvas, [{ bytes: blue, left: 0, top: 0 }, { bytes: red, left: 0, top: 0 }], { format: "png" });
    const blueOnTop = await compositeLayers(canvas, [{ bytes: red, left: 0, top: 0 }, { bytes: blue, left: 0, top: 0 }], { format: "png" });
    assert.ok(near(await pixelAt(redOnTop.bytes, 5, 5), [...RED, 255], 0));
    assert.ok(near(await pixelAt(blueOnTop.bytes, 5, 5), [...BLUE, 255], 0));
  });

  it("透明 SVG 叠在图上只改画到的像素", async () => {
    const base = await solidImage(40, 40, WHITE, "png");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect x="0" y="0" width="10" height="10" fill="#e02020"/></svg>`;
    const out = await compositeLayers(base, [{ bytes: await rasterizeSvg(svg, 40, 40), left: 0, top: 0 }], { format: "png" });
    assert.ok(near(await pixelAt(out.bytes, 3, 3), [...RED, 255]));
    assert.ok(near(await pixelAt(out.bytes, 30, 30), [...WHITE, 255], 0));
  });
});
