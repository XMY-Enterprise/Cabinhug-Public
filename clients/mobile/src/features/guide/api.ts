/**
 * features/guide — 导览简报取数。
 *
 * 形态同 `features/ownership/api.ts`：JS 只封装 invoke，网络在 Rust
 * （`commands/profile.rs` 的 `get_guide_brief` → cabinhug-net）。
 * 纯浏览器预览（vite 直开 1420，无 Tauri 桥）回落 vite 的 `/v1` 代理，
 * 只在 dev 存在，release 客户端恒为 Tauri 环境。鉴权见 `devAuth`：
 * 预览者自己贴 token，网关不接受硬编码的 `demo-token`。
 */

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useRef, useState } from "react";

import { guideBriefIsEmpty, type GuideBriefResponse } from "@cabinhug/shared";

import { devFetch } from "../../devAuth";
import { DEMO_GUIDE_BRIEF, isGuideDemo, type GuideScreenState } from "@cabinhug/ui";

export interface GuideRequestBody {
  spotName: string;
  city?: string;
  date?: string;
  selfDrive?: boolean;
  /** 「重新采集」：跳过服务端持久层，强制重采。 */
  force?: boolean;
}

function isTauriEnv(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function requestGuideBrief(body: GuideRequestBody): Promise<GuideBriefResponse> {
  if (isTauriEnv()) {
    return JSON.parse(
      await invoke<string>("get_guide_brief", { bodyJson: JSON.stringify(body) }),
    ) as GuideBriefResponse;
  }
  const r = await devFetch("/v1/guide/brief", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { status: "failed" };
  return (await r.json()) as GuideBriefResponse;
}

/**
 * 导览页状态机：open(spot) → collecting → ready/failed；close 作废在途请求
 * （迟到结果按序号丢弃，避免旧请求的数据覆盖新页面，同 cockpit）。
 */
export function useGuideBrief(context?: Omit<GuideRequestBody, "spotName">) {
  /*
   * `?guide=demo`：直接落在 ready 态，作为版式截图入口，与 `?plan=demo` / `?hitl=demo` 同一类。
   * 真实简报要经网关 → runtime → 联网检索（冷启约 50 秒），纯浏览器预览拿不到。
   * 演示数据在 `@cabinhug/ui`，两端同一份。
   */
  const [guide, setGuide] = useState<{ spot: string; state: GuideScreenState } | null>(() =>
    isGuideDemo() ? { spot: DEMO_GUIDE_BRIEF.spot, state: { status: "ready", brief: DEMO_GUIDE_BRIEF } } : null,
  );
  const seqRef = useRef(0);
  const contextRef = useRef(context);
  contextRef.current = context;

  const open = useCallback((spotName: string, opts?: { force?: boolean }) => {
    const seq = ++seqRef.current;
    setGuide({ spot: spotName, state: { status: "collecting" } });
    void requestGuideBrief({
      spotName,
      selfDrive: true,
      ...contextRef.current,
      ...(opts?.force ? { force: true } : {}),
    })
      .catch(() => ({ status: "failed" }) as GuideBriefResponse)
      .then((resp) => {
        if (seqRef.current !== seq) return;
        setGuide((cur) =>
          cur && cur.spot === spotName
            ? {
                spot: spotName,
                state:
                  // 三支全空的"ready"按 failed 呈现（有重试钮），不显示空栏目页。
                  resp.status === "ready" && resp.brief && !guideBriefIsEmpty(resp.brief)
                    ? { status: "ready", brief: resp.brief, cached: resp.cached }
                    : { status: "failed" },
              }
            : cur,
        );
      });
  }, []);

  const close = useCallback(() => {
    seqRef.current += 1;
    setGuide(null);
  }, []);

  return { guide, open, close };
}
