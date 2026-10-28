/**
 * `pretrip_items` —— 按这次行程的天气推「出门带什么」。
 *
 * # 数据来源
 *
 * 车机提示卡的物品清单由本工具按真实天气（`weather.ts`）生成，
 * 不再使用端上与行程无关的固定数组。
 *
 * # 规则是纯函数，工具只负责取数
 *
 * `recommendPretripItems()` 不碰网络：给它一个整程天气极值视图，它给出物品与理由。
 * 这样"为什么推了雨伞"能被单测覆盖，而不是埋在一次 HTTP 调用后面。
 *
 * # 三条诚实约定（与 weather.ts 同源）
 *
 * 1. 取不到天气就说取不到：返回基础三件 + `weatherAvailable: false` + `basis: "fallback"`，
 *    调用方据此不说「根据天气」。凭空推荐看起来像查过。
 * 2. 只读预报，不读实况（`observed`）：行前提示针对未来某天，
 *    不把今天的实况套到出发那天。
 * 3. 截断要说出来：超过 6 件时截断，并在 `dropped` 里列出被砍掉的，不静默丢。
 *
 * # 按整程极值判定，而不是逐天取并集
 *
 * 逐天并集在 4 天行程上能凑齐全部 8 件，失去"出门前带什么"的意义。
 * 极值判定的语义是"这一程里最需要防的那一天"，与这张卡的场景一致。
 */

import {
  isWeatherProvider,
  PRETRIP_ITEMS,
  WEATHER_LABELS,
  type PretripItemKey,
  type WeatherKind,
  type WeatherSource,
} from "@cabinhug/shared";

import { defineExternalTool, ToolError, type ExternalTool } from "./external";
import { WEATHER_SOURCES, weatherTool, type WeatherSegment } from "./weather";

export interface PretripItemsArgs {
  /** 沿途/目的地取样点。空数组 = 没有坐标可用，直接走 fallback，不调天气。 */
  points: Array<{ name: string; lat: number; lon: number }>;
  /** 出发日（YYYY-MM-DD）；缺省取今天。 */
  date?: string;
}

/** 整程天气极值视图——规则的唯一输入。 */
export interface PretripWeatherView {
  maxTempC?: number;
  minTempC?: number;
  /** 逐段的中文天气现象合并，如 ["晴", "雷阵雨"]。 */
  phenomena: string[];
  /** 整程单日最大预报降水（mm）。 */
  precipitationMm?: number;
  snowfallCm?: number;
  uvIndexMax?: number;
}

export interface PretripItemPick {
  key: PretripItemKey;
  /** 为什么推它：进轨迹与排障，不上卡（卡上只有物品名）。 */
  reason: string;
}

export interface PretripItemsData {
  items: PretripItemPick[];
  /** false = 这次没拿到天气，`items` 是与季节无关的兜底，调用方不许说「根据天气」。 */
  weatherAvailable: boolean;
  basis: "weather" | "fallback";
  /** 因为限量被砍掉的（按优先级靠后）。空数组表示没砍。 */
  dropped: PretripItemPick[];
  /** 一句话天气摘要，供播报与排障；取不到时是空字符串。 */
  weatherSummary: string;
  /**
   * 这一程算什么天气，提示卡左上角的图标用它。
   *
   * 与 `items` 出自同一份 `phenomena`，保证图标与物品不矛盾。
   * 取不到天气时是 `sunny`（与图标的兜底一致）。
   */
  weatherKind: WeatherKind;
  weatherLabel: string;
  /**
   * 天气来自谁（ACR-052），端上据此署名。只在真拿到天气时带：fallback 与 mock 没有来源可署。
   */
  weatherSource?: WeatherSource;
}

/** 每页 3 件 × 2 页；更长的清单在卡上翻不完。 */
export const MAX_PRETRIP_ITEMS = 6;

/**
 * 优先级：没带会难受的排前面。
 * 挡雨与补水在前，墨镜口罩这类非必需的在后，截断从后面砍。
 */
const PRIORITY: readonly PretripItemKey[] = [
  "umbrella",
  "water",
  "hat",
  "sunscreen",
  "jacket",
  "thermos",
  "sunglasses",
  "mask",
];

/** 取不到天气时的兜底：一年四季出门都不算错的三件。 */
const FALLBACK: readonly PretripItemKey[] = ["hat", "sunscreen", "water"];

const RAIN = /(雨|阵雨|雷)/;
const SNOW = /雪/;
const SUNNY = /晴/;
const HAZE = /(霾|沙尘|浮尘|扬沙)/;

/**
 * 规则表（可断言）。每条只回答"这种天气该加哪件"，不做取舍；
 * 取舍（去重、排序、限量）在下面统一做，规则本身保持能逐条读。
 */
