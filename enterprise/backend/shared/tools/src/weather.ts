/**
 * weather —— 沿途逐段天气（§5 工具表）。
 *
 * 它覆盖了外部工具四件套的全部能力：超时、重试退避、Mock 三态、来源标注。
 * 业务上它是出行规划并行 fan-out 的一路（§11、FL-18 F-18-03）。
 *
 * # 结构：一层基础预报 + 一层详情增强
 *
 * 基础预报只给日高低温、天气现象与风力，回答不了"路上会不会淋雨、后排会不会太闷"，
 * 所以另有一层增强：
 *
 *   基础预报  和风 | 高德 | Open-Meteo（按 `WEATHER_PROVIDER` 选）—— 日高低温 + 天气现象
 *   详情增强  中国气象局（无 key，大陆可达）—— 体感/湿度/降水实况 + 气象预警 + 把窗口拉到 7 天
 *
 * # 基础预报由谁出是显式配置（ACR-052）
 *
 * 高德与 Open-Meteo 的免费用途都限非商业，不做隐式兜底，避免部署在不知情时用上非商用来源。
 * 由 `WEATHER_PROVIDER`（装配层经 `setWeatherProvider` 注入）三选一：
 * `qweather`（缺省）| `amap` | `open-meteo`。选中的那家没装配就报 `unconfigured`，不换别家顶上。
 *
 * 增强层失败不影响主干：取不到就少那几个字段，并在 `unavailable` 里说明原因，
 * 整次调用照常返回。
 *
 * # 三条数据诚实约定
 *
 * 1. 实况不能安到未来日期上。CMA 的 `now`（体感/湿度/降水/气压/风）是此刻的观测，
 *    查明天时 `observed` 必须为 `null`。
 * 2. "该源不提供"要显式说明，不能只是字段缺失。高德+CMA 这个组合拿不到紫外线、
 *    能见度、降雪量；字段缺失会被上层读成"今天紫外线为 0"。所以有 `unavailable`。
 * 3. 每个字段的来源可追溯。`source.provider` 只能标一次调用一个供应商，
 *    而一段结果里可能混有多个来源，所以另有 `sources` 逐项标注。
 */

import {
  DEFAULT_WEATHER_PROVIDER,
  isWeatherProvider,
  WEATHER_PROVIDERS,
  type WeatherProvider,
  type WeatherSource,
} from "@cabinhug/shared";
import { getAmapClient, type AmapClient, type LngLat } from "./amap";
import { CMA_LIMITS, getCmaClient, type CmaAlarm, type CmaClient, type CmaView } from "./cma";
import { ENV_TTL, envCacheKey, roundCoord, withEnvCache } from "./env-cache";
import { defineExternalTool, ToolError, type ExternalTool } from "./external";
import {
  createQweatherClient,
  getQweatherClient,
  QWEATHER_FORECAST_DAYS,
  setQweatherClient,
  type QweatherClient,
} from "./qweather";

export interface WeatherArgs {
  /** 沿途取样点；出行规划按路线分段取点后传入（`map_route` 的 `sampledPoints` 可直接喂进来） */
  points: Array<{ name: string; lat: number; lon: number }>;
  /** 目标日期（YYYY-MM-DD）；省略取今天。与 `dates` 二选一，两个都给时以 `dates` 为准 */
  date?: string;
  /**
   * 一次问多天。逆地理与预报都按行政区缓存，高德一次 `forecast` 返回今天起 4 天、
   * 气象局 7 天，多取几天只是从同一份响应里多读几条，不多打上游请求。
   *
   * 模型轮数比耗时更贵：逐天查询时每天之间都要多一轮模型往返。
   */
  dates?: string[];
}

/** 实况观测（中国气象局）。只在查询日期是今天时出现。 */
export interface WeatherObservation {
  /** 观测站名与它离取样点多远；太远的观测不应当作"这里的天气" */
  station: string;
  stationDistanceKm: number;
  observedAt: string;
  temperatureC: number | null;
  /** 体感温度：高德链路不提供，由 CMA 补上 */
  feelsLikeC: number | null;
  humidityPct: number | null;
  /** 实况降水（mm）。与 `WeatherSegment.precipitationMm`（当日预报累计）含义不同 */
  precipitationMm: number | null;
  pressureHpa: number | null;
  windDirection: string | null;
  windDirectionDeg: number | null;
  windSpeedMs: number | null;
  windScale: string | null;
}

