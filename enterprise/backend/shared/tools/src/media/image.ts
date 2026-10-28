/**
 * 照片 → 视觉模型能读的形态（ACR-027）。
 *
 * # 用途
 *
 * 相册里能选出来的格式，视觉模型不一定读得了：DeepSeek 视觉档只认 JPEG / PNG / GIF / WebP
 * （按内容判，不看 MIME），而 iPhone 默认拍的是 HEIC。不转码时整次请求返回 400。
 *
 * # 两个解码器，因为进程内不是什么都解得开
 *
 * 进程内解码经适配层 `raster.ts`（@napi-rs/image，ACR-069）：JPEG / PNG / WebP / AVIF / BMP / TIFF 都能解；
 * HEIC 只在 macOS / Windows 经系统解码器解，Linux（生产容器）上解不开；GIF 不解。
 * ffmpeg（视频链路已在用的宿主二进制）能解开 HEIC 与 GIF：`ffmpeg -i x.heic -frames:v 1` 输出 JPEG。
 *
 * 顺序：进程内优先（快、读得到尺寸与 EXIF），它解不开才落到 ffmpeg 转一次 JPEG。
 * 不为 HEIC 另引 libheif：多一个原生依赖，而现有 ffmpeg 已能完成。
 *
 * GIF 是模型读得了的格式，进程内只是解不开像素。它的宽高就在文件头（逻辑屏幕描述符），
 * 也没有 EXIF 方向，所以不超限就原样透传；超限才落 ffmpeg 转 JPEG 再缩（动图只留第一帧）。
 *
 * # 只在必须时才重编码
 *
 * 重编码耗时、掉画质、改变字节，而观察层对小图标的分辨率敏感，
 * 无谓降质会让它认灯变差。所以三个判据，命中一个才动：
 *
 *  1. 格式模型读不了（HEIC / HEIF / AVIF / BMP / TIFF）→ 转 JPEG；
 *  2. 单边超过 `maxSide` → 等比缩到上限（DeepSeek：一次 ≥15 张图时单边 ≤ 4096）；
 *  3. EXIF 里带旋转（手机竖拍常见 orientation 6/8）→ 摆正。不摆正时模型看到的是躺倒的仪表盘，
 *     它不会指出方向问题，只会答错。
 *
 * 三个都不命中就原样返回（`changed: false`，字节不变）。
 *
 * # 不抛异常
 *
 * 两个解码器都解不开就原样返回并写 note，与观察层 `unreadable`、视频派生的 notes 一致：
 * 一张图坏了不能让整轮对话失败。真读不了时由运行时的过滤把它挡在模型之外（`graph/media.ts`）。
 */

import { isModelReadableImage, normalizeMime } from "@cabinhug/shared";

import { extForContentType, ffmpegPathsFromEnv, run, withTempFile, type FfmpegPaths } from "./ffmpeg";
import { encodeUpright, readRasterInfo, type EncodeAs, type RasterInfo } from "./raster";

export interface NormalizeImageOptions {
  /**
   * 单边像素上限，缺省 4096。
   *
   * 取 4096 而不是更小：DeepSeek 自己会把图缩到约 800×800 等效像素；
   * 而观察层需要细节（小图标在下采样后会丢），所以这里只做防止超大图的封顶，
   * 不替模型做画质决策。
   */
  maxSide?: number;
  /** JPEG / WebP 质量，缺省 88。 */
  quality?: number;
  /** ffmpeg 路径（Linux 上的 HEIC、超限 GIF 这类进程内解不开的要用）。缺省读环境变量。 */
  ffmpeg?: FfmpegPaths;
}

export interface NormalizedImage {
  bytes: Buffer;
  /** 归一化后的 MIME（转码了就是 `image/jpeg`）。 */
  contentType: string;
  /** 字节有没有被改过。false = 原样透传。 */
  changed: boolean;
  /** 做了什么 / 为什么没做成。只在改过或失败时有，供日志与轨迹如实记账。 */
  note?: string;
  width?: number;
  height?: number;
}

/** EXIF orientation 1 = 正的；>1 都要摆正（`encodeUpright` 按 EXIF 摆正，产物不再带该标记）。 */
const needsAutoOrient = (orientation: number): boolean => orientation > 1;

/** 给 ffmpeg 一个匹配的扩展名：它按内容探测容器，扩展名只是辅助。 */
function extForImageType(contentType: string): string {
  const ct = normalizeMime(contentType);
  if (ct === "image/heic" || ct === "image/heif") return ".heic";
  if (ct === "image/avif") return ".avif";
  if (ct === "image/bmp") return ".bmp";
  if (ct === "image/tiff") return ".tiff";
  if (ct.startsWith("video/")) return extForContentType(ct);
  return ".img";
}

/** 进程内这条路的结果：要么给出成品，要么说清为什么走不通（好让调用方决定落不落 ffmpeg）。 */
type Attempt = { ok: true; result: NormalizedImage } | { ok: false; why: string };

const firstLine = (e: unknown): string => (e as Error).message.split("\n")[0];

