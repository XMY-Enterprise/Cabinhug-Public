/**
 * 照片 → 受控观察（ACR-024）。
 *
 * # 两遍
 *
 * 第一遍整图检测（便宜档，定位准）；第二遍把每个 bbox 外扩 50% 裁下来、单独喂给描述档。
 * 小图标在整图里被下采样，形状与点亮状态容易误读；裁下来占满画面，细节才保得住。
 *
 * # 颜色由代码算
 *
 * `color` 取像素主色相（`color.ts`），模型的颜色只作交叉核对；不一致标 `undeterminable: color`。
 *
 * # 绝不抛到上层
 *
 * 检测失败 → `frame.unreadable = true` 的空观察；某个 crop 描述失败 → 该项用检测结果
 * 兜底成 unknown 描述子并记 note。一张图坏了不能让整轮对话失败（与 `runDualPath` 单路失败同一纪律）。
 *
 * # 先按 EXIF 转正，检测与裁剪才在同一个坐标系里
 *
 * 手机竖拍的 JPEG 存的是横躺的像素 + 一枚 Orientation 标签。端侧检测器（ultralytics）按标签转正后出框，
 * 而裁切不看标签、按存储像素裁，两边相差 90°，裁下来的是屏幕上不相干的一块（Orientation=6 的实拍上，
 * 未转正时 0/6、转正后 6/6）。所以进来先 `uprightByExif`，之后所有坐标都指转正后的图。
 */

import { compositeLayers, cropTo, encodeUpright, rasterizeSvg, readRasterInfo, resizeTo, rgbaPixels, sameFormatAs } from "../media/raster";
import { dominantColor } from "./color";
import { violatesForbidden } from "./forbidden";
import type { VisionProvider } from "./provider";
import { PhotoObservationSchema, clientDetectionsToResult, type BBox, type ClientDetections, type Descriptor, type DetectResult, type ObservedItem, type PhotoObservation } from "./schema";
import { mergeAdjacentSameClass } from "./merge-boxes";

export interface ObserveOptions {
  /** crop 外扩比例（相对框的宽高），缺省 0.5。 */
  padding?: number;
  /** 第二遍并发上限，缺省 4。 */
  concurrency?: number;
  /** 最多描述多少项（防一张图报出上百个），缺省 24。 */
  maxItems?: number;
  /**
   * 送给描述档之前把 crop 放大到短边至少这么多像素，缺省 320。
   * 小尺寸 crop 会被模型自己粗暴放大，形状与点亮状态容易误读。0 = 不放大。
   */
  minCropSide?: number;
  /**
   * 第二遍（逐 crop 重描）跑不跑：
   * - `always`（缺省，ACR-024 批准的形态）：每一项都重描；
   * - `when-uncertain`：第一遍置信 < 0.8、或标了 undeterminable、或描述子字段缺失的项才重描；
   * - `never`：只用第一遍的描述子（整图一遍）。
   * 三档并存，缺省值由 ≥30 张上的评测决定。
   */
  describePass?: "always" | "when-uncertain" | "never";
}

export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 转正后重编码 JPEG / WebP 的质量：与换库（ACR-069）前 sharp 的缺省质量一致。 */
const UPRIGHT_QUALITY = 80;

/**
 * 按 EXIF Orientation 把像素转正并去掉标签；没有标签（或 =1）时原样返回，不多一次编解码。
 * 之后本包的裁切与任何看 EXIF 的读图库（ultralytics / PIL.ImageOps.exif_transpose / 云端视觉模型）看到的是同一帧。
 */
export async function uprightByExif(image: Buffer): Promise<Buffer> {
  const info = await readRasterInfo(image);
  if (info.orientation === 1) return image;
  // 按 EXIF 转正，产物不带 Orientation；JPEG / WebP 沿用原格式，其它落无损 PNG
  return (await encodeUpright(image, {}, sameFormatAs(info.format, UPRIGHT_QUALITY))).bytes;
}

