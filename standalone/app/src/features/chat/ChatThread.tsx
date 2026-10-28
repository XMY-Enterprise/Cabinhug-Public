/**
 * 对话流：用户气泡靠右浅橙底，助手气泡靠左白底带小头像。正在生成的一轮跟在末尾。
 * 助手正文里的 `**关键信息**` 渲染成高亮，规则与两个端同一份（`splitHighlights`）。
 */
import { useEffect, useRef, type ReactNode } from "react";

import type { ChatMessage } from "@cabinhug/shared";
import { splitHighlights, SPRITES } from "@cabinhug/ui";

import { Callout, cx } from "../../ui";
import type { ChatState } from "../../useChat";
import s from "./ChatThread.module.css";

export function ChatThread({
  chat,
  notice,
  empty,
  footer,
}: {
  chat: Pick<ChatState, "messages" | "streaming" | "busy" | "error">;
  notice: string | null;
  empty: string;
  /** 末尾跟一排快捷动作。 */
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [chat.messages, chat.streaming, chat.busy]);
  return (
    <div className={s.thread} ref={ref}>
      {chat.messages.length === 0 && !chat.streaming && !chat.busy && <p className={s.empty}>{empty}</p>}
      {chat.messages.map((m) => (
        <Bubble key={m.messageId} message={m} />
      ))}
      {chat.streaming && (
        <AssistantRow>
          <RichText text={chat.streaming} />
        </AssistantRow>
      )}
      {chat.busy && !chat.streaming && (
        <AssistantRow muted>
          <span className={s.dots}>正在规划</span>
        </AssistantRow>
      )}
      {notice && <Callout>{notice}</Callout>}
      {chat.error && <p className={s.error}>{chat.error}</p>}
      {footer}
    </div>
  );
}

function RichText({ text }: { text: string }) {
  return (
    <>
      {splitHighlights(text).map((seg, i) =>
        seg.key ? (
          <mark key={i} className={s.key}>
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

function AssistantRow({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <div className={s.assistantRow}>
      <img src={SPRITES.light.assistant} alt="" className={s.avatar} draggable={false} />
      <div className={cx(s.bubble, s.assistant, muted && s.muted)}>{children}</div>
    </div>
  );
}

function Bubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    // 车主自己打的字原样显示：真打了两个星号就该看到星号。
    return <div className={cx(s.bubble, s.user)}>{message.content}</div>;
  }
  return (
    <AssistantRow>
      <RichText text={message.content} />
      {message.sources?.length ? <div className={s.sources}>引用来源：{message.sources.map((x) => x.name).join("、")}</div> : null}
    </AssistantRow>
  );
}
