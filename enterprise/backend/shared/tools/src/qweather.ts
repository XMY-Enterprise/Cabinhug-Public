/**
 * 和风天气（QWeather）逐日预报客户端（ACR-052）。
 *
 * 只接一个接口：`GET /v7/weather/7d?location=<lon>,<lat>`。它一次给今天起 7 天，
 * 每天带高低温、中文现象、风力、降水、湿度、能见度、紫外线，覆盖高德缺少的几栏。
 *
 * # 接口约束
 *
 * 1. API Host 是每个账号专属的（控制台「设置」里，形如 `xxx.re.qweatherapi.com`）。
 *    公共域名 `api.qweather.com` / `devapi.qweather.com` 自 2026 年起逐步停用，不要写死。
 * 2. 认证走请求头 `X-QW-Api-Key`，不放 URL 参数（URL 会进访问日志）。2027-01-01 起
 *    API KEY 认证有日请求量限制，届时要换 JWT（Ed25519），换法只动本文件的 `headers`。
 * 3. 数值都是字符串（`"tempMax": "24"`），失败有两种形态：旧式 `{ code: "402" }`
 *    随 HTTP 200 返回，新式随 4xx/5xx 返回 `{ error: { status, title } }`。两种都要识别。
 * 4. 许可条款：数据可以缓存（地理信息 GeoAPI 除外，本客户端不调它）；显示数据的界面
 *    必须署名「和风天气」并链接官网（`WEATHER_SOURCES.qweather`）；不得把接口或原始数据
 *    转给第三方。预警与空气质量另有 `refer.sources` 展示义务，所以本客户端不接它们。
 */

import { ToolError } from "./external";

/** 和风逐日预报的一天。数值字段已从字符串转成数字，取不到为 null。 */
export interface QweatherDaily {
  /** YYYY-MM-DD */
  date: string;
  tempMaxC: number | null;
  tempMinC: number | null;
  /** 白天天气现象，如「雷阵雨」 */
  textDay: string;
  /** 白天风力等级，如「1-3」 */
  windScaleDay: string;
  precipitationMm: number | null;
  humidityPct: number | null;
  visibilityKm: number | null;
  uvIndex: number | null;
}

export interface QweatherClient {
  /** 取样点所在网格的 7 天逐日预报（含今天）。 */
  daily7d(point: { lat: number; lon: number }, signal?: AbortSignal): Promise<QweatherDaily[]>;
}

/** 和风 `7d` 接口的窗口：今天起 7 天（含今天）。 */
export const QWEATHER_FORECAST_DAYS = 7;

/** 旧式错误码的说明，只进报错文本，方便排障。 */
const QWEATHER_CODE_HINT: Record<string, string> = {
  "204": "该地区暂无数据",
  "400": "请求参数错误",
  "401": "认证失败（key 或 API Host 不对）",
  "402": "超过访问次数或余额不足",
  "403": "无访问权限",
  "404": "查询的数据或地区不存在",
  "429": "请求过于频繁",
};

export function createQweatherClient({ apiHost, apiKey }: { apiHost: string; apiKey: string }): QweatherClient {
  // 控制台里抄来的 Host 可能带也可能不带协议头，两种都收。
  const host = apiHost.trim().replace(/\/+$/, "");
  const origin = host.startsWith("https://") || host.startsWith("http://") ? host : `https://${host}`;

  return {
    async daily7d(point, signal) {
      const url = new URL("/v7/weather/7d", origin);
      // 和风的坐标是「经度,纬度」且最多两位小数（约 1.1km），与 ⑤缓存的取整粒度一致。
      url.searchParams.set("location", `${point.lon.toFixed(2)},${point.lat.toFixed(2)}`);

      const res = await fetch(url, { headers: { "X-QW-Api-Key": apiKey }, signal });
      const body = (await res.json().catch(() => undefined)) as QweatherResponse | undefined;
      if (!res.ok) {
        const detail = body?.error?.title ?? body?.error?.detail ?? `HTTP ${res.status}`;
        // 4xx 是 key / Host / 参数的问题，重试没用；5xx 与限流才值得重试。
        throw new ToolError("weather", "upstream", `和风天气：${detail}`, res.status >= 500 || res.status === 429);
      }
      if (!body || body.code !== "200") {
        const code = body?.code ?? "?";
        throw new ToolError(
          "weather",
          "upstream",
          `和风天气 code=${code}（${QWEATHER_CODE_HINT[code] ?? "未知错误"}）`,
          code === "429",
        );
      }
      return (body.daily ?? []).map(toDaily);
    },
  };
}

interface QweatherResponse {
  code?: string;
  daily?: Array<Record<string, string | undefined>>;
  error?: { status?: number; title?: string; detail?: string };
}

function toDaily(d: Record<string, string | undefined>): QweatherDaily {
  return {
    date: d.fxDate ?? "",
    tempMaxC: num(d.tempMax),
    tempMinC: num(d.tempMin),
    textDay: d.textDay ?? "",
    windScaleDay: d.windScaleDay ?? "",
    precipitationMm: num(d.precip),
    humidityPct: num(d.humidity),
    visibilityKm: num(d.vis),
    uvIndex: num(d.uvIndex),
  };
}

function num(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── 注入点（与 setAmapClient / setCmaClient 同形态）──────────────

let client: QweatherClient | undefined;

/** 装配层注入。传 undefined 表示未接入（没配 `QWEATHER_API_KEY` / `QWEATHER_API_HOST`）。 */
export function setQweatherClient(c: QweatherClient | undefined): void {
  client = c;
}

export function getQweatherClient(): QweatherClient | undefined {
  return client;
}
