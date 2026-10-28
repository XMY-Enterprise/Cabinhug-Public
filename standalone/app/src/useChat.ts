/**
 * 一个会话的对话状态：历史回源 + 事件流投影（复用 `@cabinhug/ui` 与 Rust 逐条对齐的 `project()`）。
 * 用户消息与助手回复都由事件流回流，不做本地乐观插入（同两个端，见 mobile chat.rs 的注释）。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { BRIDGE_EVENTS, type ChatMessage, type EventEnvelope, type PermissionRequest } from "@cabinhug/shared";
import { project, TurnAccumulator } from "@cabinhug/ui/web-shim";

import { GatewayError, gw, openStream } from "./api";

/** `sent` 已交给网关；`expired` 这个会话已被服务端按空闲关掉（409），调用方换新会话重发；`failed` 已在界面报错。 */
export type SendResult = "sent" | "expired" | "failed";

export interface ChatState {
  messages: ChatMessage[];
  /** 正在生成的这一轮的正文（turn_end 之后并入 messages）。 */
  streaming: string;
  busy: boolean;
  permission: PermissionRequest | null;
  error: string | null;
  send(text: string): Promise<SendResult>;
  /**
   * 给一个**即将切过去**的会话排一句话：那个会话的事件流接上（`onOpen`）之后才发，
   * 先发会丢掉这一轮的回流。新会话的第一句、会话过期后的重发都走这里。
   */
  queue(sessionId: string, text: string): void;
  answerPermission(approved: boolean): Promise<void>;
}

function upsert(list: ChatMessage[], m: ChatMessage): ChatMessage[] {
  const i = list.findIndex((x) => x.messageId === m.messageId);
  if (i < 0) return [...list, m];
  const next = list.slice();
  next[i] = m;
  return next;
}

export function useChat(sessionId: string | null, events: { onTurnEnd(): void; onTitle(): void }): ChatState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handlers = useRef(events);
  handlers.current = events;
  const queued = useRef<{ sessionId: string; text: string } | null>(null);

  const post = useCallback(async (id: string, text: string): Promise<SendResult> => {
    setError(null);
    setBusy(true);
    try {
      await gw("POST", `/v1/session/${id}/messages`, { content: text });
      return "sent";
    } catch (err) {
      setBusy(false);
      // 不报错：调用方会换一个会话把这句话重发，车主的话不丢（同两个端的 sendWithRetry）。
      if (err instanceof GatewayError && err.code === "session_expired") return "expired";
      setError(`没发出去：${err instanceof Error ? err.message : String(err)}`);
      return "failed";
    }
  }, []);

  useEffect(() => {
    setMessages([]);
    setStreaming("");
    setBusy(queued.current !== null && queued.current.sessionId === sessionId);
    setPermission(null);
    setError(null);
    if (!sessionId) return;
    let alive = true;
    let close: (() => void) | undefined;
    const acc = new TurnAccumulator();
    (async () => {
      const page = await gw<{ messages: ChatMessage[] }>("GET", `/v1/session/${sessionId}/messages`);
      if (!alive) return;
      setMessages(page.messages ?? []);
      const stop = await openStream(`/v1/session/${sessionId}/stream`, {
        onOpen: () => {
          const q = queued.current;
          if (!alive || !q || q.sessionId !== sessionId) return;
          queued.current = null;
          void post(sessionId, q.text);
        },
        onData: (data) => {
          let env: EventEnvelope;
          try {
            env = JSON.parse(data) as EventEnvelope;
          } catch {
            return;
          }
          for (const e of project(env, acc)) {
            switch (e.event) {
              case BRIDGE_EVENTS.dialogDelta:
                setBusy(true);
                setStreaming((s) => s + (e.payload as { text: string }).text);
                break;
              case BRIDGE_EVENTS.dialogMessage: {
                const m = e.payload as ChatMessage;
                setMessages((list) => upsert(list, m));
                if (m.role === "assistant") setStreaming("");
                else setBusy(true);
                break;
              }
              case BRIDGE_EVENTS.assistantState:
                if (e.payload === "idle") {
                  setBusy(false);
                  setStreaming("");
                  handlers.current.onTurnEnd();
                } else {
                  setBusy(true);
                }
                break;
              case BRIDGE_EVENTS.dialogPermission:
                setPermission(e.payload as PermissionRequest);
                break;
              case BRIDGE_EVENTS.dialogTitle:
                handlers.current.onTitle();
                break;
              default:
                break;
            }
          }
        },
        onClosed: (reason) => {
          if (alive && reason !== "ended") setError(`和本地服务的连接断了：${reason}`);
        },
      });
      if (alive) close = stop;
      else stop();
    })().catch((err: unknown) => {
      if (alive) setError(String(err instanceof Error ? err.message : err));
    });
    return () => {
      alive = false;
      close?.();
    };
  }, [sessionId, post]);

  const send = useCallback(
    async (text: string): Promise<SendResult> => {
      if (!sessionId || !text.trim()) return "failed";
      return post(sessionId, text.trim());
    },
    [sessionId, post],
  );

  const queue = useCallback((id: string, text: string) => {
    queued.current = { sessionId: id, text: text.trim() };
  }, []);

  const answerPermission = useCallback(
    async (approved: boolean) => {
      if (!sessionId || !permission) return;
      const { interruptId } = permission;
      setPermission(null);
      try {
        await gw("POST", `/v1/session/${sessionId}/resume`, { interruptId, approved });
      } catch (err) {
        // 不静默：车主按了确认却没生效，会以为已经定了。
        setError(`${approved ? "确认" : "拒绝"}没送到：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [sessionId, permission],
  );

  return { messages, streaming, busy, permission, error, send, queue, answerPermission };
}
