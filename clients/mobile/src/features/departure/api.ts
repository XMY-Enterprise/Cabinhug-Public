/**
 * features/departure — 出发导航规划的手机端请求封装（与车机对齐）。
 *
 * 形态同 `guide/jobs.ts`：JS 只封装 invoke（网络在 Rust，§2.2 C2），纯浏览器预览回落 `/v1` 代理。
 * 回包归一与起点取法是 `@cabinhug/ui/departure` 的共享纯逻辑，与车机相同。
 * 任何异常都收敛成 `{status:"failed"}`：出发卡据此走直连，不把降级渲染成报错
 * （旧版 Rust 二进制没有这个命令时 invoke 会 reject，同样处理）。
 */

import { invoke } from "@tauri-apps/api/core";

import type { NavPlanRequest, NavPlanResponse } from "@cabinhug/shared";
import { normalizeNavPlanResponse, type OpenExternal } from "@cabinhug/ui/departure";

import { devFetch } from "../../devAuth";

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function requestNavPlan(body: NavPlanRequest): Promise<NavPlanResponse> {
  try {
    if (isTauriEnv()) {
      const raw = await invoke<string>("plan_departure_nav", { bodyJson: JSON.stringify(body) });
      return normalizeNavPlanResponse(JSON.parse(raw));
    }
    const r = await devFetch("/v1/trip-plan/nav-plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { status: "failed", reason: `http_${r.status}` };
    return normalizeNavPlanResponse(await r.json());
  } catch {
    return { status: "failed", reason: "failed" };
  }
}

/**
 * Tauri 里 WKWebView 会静默忽略 `target=_blank`（车机与手机是同一种 WebView）：
 * 注入 opener 插件（iOS 是 UIApplication openURL，能唤起 `iosamap://` 的高德 App；
 * 可开清单钉在 `src-tauri/capabilities/default.json`）。纯浏览器不注入，出发卡让 `<a>` 自己跳。
 */
export function tauriOpener(): OpenExternal | undefined {
  if (!isTauriEnv()) return undefined;
  return (url) => invoke<void>("plugin:opener|open_url", { url });
}
