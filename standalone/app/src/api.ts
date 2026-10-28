/**
 * 界面与 Rust 侧的全部往来（ACR-063）。界面不直接连网关：请求与事件流都经 Rust 转发，
 * 登录口令与令牌留在 Rust 侧。
 */
import { Channel, invoke } from "@tauri-apps/api/core";

import type { ClientConfig, CredentialGroup, HostStatus, Verdict } from "./types";

export const host = {
  status: () => invoke<HostStatus>("host_status"),
  groups: () => invoke<CredentialGroup[]>("credential_groups"),
  save: (group: string, values: Record<string, string>) => invoke<Verdict>("save_credentials", { group, values }),
  start: () => invoke<void>("start_host"),
  restart: () => invoke<void>("restart_host"),
  clientConfig: () => invoke<ClientConfig>("client_config"),
  openApplyPage: (url: string) => invoke<void>("open_apply_page", { url }),
  openLogDir: () => invoke<void>("open_log_dir"),
};

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    path: string,
  ) {
    super(`${path} → ${status}${code ? " " + code : ""}`);
  }
}

/** 经 Rust 转发一个网关请求。2xx 之外一律抛 `GatewayError`，带上网关给的 `error` 码。 */
export async function gw<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await invoke<{ status: number; body: string }>("gateway_request", { method, path, body: body ?? null });
  const parsed = res.body ? (JSON.parse(res.body) as unknown) : undefined;
  if (res.status >= 400) {
    const code = parsed && typeof parsed === "object" && "error" in parsed ? String((parsed as { error: unknown }).error) : null;
    throw new GatewayError(res.status, code, path);
  }
  return parsed as T;
}

type StreamMsg = { kind: "open" } | { kind: "data"; data: string } | { kind: "closed"; reason: string };

export interface StreamHandlers {
  /** 网关已接上（已订阅这个会话）：此后发的消息，回流一定收得到。 */
  onOpen(): void;
  onData(data: string): void;
  onClosed(reason: string): void;
}

/** 打开一条 SSE。返回关闭函数（`invoke` 返回时还没接上，接上以 `onOpen` 为准）。 */
export async function openStream(path: string, on: StreamHandlers): Promise<() => void> {
  const channel = new Channel<StreamMsg>();
  channel.onmessage = (m) => (m.kind === "open" ? on.onOpen() : m.kind === "data" ? on.onData(m.data) : on.onClosed(m.reason));
  const id = await invoke<number>("gateway_stream", { path, onEvent: channel });
  return () => {
    void invoke("gateway_stream_close", { id });
  };
}
