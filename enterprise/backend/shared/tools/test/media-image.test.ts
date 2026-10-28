/**
 * [F-09-10][AC-09-9] 照片归一化：模型读不了的格式转 JPEG、超大缩到 4096、EXIF 摆正；
 * 三条都不命中时字节不动；两个解码器都解不开也不抛。
 *
 * 进程内解码（ACR-069）解得开 BMP / TIFF / AVIF，HEIC 只在 macOS / Windows 解得开，GIF 不解。
 * GIF 不超限时按文件头宽高原样透传；超限的 GIF 覆盖"进程内解不开 → 落到 ffmpeg"那条分支。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ffmpegPathsFromEnv, ffmpegVersion, normalizeImageForModel } from "../src/media";
import { readRasterInfo } from "../src/media/raster";
import { solidBmp, solidGif, solidImage, withExifOrientation } from "./helpers/image-fixtures";

const paths = ffmpegPathsFromEnv();
const hasFfmpeg = (await ffmpegVersion(paths)) !== null;
const HEIC = new URL("./fixtures/solid-800x600.heic", import.meta.url);
/** 进程内解 HEIC 靠系统解码器：只有 macOS / Windows 有。 */
const heicInProcess = process.platform === "darwin" || process.platform === "win32";

const GREEN = [0x22, 0xbb, 0x66] as const;

describe("[F-09-10][AC-09-9] normalizeImageForModel", () => {
  it("模型读得了、尺寸也正常 → 字节不动（避免对观察层已调好的分辨率重复降质）", async () => {
    const png = await solidImage(100, 80, GREEN, "png");
    const r = await normalizeImageForModel(png, "image/png");
    assert.equal(r.changed, false);
    assert.equal(r.contentType, "image/png");
    assert.ok(r.bytes === png, "没改就该原样返回同一个 Buffer");
    assert.equal(r.note, undefined);

    const jpg = await solidImage(100, 80, GREEN, "jpeg");
    assert.equal((await normalizeImageForModel(jpg, "image/jpg")).changed, false, "别名 image/jpg 也算模型读得了");
  });

  it("TIFF / AVIF / BMP 这类模型读不了的 → 进程内转 JPEG，且产物真的能解", async () => {
    for (const [label, buf, mime] of [
      ["tiff", await solidImage(60, 40, GREEN, "tiff"), "image/tiff"],
      ["avif", await solidImage(60, 40, GREEN, "avif"), "image/avif"],
      ["bmp", solidBmp(4, 2, GREEN), "image/bmp"],
    ] as const) {
      const r = await normalizeImageForModel(buf, mime);
      assert.equal(r.contentType, "image/jpeg", label);
      assert.equal(r.changed, true, label);
      assert.match(r.note ?? "", /模型读不了，已转 JPEG/, label);
      assert.doesNotMatch(r.note ?? "", /ffmpeg/, `${label} 应在进程内解开`);
      assert.equal((await readRasterInfo(r.bytes)).format, "jpeg", label);
    }
  });

  it("超过 4096 的一边缩下来，格式不变（PNG 截图不该被顺手转成 JPEG）", async () => {
    const wide = await solidImage(5000, 100, GREEN, "png");
    const r = await normalizeImageForModel(wide, "image/png");
    assert.equal(r.changed, true);
    assert.equal(r.contentType, "image/png");
    assert.equal(r.width, 4096);
    assert.match(r.note ?? "", /单边超过 4096px/);
  });

  it("EXIF 里躺倒的照片摆正：模型不会指出方向不对，只会答错", async () => {
    // orientation 6 = 顺时针转 90°；摆正后宽高对调
    const sideways = withExifOrientation(await solidImage(120, 60, GREEN, "jpeg"), 6);
    assert.equal((await readRasterInfo(sideways)).orientation, 6);
    const r = await normalizeImageForModel(sideways, "image/jpeg");
    assert.equal(r.changed, true);
    assert.equal(r.width, 60);
    assert.equal(r.height, 120);
    assert.match(r.note ?? "", /按 EXIF 摆正/);
    assert.equal((await readRasterInfo(r.bytes)).orientation, 1, "产物不再带方向标记");
  });

  it("GIF 不超限：进程内解不开像素，按文件头宽高原样透传", async () => {
    const gif = solidGif(4, 2, GREEN);
    const r = await normalizeImageForModel(gif, "image/gif");
    assert.equal(r.changed, false);
    assert.equal(r.contentType, "image/gif");
    assert.ok(r.bytes === gif);
    assert.deepEqual([r.width, r.height], [4, 2]);
  });

  it("解不开的字节不抛，原样返回并写 note（由运行时那道过滤挡在模型之外）", async () => {
    const r = await normalizeImageForModel(Buffer.from("这不是图片"), "image/png");
    assert.equal(r.changed, false);
    assert.match(r.note ?? "", /解不开|读不出/);
  });
});

describe(
  "[F-09-10][AC-09-9] HEIC（iPhone 默认格式）出 800×600 的 JPEG",
  { skip: heicInProcess || hasFfmpeg ? false : "本平台进程内解不了 HEIC，且没有可用的 ffmpeg（FFMPEG_PATH）" },
  () => {
    it(heicInProcess ? "macOS / Windows：进程内经系统解码器解开" : "Linux：进程内解不开，ffmpeg 兜住", async () => {
      const r = await normalizeImageForModel(readFileSync(HEIC), "image/heic");
      assert.equal(r.contentType, "image/jpeg");
      assert.equal(r.changed, true);
      assert.match(r.note ?? "", heicInProcess ? /模型读不了，已转 JPEG/ : /ffmpeg/);
      const info = await readRasterInfo(r.bytes);
      assert.deepEqual([info.format, info.width, info.height], ["jpeg", 800, 600]);
    });
  },
);

describe("[F-09-10][AC-09-9] 进程内解不开时落到 ffmpeg", { skip: hasFfmpeg ? false : "本机没有可用的 ffmpeg（FFMPEG_PATH）" }, () => {
  it("超限 GIF：进程内不解、文件头宽高超限，ffmpeg 转 JPEG 后再缩到 4096", async () => {
    const r = await normalizeImageForModel(solidGif(5000, 10, GREEN), "image/gif");
    assert.equal(r.contentType, "image/jpeg");
    assert.equal(r.changed, true);
    assert.equal(r.width, 4096);
    assert.match(r.note ?? "", /进程内解不开，已用 ffmpeg 转成 JPEG/);
    assert.match(r.note ?? "", /单边超过 4096px/);
  });

  it("ffmpeg 也解不开时不抛：整轮对话不因一张图失败", async () => {
    const r = await normalizeImageForModel(Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0xff]), "image/heic");
    assert.equal(r.changed, false);
    assert.match(r.note ?? "", /解不开/);
  });
});
