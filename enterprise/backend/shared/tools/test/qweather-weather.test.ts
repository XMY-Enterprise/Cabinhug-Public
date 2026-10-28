/**
 * 和风天气接入单测（ACR-052）。
 *
 * 与 `amap.test.ts` 同一条约束：不打网络。和风的响应用 stub fetch 喂进去，
 * 断言的是对它的解读（字符串数值、两种失败形态、窗口、署名）。
 * key 与 API Host 是否真的通，由 `corepack pnpm probe:weather` 走真实网络回答。
 */

import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";

import { DEFAULT_WEATHER_PROVIDER } from "@cabinhug/shared";

import { setAmapClient } from "../src/amap";
import { setCmaClient } from "../src/cma";
import { setEnvCache } from "../src/env-cache";
import { ToolError, type ToolCallContext } from "../src/external";
import { pretripItemsTool } from "../src/pretrip-items";
import { citedSourceOf } from "../src/registry";
import { createQweatherClient, setQweatherClient } from "../src/qweather";
import {
  configureWeatherProvider,
  getWeatherProvider,
  setWeatherProvider,
  WEATHER_SOURCES,
  weatherTool,
} from "../src/weather";

const ctx: ToolCallContext = { sessionId: "sess-test", agent: "trip" };
const POINT = { name: "起点", lat: 22.5437, lon: 114.0596 };

/** 北京时间的今天——与 weather.ts 的口径一致。 */
function todayCn(): string {
  return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
}
function plusDays(n: number): string {
  return new Date(Date.now() + 8 * 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);
}

/** 和风 7d 的响应形状：数值全是字符串。 */
function sevenDays(): unknown {
  return {
    code: "200",
    daily: Array.from({ length: 7 }, (_, i) => ({
      fxDate: plusDays(i),
      tempMax: String(30 + i),
      tempMin: "22",
      textDay: i === 1 ? "雷阵雨" : "多云",
      windScaleDay: "1-3",
      precip: i === 1 ? "12.5" : "0.0",
      humidity: "78",
      vis: "24",
      uvIndex: "6",
    })),
    refer: { sources: ["QWeather"], license: ["QWeather Developers License"] },
  };
}

interface Stub {
  urls: string[];
  headers: Array<Record<string, string>>;
  restore: () => void;
}

function stubFetch(respond: () => { status: number; body: unknown }): Stub {
  const original = globalThis.fetch;
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    urls.push(String(input));
    headers.push((init?.headers ?? {}) as Record<string, string>);
    const { status, body } = respond();
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { urls, headers, restore: () => (globalThis.fetch = original) };
}

before(() => {
  setWeatherProvider("qweather");
  setCmaClient(undefined);
  setEnvCache(undefined);
});
afterEach(() => {
  setQweatherClient(undefined);
  setAmapClient(undefined);
});
after(() => setWeatherProvider(DEFAULT_WEATHER_PROVIDER));

describe("weather —— 和风天气供应商（ACR-052）", () => {
  it("缺省供应商是和风", () => {
    assert.equal(DEFAULT_WEATHER_PROVIDER, "qweather");
  });

  it("映射：字符串数值转数字，带出紫外线/能见度/湿度；降雪如实标不提供", async () => {
    const stub = stubFetch(() => ({ status: 200, body: sevenDays() }));
    setQweatherClient(createQweatherClient({ apiHost: "abc.re.qweatherapi.com", apiKey: "k-test" }));
    try {
      const r = await weatherTool.call({ points: [POINT], date: plusDays(1) }, ctx);
      const seg = r.data[0];
      assert.equal(r.source.provider, "qweather");
      assert.equal(seg.tempMaxC, 31);
      assert.equal(seg.tempMinC, 22);
      assert.equal(seg.condition, "雷阵雨");
      assert.equal(seg.precipitationMm, 12.5);
      assert.equal(seg.uvIndexMax, 6);
      assert.equal(seg.visibilityKm, 24);
      assert.equal(seg.humidityPct, 78);
      assert.equal(seg.weatherCode, null, "和风图标代码不是 WMO 口径，不进 weatherCode");
      assert.equal(seg.snowfallCm, null);
      assert.ok((seg.unavailable ?? []).some((u) => u.startsWith("snowfallCm")));
      assert.deepEqual(seg.sources, ["qweather:forecast"]);
    } finally {
      stub.restore();
    }
  });

  it("请求：账号专属 Host 补上 https、坐标是「经度,纬度」两位小数、key 走请求头不进 URL", async () => {
    const stub = stubFetch(() => ({ status: 200, body: sevenDays() }));
    setQweatherClient(createQweatherClient({ apiHost: "abc.re.qweatherapi.com/", apiKey: "k-test" }));
    try {
      await weatherTool.call({ points: [POINT] }, ctx);
      const url = new URL(stub.urls[0]);
      assert.equal(url.origin, "https://abc.re.qweatherapi.com");
      assert.equal(url.pathname, "/v7/weather/7d");
      assert.equal(url.searchParams.get("location"), "114.06,22.54");
      assert.ok(!stub.urls[0].includes("k-test"), "key 不能出现在 URL 里（会进访问日志）");
      assert.equal(stub.headers[0]["X-QW-Api-Key"], "k-test");
    } finally {
      stub.restore();
    }
  });

  it("旧式失败（HTTP 200 + code≠200）被认出来，且带上错误码说明", async () => {
    const stub = stubFetch(() => ({ status: 200, body: { code: "402" } }));
    setQweatherClient(createQweatherClient({ apiHost: "abc.re.qweatherapi.com", apiKey: "k-test" }));
    try {
      await assert.rejects(weatherTool.call({ points: [POINT] }, ctx), (e: unknown) => {
        assert.ok(e instanceof ToolError);
        assert.match(e.message, /code=402/);
        assert.match(e.message, /余额不足/);
        return true;
      });
    } finally {
      stub.restore();
    }
  });

  it("新式失败（4xx + error 对象）被认出来，4xx 不重试", async () => {
    const stub = stubFetch(() => ({ status: 401, body: { error: { status: 401, title: "Unauthorized" } } }));
    setQweatherClient(createQweatherClient({ apiHost: "abc.re.qweatherapi.com", apiKey: "bad" }));
    try {
      await assert.rejects(weatherTool.call({ points: [POINT] }, ctx), /Unauthorized/);
      assert.equal(stub.urls.length, 1, "401 是 key/Host 的问题，重试只会多打几次");
    } finally {
      stub.restore();
    }
  });

  it("超出 7 天窗口 → 正常返回空档段、不出网，并写明不许据此推测", async () => {
    const stub = stubFetch(() => ({ status: 200, body: sevenDays() }));
    setQweatherClient(createQweatherClient({ apiHost: "abc.re.qweatherapi.com", apiKey: "k-test" }));
    try {
      const r = await weatherTool.call({ points: [POINT], date: plusDays(9) }, ctx);
      assert.equal(stub.urls.length, 0);
      assert.equal(r.data[0].tempMaxC, null);
      assert.match((r.data[0].unavailable ?? []).join(""), /和风天气覆盖今天起 7 天.*不要据此推测/);
    } finally {
      stub.restore();
    }
  });

  it("选了和风却没配 key → unconfigured，不退回高德或 Open-Meteo", async () => {
    const stub = stubFetch(() => ({ status: 200, body: sevenDays() }));
    try {
      await assert.rejects(
        weatherTool.call({ points: [POINT], date: todayCn() }, ctx),
        (e: unknown) => e instanceof ToolError && e.category === "unconfigured",
      );
      assert.equal(stub.urls.length, 0, "未接入时不该打任何上游");
    } finally {
      stub.restore();
    }
  });
});

