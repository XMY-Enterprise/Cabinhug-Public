/**
 * 导览页：复用 `@cabinhug/ui` 的 `GuideScreen`（车机横屏两栏版式，与车机端同一份）。
 *
 * 它本来是盖住整个窗口的 fixed 层；桌面上只盖主区，导航栏与状态栏留在原处——
 * 这一层把它改成相对主区定位（样式见同名 module）。
 *
 * 版式挂车机那一套（`data-surface="cockpit"`）：共享样式只给两个端写了成套的尺寸，不挂就是未定尺寸的
 * 裸样式（返回键里的箭头撑满整个按钮）。桌面窗口与车机屏同是横屏两栏，车机版式按 `--hud-unit`
 * （视口宽 / 1672）缩放，在桌面窗口里约等于 1px，不必另写一套。重新采集不给：简报有 14 天保鲜期，
 * 过期自动重采；手动强制重采走的是同步路径，桌面端的网关转发撑不住（见 useGuide）。
 */
import { GuideScreen } from "@cabinhug/ui";

import type { GuideApi } from "./useGuide";
import s from "./GuideOverlay.module.css";

export function GuideOverlay({ guide }: { guide: GuideApi }) {
  if (!guide.open) return null;
  const { spot, state } = guide.open;
  return (
    <div className={s.host} data-surface="cockpit">
      <GuideScreen spotName={spot} state={state} onBack={guide.close} onRetry={() => guide.openSpot(spot)} layout="wide" theme="light" />
    </div>
  );
}
