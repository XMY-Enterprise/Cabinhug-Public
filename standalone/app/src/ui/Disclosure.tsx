/** 可收起的一节：「景点介绍 ⌃」「周边餐饮 ⌄」。头是按钮，内容收起时不渲染。 */
import { useState, type ReactNode } from "react";

import { Icon, type IconName } from "./Icon";
import s from "./Disclosure.module.css";

export function Disclosure({
  title,
  icon,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon?: IconName;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={s.section}>
      <button type="button" className={s.head} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {icon && <Icon name={icon} />}
        <span className={s.title}>{title}</span>
        <Icon name={open ? "chevron-up" : "chevron-down"} size="sm" />
      </button>
      {open && <div className={s.body}>{children}</div>}
    </section>
  );
}
