/**
 * 天气基础预报供应商（ACR-052）。
 *
 * 供应商是**显式配置**，不按"配了哪把 key"隐式推断：Open-Meteo 的免费接口与高德天气的
 * 免费额度都限非商业用途，静默兜底会让部署在不知情时用上非商用来源。
 *
 * 三处消费方共用这一份：`@cabinhug/db` 的配置注册表（取值校验与缺省值）、`@cabinhug/tools`
 * 的 weather 工具（按它选路）、两端 HUD（`WeatherSource` 的形状）。
 *
 * 署名的名称与链接表**不放这里**：本包端上也会 import，端上不得出现非网关地址（check:arch
 * 的 client-isolation）。那张表在 `@cabinhug/tools` 的 `WEATHER_SOURCES`，随数据下发到端上。
 */

export const WEATHER_PROVIDERS = ["qweather", "amap", "open-meteo"] as const;

export type WeatherProvider = (typeof WEATHER_PROVIDERS)[number];

/** 缺省和风天气：三家里唯一在免费额度内允许商用的（条件是署名）。 */
export const DEFAULT_WEATHER_PROVIDER: WeatherProvider = "qweather";

export function isWeatherProvider(v: string): v is WeatherProvider {
  return (WEATHER_PROVIDERS as readonly string[]).includes(v);
}

/** 数据来源署名：显示名 + 链接。和风的署名要求是「和风天气」字样并链接官网。 */
export interface WeatherSource {
  name: string;
  url: string;
}
