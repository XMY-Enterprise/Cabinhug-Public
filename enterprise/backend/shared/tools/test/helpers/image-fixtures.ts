/**
 * 测试用图像夹具（ACR-069）：纯色 / 色块图按格式编码、给 JPEG 写 EXIF Orientation、手写 GIF 与 BMP。
 *
 * 像素直接按 RGBA 填，不经 SVG 光栅化：色块边缘没有抗锯齿，定色与裁切断言可以写死。
 * GIF 与 BMP 手写字节：前者是图像库不解的格式（覆盖文件头兜底与 ffmpeg 分支），
 * 后者用来断言进程内能解。
 */

import { Transformer } from "@napi-rs/image";

export type Rgb = readonly [number, number, number];

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  color: Rgb;
}

export type FixtureFormat = "png" | "jpeg" | "webp" | "tiff" | "avif" | "bmp";

/** 纯色底上画若干实心矩形，返回 RGBA 像素。 */
export function rectsRgba(width: number, height: number, background: Rgb, rects: readonly Rect[] = []): Buffer {
  const px = Buffer.alloc(width * height * 4);
  const paint = (x: number, y: number, [r, g, b]: Rgb): void => {
    const o = (y * width + x) * 4;
    px[o] = r;
    px[o + 1] = g;
    px[o + 2] = b;
    px[o + 3] = 255;
  };
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) paint(x, y, background);
  for (const r of rects) {
    for (let y = r.y; y < r.y + r.height; y += 1) for (let x = r.x; x < r.x + r.width; x += 1) paint(x, y, r.color);
  }
  return px;
}

/** 按格式编码一张色块图。 */
export async function rectsImage(width: number, height: number, background: Rgb, rects: readonly Rect[], format: FixtureFormat): Promise<Buffer> {
  const t = Transformer.fromRgbaPixels(rectsRgba(width, height, background, rects), width, height);
  switch (format) {
    case "png": return t.png();
    case "jpeg": return t.jpeg(92);
    case "webp": return t.webp(92);
    case "tiff": return t.tiff();
    case "avif": return t.avif();
    case "bmp": return t.bmp();
  }
}

/** 纯色图。 */
export function solidImage(width: number, height: number, color: Rgb, format: FixtureFormat): Promise<Buffer> {
  return rectsImage(width, height, color, [], format);
}

/**
 * 在 JPEG 的 SOI 之后插入一段只含 Orientation 的 EXIF（APP1）——手机竖拍的样子。
 * 结构：`Exif\0\0` + 大端 TIFF 头 + 一个只有 0x0112（SHORT）一项的 IFD0。
 */
export function withExifOrientation(jpeg: Buffer, orientation: number): Buffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error("withExifOrientation：不是 JPEG（缺 SOI）");
  const tiff = Buffer.alloc(26);
  tiff.write("MM", 0, "ascii");
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4); // IFD0 紧跟 TIFF 头
  tiff.writeUInt16BE(1, 8); // 一项
  tiff.writeUInt16BE(0x0112, 10); // Orientation
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(orientation, 18); // 值左对齐占 4 字节中的前 2 字节
  tiff.writeUInt32BE(0, 22); // 没有下一个 IFD
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(payload.length + 2, 2); // 段长含自身两字节
  return Buffer.concat([jpeg.subarray(0, 2), app1, payload, jpeg.subarray(2)]);
}

/**
 * 手写单色 GIF89a。LZW 最小码长取 7，码宽恒为 8 位、一码一字节：
 * 每 100 个像素前发一次 CLEAR，字典长不到需要加宽的地步，不用实现压缩。
 */
export function solidGif(width: number, height: number, [r, g, b]: Rgb): Buffer {
  const CLEAR = 128;
  const END = 129;
  const RUN = 100;
  const head = Buffer.alloc(13);
  head.write("GIF89a", 0, "ascii");
  head.writeUInt16LE(width, 6);
  head.writeUInt16LE(height, 8);
  head[10] = 0xe6; // 有全局色表、128 色
  const palette = Buffer.alloc(128 * 3);
  palette[0] = r;
  palette[1] = g;
  palette[2] = b;
  const descriptor = Buffer.alloc(10);
  descriptor[0] = 0x2c;
  descriptor.writeUInt16LE(width, 5);
  descriptor.writeUInt16LE(height, 7);
  const codes: number[] = [];
  for (let left = width * height; left > 0; left -= RUN) codes.push(CLEAR, ...new Array<number>(Math.min(RUN, left)).fill(0));
  codes.push(END);
  const blocks: Buffer[] = [];
  for (let i = 0; i < codes.length; i += 255) {
    const chunk = codes.slice(i, i + 255);
    blocks.push(Buffer.from([chunk.length, ...chunk]));
  }
  return Buffer.concat([head, palette, descriptor, Buffer.from([7]), ...blocks, Buffer.from([0x00, 0x3b])]);
}

/** 手写 24bpp BMP（自下而上存行、行按 4 字节对齐）。 */
export function solidBmp(width: number, height: number, [r, g, b]: Rgb): Buffer {
  const row = Math.ceil((width * 3) / 4) * 4;
  const off = 54;
  const out = Buffer.alloc(off + row * height);
  out.write("BM", 0, "ascii");
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(off, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(row * height, 34);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = off + y * row + x * 3;
      out[o] = b;
      out[o + 1] = g;
      out[o + 2] = r;
    }
  }
  return out;
}
