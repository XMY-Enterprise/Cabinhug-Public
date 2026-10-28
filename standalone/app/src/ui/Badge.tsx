/**
 * 小标签：状态徽标（已确认 / 草案）、属性标签（历史街区 / 建议停留 1.5 小时）、角标（估算）。
 *
 *   ok      绿底绿字：已确认、已验证
 *   pending 白底橙描边：草案、超出预报窗口——"还没定"
 *   info    浅蓝底：品类
 *   brand   浅橙底：时长这类"建议"
 *   neutral 描边灰字：估算
 */
import type { ReactNode } from "react";

import { cx } from "./cx";
import { Icon, type IconName } from "./Icon";
import s from "./Badge.module.css";

export function Badge({
  tone = "neutral",
  size = "md",
  icon,
  children,
}: {
  tone?: "ok" | "pending" | "info" | "brand" | "neutral";
  size?: "sm" | "md";
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <span className={cx(s.badge, s[tone], s[size])}>
      {icon && <Icon name={icon} size="sm" />}
      {children}
    </span>
  );
}