/** GIF 文件头里的宽高（逻辑屏幕描述符：签名后两个小端 u16）；不是 GIF 返回 null。 */
function gifSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 10) return null;
  const signature = bytes.toString("ascii", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

/** 进程内解不开的 GIF：不超限原样透传（见文件头）；不是 GIF 或超限返回 null。 */
function passGifThrough(input: Buffer, maxSide: number): Attempt | null {
  const size = gifSize(input);
  if (!size || Math.max(size.width, size.height) > maxSide) return null;
  return { ok: true, result: { bytes: input, contentType: "image/gif", changed: false, ...size } };
}

/**
 * 进程内走一遍：读信息 → 判要不要动 → 动。
 *
 * 读得出信息不等于解得开像素（容器头认得、编码解不开的格式都有），
 * 所以判据是"整条流水线跑通了没有"，不是"元信息读到了没有"。
 */
async function tryInProcess(input: Buffer, declared: string, maxSide: number, quality: number): Promise<Attempt> {
  let info: RasterInfo;
  try {
    info = await readRasterInfo(input);
  } catch (e) {
    return passGifThrough(input, maxSide) ?? { ok: false, why: `读不出图片信息（${firstLine(e)}）` };
  }

  const { width, height } = info;
  // 以解码器认出来的格式为准；认不出时才信声明值。
  const actual = info.format ? normalizeMime(`image/${info.format}`) : declared;
  const wrongFormat = !isModelReadableImage(actual);
  const tooBig = Math.max(width, height) > maxSide;
  const sideways = needsAutoOrient(info.orientation);

  if (!wrongFormat && !tooBig && !sideways) {
    return { ok: true, result: { bytes: input, contentType: actual, changed: false, width, height } };
  }

  try {
    // 格式本来就没问题时保持原格式：为缩放 / 摆正而重编码时不换格式（PNG 截图转 JPEG 会糊掉字）。
    const keep = !wrongFormat && (actual === "image/png" || actual === "image/webp");
    const as: EncodeAs = keep && actual === "image/png" ? { format: "png" } : keep ? { format: "webp", quality } : { format: "jpeg", quality };
    // 摆正与缩放在同一遍：编码器不写 EXIF，分两遍会把方向丢掉
    const out = await encodeUpright(input, { maxSide }, as);
    const note = [
      wrongFormat ? `${actual || "未知格式"} 模型读不了，已转 JPEG` : null,
      tooBig ? `单边超过 ${maxSide}px，已缩到 ${out.width}×${out.height}` : null,
      sideways ? "按 EXIF 摆正了方向" : null,
    ]
      .filter(Boolean)
      .join("；");
    return { ok: true, result: { bytes: out.bytes, contentType: keep ? actual : "image/jpeg", changed: true, note, width: out.width, height: out.height } };
  } catch (e) {
    return { ok: false, why: `解不开像素（${firstLine(e)}）` };
  }
}

/** 进程内走不通时的兜底：ffmpeg 解一帧成 JPEG。解不开返回 null（不抛）。 */
async function decodeWithFfmpeg(bytes: Buffer, contentType: string, paths: FfmpegPaths): Promise<Buffer | null> {
  try {
    return await withTempFile(bytes, extForImageType(contentType), async (file) => {
      const { stdout } = await run(paths.ffmpeg, ["-v", "error", "-i", file, "-frames:v", "1", "-f", "mjpeg", "-q:v", "3", "pipe:1"], {
        timeoutMs: 30_000,
        maxStdoutBytes: 64 * 1024 * 1024,
      });
      return stdout.length > 0 ? stdout : null;
    });
  } catch {
    return null;
  }
}

export async function normalizeImageForModel(
  input: Buffer,
  contentType: string,
  opts: NormalizeImageOptions = {},
): Promise<NormalizedImage> {
  const maxSide = opts.maxSide ?? 4096;
  const quality = opts.quality ?? 88;
  const declared = normalizeMime(contentType);

  const first = await tryInProcess(input, declared, maxSide, quality);
  if (first.ok) return first.result;

  // 进程内走不通（Linux 上的 HEIC、超限 GIF 这类）→ ffmpeg 转一帧 JPEG，再把缩放 / 摆正补上
  const decoded = await decodeWithFfmpeg(input, declared, opts.ffmpeg ?? ffmpegPathsFromEnv());
  if (!decoded) {
    return { bytes: input, contentType: declared, changed: false, note: `这张图的格式解不开（${declared || "未知格式"}：${first.why}），本次未转码` };
  }
  const converted = `${declared || "原格式"} 进程内解不开，已用 ffmpeg 转成 JPEG`;
  const second = await tryInProcess(decoded, "image/jpeg", maxSide, quality);
  if (!second.ok) {
    // 转出来的 JPEG 本身已经比原件可用，后续处理失败也照样交出去。
    return { bytes: decoded, contentType: "image/jpeg", changed: true, note: `${converted}（后续处理失败：${second.why}）` };
  }
  return {
    ...second.result,
    bytes: second.result.bytes,
    contentType: "image/jpeg",
    changed: true,
    note: [converted, second.result.note].filter(Boolean).join("；"),
  };
}
