/**
 * 行程详情面板（定稿 02 / 03）：压在地图右侧，两档宽度。
 *
 *   1 倍  看一天：日期块 + 带配图的时间轴，点一站进 2 倍看详情
 *   2 倍  左日程（可收起的天）、右景点详情；「在地图中定位」退回 1 倍再推镜头，免得点落在面板底下
 *
 * 左缘的把手横拖切换两档。面板挂 `data-map-drawer`，地图取景按它让位（AmapTripLayer 的 drawerWidth）。
 */
import { useRef, useState } from "react";

import type { TripPlanSnapshot } from "@cabinhug/shared";
import type { ServiceCategoryKey } from "@cabinhug/ui";

import { Breadcrumb, Button, Callout, Card, Segmented } from "../../ui";
import { durationLabel } from "../../trip";
import { GuideBadge, GuideProgress } from "../guide/GuideStatus";
import type { GuideApi } from "../guide/useGuide";
import { ALL_DAYS, DayTabs } from "./DayTabs";
import { DayHeader, ScheduleTimeline } from "./DaySchedule";
import { DayServices } from "./DayServices";
import { scheduleRows, type ScheduleRow } from "./schedule";
import { SpotDetail } from "./SpotDetail";
import s from "./TripPanel.module.css";

export type PanelWidth = "1x" | "2x";

/** 把手拖过这么远才换档：手抖一下不该把面板甩宽。 */
const GRIP_SWITCH_PX = 60;

export function TripPanel({
  plan,
  width,
  onWidth,
  day,
  onDay,
  spot,
  onSpot,
  seqOf,
  notice,
  onClose,
  onFullscreen,
  onLocate,
  guide,
  services,
}: {
  plan: TripPlanSnapshot;
  width: PanelWidth;
  onWidth(w: PanelWidth): void;
  /** 0 = 全部。 */
  day: number;
  onDay(day: number): void;
  spot: { day: number; name: string } | null;
  onSpot(spot: { day: number; name: string } | null): void;
  seqOf(day: number, name: string): number | undefined;
  /** 面板顶上的一句交代（草案来自另一段对话）。 */
  notice?: string;
  onClose(): void;
  onFullscreen(): void;
  onLocate(name: string): void;
  guide: GuideApi;
  /** 沿途服务的选中类目：哪一天、哪几类画在地图上（状态在页面那层，地图要用）。 */
  services: {
    selectedFor(day: number): readonly ServiceCategoryKey[];
    onToggle(day: number, key: ServiceCategoryKey): void;
  };
}) {
  const wide = width === "2x";
  const days = day === ALL_DAYS ? plan.skeleton.map((d) => d.day) : [day];
  const route = plan.origin
    ? `${plan.origin} → ${plan.destination}`
    : plan.destination;
  const [folded, setFolded] = useState<ReadonlySet<number>>(new Set());
  const grip = useRef<number | null>(null);
  const spotData = spot
    ? plan.skeleton
        .find((d) => d.day === spot.day)
        ?.spots.find((x) => x.name === spot.name)
    : undefined;

  const guideBadge = (r: ScheduleRow) =>
    r.spot ? <GuideBadge state={guide.stateOf(r.spot.name)} /> : null;
  const dayServices = (d: number) => (
    <DayServices
      plan={plan}
      day={d}
      selected={services.selectedFor(d)}
      onToggle={(k) => services.onToggle(d, k)}
    />
  );

  const openSpot = (d: number) => (name: string) => {
    onSpot({ day: d, name });
    if (!wide) onWidth("2x");
  };

  return (
    <Card
      variant="float"
      padding="none"
      as="aside"
      className={s.panel}
      data-map-drawer=""
      aria-label="行程详情"
    >
      <div
        className={s.grip}
        role="separator"
        aria-orientation="vertical"
        aria-label="横向拖动切换面板宽度"
        onPointerDown={(e) => {
          grip.current = e.clientX;
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerUp={(e) => {
          const dx = grip.current === null ? 0 : e.clientX - grip.current;
          grip.current = null;
          if (dx < -GRIP_SWITCH_PX) onWidth("2x");
          else if (dx > GRIP_SWITCH_PX) onWidth("1x");
        }}
      />
      <header className={wide ? s.headWide : s.head}>
        <h2 className={s.title}>行程详情</h2>
        <span className={s.subtitle}>
          {route} · {durationLabel(plan)}
        </span>
        <div className={s.tools}>
          <Segmented
            variant="switch"
            label="面板宽度"
            options={[
              { value: "1x", label: "1x" },
              { value: "2x", label: "2x" },
            ]}
            value={width}
            onChange={onWidth}
          />
          <Button icon="fullscreen" label="全屏" onClick={onFullscreen}>
            {wide ? "全屏" : undefined}
          </Button>
          <Button
            variant="ghost"
            icon="x"
            label="关闭行程详情"
            onClick={onClose}
          />
        </div>
      </header>

      <div className={s.nav}>
        <Breadcrumb
          bar
          icon="home"
          items={[
            { label: "当前行程", onClick: () => onDay(ALL_DAYS) },
            { label: wide || day === ALL_DAYS ? "每日安排" : `Day ${day}` },
          ]}
        />
        <DayTabs
          plan={plan}
          value={day}
          onChange={onDay}
          wide={wide}
          tone={wide ? "soft" : "solid"}
          stretch={!wide}
        />
        <GuideProgress jobs={guide.jobs} />
      </div>

      <div className={wide ? s.bodyWide : s.body}>
        <div className={s.column}>
          <div className={s.schedule}>
            {notice && <Callout>{notice}</Callout>}
            {days.map((d) =>
              wide ? (
                <section key={d} className={s.daySection}>
                  <DayHeader
                    plan={plan}
                    day={d}
                    variant="list"
                    open={!folded.has(d)}
                    onToggle={() =>
                      setFolded((f) => {
                        const next = new Set(f);
                        if (!next.delete(d)) next.add(d);
                        return next;
                      })
                    }
                  />
                  {!folded.has(d) && (
                    <>
                      {dayServices(d)}
                      <ScheduleTimeline
                        rows={scheduleRows(plan, d)}
                        density="compact"
                        selected={spot?.day === d ? spot.name : undefined}
                        onSpot={openSpot(d)}
                        extra={guideBadge}
                      />
                    </>
                  )}
                </section>
              ) : (
                <section key={d} className={s.daySection}>
                  <DayHeader plan={plan} day={d} variant="panel" />
                  {dayServices(d)}
                  <ScheduleTimeline
                    rows={scheduleRows(plan, d)}
                    media
                    onSpot={openSpot(d)}
                    extra={guideBadge}
                  />
                </section>
              ),
            )}
          </div>
          {/* 声明钉在栏底，不随日程滚走（定稿 02 / 03）。 */}
          {plan.caveats.length > 0 && (
            <Callout icon="umbrella">
              {plan.caveats.map((c) => (
                <div key={c}>{c}</div>
              ))}
            </Callout>
          )}
        </div>
        {wide &&
          (spot && spotData ? (
            <SpotDetail
              plan={plan}
              day={spot.day}
              spot={spotData}
              seq={seqOf(spot.day, spot.name)}
              onClose={() => onSpot(null)}
              onLocate={() => onLocate(spot.name)}
              guideState={guide.stateOf(spot.name)}
              onOpenGuide={() => guide.openSpot(spot.name)}
              onFetchGuide={() => guide.fetchSpot(spot.name)}
            />
          ) : (
            <div className={s.detailEmpty}>
              点左边任意一站，在这里看它的详情
            </div>
          ))}
      </div>
    </Card>
  );
}