export interface WeatherSegment {
  name: string;
  date: string;
  tempMinC: number | null;
  tempMaxC: number | null;
  /** 当日预报累计降水（mm）。高德不提供 → null；实况降水在 `observed` 里 */
  precipitationMm: number | null;
  /** 原始天气代码，供上层做"是否适合出行"的判断，不在工具里下结论（Open-Meteo 才有） */
  weatherCode: number | null;
  /** 中文天气现象（白天），如「雷阵雨」。高德与 CMA 都有，可直接播报 */
  condition?: string | null;
  /** 风力等级，如「1-3」「5级」 */
  windPower?: string | null;
  /** 该取样点落在哪个城市；天气是城市粒度的 */
  city?: string | null;
  /** 紫外线指数（当日最大）。只有 Open-Meteo 提供；高德+CMA 组合下为 null */
  uvIndexMax?: number | null;
  /** 能见度（km）。只有 Open-Meteo 提供；高德+CMA 组合下为 null */
  visibilityKm?: number | null;
  /** 当日降雪量（cm）。只有 Open-Meteo 提供 */
  snowfallCm?: number | null;
  /** 体感温度（预报值，Open-Meteo）。CMA 的体感是实况，在 `observed` 里 */
  apparentTempMaxC?: number | null;
  /** 相对湿度（预报值，Open-Meteo）。CMA 的湿度是实况，在 `observed` 里 */
  humidityPct?: number | null;
  /** 实况观测（中国气象局）。仅当查询日期是今天 */
  observed?: WeatherObservation | null;
  /** 当前生效的气象预警。与日期无关，预警描述的是"现在" */
  alarms?: WeatherAlarm[];
  /** 这一段的字段分别来自谁，如 ["amap:forecast","cma:observed"] */
  sources?: string[];
  /** 本次组合结构性拿不到的字段与原因。空数组表示都拿到了 */
  unavailable?: string[];
}

export interface WeatherAlarm {
  title: string;
  type: string;
  level: string;
  severity: string;
  effective: string;
}

const ENDPOINT = "https://api.open-meteo.com/v1/forecast";

/** 高德预报窗口：`casts` 返回今天 + 之后 3 天，共 4 条（实测）。 */
const AMAP_FORECAST_DAYS = 4;
/**
 * 气象局增强层的时间预算。
 *
 * 气象局是公开接口、无 key、无 SLA，个别站点的实况请求可达数秒，而高德请求并行后
 * 通常不到 200ms。增强层与基础预报并行，超过预算只丢体感/湿度/预警那几栏，基础预报照常。
 *
 * 超时后那次请求不取消：它回来会把 ⑤缓存填上，下一次毫秒级命中。
 */
const CMA_ENRICH_BUDGET_MS = 1_500;

/** 中国气象局 `daily` 返回 7 天（含今天，实测）。 */
const CMA_FORECAST_DAYS = 7;

// ── Open-Meteo：字段取全 ─────────────────────────────────────────

const OM_DAILY = [
  "temperature_2m_min",
  "temperature_2m_max",
  "precipitation_sum",
  "rain_sum",
  "snowfall_sum",
  "weather_code",
  "uv_index_max",
  "apparent_temperature_max",
].join(",");

interface OpenMeteoDaily {
  temperature_2m_min?: number[];
  temperature_2m_max?: number[];
  precipitation_sum?: number[];
  snowfall_sum?: number[];
  weather_code?: number[];
  uv_index_max?: number[];
  apparent_temperature_max?: number[];
}

