/**
 * 图像库适配层（ACR-069）：本包只经这里碰图像库。
 *
 * 底层是 @napi-rs/image（Rust image-rs + resvg，MIT）。换库只改本文件，
 * 照片归一化（`image.ts`）、帧序图（`sheet.ts`）、观察层（`vision/observe.ts`）不感知。
 *
 * # 一次只做一件跟顺序有关的事
 *
 * @napi-rs/image 的 `Transformer` 不按调用顺序执行：实测先 crop 后 resize 与先 resize 后 crop
 * 出同一张图，库内部有自己的固定顺序。所以裁切、缩放、叠加各自一遍编解码，
 * 只有"摆正 + 方框内等比缩"放在一遍里——方框是正方形，先转还是先缩结果相同。
 *
 * # 底层库的几处行为与直觉不同，都在这里抹平
 *
 *  - EXIF Orientation 只有 `metadata(true)` 才读，缺省读不到；
 *  - `ResizeFit.Inside` 会放大小图，"只缩不放"要自己判；
 *  - `fromSvg` 会把小尺寸 SVG 放大若干倍再光栅化（80×30 出 1280×480），要缩回声明尺寸；
 *  - `rawPixels` 按源图的颜色类型给字节（灰度 1 通道、RGB 3 通道、16 bit 两字节），
 *    这里统一成 RGBA8；
 *  - 编码器不写 EXIF：任何一次重编码都会丢掉 Orientation，所以要摆正就必须同一遍摆正。
 *
 * # 格式覆盖
 *
 * 进程内能解 JPEG / PNG / WebP / AVIF / BMP / TIFF（不含 JPEG 压缩的 TIFF），
 * HEIC 只在 macOS / Windows 经系统解码器解；GIF 不解（发布构建未启用）。
 * 解不开时抛错，由调用方决定落不落 ffmpeg。
 */

import { endianness } from "node:os";

import { JsColorType, ResizeFilterType, ResizeFit, Transformer } from "@napi-rs/image";

export interface RasterInfo {
  width: number;
  height: number;
  /** 解码器认出的格式，小写：`jpeg` / `png` / `webp` / `avif` / `heic` / `bmp` / `tiff` …… */
  format: string;
  /** EXIF Orientation；没有标签时为 1。 */
  orientation: number;
}

/** 编码目标。质量 0–100。 */
export type EncodeAs = { format: "jpeg"; quality: number } | { format: "webp"; quality: number } | { format: "png" };

export interface Encoded {
  bytes: Buffer;
  width: number;
  height: number;
}

export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 一层叠加：已编码的图（PNG 可带透明）放在底图的 (left, top)。 */
export interface Layer {
  bytes: Uint8Array;
  left: number;
  top: number;
}

/** 纯色底图，RGB 各 0–255。 */
export interface SolidCanvas {
  width: number;
  height: number;
  background: readonly [number, number, number];
}

/** 读宽高、格式与 EXIF 方向。解不开抛错。 */
export async function readRasterInfo(bytes: Uint8Array): Promise<RasterInfo> {
  const meta = await new Transformer(bytes).metadata(true);
  return { width: meta.width, height: meta.height, format: meta.format.toLowerCase(), orientation: meta.orientation ?? 1 };
}

/** "按原格式编码"时的取法：JPEG / WebP 沿用，其它一律无损 PNG。 */
export function sameFormatAs(format: string, quality: number): EncodeAs {
  if (format === "jpeg") return { format: "jpeg", quality };
  if (format === "webp") return { format: "webp", quality };
  return { format: "png" };
}

async function encode(t: Transformer, as: EncodeAs): Promise<Encoded> {
  const bytes = as.format === "jpeg" ? await t.jpeg(as.quality) : as.format === "webp" ? await t.webp(as.quality) : await t.png();
  // 编码后的尺寸以产物为准：缩放的取整由底层决定
  const meta = await new Transformer(bytes).metadata();
  return { bytes, width: meta.width, height: meta.height };
}

/**
 * 按 EXIF 摆正，并在任一边超过 `maxSide` 时等比缩进 maxSide×maxSide 的方框（只缩不放）。
 * 产物不带 EXIF。
 */
export async function encodeUpright(bytes: Uint8Array, opts: { maxSide?: number }, as: EncodeAs): Promise<Encoded> {
  const info = await readRasterInfo(bytes);
  const t = new Transformer(bytes).rotate();
  const { maxSide } = opts;
  if (maxSide !== undefined && Math.max(info.width, info.height) > maxSide) {
    t.resize(maxSide, maxSide, ResizeFilterType.Lanczos3, ResizeFit.Inside);
  }
  return encode(t, as);
}

