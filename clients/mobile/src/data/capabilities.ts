/**
 * 能力开关的端上一侧（ACR-057）：取网关下发的关闭清单，决定拍照问诊入口显不显示。
 *
 * # 取不到就沿用上一次，初值全开
 *
 * 旧网关没有 `/v1/capabilities`、网络抖动、503——都不能把入口藏起来：分离部署下所有能力本来就开着。
 * 只有网关明确下发「photo-diagnosis 关闭」时入口才消失。拦截不靠这里（网关对照片回 403），
 * 这里只省掉「拍完才被拒」的那一步。
 *
 * 网络在 Rust（§2.2 C2），WebView 只 invoke；取数函数由调用方注入，本模块不认识 Tauri。
 */

import { useEffect, useState } from "react";

import { capabilitiesFromPayload, type Capability } from "@cabinhug/shared";

/** 网关没给 refreshMs、或这次没取到时的复查间隔。与网关的 30 秒同量级。 */
export const CAPABILITIES_RETRY_MS = 30_000;

/** 解析一次下发。形状不对返回 undefined（调用方沿用上一次的值）。 */
export function parseCapabilitiesResponse(raw: string): { off: Set<Capability>; refreshMs: number } | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const off = capabilitiesFromPayload(json);
  if (!off) return undefined;
  const r = (json as { refreshMs?: unknown }).refreshMs;
  return { off, refreshMs: typeof r === "number" && r >= 1_000 ? r : CAPABILITIES_RETRY_MS };
}

const sameSet = (a: ReadonlySet<Capability>, b: ReadonlySet<Capability>) => a.size === b.size && [...a].every((c) => b.has(c));

/**
 * 轮询：立刻取一次，之后按下发的 `refreshMs` 复查。只在集合真的变了时回调。
 * 返回停止函数。定时器可注入（测试用）。
 */
export function startCapabilitiesPolling(
  fetchRaw: () => Promise<string>,
  onChange: (off: ReadonlySet<Capability>) => void,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  },
): () => void {
  let current: ReadonlySet<Capability> = new Set();
  let stopped = false;
  let handle: unknown;
  const tick = async () => {
    let next = CAPABILITIES_RETRY_MS;
    try {
      const parsed = parseCapabilitiesResponse(await fetchRaw());
      if (parsed) {
        next = parsed.refreshMs;
        if (!stopped && !sameSet(parsed.off, current)) {
          current = parsed.off;
          onChange(current);
        }
      }
    } catch {
      // 取不到：沿用上一次的值，到点再试。
    }
    if (!stopped) handle = timers.set(() => void tick(), next);
  };
  void tick();
  return () => {
    stopped = true;
    if (handle !== undefined) timers.clear(handle);
  };
}

/** 当前关闭的能力。`fetchRaw` 缺席（浏览器预览）恒为空集 = 全开。 */
export function useCapabilitiesOff(fetchRaw: (() => Promise<string>) | undefined): ReadonlySet<Capability> {
  const [off, setOff] = useState<ReadonlySet<Capability>>(() => new Set());
  useEffect(() => {
    if (!fetchRaw) return;
    return startCapabilitiesPolling(fetchRaw, setOff);
  }, [fetchRaw]);
  return off;
}
