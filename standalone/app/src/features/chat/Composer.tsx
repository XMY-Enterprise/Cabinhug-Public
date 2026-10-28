/**
 * 输入条：一行输入 + 圆形发送键。回车发送、Shift+回车换行、输入法组字时不发。
 * 单机版没有麦克风（ARCH-002 能力开关全关），不放一个按不响的话筒。
 */
import { forwardRef, useImperativeHandle, useRef, useState } from "react";

import { Button } from "../../ui";
import s from "./Composer.module.css";

export interface ComposerHandle {
  /** 把一句话放进输入框并聚焦（「调整行程」先垫一句开头）。 */
  prefill(text: string): void;
}

export const Composer = forwardRef<ComposerHandle, { ready: boolean; busy: boolean; onSend(text: string): void }>(function Composer(
  { ready, busy, onSend },
  ref,
) {
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({
    prefill(text) {
      setDraft(text);
      requestAnimationFrame(() => {
        const el = input.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(text.length, text.length);
      });
    },
  }));

  function submit() {
    const text = draft.trim();
    if (!text || busy || !ready) return;
    setDraft("");
    onSend(text);
  }

  return (
    <div className={s.composer}>
      <textarea
        ref={input}
        className={s.input}
        rows={1}
        placeholder={ready ? "说说你想怎么安排…" : "本地服务启动中，稍等…"}
        disabled={!ready}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <Button variant="primary" shape="circle" icon="send" label="发送" disabled={!ready || busy || !draft.trim()} onClick={submit} />
    </div>
  );
});
