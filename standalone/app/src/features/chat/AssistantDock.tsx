/**
 * 助手（定稿 01 左下的收起条 ↔ 02/03 的对话窗）。
 *
 *   收起  头像 + 「Cabinhug 助手 ●」+ 一句状态，点一下展开
 *   展开  可拖动（标题栏）、可改大小（右下角）的对话窗：对话流、快捷动作、输入条
 *
 * 它只是对话的一个外壳：消息、发送、过期重发都在 `useChat` 与 MainScreen 里，这里不碰。
 */
import { forwardRef, useImperativeHandle, useRef, type ReactNode } from "react";

import { SPRITES } from "@cabinhug/ui";

import { Button, Card, StatusDot } from "../../ui";
import type { ChatState } from "../../useChat";
import { ChatThread } from "./ChatThread";
import { Composer, type ComposerHandle } from "./Composer";
import { useDockBox } from "./useDockBox";
import s from "./AssistantDock.module.css";

export interface QuickAction {
  label: string;
  icon: "edit" | "calendar" | "list";
  run(): void;
}

export type DockHandle = ComposerHandle;

export const AssistantDock = forwardRef<
  DockHandle,
  {
    open: boolean;
    onOpenChange(open: boolean): void;
    chat: ChatState;
    ready: boolean;
    notice: string | null;
    actions: readonly QuickAction[];
    onSend(text: string): void;
    onHistory(): void;
  }
>(function AssistantDock({ open, onOpenChange, chat, ready, notice, actions, onSend, onHistory }, ref) {
  const el = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const dock = useDockBox(el);
  useImperativeHandle(ref, () => ({ prefill: (t) => composer.current?.prefill(t) }));

  const status = !ready ? "本地服务启动中…" : chat.busy ? "正在规划…" : "需要时，随时叫我";
  const name: ReactNode = (
    <span className={s.name}>
      Cabinhug 助手
      <StatusDot tone={!ready ? "idle" : chat.busy ? "busy" : "ok"} />
    </span>
  );

  if (!open) {
    return (
      <div ref={el} className={s.anchor}>
        <Card variant="float" padding="sm" className={s.pill}>
          <button type="button" className={s.pillHit} onClick={() => onOpenChange(true)} aria-label="展开助手">
            <img src={SPRITES.light.assistant} alt="" className={s.avatarLg} draggable={false} />
            <span className={s.titles}>
              {name}
              <span className={s.hint}>{status}</span>
            </span>
          </button>
          <Button shape="circle" icon="chevron-up" label="展开助手" onClick={() => onOpenChange(true)} />
        </Card>
      </div>
    );
  }

  const { box } = dock;
  return (
    <div
      ref={el}
      className={s.anchor}
      style={{ width: box.w, height: box.h, transform: `translate(${box.x}px, ${box.y}px)` }}
    >
      <Card variant="float" padding="none" className={s.window} role="dialog" aria-label="Cabinhug 助手">
        <header className={s.head} {...dock.moveHandlers}>
          <img src={SPRITES.light.assistant} alt="" className={s.avatar} draggable={false} />
          <span className={s.titles}>
            {name}
            <span className={s.hint}>拖动标题栏可移动</span>
          </span>
          <Button variant="ghost" size="sm" icon="grid" label="历史对话" onClick={onHistory} />
          <Button variant="ghost" size="sm" icon="minus" label="收起" onClick={() => onOpenChange(false)} />
          <Button
            variant="ghost"
            size="sm"
            icon="expand"
            label={dock.maximized ? "还原大小" : "放大"}
            onClick={dock.maximized ? dock.restore : dock.maximize}
          />
        </header>
        <ChatThread
          chat={chat}
          notice={notice}
          empty="说一句想去哪、玩几天，行程会出现在地图上。"
          footer={
            actions.length > 0 && !chat.busy ? (
              <div className={s.actions}>
                {actions.map((a) => (
                  <Button key={a.label} size="sm" shape="pill" icon={a.icon} onClick={a.run}>
                    {a.label}
                  </Button>
                ))}
              </div>
            ) : undefined
          }
        />
        <Composer ref={composer} ready={ready} busy={chat.busy} onSend={onSend} />
        <span className={s.resize} aria-hidden="true" {...dock.resizeHandlers} />
      </Card>
    </div>
  );
});
