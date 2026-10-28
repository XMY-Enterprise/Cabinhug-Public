/**
 * SSE 读取 —— 用 `fetch` 而不是 `EventSource`。
 *
 * # 为什么不用 EventSource
 *
 * 它设不了请求头，带 token 只能放进 query，而 URL 会进服务端访问日志、浏览器历史与 Referer。
 * 后台的 token 能读全部会话，不应出现在这些地方。
 *
 * 代价是自动重连要自己实现（下面那层），token 照常走 `Authorization`。
 *
 * # 重连要有退避，且状态对页面可见
 *
 * 固定 1s 重连会在网关重启时产生大量请求。退避到 15s 封顶；
 * 状态经 `onState` 交给页面：没有事件的实时流与断线在外观上无法区分，
 * 页面必须能显示连接是否正常。
 */

import { getToken } from "./index";

export type StreamState = "connecting" | "open" | "closed";

export interface StreamHandle {
  close(): void;
}

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 15_000;

export function openEventStream<T>(
  path: string,
  handlers: {
    onEvent: (e: T) => void;
    onState?: (s: StreamState, detail?: string) => void;
  },
): StreamHandle {
  let stopped = false;
  let abort: AbortController | undefined;
  let backoff = BACKOFF_START_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = async (): Promise<void> => {
    if (stopped) return;
    handlers.onState?.("connecting");
    abort = new AbortController();
    try {
      const token = getToken();
      const res = await fetch(path, {
        signal: abort.signal,
        headers: {
          accept: "text/event-stream",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!res.ok || !res.body) {
        // 401/403/503 不应无限重试同一个错误，把错误码报给页面，
        // 而不是让页面显示成仍在连接。
        let code = `http_${res.status}`;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) code = body.error;
        } catch {
          /* 非 JSON 错误体 */
        }
        throw new Error(code);
      }
      handlers.onState?.("open");
      backoff = BACKOFF_START_MS;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done || stopped) break;
        buffer += decoder.decode(value, { stream: true });
        // 按帧（空行）切，不是按行：一条长事件会被切成好几段到达，
        // 按行处理会解析到半条 JSON。
        let sep = buffer.indexOf("\n\n");
        while (sep !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          sep = buffer.indexOf("\n\n");
          const line = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue; // 注释行：心跳
          try {
            handlers.onEvent(JSON.parse(line.slice(5).trim()) as T);
          } catch {
            /* 坏事件丢一条，不断流 */
          }
        }
      }
      if (!stopped) throw new Error("stream_ended");
    } catch (err) {
      if (stopped) return;
      handlers.onState?.("closed", err instanceof Error ? err.message : String(err));
      timer = setTimeout(() => void connect(), backoff);
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
    }
  };

  void connect();

  return {
    close() {
      stopped = true;
      if (timer) clearTimeout(timer);
      abort?.abort();
      handlers.onState?.("closed");
    },
  };
}