/**
 * 缩放到 width×height：`cover` 等比放满后居中裁掉多余部分，`fill` 不保比例直接拉伸。
 * 用 Lanczos3：观察层放大小图标时边缘要锐。
 */
export async function resizeTo(bytes: Uint8Array, size: { width: number; height: number; fit: "cover" | "fill" }, as: EncodeAs): Promise<Encoded> {
  const fit = size.fit === "cover" ? ResizeFit.Cover : ResizeFit.Fill;
  return encode(new Transformer(bytes).resize(size.width, size.height, ResizeFilterType.Lanczos3, fit), as);
}

/** 按像素矩形裁下一块。矩形须落在图内（调用方先贴边，见 `cropRegion`）。 */
export async function cropTo(bytes: Uint8Array, rect: PixelRect, as: EncodeAs): Promise<Encoded> {
  return encode(new Transformer(bytes).crop(rect.left, rect.top, rect.width, rect.height), as);
}

/**
 * SVG 光栅化成 width×height 的 PNG（透明底）。文字用系统字体：宿主没有字体时文字不出现，
 * 其余图形照画。
 */
export async function rasterizeSvg(svg: string, width: number, height: number): Promise<Buffer> {
  // fromSvg 会把小 SVG 放大若干倍再光栅化，这里缩回声明尺寸
  const t = Transformer.fromSvg(svg).resize(width, height, ResizeFilterType.Lanczos3, ResizeFit.Fill);
  return t.png();
}

function solidRgba(canvas: SolidCanvas): Buffer {
  const [r, g, b] = canvas.background;
  const px = Buffer.alloc(canvas.width * canvas.height * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  }
  return px;
}

/** 在底图（已编码的图或纯色底）上按顺序叠加各层（source-over），再编码。 */
export async function compositeLayers(base: Uint8Array | SolidCanvas, layers: readonly Layer[], as: EncodeAs): Promise<Encoded> {
  const t = base instanceof Uint8Array ? new Transformer(base) : Transformer.fromRgbaPixels(solidRgba(base), base.width, base.height);
  for (const layer of layers) t.overlay(layer.bytes, layer.left, layer.top);
  return encode(t, as);
}

/** 每像素的通道数与每通道字节数；浮点类型不支持（照片与截图不会是浮点）。 */
function layoutOf(colorType: JsColorType): { channels: 1 | 2 | 3 | 4; bytesPerChannel: 1 | 2 } {
  switch (colorType) {
    case JsColorType.L8: return { channels: 1, bytesPerChannel: 1 };
    case JsColorType.La8: return { channels: 2, bytesPerChannel: 1 };
    case JsColorType.Rgb8: return { channels: 3, bytesPerChannel: 1 };
    case JsColorType.Rgba8: return { channels: 4, bytesPerChannel: 1 };
    case JsColorType.L16: return { channels: 1, bytesPerChannel: 2 };
    case JsColorType.La16: return { channels: 2, bytesPerChannel: 2 };
    case JsColorType.Rgb16: return { channels: 3, bytesPerChannel: 2 };
    case JsColorType.Rgba16: return { channels: 4, bytesPerChannel: 2 };
    default: throw new Error(`不支持的像素类型（JsColorType=${colorType}）：浮点图不在照片与截图的范围内`);
  }
}

/** 解码成 RGBA8 像素（行优先、无填充）。灰度展开成三通道，16 bit 取高位字节，没有 alpha 的补 255。 */
export async function rgbaPixels(bytes: Uint8Array): Promise<{ data: Buffer; width: number; height: number }> {
  const meta = await new Transformer(bytes).metadata();
  const raw = await new Transformer(bytes).rawPixels();
  const { channels, bytesPerChannel } = layoutOf(meta.colorType);
  // 16 bit 是本机字节序：小端时高位字节在后
  const high = bytesPerChannel === 2 && endianness() === "LE" ? 1 : 0;
  const at = (pixel: number, channel: number): number => raw[(pixel * channels + channel) * bytesPerChannel + high];
  const count = meta.width * meta.height;
  const data = Buffer.alloc(count * 4);
  for (let p = 0; p < count; p += 1) {
    const gray = channels <= 2;
    data[p * 4] = at(p, 0);
    data[p * 4 + 1] = at(p, gray ? 0 : 1);
    data[p * 4 + 2] = at(p, gray ? 0 : 2);
    data[p * 4 + 3] = channels === 2 ? at(p, 1) : channels === 4 ? at(p, 3) : 255;
  }
  return { data, width: meta.width, height: meta.height };
}