export function recommendPretripItems(w: PretripWeatherView): PretripItemsData {
  // 图标与物品同源：分类与挑选吃的是同一个 view，不各查各的。
  const kind = classifyWeatherKind(w);
  const picks: PretripItemPick[] = [];
  const add = (key: PretripItemKey, reason: string) => picks.push({ key, reason });

  const phenomena = w.phenomena.join(" ");
  const hasRain = RAIN.test(phenomena) || (w.precipitationMm ?? 0) > 0;
  const hasSnow = SNOW.test(phenomena) || (w.snowfallCm ?? 0) > 0;
  const hot = (w.maxTempC ?? -Infinity) >= 28;
  const veryHot = (w.maxTempC ?? -Infinity) >= 33;
  const cold = (w.minTempC ?? Infinity) <= 12;
  const veryCold = (w.minTempC ?? Infinity) <= 5;
  const swing =
    w.maxTempC !== undefined && w.minTempC !== undefined && w.maxTempC - w.minTempC >= 10;

  if (hasRain) add("umbrella", "这一程有降雨");
  // 高温优先补水：33℃ 以上缺水比日晒更难受，所以它排在防晒前面。
  if (veryHot) add("water", `最高气温 ${w.maxTempC}℃`);
  /*
   * 防晒三件（遮阳帽 / 防晒霜 / 墨镜）看的是有没有日晒，不是气温。
   *
   * 下雨天气温同样可能 ≥28℃，只按气温判会让同一张卡上同时出现雨伞与防晒，
   * 推荐自相矛盾会损害整张卡的可信度。
   *
   * 下雨/下雪时不给防晒；补水另算：高温雨天同样要喝水，与日晒无关。
   */
  const sunExposed = !hasRain && !hasSnow && (hot || SUNNY.test(phenomena));
  if (sunExposed) {
    add("hat", hot ? `最高气温 ${w.maxTempC}℃` : "晴天");
    add("sunscreen", "紫外线");
  }
  if (hot) add("water", "天热补水");
  if (sunExposed && SUNNY.test(phenomena) && hot) add("sunglasses", "晴天强光");
  if (cold || swing) {
    add("jacket", cold ? `最低气温 ${w.minTempC}℃` : `昼夜温差 ${(w.maxTempC ?? 0) - (w.minTempC ?? 0)}℃`);
  }
  if (veryCold || hasSnow) add("thermos", hasSnow ? "有雪" : `最低气温 ${w.minTempC}℃`);
  if (HAZE.test(phenomena)) add("mask", "有霾/沙尘");

  // 去重按 key（key 就是图标品类，同一张图不该在卡上出现两次）；保留先入的理由。
  const deduped: PretripItemPick[] = [];
  const seen = new Set<PretripItemKey>();
  for (const p of picks) {
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    deduped.push(p);
  }

  if (deduped.length === 0) {
    // 一条规则都没命中（例如多云 20℃ 的好天气）：给基础三件，但如实标 fallback。
    return {
      items: FALLBACK.map((key) => ({ key, reason: "常备" })),
      weatherAvailable: true,
      basis: "fallback",
      dropped: [],
      weatherSummary: summarize(w),
      weatherKind: kind,
      weatherLabel: WEATHER_LABELS[kind],
    };
  }

  deduped.sort((a, b) => PRIORITY.indexOf(a.key) - PRIORITY.indexOf(b.key));

  return {
    items: deduped.slice(0, MAX_PRETRIP_ITEMS),
    weatherAvailable: true,
    basis: "weather",
    dropped: deduped.slice(MAX_PRETRIP_ITEMS),
    weatherSummary: summarize(w),
    weatherKind: kind,
    weatherLabel: WEATHER_LABELS[kind],
  };
}

/**
 * 现象 → 天气种类。
 *
 * 多天行程取最该注意的那一种，与物品的极值判定同一取向：
 * 雪 > 雨 > 雾霾 > 阴 > 多云 > 晴。一程里有一天下雨，卡上就显示雨；
 * 取最常见的那种会让"带伞"配着太阳出现。
 */
export function classifyWeatherKind(w: PretripWeatherView): WeatherKind {
  const phenomena = w.phenomena.join(" ");
  if (SNOW.test(phenomena) || (w.snowfallCm ?? 0) > 0) return "snow";
  if (RAIN.test(phenomena) || (w.precipitationMm ?? 0) > 0) return "rain";
  if (HAZE.test(phenomena) || /雾/.test(phenomena)) return "haze";
  if (/阴/.test(phenomena)) return "overcast";
  if (/多云/.test(phenomena)) return "cloudy";
  // 认不出来就按晴：它是唯一有定稿图的那张，也是兜底图标。
  return "sunny";
}

