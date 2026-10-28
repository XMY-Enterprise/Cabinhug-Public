/**
 * 舞台底下那张地图：有行程画行程（共享的 `AmapTripLayer`，与车机端同一层），没有就是一张空底图。
 * 地图没配 key / 没加载出来时退回一句说明，不画假地图。
 *
 * 沿途服务点（`servicePois`）由页面按选中的天与类目算好传进来；点景点标记打开它的导览（`onSpotClick`）。
 */
import type { MutableRefObject } from "react";

import { AmapTripLayer, type AmapTripLayerProps, type TripMapControl, type TripMapStop } from "@cabinhug/ui";

import s from "./TripMap.module.css";

export function TripMap({
  ready,
  stops,
  planKey,
  focusDay,
  control,
  servicePois,
  onSpotClick,
}: {
  ready: boolean;
  stops: TripMapStop[];
  planKey: string;
  focusDay?: number;
  control: MutableRefObject<TripMapControl | null>;
  servicePois?: AmapTripLayerProps["servicePois"];
  onSpotClick?: (name: string) => void;
}) {
  if (!ready) return <div className={s.fallback}>地图加载中…</div>;
  return (
    <AmapTripLayer
      theme="light"
      stops={stops}
      showDayBadge
      planKey={planKey}
      focusDay={focusDay}
      control={control}
      servicePois={servicePois}
      onStopClick={onSpotClick ? (stop) => onSpotClick(stop.name) : undefined}
    />
  );
}
