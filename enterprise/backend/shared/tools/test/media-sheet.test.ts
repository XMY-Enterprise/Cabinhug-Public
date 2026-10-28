/**
 * [F-09-10][AC-09-9] 帧序图合成：1 行 N 列、每帧统一宽、角标时刻、分组按 10 秒窗、PCM 按窗切段。
 * 全部零 ffmpeg：帧用纯色夹具，PCM 用零填充。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { composeSheet, formatClock, groupFrames, splitPcm } from "../src/media";
import { readRasterInfo, rgbaPixels } from "../src/media/raster";
import { solidImage, type Rgb } from "./helpers/image-fixtures";

function frame(color: Rgb, w = 640, h = 360): Promise<Buffer> {
  return solidImage(w, h, color, "jpeg");
}

describe("formatClock", () => {
  it("mm:ss，四舍五入到秒", () => {
    assert.equal(formatClock(0), "00:00");
    assert.equal(formatClock(4000), "00:04");
    assert.equal(formatClock(59_600), "01:00");
    assert.equal(formatClock(125_000), "02:05");
  });
});

describe("composeSheet", () => {
  it("5 帧 → 宽 = 5×480 + 4×gap，高按 16:9，输出 JPEG", async () => {
    const colors: Rgb[] = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255]];
    const frames = await Promise.all(colors.map((c) => frame(c)));
    const sheet = await composeSheet(
      frames.map((bytes, i) => ({ atMs: i * 2000, bytes })),
      { frameWidth: 480, gap: 6 },
    );
    assert.equal(sheet.frames, 5);
    assert.equal(sheet.width, 5 * 480 + 4 * 6);
    assert.equal(sheet.height, 270);
    assert.equal(sheet.contentType, "image/jpeg");
    const meta = await readRasterInfo(sheet.bytes);
    assert.equal(meta.format, "jpeg");
    assert.equal(meta.width, sheet.width);
    // 第 3 帧（蓝）落在它自己的格子里：取格子中心像素。
    const { data, width } = await rgbaPixels(sheet.bytes);
    const o = (100 * width + 2 * 486 + 240) * 4;
    assert.ok(data[o + 2] > 200 && data[o] < 60, `第 3 格应是蓝色，实际 rgb(${data[o]},${data[o + 1]},${data[o + 2]})`);
    // 帧间留白是底色（#101010）
    const g = (100 * width + 480 + 3) * 4;
    assert.ok(data[g] < 40 && data[g + 1] < 40 && data[g + 2] < 40, `留白应是深色底，实际 rgb(${data[g]},${data[g + 1]},${data[g + 2]})`);
  });

  it("竖拍帧按第一帧比例；单帧也能合成；空数组抛错", async () => {
    const portrait = await frame([0x88, 0x88, 0x88], 360, 640);
    const sheet = await composeSheet([{ atMs: 0, bytes: portrait }], { frameWidth: 240 });
    assert.equal(sheet.width, 240);
    assert.equal(sheet.height, Math.round(240 * (640 / 360)));
    await assert.rejects(() => composeSheet([], { frameWidth: 240 }), /至少要有一帧/);
  });
});

describe("groupFrames / splitPcm", () => {
  it("每 2 秒一帧、10 秒一组：23 秒 → 3 组（5/5/2 帧），超出 analyzedMs 的帧丢弃", () => {
    const frames = Array.from({ length: 12 }, (_, i) => Buffer.from([i]));
    const groups = groupFrames(frames, 2000, 10_000, 23_000);
    assert.deepEqual(
      groups.map((g) => [g.index, g.fromMs, g.toMs, g.frames.length]),
      [
        [0, 0, 10_000, 5],
        [1, 10_000, 20_000, 5],
        [2, 20_000, 23_000, 2],
      ],
    );
    assert.deepEqual(groups[2].frames.map((f) => f.atMs), [20_000, 22_000]);
  });

  it("PCM 按 10 秒窗切、尾段短于 minMs 丢弃、总长受 analyzedMs 封顶", () => {
    const bytesPerMs = 32;
    const pcm = Buffer.alloc(bytesPerMs * 25_400); // 25.4 s
    const segs = splitPcm(pcm, 60_000, 10_000, 800);
    assert.deepEqual(segs.map((s) => [s.fromMs, s.toMs]), [[0, 10_000], [10_000, 20_000], [20_000, 25_400]]);
    assert.equal(segs[0].pcm16k.length, bytesPerMs * 10_000);
    // 尾段 0.4 s → 丢
    const short = splitPcm(Buffer.alloc(bytesPerMs * 10_400), 60_000, 10_000, 800);
    assert.deepEqual(short.map((s) => [s.fromMs, s.toMs]), [[0, 10_000]]);
    // 封顶：75 s 的 PCM 只切前 60 s
    const capped = splitPcm(Buffer.alloc(bytesPerMs * 75_000), 60_000, 10_000, 800);
    assert.equal(capped.length, 6);
    assert.equal(capped[5].toMs, 60_000);
  });
});
