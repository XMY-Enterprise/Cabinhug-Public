/**
 * 时间轴：左侧一根橙线串起圆点，每行「时刻 · [配图] · 标题 / 说明 · ›」。
 *
 * 三处用法是同一个组件、换参数，不各写一份：
 *   1 倍面板   带配图（`media`）、一行说明
 *   2 倍面板   不带配图、`density="compact"`，选中行浅橙底
 *   全屏天卡   不带配图、两行说明
 */
import type { ReactNode } from "react";

import { cx } from "./cx";
import { Icon } from "./Icon";
import s from "./Timeline.module.css";

export function Timeline({ density = "comfortable", children }: { density?: "comfortable" | "compact"; children: ReactNode }) {
  return <ol className={cx(s.timeline, s[density])}>{children}</ol>;
}

export function TimelineItem({
  time,
  title,
  subtitle,
  media,
  active,
  onClick,
  chevron = onClick !== undefined,
}: {
  time?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  media?: ReactNode;
  active?: boolean;
  onClick?: () => void;
  chevron?: boolean;
}) {
  const body = (
    <>
      <span className={s.rail} aria-hidden="true">
        <span className={s.dot} />
      </span>
      <span className={cx(s.time, "sa-num")}>{time ?? ""}</span>
      {media && <span className={s.media}>{media}</span>}
      <span className={s.content}>
        <span className={s.title}>{title}</span>
        {subtitle && <span className={s.subtitle}>{subtitle}</span>}
      </span>
      {chevron && <Icon name="chevron-right" size="sm" className={s.chevron} />}
    </>
  );
  return (
    <li className={cx(s.item, active && s.active)}>
      {onClick ? (
        <button type="button" className={s.row} onClick={onClick} aria-current={active || undefined}>
          {body}
        </button>
      ) : (
        <div className={s.row}>{body}</div>
      )}
    </li>
  );
}