async function fetchOne(
  p: WeatherArgs["points"][number],
  date: string,
  signal?: AbortSignal,
): Promise<WeatherSegment> {
  const url = new URL(ENDPOINT);
  url.searchParams.set("latitude", String(p.lat));
  url.searchParams.set("longitude", String(p.lon));
  url.searchParams.set("daily", OM_DAILY);
  // 湿度与能见度只有小时粒度；取当日均值/最小值代价高，这里取当前值即可满足
  // "带不带伞、看不看得见"的判断，并在 sources 里标明是 current 而非 daily。
  url.searchParams.set("current", "relative_humidity_2m,visibility");
  url.searchParams.set("start_date", date);
  url.searchParams.set("end_date", date);
  url.searchParams.set("timezone", "Asia/Shanghai");

  const res = await fetch(url, { signal });
  if (!res.ok) {
    // 4xx 多半是参数错，重试没用；5xx 与网络错才值得重试。
    throw new ToolError("weather", "upstream", `HTTP ${res.status}`, res.status >= 500);
  }
  const body = (await res.json()) as {
    daily?: OpenMeteoDaily;
    current?: { relative_humidity_2m?: number; visibility?: number };
  };
  const d = body.daily;
  const c = body.current;
  return {
    name: p.name,
    date,
    tempMinC: d?.temperature_2m_min?.[0] ?? null,
    tempMaxC: d?.temperature_2m_max?.[0] ?? null,
    precipitationMm: d?.precipitation_sum?.[0] ?? null,
    weatherCode: d?.weather_code?.[0] ?? null,
    snowfallCm: d?.snowfall_sum?.[0] ?? null,
    uvIndexMax: d?.uv_index_max?.[0] ?? null,
    apparentTempMaxC: d?.apparent_temperature_max?.[0] ?? null,
    humidityPct: c?.relative_humidity_2m ?? null,
    visibilityKm: typeof c?.visibility === "number" ? c.visibility / 1000 : null,
    sources: ["open-meteo:forecast"],
    unavailable: [],
  };
}

// ── 和风天气：7 天逐日，字段最全（ACR-052）──────────────────────

/** 和风这一路结构性拿不到的那一栏。气象局增强层据它判断不必再报一遍同一件事。 */
const QWEATHER_NO_SNOWFALL = "snowfallCm：和风逐日预报不单列降雪量，下雪只体现在 condition 的文字里";

/**
 * 和风路径：坐标 → 7 天逐日预报。
 *
 * 按取整坐标缓存（与高德的逆地理同一粒度，约 1.1km）：同一轮里沿途几个挨得近的取样点、
 * 同一个点问多天，都只打一次上游。和风许可允许缓存天气数据（地理信息除外，这里不调）。
 */
async function fetchAllViaQweather(
  qweather: QweatherClient,
  points: WeatherArgs["points"],
  dates: readonly string[],
  signal?: AbortSignal,
): Promise<WeatherSegment[]> {
  const forecasts = await Promise.all(
    points.map(async (p) => {
      const key = envCacheKey("qweather-7d", [roundCoord(p.lat), roundCoord(p.lon)]);
      const { value } = await withEnvCache(key, ENV_TTL.weatherForecast, () =>
        qweather.daily7d({ lat: p.lat, lon: p.lon }, signal),
      );
      return value;
    }),
  );

  return dates.flatMap((date) =>
    points.map((p, i) => {
      const day = forecasts[i].find((d) => d.date === date);
      if (!day) {
        // 与高德那一路同一条纪律：只问一天时抛错，多天时只把这一天标成取不到。
        if (dates.length > 1) return missingSeg(p, date);
        throw new ToolError("weather", "upstream", `和风天气没有返回 ${p.name} 在 ${date} 的预报`, true);
      }
      return {
        name: p.name,
        date,
        tempMinC: day.tempMinC,
        tempMaxC: day.tempMaxC,
        precipitationMm: day.precipitationMm,
        weatherCode: null, // 和风的图标代码不是 WMO 口径，不往这个字段里放
        condition: day.textDay || null,
        windPower: day.windScaleDay || null,
        // 不调和风的 GeoAPI（许可禁止缓存地理信息），这里不给城市名。
        city: null,
        uvIndexMax: day.uvIndex,
        visibilityKm: day.visibilityKm,
        humidityPct: day.humidityPct,
        snowfallCm: null,
        sources: ["qweather:forecast"],
        unavailable: [QWEATHER_NO_SNOWFALL],
      } satisfies WeatherSegment;
    }),
  );
}

// ── 基础预报供应商（ACR-052）─────────────────────────────────

/**
 * 各供应商的署名：显示名 + 链接，随 `WeatherContext.source` 下发到端上显示。
 * 放服务端而不放契约包：端上代码里不得出现非网关地址（check:arch 的 client-isolation）。
 */
export const WEATHER_SOURCES: Record<WeatherProvider, WeatherSource> = {
  qweather: { name: "和风天气", url: "https://www.qweather.com" },
  amap: { name: "高德开放平台", url: "https://lbs.amap.com" },
  "open-meteo": { name: "Open-Meteo", url: "https://open-meteo.com" },
};

