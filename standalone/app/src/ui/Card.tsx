/**
 * 面：所有"一块白"都从这里出，三种层级。
 *
 *   float  浮在地图上（概要卡、缩略图、行程面板、助手窗）：半透白 + 浮层阴影
 *   plain  页面里的卡（全屏行程页的天卡）：白底描边 + 轻阴影
 *   inset  卡里的衬底块（景点详情的分区、提示条）：浅蓝灰底，无阴影
 */
import { forwardRef, type HTMLAttributes } from "react";

import { cx } from "./cx";
import s from "./Card.module.css";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  variant?: "float" | "plain" | "inset";
  padding?: "none" | "sm" | "md" | "lg";
  as?: "div" | "section" | "aside" | "article" | "header";
}

export const Card = forwardRef<HTMLElement, CardProps>(function Card(
  { variant = "plain", padding = "md", as: Tag = "div", className, ...rest },
  ref,
) {
  return <Tag ref={ref as never} className={cx(s.card, s[variant], s[`pad-${padding}`], className)} {...rest} />;
});
