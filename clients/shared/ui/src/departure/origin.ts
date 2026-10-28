/**
 * 出发导航规划请求的两端共用部分。
 *
 * 网络本身不在这里：Tauri 里走各端的 `invoke("plan_departure_nav")`（网络在 Rust，§2.2 C2），
 * 浏览器环境走各端自己的 `devFetch`。这里只放两端完全相同的两样东西：
 * 回包归一（任何形状都收敛成 `ready`/`failed`）与起点取法。
 */

import type { NavPlanRequest, NavPlanResponse } from "@cabinhug/shared";

import type { LocationPort } from "../location";

/**
 * 打开一条外部 URL；reject = 这条打不开。出发卡按先 App scheme 再 web 兜底的顺序各试一次，
 * 两跳都失败才在卡上提示，不表现为成功。各端用 opener 插件实现它；浏览器环境不注入。
 */
export type OpenExternal = (url: string) => Promise<void>;

/** 回包归一：`ready` 必须带 plan，其余一律 `failed`（带得出原因就带上）。 */
export function normalizeNavPlanResponse(v: unknown): NavPlanResponse {
  const o = (v ?? {}) as Partial<NavPlanResponse>;
  if (o.status === "ready" && o.plan) return { status: "ready", plan: o.plan, ...(o.elapsedMs !== undefined ? { elapsedMs: o.elapsedMs } : {}) };
  return { status: "failed", ...(typeof o.reason === "string" ? { reason: o.reason } : {}) };
}

/**
 * 起点：端上最近一次定位（有则带采集时刻，网关据此算新鲜度）；没有就 undefined，
 * 回退到常住地是网关的事（它持有 OwnerProfileRepository），端上不猜。
 *
 * 端口由调用方传入（组件里 `getLocationPort()`）：本文件只 `import type`，因为
 * 各端的 node:test 会经子路径 `@cabinhug/ui/departure` 引到这里，运行时依赖会把 png 资源一起带进来。
 */
export async function currentOriginForNav(port: Pick<LocationPort, "getState">): Promise<NavPlanRequest["origin"] | undefined> {
  try {
    const s = await port.getState();
    const fix = s.lastFix;
    if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon)) return undefined;
    return { lat: fix.lat, lon: fix.lon, ...(fix.at ? { at: fix.at } : {}) };
  } catch {
    return undefined;
  }
}