/**
 * 一次 `weather` 调用该署名的来源：只有真实供应商返回的数据才署名，模拟数据不挂任何名字。
 * 入参是 `invokeTool` 的原始返回（`ToolResult`），形状不对就当没有。
 */
export function weatherCitation(result: unknown): WeatherSource | undefined {
  const source = (result as { source?: { kind?: unknown; provider?: unknown } } | undefined)?.source;
  if (source?.kind !== "real" || typeof source.provider !== "string") return undefined;
  return isWeatherProvider(source.provider) ? WEATHER_SOURCES[source.provider] : undefined;
}

let weatherProvider: WeatherProvider = DEFAULT_WEATHER_PROVIDER;

/** 装配层按 `WEATHER_PROVIDER` 注入；取值校验在配置注册表那一侧。 */
export function setWeatherProvider(p: WeatherProvider): void {
  weatherProvider = p;
}

export function getWeatherProvider(): WeatherProvider {
  return weatherProvider;
}

/**
 * 装配层入口：按 `WEATHER_PROVIDER` 选供应商，并按 `QWEATHER_*` 注入和风客户端。
 *
 * agent-runtime 与 worker 都调它，口径只写一份。要在 `setAmapClient` 之后调：
 * 返回的 `ready` 取决于高德是否已装配。取值不认识就抛错，配置错误在启动时暴露，
 * 不落回缺省供应商。
 */
export function configureWeatherProvider(read: (key: string) => string | undefined): {
  provider: WeatherProvider;
  ready: boolean;
} {
  const raw = (read("WEATHER_PROVIDER") ?? "").trim() || DEFAULT_WEATHER_PROVIDER;
  if (!isWeatherProvider(raw)) {
    throw new Error(`WEATHER_PROVIDER=${raw} 不认识，只能是 ${WEATHER_PROVIDERS.join(" / ")}`);
  }
  setWeatherProvider(raw);

  const apiKey = (read("QWEATHER_API_KEY") ?? "").trim();
  const apiHost = (read("QWEATHER_API_HOST") ?? "").trim();
  setQweatherClient(apiKey && apiHost ? createQweatherClient({ apiKey, apiHost }) : undefined);

  const ready =
    raw === "qweather" ? getQweatherClient() !== undefined : raw === "amap" ? getAmapClient() !== undefined : true;
  return { provider: raw, ready };
}

function unconfigured(provider: WeatherProvider, missing: string): ToolError {
  return new ToolError(
    "weather",
    "unconfigured",
    `天气未接入：WEATHER_PROVIDER=${provider}，但${missing}。不会换用其它供应商顶上`,
    false,
  );
}

// ── 高德：日高低温 + 中文现象 ─────────────────────────────────

/**
 * 高德路径：坐标 → adcode → 城市预报。
 *
 * 按 adcode 分组：同一个市的多个取样点拿到的是同一份预报，只查一次。
 */
