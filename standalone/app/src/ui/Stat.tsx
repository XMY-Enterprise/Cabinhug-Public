/** 一格指标：图标 + 标签 + 值（「⚡ 下一站 钱江世纪公园」「🚗 去程 约 2 小时 38 分」）。 */
import type { ReactNode } from "react";

import { Icon, type IconName } from "./Icon";
import s from "./Stat.module.css";

export function Stat({ icon, label, children }: { icon: IconName; label?: string; children: ReactNode }) {
  return (
    <span className={s.stat}>
      <Icon name={icon} className={s.icon} />
      {label && <span className={s.label}>{label}</span>}
      <span className={`${s.value} sa-num`}>{children}</span>
    </span>
  );
}

/** 一排指标，中间竖线隔开。 */
export function StatRow({ children }: { children: ReactNode }) {
  return <div className={s.row}>{children}</div>;
}
