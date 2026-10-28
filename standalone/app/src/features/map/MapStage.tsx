/**
 * 地图舞台（定稿 01–03）：地图铺满主区，浮层按固定槽位摆在上面。
 *
 *   ┌ mini ┬──────── summary ────────┬ aside ┐   第一行：缩略图 · 行程概要 · 天气
 *   │      ├─────────────────────────┴ actions│   第二行（body）：右上「行程详情 ›」、
 *   │                         panel │ controls│   右侧行程面板、右下缩放
 *   └────────────────────────────────────────┘
 *
 * 舞台只管落位，不认识行程或对话；槽位空着就不占地方。缩略图跨两行贴顶，
 * 不把第一行撑高——第一行的高度由概要卡定，面板顶边紧贴它下面。
 * 助手不在舞台里：它在全屏行程页上也要出现，锚在主区左下（AssistantDock）。
 */
import type { ReactNode } from "react";

import s from "./MapStage.module.css";

export function MapStage({
  map,
  mini,
  summary,
  aside,
  actions,
  controls,
  panel,
  panelWidth,
}: {
  map: ReactNode;
  mini?: ReactNode;
  summary?: ReactNode;
  aside?: ReactNode;
  actions?: ReactNode;
  controls?: ReactNode;
  panel?: ReactNode;
  /** 面板开着时的宽度档；共享地图层的「回到全程」按它让位（styles/base.css）。 */
  panelWidth?: "1x" | "2x";
}) {
  return (
    <div className={s.stage} data-map-stage="" data-panel={panel ? panelWidth : undefined}>
      <div className={`hud-viewport ${s.map}`}>{map}</div>
      <div className={s.overlay}>
        {mini && <div className={s.mini}>{mini}</div>}
        {summary && <div className={s.summary}>{summary}</div>}
        {aside && <div className={s.aside}>{aside}</div>}
        <div className={s.body}>
          {actions && <div className={s.actions}>{actions}</div>}
          {controls && <div className={s.controls}>{controls}</div>}
          {panel && <div className={s[`panel${panelWidth ?? "1x"}`]}>{panel}</div>}
        </div>
      </div>
    </div>
  );
}