async function fetchAllViaAmap(
  amap: AmapClient,
  points: WeatherArgs["points"],
  dates: readonly string[],
  signal?: AbortSignal,
): Promise<WeatherSegment[]> {
  /*
   * ⑤缓存。天气是这条链路上最贵的一跳（一次沿途查询实测 2888ms），
   * 而出行规划会按取样点逐段查。
   *
   * 两级都缓存，TTL 依据不同：
   *  - 逆地理编码（坐标→adcode）：24 小时。行政区划一天内不会变；
   *  - 预报：30 分钟。高德预报本身按小时/半天更新，30 分钟内重复查
   *    拿到的是同一份。
   *
   * key 只含取整坐标与 adcode，不含 userId / 会话 id：
   * 同一个地点的天气对所有人是同一份。
   */
  const regeos = await Promise.all(
    points.map(async (p) => {
      const key = envCacheKey("regeo", [roundCoord(p.lat), roundCoord(p.lon)]);
      const { value } = await withEnvCache(key, 24 * 60 * 60, () =>
        amap.regeo({ lat: p.lat, lon: p.lon } satisfies LngLat, signal),
      );
      return value;
    }),
  );

  const uniqueAdcodes = [...new Set(regeos.map((r) => r.adcode))];
  const forecasts = new Map(
    await Promise.all(
      uniqueAdcodes.map(async (adcode) => {
        const key = envCacheKey("amap-forecast", [adcode]);
        const { value } = await withEnvCache(key, ENV_TTL.weatherForecast, () =>
          amap.forecast(adcode, signal),
        );
        return [adcode, value] as const;
      }),
    ),
  );

  return dates.flatMap((date) =>
    points.map((p, i) => {
    const regeo = regeos[i];
    const cast = forecasts.get(regeo.adcode)?.casts.find((c) => c.date === date);
    if (!cast) {
      /*
       * 高德在窗口内也没给这一天。
       *
       * 只问一天时抛错：那是数据问题，调用方需要知道；
       * 一次问多天时抛错会连带丢掉有数据的日子，所以只把这一天标成取不到（`missingSeg`）。
       */
      if (dates.length > 1) return missingSeg(p, date, regeo.city);
      throw new ToolError(
        "weather",
        "upstream",
        `高德没有返回 ${regeo.city || regeo.adcode} 在 ${date} 的预报`,
        true,
      );
    }
    return {
      name: p.name,
      date,
      tempMinC: cast.nightTempC,
      tempMaxC: cast.dayTempC,
      precipitationMm: null, // 高德不提供降水毫米数
      weatherCode: null, // 高德给的是中文现象，没有数值代码
      condition: cast.dayWeather || null,
      windPower: cast.dayPower || null,
      city: regeo.city || regeo.district || null,
      sources: ["amap:forecast"],
      unavailable: [],
    } satisfies WeatherSegment;
    }),
  );
}

/**
 * 给一个可选的增强请求一段预算，到点就当它没回来。
 *
 * 不取消它：让它继续完成，结果会落进 ⑤缓存，下一次直接命中。
 */
