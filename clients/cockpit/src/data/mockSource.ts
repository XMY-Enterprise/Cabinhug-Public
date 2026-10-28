/**
 * HUD 数据源抽象与 mock 实现
 *
 * 真实实现将走网关的 REST + SSE（**不使用 WebSocket**，见 内部开发指引 / 架构 §3）。
 * 本文件只提供契约与可替换的 mock，SSE 实现位见 createSseHudSource。
 */
import { WEATHER_LABELS, paginateTipItems, type HudSnapshot, type WeatherKind } from "./types";
import type { HudDataSource } from "@cabinhug/ui";

/*
 * 网关数据源、常住地 mock 与实时能量在 @cabinhug/ui（两端共用一份）。
 * 这里只留车机自己的 mock 基线与 Tauri 取数适配（`invokeFetchTripPlan` / `invokeFetchEnergy`）。
 */
export { MOCK_HOME, createGatewayHudSource } from "@cabinhug/ui";
export type { GatewayHudSource, GatewayHudSourceOptions, HomePlace, HudDataSource } from "@cabinhug/ui";

/** Tauri 取数适配（§2.2 C2：网络在 Rust，WebView 只 invoke）。 */
export async function invokeFetchTripPlan(refreshPretrip = false): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  // 参数名按 Tauri 的 camelCase 约定传（Rust 侧是 `refresh_pretrip: Option<bool>`）。
  return invoke<string>("fetch_trip_plan", { refreshPretrip });
}
/**
 * 行程核查「知道了」。Tauri 里经 Rust 命令；浏览器走查走 `devFetch`
 * （与 `/v1/guide/jobs/trigger` 同一形态，App 里按 `isTauriEnv()` 分流）。
 */
export async function invokeAckTripReview(planId: string, reviewId: string): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("ack_trip_review", {
    planId,
    bodyJson: JSON.stringify({ reviewId }),
  });
}
export async function invokeFetchEnergy(vin: string): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("fetch_vehicle_energy", { vin });
}

/* 一件物品只上一次卡。贴纸按 key 取，同 key 的条目会画出同一张图、只换名字，
   看起来像同一件东西推荐了两遍，所以默认快照不补第 2 页。
   分页能力由 `paginateTipItems` 的单测覆盖。 */
const SUNNY_ITEMS = [
  { key: "hat", label: "遮阳帽" },
  { key: "sunscreen", label: "防晒霜" },
  { key: "water", label: "水" },
];

/* 雨天清单受**贴纸**限制：只有遮阳帽 / 防晒霜 / 水三张图（sprites.ts），
   而图标下要显示物品名，名字必须叫得出图上画的那件东西（例如不能用「防水袋」配防晒霜的图）。
   要出雨具，先补雨伞/雨衣贴纸再加条目。 */
const RAINY_ITEMS = [
  { key: "hat", label: "遮阳帽" },
  { key: "water", label: "保温水杯" },
  { key: "sunscreen", label: "防晒霜" },
];

/** 定稿同款晴热数据（Brief §3.2 的 36 km / 68% / 21%）。 */
export function makeSnapshot(weather: WeatherKind = "sunny"): HudSnapshot {
  // 演示数据：只有"晴"与"非晴"两套物品；天气名一律查 WEATHER_LABELS。
  const sunny = weather === "sunny";
  return {
    trip: {
      origin: { anchor: "home", name: "家", kind: "home" },
      nodes: [
        { anchor: "park", name: "亲子乐园", kind: "leisure" },
        { anchor: "charge", name: "充电站", kind: "charging" },
        { anchor: "rest", name: "休息区", kind: "rest" },
        { anchor: "wetland", name: "湿地公园", kind: "nature" },
      ],
      activeSegment: 1,
    },
    energy: { distanceKm: 36, batteryPercent: 68, requiredPercent: 21 },
    tips: {
      headline: "行前温馨提示",
      pages: paginateTipItems(sunny ? SUNNY_ITEMS : RAINY_ITEMS),
    },
    weather: { kind: weather, label: WEATHER_LABELS[weather] },
    assistantState: "idle",
    freshness: { stale: false, updatedAt: "刚刚" },
  };
}

/** Mock 数据源：立即推一帧，支持外部切换天气以验证服饰/物品一致性。 */
export function createMockHudSource(weather: WeatherKind = "sunny"): HudDataSource {
  return {
    subscribe(onSnapshot) {
      onSnapshot(makeSnapshot(weather));
      return () => {};
    },
  };
}
