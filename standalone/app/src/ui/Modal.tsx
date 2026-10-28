/** 弹窗：遮罩 + 居中白卡。点遮罩或按 Esc 关。`wide` 给放得下一排三张卡的内容（设置里的费用明细）。 */
import { useEffect, type ReactNode } from "react";

import { Button } from "./Button";
import { cx } from "./cx";
import s from "./Modal.module.css";

export function Modal({
  title,
  onClose,
  actions,
  size = "md",
  children,
}: {
  title: string;
  onClose(): void;
  actions?: ReactNode;
  size?: "md" | "wide";
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className={s.scrim} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx(s.dialog, size === "wide" && s.wide)} role="dialog" aria-modal="true" aria-label={title}>
        <header className={s.head}>
          <h2 className={s.title}>{title}</h2>
          <Button variant="ghost" icon="x" label="关闭" onClick={onClose} />
        </header>
        <div className={s.body}>{children}</div>
        {actions && <footer className={s.actions}>{actions}</footer>}
      </div>
    </div>
  );
}
