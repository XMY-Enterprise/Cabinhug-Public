/**
 * 按钮：四种外观 × 三档高度 × 三种形状。图标按钮就是只给 `icon` 不给字、外加 `label` 作读屏名。
 *
 *   primary   品牌橙渐变，一个视野里只放一个（定下来、在地图中定位、发送、新行程）
 *   secondary 白底描边（返回行程、调整行程、重新排）
 *   ghost     无底，悬停才有衬底（面板标题栏的关闭、最小化）
 *   float     浮在地图上的白卡按钮（行程详情 ›、缩放钮），带浮层阴影
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cx } from "./cx";
import { Icon, type IconName } from "./Icon";
import s from "./Button.module.css";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  variant?: "primary" | "secondary" | "ghost" | "float";
  size?: "sm" | "md" | "lg";
  shape?: "rounded" | "pill" | "circle";
  icon?: IconName;
  /** 图标放在字后面（「行程详情 ›」）。 */
  trailingIcon?: IconName;
  /** 只有图标时的读屏名，同时作悬停提示。 */
  label?: string;
  selected?: boolean;
  block?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  shape = "rounded",
  icon,
  trailingIcon,
  label,
  selected,
  block,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  const iconOnly = children === undefined || children === null;
  return (
    <button
      type={type}
      className={cx(
        s.button,
        s[variant],
        s[size],
        s[shape],
        iconOnly && s.iconOnly,
        selected && s.selected,
        block && s.block,
        className,
      )}
      aria-label={iconOnly ? label : undefined}
      aria-pressed={selected}
      title={label}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === "lg" ? "lg" : "md"} />}
      {!iconOnly && <span className={s.text}>{children}</span>}
      {trailingIcon && <Icon name={trailingIcon} size="sm" />}
    </button>
  );
}
