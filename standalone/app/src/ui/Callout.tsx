/**
 * 说明条：不是故障，是交代一件事。
 *   info  浅蓝底（天气提醒、"这份草案来自另一段对话"）
 *   warn  浅橙底（出行提示、估算价格的声明）
 * 真正的错误不用它，用就地的红字。
 */
import type { ReactNode } from "react";

import { cx } from "./cx";
import { Icon, type IconName } from "./Icon";
import s from "./Callout.module.css";

export function Callout({
  tone = "info",
  icon = tone === "warn" ? "alert" : "info",
  title,
  children,
}: {
  tone?: "info" | "warn";
  icon?: IconName;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx(s.callout, s[tone])} role="note">
      <Icon name={icon} className={s.icon} />
      <div className={s.text}>
        {title && <strong className={s.title}>{title}：</strong>}
        {children}
      </div>
    </div>
  );
}