async function withBudget<T>(task: Promise<T[]> | undefined, ms: number): Promise<T[]> {
  if (!task) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<T[]>((resolve) => {
    timer = setTimeout(() => resolve([]), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([task, budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 某一天取不到时的空档段：有这一天但没有数据，与"没问过这一天"区分开。 */
function missingSeg(p: WeatherArgs["points"][number], date: string, city?: string | null): WeatherSegment {
  return {
    name: p.name,
    date,
    tempMinC: null,
    tempMaxC: null,
    precipitationMm: null,
    weatherCode: null,
    condition: null,
    windPower: null,
    city: city ?? null,
    sources: [],
    unavailable: [`该取样点在 ${date} 没有可用预报`],
  } satisfies WeatherSegment;
}

// ── 中国气象局：详情增强 ──────────────────────────────────────

/**
 * 给每个取样点找最近站点并取一次 `view`。
 *
 * 按站点去重：一条长路线上多个取样点常落在同一个站的辖区里，只查一次。
 * 返回 `undefined` 表示该点没有可用站点（超过 100km），这是要如实报告的信息，不是失败。
 */
/**
 * 取一个站点的 CMA 视图，带⑤缓存。
 *
 * # TTL 取实况那一档（10 分钟），不取预报那一档
 *
 * `view` 一次返回三样东西：实况、7 天预报、预警。三者时效差着数量级，
 * 混在一起时按最快的那个定 TTL；按预报的 30 分钟缓存会把"现在几度"答成半小时前的值，
 * 而实况正是这一跳存在的理由（高德不提供实况）。
 *
 * # 预警因此最多晚 10 分钟
 *
 * 刚发布的预警最坏 10 分钟内查不到。这条链路服务的是出行规划的问答，不是预警推送；
 * 接入预警推送时这一条要拆开，预警不能走缓存。
 *
 * # 按站点做键，不按坐标
 *
 * `nearestStation` 已经把一片区域的取样点收敛到同一个站（纯计算，站点表在进程内缓存，
 * 不走网络）。按坐标做键会重新引入已收敛的差异，降低命中率。
 */
function cachedCmaView(
  cma: CmaClient,
  stationId: string,
  signal?: AbortSignal,
): Promise<CmaView> {
  const key = envCacheKey("cma-view", [stationId]);
  return withEnvCache(key, ENV_TTL.weatherObservation, () => cma.view(stationId, signal)).then(
    (r) => r.value,
  );
}

async function fetchCmaViews(
  cma: CmaClient,
  points: WeatherArgs["points"],
  signal?: AbortSignal,
): Promise<Array<{ view: CmaView; distanceKm: number } | undefined>> {
  const nearest = await Promise.all(
    points.map((p) => cma.nearestStation({ lat: p.lat, lon: p.lon }, signal).catch(() => undefined)),
  );

  const byStation = new Map<string, Promise<CmaView | undefined>>();
  for (const n of nearest) {
    if (!n || byStation.has(n.station.id)) continue;
    byStation.set(
      n.station.id,
      // 单个站点取不到不影响整条路线，增强层失败只是少几个字段。
      cachedCmaView(cma, n.station.id, signal).catch(() => undefined),
    );
  }
  const resolved = new Map<string, CmaView | undefined>();
  for (const [id, p] of byStation) resolved.set(id, await p);

  return nearest.map((n) => {
    if (!n) return undefined;
    const view = resolved.get(n.station.id);
    return view ? { view, distanceKm: n.distanceKm } : undefined;
  });
}

/** 把 CMA 的实况与预警合并进一段结果。基础字段不覆盖，只补空。 */
function enrichWithCma(
  seg: WeatherSegment,
  hit: { view: CmaView; distanceKm: number } | undefined,
  date: string,
  isToday: boolean,
): WeatherSegment {
  const sources = [...(seg.sources ?? [])];
  const unavailable = [...(seg.unavailable ?? [])];

  if (!hit) {
    unavailable.push(
      `observed/alarms：该取样点 100km 内没有气象局观测站，或该站取数失败`,
      ...CMA_LIMITS.UNAVAILABLE,
    );
    return { ...seg, observed: null, alarms: [], sources, unavailable };
  }

  const { view, distanceKm } = hit;

  // 基础字段只补空、不覆盖：基础预报已经给了的就用它的，
  // 保证同一次调用里基础字段的来源一致。
  const cmaDay = view.daily.find((d) => d.date === date);
  const merged: WeatherSegment = { ...seg };
  if (cmaDay) {
    if (merged.tempMaxC === null || merged.tempMaxC === undefined) merged.tempMaxC = cmaDay.highC;
    if (merged.tempMinC === null || merged.tempMinC === undefined) merged.tempMinC = cmaDay.lowC;
    if (!merged.condition) merged.condition = cmaDay.dayText || null;
    if (!merged.windPower) merged.windPower = cmaDay.dayWindScale || null;
    if (!sources.includes("cma:forecast") && !seg.sources?.length) sources.push("cma:forecast");
  }

  // 实况只在今天填（文件头约定 1）。
  if (isToday) {
    merged.observed = {
      station: view.station.name,
      stationDistanceKm: distanceKm,
      observedAt: view.lastUpdate,
      ...view.observation,
    };
    sources.push("cma:observed");
  } else {
    merged.observed = null;
    unavailable.push(
      `observed：气象局的体感/湿度/降水/气压/风是**此刻的实况**，不适用于 ${date}`,
    );
  }

  merged.alarms = view.alarms.map(toAlarm);
  sources.push("cma:alarm");

  // 紫外线/能见度/降雪：Open-Meteo 与和风那一路有（和风缺降雪），高德+CMA 这一路没有。
  if (merged.uvIndexMax === undefined || merged.uvIndexMax === null) {
    merged.uvIndexMax = null;
    unavailable.push(CMA_LIMITS.UNAVAILABLE[0]);
  }
  if (merged.visibilityKm === undefined || merged.visibilityKm === null) {
    merged.visibilityKm = null;
    unavailable.push(CMA_LIMITS.UNAVAILABLE[1]);
  }
  // 基础预报那一路已经说过拿不到降雪（和风）时，不再用气象局的口径重复一遍。
  if ((merged.snowfallCm === undefined || merged.snowfallCm === null) && !unavailable.includes(QWEATHER_NO_SNOWFALL)) {
    merged.snowfallCm = null;
    unavailable.push(CMA_LIMITS.UNAVAILABLE[2]);
  }

  return { ...merged, sources, unavailable };
}

function toAlarm(a: CmaAlarm): WeatherAlarm {
  return { title: a.title, type: a.type, level: a.level, severity: a.severity, effective: a.effective };
}

/** 纯用 CMA 出基础预报——高德窗口外（第 5~7 天）走这条。 */
function baseFromCma(
  points: WeatherArgs["points"],
  hits: Array<{ view: CmaView; distanceKm: number } | undefined>,
  dates: readonly string[],
): WeatherSegment[] {
  return dates.flatMap((date) =>
    points.map((p, i) => {
    const hit = hits[i];
    const day = hit?.view.daily.find((d) => d.date === date);
    return {
      name: p.name,
      date,
      tempMinC: day?.lowC ?? null,
      tempMaxC: day?.highC ?? null,
      precipitationMm: null,
      weatherCode: null,
      condition: day?.dayText || null,
      windPower: day?.dayWindScale || null,
      city: hit?.view.station.name ?? null,
      sources: day ? ["cma:forecast"] : [],
      unavailable: day ? [] : [`该取样点在 ${date} 没有可用预报`],
    } satisfies WeatherSegment;
    }),
  );
}

// ── 窗口判定 ─────────────────────────────────────────────────

function daysFromToday(date: string): number {
  const target = Date.parse(`${date}T00:00:00+08:00`);
  const base = Date.parse(`${today()}T00:00:00+08:00`);
  if (!Number.isFinite(target)) {
    throw new ToolError("weather", "invalid", `日期不可读：${date}`, false);
  }
  return Math.round((target - base) / 86_400_000);
}

function today(): string {
  // 与高德/气象局同一时区口径（北京时间），否则跨零点前后会差一天。
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

export const weatherTool: ExternalTool<WeatherArgs, WeatherSegment[]> = defineExternalTool({
  name: "weather",
  // 供应商是显式配置（ACR-052）。基础预报是谁就标谁；逐字段来源见 `sources`。
  provider: () => getWeatherProvider(),
  sensitive: false,
  // 增强层多打一跳，超时相应放宽。
  timeoutMs: 8_000,
  retries: 2,

  real: async (args, ctx) => {
    if (args.points.length === 0) {
      throw new ToolError("weather", "invalid", "points 不能为空", false);
    }
    // 一次可以问多天：去重、排序，`dates` 优先于 `date`。
    const dates = [...new Set((args.dates?.length ? args.dates : [args.date ?? today()]).map((d) => d.trim()).filter(Boolean))].sort();
    const provider = getWeatherProvider();
    const cma = getCmaClient();

    /*
     * 气象局先发不先等（见 `CMA_ENRICH_BUDGET_MS`）。
     * 这里先把它发出去，谁等它、等多久由下面各条路径各自决定。
     */
    const cmaAhead = cma ? fetchCmaViews(cma, args.points, ctx.signal).catch(() => []) : undefined;

    // 和风：7 天窗口，自己就带紫外线/能见度/湿度；气象局只补实况与预警，给预算。
    if (provider === "qweather") {
      const qweather = getQweatherClient();
      if (!qweather) throw unconfigured(provider, "QWEATHER_API_KEY / QWEATHER_API_HOST 未配置");
      const covers = (d: string): boolean => {
        const o = daysFromToday(d);
        return o >= 0 && o < QWEATHER_FORECAST_DAYS;
      };
      const covered = dates.filter(covers);
      const outOfWindowSegs = dates
        .filter((d) => !covers(d))
        .flatMap((d) =>
          args.points.map((p) => ({
            ...missingSeg(p, d),
            unavailable: [
              `超出预报窗口：和风天气覆盖今天起 ${QWEATHER_FORECAST_DAYS} 天` +
                `（至 ${addDays(today(), QWEATHER_FORECAST_DAYS - 1)}）。**不要据此推测那天的天气**，临近再查`,
            ],
          })),
        );
      if (covered.length === 0) return outOfWindowSegs;
      const [base, hits] = await Promise.all([
        fetchAllViaQweather(qweather, args.points, covered, ctx.signal),
        withBudget(cmaAhead, CMA_ENRICH_BUDGET_MS),
      ]);
      if (!hits.length) return [...base, ...outOfWindowSegs];
      return [
        ...base.map((seg, i) =>
          enrichWithCma(seg, hits[i % args.points.length], seg.date, daysFromToday(seg.date) === 0),
        ),
        ...outOfWindowSegs,
      ];
    }

    // Open-Meteo：只在显式选中时走（免费接口限非商用，ACR-052 起不再作兜底）。
    if (provider === "open-meteo") {
      // 沿途多点是工具内并发（一个 Agent 自己并行调），不是跨 Agent 协作（§11 注）。
      const [base, hits] = await Promise.all([
        Promise.all(dates.flatMap((d) => args.points.map((p) => fetchOne(p, d, ctx.signal)))),
        // Open-Meteo 这一路 CMA 同样只是增强（紫外线/能见度/降雪它自己就有），给预算。
        withBudget(cmaAhead, CMA_ENRICH_BUDGET_MS),
      ]);
      if (!hits.length) return base;
      return base.map((seg, i) =>
        enrichWithCma(seg, hits[i % args.points.length], seg.date, daysFromToday(seg.date) === 0),
      );
    }

    const amap = getAmapClient();
    if (!amap) throw unconfigured(provider, "AMAP_SERVER_KEY 未配置");

    /*
     * ── 超窗不是错误，是"这一天盖不到" ───────────────────────────────
     *
     * 车主要的日子在预报窗口之外是正常情形。抛错会进模型的工具循环，模型会再想一轮、
     * 换个日期重查，多一轮往返。所以超窗与"窗口内缺某天"同样处理：用 `missingSeg`
     * 标成取不到，并逐天判定，窗口内的日子照常返回。
     *
     * 说明文字里的「不要据此推测那天的天气」用于防止模型编造，写在 `unavailable` 里模型才看得见。
     */
    const maxWindow = cma ? Math.max(AMAP_FORECAST_DAYS, CMA_FORECAST_DAYS) : AMAP_FORECAST_DAYS;
    const covers = (d: string): boolean => {
      const o = daysFromToday(d);
      return o >= 0 && o < maxWindow;
    };
    const covered = dates.filter(covers);
    const uncovered = dates.filter((d) => !covers(d));
    const outOfWindowReason =
      `超出预报窗口：高德覆盖今天起 ${AMAP_FORECAST_DAYS} 天` +
      `（至 ${addDays(today(), AMAP_FORECAST_DAYS - 1)}）` +
      (cma
        ? `，中国气象局覆盖 ${CMA_FORECAST_DAYS} 天（至 ${addDays(today(), CMA_FORECAST_DAYS - 1)}）`
        : "，中国气象局未接入") +
      "。**不要据此推测那天的天气**，临近再查";
    const outOfWindowSegs = uncovered.flatMap((d) =>
      args.points.map((p) => ({ ...missingSeg(p, d), unavailable: [outOfWindowReason] })),
    );
    // 一天都盖不到：返回全部空档段，不抛错；"查不到"是结论，不是故障。
    if (covered.length === 0) return outOfWindowSegs;

    const offsets = covered.map((d) => daysFromToday(d));
    // 用哪一路按能盖到的那几天里最远的判：高德窗口内走高德，否则气象局当主干。
    const offset = Math.max(...offsets);
    const inAmapWindow = offset < AMAP_FORECAST_DAYS;

    /*
     * 高德窗口内：两边并行，气象局只给 `CMA_ENRICH_BUDGET_MS` 的预算，它补的那几栏是可选的。
     * 窗口外（第 5~7 天）：气象局是主干，没有它就没有基础预报，必须等满（工具级 8s 超时兜着）。
     */
    const [base, hits] = inAmapWindow
      ? await Promise.all([
          fetchAllViaAmap(amap, args.points, covered, ctx.signal),
          withBudget(cmaAhead, CMA_ENRICH_BUDGET_MS),
        ])
      : await (async () => {
          const h = await (cmaAhead ?? Promise.resolve([]));
          return [baseFromCma(args.points, h, covered), h] as const;
        })();

    if (!hits.length) return [...base, ...outOfWindowSegs];
    // segment 按 dates × points 铺开，取样点索引按 points 长度取模对回去。
    return [
      ...base.map((seg, i) =>
        enrichWithCma(seg, hits[i % args.points.length], seg.date, daysFromToday(seg.date) === 0),
      ),
      ...outOfWindowSegs,
    ];
  },

  // mock 数据用固定值，并由 source.kind=mock 标注。
  mock: (args) =>
    args.points.map((p) => ({
      name: p.name,
      date: args.date ?? today(),
      tempMinC: 3,
      tempMaxC: 11,
      precipitationMm: 0,
      weatherCode: 1,
      condition: "多云",
      windPower: "1-3",
      city: null,
      uvIndexMax: 3,
      visibilityKm: 20,
      snowfallCm: 0,
      observed: null,
      alarms: [],
      sources: ["mock"],
      unavailable: [],
    })),
});