/** 0–1000 归一化框 → 像素矩形，外扩后贴边裁剪，至少 1×1。 */
export function cropRegion(bbox: BBox, width: number, height: number, padding = 0.5): PixelRect {
  const [x1, y1, x2, y2] = bbox;
  const bw = ((x2 - x1) / 1000) * width;
  const bh = ((y2 - y1) / 1000) * height;
  const left = Math.max(0, Math.floor((x1 / 1000) * width - bw * padding));
  const top = Math.max(0, Math.floor((y1 / 1000) * height - bh * padding));
  const right = Math.min(width, Math.ceil((x2 / 1000) * width + bw * padding));
  const bottom = Math.min(height, Math.ceil((y2 / 1000) * height + bh * padding));
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

async function mapConcurrent<T, R>(xs: readonly T[], limit: number, f: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, xs.length) }, async () => {
    while (next < xs.length) {
      const i = next;
      next += 1;
      out[i] = await f(xs[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const unknownDescriptor = (category: Descriptor["category"]): Descriptor => ({
  category,
  shape: "other",
  color: "unknown",
  state: "unknown",
  text: [],
  elements: [],
  literal: "",
  confidence: 0,
  quality: { blur: false, glare: false, partial: false },
  undeterminable: ["shape", "color", "state", "elements_detail"],
});

const dedupe = <T,>(xs: T[]): T[] => [...new Set(xs)];

const stripUndefined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export async function observePhoto(image: Buffer, provider: VisionProvider, opts: ObserveOptions = {}): Promise<PhotoObservation> {
  const padding = opts.padding ?? 0.5;
  const concurrency = opts.concurrency ?? 4;
  const maxItems = opts.maxItems ?? 24;
  const minCropSide = opts.minCropSide ?? 320;
  const describePass = opts.describePass ?? "always";
  const t0 = Date.now();
  const notes: string[] = [];

  const unreadable = (why: string): PhotoObservation =>
    PhotoObservationSchema.parse({
      frame: { quality: {}, cut_off_sides: [], cutOffSource: "none", item_count: 0, unreadable: true },
      items: [],
      model: provider.models,
      timings: { detectMs: Date.now() - t0, describeMs: 0, totalMs: Date.now() - t0 },
      notes: [why],
    });

  let width = 0;
  let height = 0;
  try {
    // 不是图片（或坏文件）也走 unreadable，不抛——与检测失败同一条纪律。
    image = await uprightByExif(image);
    ({ width, height } = await readRasterInfo(image));
  } catch (e) {
    return unreadable(`不是可解码的图片：${(e as Error).message}`);
  }

  /*
   * 第一遍抛错或零框 → 换一家再定位一次（`provider.detectFallback`）。
   *
   * 零框：同一块屏的全景照稳出框（置信 0.82~0.94），裁得很紧的近景照上置信整体降到
   * 0.21~0.30，落在 conf 0.3 闸门之下。放大 2x/3x 仍是零框：缺的是训练集的尺度分布，
   * 这一层修不了，只能换一家定位。
   *
   * 抛错（ACR-050）：检测服务连不上与零框对车主等价，都不代表照片里什么都没有，
   * 同样交给兜底定位；否则一条配置问题会让每张不带框的照片整图降级。
   *
   * 失败只记 note。只有两家都失败（或根本没装兜底）才是 `unreadable`；
   * 第一遍成功但零框时兜底再失败，结果仍是零框。
   */
  let detect: DetectResult | undefined;
  let detectError: Error | undefined;
  try {
    detect = await provider.detect(image);
  } catch (e) {
    detectError = e as Error;
    if (!provider.detectFallback) return unreadable(`检测失败：${detectError.message}`);
  }
  if ((!detect || detect.items.length === 0) && provider.detectFallback) {
    try {
      const again = await provider.detectFallback(image);
      if (detectError) {
        notes.push(`第一遍（${provider.models.detect}）失败：${detectError.message}；改用兜底定位，出 ${again.items.length} 项`);
        detect = again;
      } else if (again.items.length > 0) {
        notes.push(`第一遍（${provider.models.detect}）零框，改用兜底定位，出 ${again.items.length} 项`);
        detect = again;
      } else {
        notes.push("第一遍与兜底定位都没框到符号");
      }
    } catch (e) {
      if (detectError) return unreadable(`检测失败：${detectError.message}；兜底定位也失败：${(e as Error).message}`);
      notes.push(`兜底定位失败：${(e as Error).message}`);
    }
  }
  // 走到这里 detect 必有值：抛错且没兜底、抛错且兜底也失败，上面都已经 return 了
  if (!detect) return unreadable(`检测失败：${detectError?.message ?? "未知"}`);
  const detectMs = Date.now() - t0;
  // 模型自检（数出来的项数 = 列出来的项数）在合并之前核对：它核的是模型自己的输出，合并会改变项数。
  if (detect.frame.item_count !== detect.items.length) {
    notes.push(`item_count=${detect.frame.item_count} 与 items 长度 ${detect.items.length} 不一致（模型自检没过）`);
  }
  // 同一符号被检测器劈成两半的先合回去（`merge-boxes.ts` 文件头），再进第二遍描述。
  detect = { ...detect, items: mergeAdjacentSameClass(detect.items, notes) };
  const detected = detect.items.slice(0, maxItems);
  if (detect.items.length > maxItems) notes.push(`检测出 ${detect.items.length} 项，只描述前 ${maxItems} 项`);

  const t1 = Date.now();
  const items = await mapConcurrent(detected, concurrency, async (it): Promise<ObservedItem> => {
    const region = cropRegion(it.bbox, width, height, padding);
    const crop = (await cropTo(image, region, { format: "png" })).bytes;
    // 定色用原尺寸 crop（放大不改变色相分布，但会稀释计数阈值的含义）
    const rgba = await rgbaPixels(crop);
    const px = dominantColor(rgba.data, rgba.width, rgba.height, 4);
    const short = Math.min(region.width, region.height);
    const scale = minCropSide > 0 && short < minCropSide ? minCropSide / short : 1;
    const enlarged = { width: Math.round(region.width * scale), height: Math.round(region.height * scale), fit: "fill" } as const;
    const forModel = scale > 1 ? (await resizeTo(crop, enlarged, { format: "png" })).bytes : crop;

    // 第一遍给出的描述子（可能不全）：补齐缺省后作为基线
    const { bbox: _bbox, confidence: firstConfidence, ...firstPartial } = it;
    const first: Descriptor = { ...unknownDescriptor(it.category), undeterminable: [], ...stripUndefined(firstPartial), confidence: firstConfidence };
    const firstComplete = it.shape !== undefined && it.color !== undefined && it.state !== undefined && it.elements !== undefined;
    const uncertain = !firstComplete || firstConfidence < 0.8 || (it.undeterminable?.length ?? 0) > 0;
    const needDescribe = describePass === "always" || (describePass === "when-uncertain" && uncertain);

    let desc: Descriptor = first;
    if (needDescribe) {
      try {
        desc = await provider.describe(forModel, { bbox: it.bbox, category: it.category });
      } catch (e) {
        desc = firstComplete ? first : unknownDescriptor(it.category);
        notes.push(`bbox [${it.bbox}] 描述失败，${firstComplete ? "沿用第一遍描述子" : "按未知描述子兜底"}：${(e as Error).message}`);
      }
    } else if (!firstComplete) {
      notes.push(`bbox [${it.bbox}] 第一遍描述子不全且未重描（describePass=${describePass}），缺项按 unknown`);
    }

    /*
     * 类别以检测器为准：第一遍看的是整张屏幕，第二遍只看一块放大的 crop，
     * 可能把符号误读成文字，下游会因此跳过目录匹配。
     *
     * 类别不一致时形状类字段（shape / text / elements / literal）也不用第二遍的，
     * 它们描述的是那次误读而非符号本身。回落到第一遍整图的描述子；第一遍没给
     * （端上框只有类别和框）就按未知并标 undeterminable，让下游只靠 crop 的图像路匹配。
     * 颜色与点亮状态仍用第二遍的：这两项不受类别误读影响，且颜色最终由像素定。
     */
    if (desc.category !== it.category) {
      const fallback = firstComplete ? first : unknownDescriptor(it.category);
      notes.push(`bbox [${it.bbox}] 第二遍把类别写成 ${desc.category}，以第一遍的 ${it.category} 为准；形状与文字${firstComplete ? "回落到第一遍整图的描述子" : "按未知，只靠图像路匹配"}`);
      desc = {
        ...desc,
        shape: fallback.shape,
        text: fallback.text,
        elements: fallback.elements,
        literal: fallback.literal,
        undeterminable: firstComplete ? desc.undeterminable : dedupe([...desc.undeterminable, "shape", "text", "elements_detail"] as Descriptor["undeterminable"]),
      };
    }

    let literal = desc.literal;
    let undeterminable = [...desc.undeterminable];
    if (violatesForbidden(literal)) {
      notes.push(`bbox [${it.bbox}] literal 含结论词，已置空：「${literal}」`);
      literal = "";
      undeterminable.push("elements_detail");
    }
    const colorByModel = desc.color;
    const colorByPixels = px.color;
    const colorAgreement = colorByModel === "unknown" || colorByPixels === "unknown" ? "unknown" : colorByModel === colorByPixels ? "agree" : "disagree";
    if (colorAgreement === "disagree") undeterminable.push("color");
    undeterminable = dedupe(undeterminable);

    return {
      ...desc,
      category: it.category,
      ...(it.symbolHint ? { symbolHint: it.symbolHint } : {}),
      literal,
      undeterminable,
      bbox: it.bbox,
      color: colorByPixels === "unknown" ? colorByModel : colorByPixels,
      colorByModel,
      colorByPixels,
      colorAgreement,
    };
  });
  const describeMs = Date.now() - t1;

  return PhotoObservationSchema.parse({
    frame: {
      quality: detect.frame.quality,
      cut_off_sides: detect.frame.cut_off_sides,
      cutOffSource: "model",
      item_count: detect.items.length,
      unreadable: false,
    },
    items,
    model: provider.models,
    timings: { detectMs, describeMs, totalMs: Date.now() - t0 },
    notes,
  });
}

/** 按归一化框裁下一块（外扩 padding），PNG 缓冲——评测 --match 与成对核验用。 */
export async function extractCrop(image: Buffer, bbox: BBox, padding = 0.5): Promise<Buffer> {
  image = await uprightByExif(image);
  const { width, height } = await readRasterInfo(image);
  const region = cropRegion(bbox, width, height, padding);
  return (await cropTo(image, region, { format: "png" })).bytes;
}

/**
 * 把 0–1000 归一化框画回原图（评测抽查与 trace 附图用）。SVG 经适配层（`media/raster.ts`）
 * 光栅化后叠加，不引入第二个图像库；框的标签文字用宿主的系统字体。
 */
export async function renderBoxes(image: Buffer, boxes: ReadonlyArray<{ bbox: BBox; label?: string }>): Promise<Buffer> {
  image = await uprightByExif(image);
  const { width: W, height: H } = await readRasterInfo(image);
  const rects = boxes
    .map(({ bbox: [x1, y1, x2, y2], label }, i) => {
      const l = (x1 / 1000) * W;
      const t = (y1 / 1000) * H;
      const w = ((x2 - x1) / 1000) * W;
      const h = ((y2 - y1) / 1000) * H;
      const text = (label ?? String(i)).replace(/[<>&]/g, "");
      return `<rect x="${l}" y="${t}" width="${w}" height="${h}" fill="none" stroke="#ff00ff" stroke-width="4"/>` +
        `<text x="${l}" y="${Math.max(12, t - 6)}" font-size="16" fill="#ff00ff" font-family="sans-serif">${text}</text>`;
    })
    .join("");
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${rects}</svg>`;
  const overlay = await rasterizeSvg(svg, W, H);
  return (await compositeLayers(image, [{ bytes: overlay, left: 0, top: 0 }], { format: "png" })).bytes;
}

/**
 * 端上已经框好了（ACR-045）：把 provider 的第一遍换成「直接用端上的框」，第二遍（描述）、成对核验、读警报页照旧。
 * 端上有框时不向任何检测器要框，服务端检测器与云端定位的可用性都不影响；`models.detect` 记 `client`，
 * trace 里能看出这一轮的框从哪来。
 *
 * 端上零框时才往下问（`detectFallback`）：端侧与服务端跑的是同一族权重，同一张近景照上会同样漏检
 * （见 `observePhoto` 里的兜底说明）。
 */
export function withClientDetections(provider: VisionProvider, det: ClientDetections): VisionProvider {
  const result = clientDetectionsToResult(det);
  return {
    name: `client+${provider.name}`,
    models: { detect: "client", describe: provider.models.describe },
    detect: async () => result,
    // 端上零框时的那一级一级往下问：服务端检测器 → 它自己的兜底（云端定位）。
    detectFallback: async (image: Buffer) => {
      // 服务端检测器连不上与它零框同样处理（ACR-050）：有下一级就往下问，没有才把错误交回去
      let server: DetectResult;
      try {
        server = await provider.detect(image);
      } catch (e) {
        if (!provider.detectFallback) throw e;
        return provider.detectFallback(image);
      }
      if (server.items.length > 0 || !provider.detectFallback) return server;
      return provider.detectFallback(image);
    },
    describe: (crop, ctx) => provider.describe(crop, ctx),
    verifyPair: (a, b) => provider.verifyPair(a, b),
    ...(provider.readAlerts ? { readAlerts: (image: Buffer) => provider.readAlerts!(image) } : {}),
  };
}