describe("configureWeatherProvider —— 装配口径（ACR-052）", () => {
  it("没写 WEATHER_PROVIDER 取缺省和风；key 与 Host 齐了才算接入", () => {
    const r1 = configureWeatherProvider(() => undefined);
    assert.deepEqual(r1, { provider: "qweather", ready: false });
    const env: Record<string, string> = { QWEATHER_API_KEY: "k", QWEATHER_API_HOST: "abc.re.qweatherapi.com" };
    const r2 = configureWeatherProvider((k) => env[k]);
    assert.deepEqual(r2, { provider: "qweather", ready: true });
  });

  it("选 amap 时是否接入看高德装没装上", () => {
    assert.deepEqual(configureWeatherProvider(() => "amap"), { provider: "amap", ready: false });
    assert.equal(getWeatherProvider(), "amap");
    setWeatherProvider("qweather");
  });

  it("不认识的取值启动即抛错，不悄悄落回缺省", () => {
    assert.throws(() => configureWeatherProvider(() => "caiyun"), /WEATHER_PROVIDER=caiyun 不认识/);
  });
});

describe("pretrip_items 带出天气署名（ACR-052）", () => {
  it("真拿到和风天气时带 weatherSource，端上据此署名", async () => {
    const stub = stubFetch(() => ({ status: 200, body: sevenDays() }));
    setQweatherClient(createQweatherClient({ apiHost: "abc.re.qweatherapi.com", apiKey: "k-test" }));
    try {
      const r = await pretripItemsTool.call({ points: [POINT], date: plusDays(1) }, ctx);
      assert.equal(r.data.weatherAvailable, true);
      assert.deepEqual(r.data.weatherSource, WEATHER_SOURCES.qweather);
    } finally {
      stub.restore();
    }
  });

  it("天气没取到（fallback）时不带署名", async () => {
    const r = await pretripItemsTool.call({ points: [POINT], date: plusDays(1) }, ctx);
    assert.equal(r.data.weatherAvailable, false);
    assert.equal(r.data.weatherSource, undefined);
  });
});

describe("对话回复的引用来源：工具自己声明署名", () => {
  it("weather 真实返回署供应商名，模拟数据不署名", () => {
    const real = { data: [], source: { kind: "real", provider: "qweather", fetchedAt: "" } };
    const mock = { data: [], source: { kind: "mock", provider: "qweather", fetchedAt: "" } };
    assert.deepEqual(citedSourceOf("weather", real), WEATHER_SOURCES.qweather);
    assert.equal(citedSourceOf("weather", mock), undefined);
  });

  it("pretrip_items 沿用结果里的天气署名；没声明的工具与形状不对的结果都不署名", () => {
    const withSource = { data: { weatherSource: WEATHER_SOURCES.qweather }, source: { kind: "real" } };
    assert.deepEqual(citedSourceOf("pretrip_items", withSource), WEATHER_SOURCES.qweather);
    assert.equal(citedSourceOf("pretrip_items", { data: {} }), undefined);
    assert.equal(citedSourceOf("map_route", { source: { kind: "real", provider: "amap" } }), undefined);
    assert.equal(citedSourceOf("weather", null), undefined);
  });
});