function summarize(w: PretripWeatherView): string {
  const parts: string[] = [];
  if (w.phenomena.length > 0) parts.push([...new Set(w.phenomena)].join("/"));
  if (w.minTempC !== undefined && w.maxTempC !== undefined) {
    parts.push(`${Math.round(w.minTempC)}~${Math.round(w.maxTempC)}℃`);
  }
  if ((w.precipitationMm ?? 0) > 0) parts.push(`降水 ${w.precipitationMm}mm`);
  return parts.join("，");
}

/** 取不到天气时的返回体。basis=fallback + weatherAvailable=false，调用方据此不说"根据天气"。 */
export function fallbackPretripItems(): PretripItemsData {
  return {
    items: FALLBACK.map((key) => ({ key, reason: "没查到天气，给的是常备三件" })),
    weatherAvailable: false,
    basis: "fallback",
    dropped: [],
    weatherSummary: "",
    // 没拿到天气，图标回落太阳，与端上 `?? sprites.weather.sunny` 同一个兜底。
    weatherKind: "sunny",
    weatherLabel: WEATHER_LABELS.sunny,
  };
}

/**
 * WMO 天气代码 → 中文现象（只分到规则用得上的粒度）。
 *
 * 没有高德 key 时 `condition` 恒为 null，Open-Meteo 那一路只给 `weatherCode`。
 * 缺这张表时「晴」匹配不上，墨镜永远推不出来，且不报错。
 */
function phenomenonFromCode(code: number): string | undefined {
  if (code === 0) return "晴";
  if (code <= 3) return "多云";
  if (code === 45 || code === 48) return "雾";
  if (code >= 95) return "雷阵雨";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "雪";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "雨";
  return undefined;
}

/**
 * `WeatherSegment[]` → 整程极值视图。
 * 只读预报字段：`observed` 是"此刻"的实况，行前提示问的是出发那天。
 */
export function reduceSegments(segments: readonly WeatherSegment[]): PretripWeatherView {
  const nums = (xs: Array<number | null | undefined>) =>
    xs.filter((x): x is number => typeof x === "number");

  const maxs = nums(segments.map((s) => s.tempMaxC));
  const mins = nums(segments.map((s) => s.tempMinC));
  const precip = nums(segments.map((s) => s.precipitationMm));
  const snow = nums(segments.map((s) => s.snowfallCm));
  const uv = nums(segments.map((s) => s.uvIndexMax));

  return {
    maxTempC: maxs.length ? Math.max(...maxs) : undefined,
    minTempC: mins.length ? Math.min(...mins) : undefined,
    // 中文现象优先（高德/CMA 给的），没有就从 WMO 代码翻一个出来。
    phenomena: segments
      .map((s) => s.condition ?? (typeof s.weatherCode === "number" ? phenomenonFromCode(s.weatherCode) : undefined))
      .filter((c): c is string => typeof c === "string" && c.length > 0),
    precipitationMm: precip.length ? Math.max(...precip) : undefined,
    snowfallCm: snow.length ? Math.max(...snow) : undefined,
    uvIndexMax: uv.length ? Math.max(...uv) : undefined,
  };
}

export const pretripItemsTool: ExternalTool<PretripItemsArgs, PretripItemsData> =
  defineExternalTool<PretripItemsArgs, PretripItemsData>({
    name: "pretrip_items",
    // 数据来自 weather 那一路；这里标自己，让轨迹能分辨调用方。
    provider: "cabinhug-weather",
    sensitive: false,
    retries: 1,
    timeoutMs: 12_000,

    real: async (args, ctx) => {
      // 没有坐标就不调天气接口：它只会返回空数组。
      if (args.points.length === 0) return fallbackPretripItems();

      try {
        const r = await weatherTool.call(
          { points: args.points, date: args.date },
          ctx,
        );
        const segments = r.data;
        if (segments.length === 0) return fallbackPretripItems();
        const picked = recommendPretripItems(reduceSegments(segments));
        const provider = r.source.provider;
        if (r.source.kind !== "real" || !isWeatherProvider(provider)) return picked;
        return { ...picked, weatherSource: WEATHER_SOURCES[provider] };
      } catch (err) {
        // 天气失败不等于本工具失败：物品清单总能给出，只是如实标 fallback。
        // 抛出去会让上游（确认路径）多一处 catch，那里失败会导致行程定不下来。
        if (err instanceof ToolError && err.category === "invalid") throw err;
        return fallbackPretripItems();
      }
    },

    mock: () => recommendPretripItems({ phenomena: ["晴"], maxTempC: 34, minTempC: 27 }),
  });

/** 供上层校验：产出的 key 一定在契约表里（防止推出没有名字也没有贴纸的物品）。 */
export function allPretripKeysKnown(data: PretripItemsData): boolean {
  return [...data.items, ...data.dropped].every((i) => i.key in PRETRIP_ITEMS);
}
