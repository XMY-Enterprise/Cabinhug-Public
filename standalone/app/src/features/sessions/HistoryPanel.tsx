/**
 * 历史对话（导航栏「历史」）：按今天 / 昨天 / 更早分组，点一条切过去。
 * 浮在导航栏右边，不占地图；切过去或点空白处就收起。
 */
import { useEffect } from "react";

import type { SessionItem } from "../../types";
import { Button, Card, cx } from "../../ui";
import s from "./HistoryPanel.module.css";

function sessionTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function dayGroup(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "今天";
  if (d.toDateString() === yesterday.toDateString()) return "昨天";
  return "更早";
}

export function HistoryPanel({
  sessions,
  current,
  onOpen,
  onNew,
  onClose,
}: {
  sessions: readonly SessionItem[];
  current: string | null;
  onOpen(sessionId: string): void;
  onNew(): void;
  onClose(): void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const groups = new Map<string, SessionItem[]>();
  for (const x of sessions) {
    const g = dayGroup(x.updatedAt);
    groups.set(g, [...(groups.get(g) ?? []), x]);
  }
  return (
    <div className={s.scrim} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <Card variant="float" padding="none" as="aside" className={s.panel} aria-label="历史对话">
        <header className={s.head}>
          <h2 className={s.title}>历史对话</h2>
          <Button variant="ghost" icon="x" label="关闭" onClick={onClose} />
        </header>
        <div className={s.new}>
          <Button variant="primary" block icon="plus" onClick={onNew}>
            新行程
          </Button>
        </div>
        <nav className={s.list}>
          {sessions.length === 0 && <p className={s.empty}>还没有对话</p>}
          {[...groups.entries()].map(([g, list]) => (
            <section key={g}>
              <h3 className={s.group}>{g}</h3>
              {list.map((x) => (
                <button
                  key={x.sessionId}
                  type="button"
                  className={cx(s.item, x.sessionId === current && s.active)}
                  aria-current={x.sessionId === current || undefined}
                  onClick={() => onOpen(x.sessionId)}
                >
                  <span className={s.itemTitle}>{x.title ?? "新对话"}</span>
                  <span className={`${s.itemTime} sa-num`}>{sessionTime(x.updatedAt)}</span>
                </button>
              ))}
            </section>
          ))}
        </nav>
      </Card>
    </div>
  );
}
