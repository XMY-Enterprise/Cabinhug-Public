/**
 * 一天的日程：天头 + 时间轴。行程面板（1 倍 / 2 倍）与全屏天卡都由这两块拼，不各写一份。
 *
 *   DayHeader         三种天头：panel「📅 10/25 周日 / 老城漫步」、list「📍 Day 2 · 10/25 周日 · 老城漫步 ⌄」、
 *                     card「Day 1 · 10/24 周六 › / 抵达杭州 · 钱塘江畔」
 *   ScheduleTimeline  日程行 → 时间轴；配不配图、说明取哪一句由参数定
 */
import type { ReactNode } from "react";

import type { TripPlanSnapshot } from "@cabinhug/shared";

import { Button, cx, Icon, PoiArt, Timeline, TimelineItem } from "../../ui";
import { dayDateLabel, dayHeadline } from "../../trip";
import type { ScheduleRow } from "./schedule";
import s from "./DaySchedule.module.css";

export function DayHeader({
  plan,
  day,
  variant,
  open,
  onToggle,
  onOpen,
}: {
  plan: TripPlanSnapshot;
  day: number;
  variant: "panel" | "list" | "card";
  /** list：展开着。 */
  open?: boolean;
  onToggle?: () => void;
  /** card：右上 › 去这一天。 */
  onOpen?: () => void;
}) {
  const d = plan.skeleton.find((x) => x.day === day);
  if (!d) return null;
  const date = dayDateLabel(plan, day);
  const headline = dayHeadline(d);
  if (variant === "panel") {
    return (
      <header className={s.panelHead}>
        <span className={s.dateIcon}>
          <Icon name="calendar" size="lg" />
        </span>
        <div>
          <div className={`${s.date} sa-num`}>{date ?? `Day ${day}`}</div>
          <div className={s.headline}>{headline}</div>
        </div>
      </header>
    );
  }
  if (variant === "list") {
    return (
      <button type="button" className={s.listHead} aria-expanded={open} onClick={onToggle}>
        <Icon name="pin" className={s.pin} />
        <span className={`${s.listTitle} sa-num`}>
          Day {day}
          {date ? ` · ${date}` : ""} · {d.theme}
        </span>
        <Icon name={open ? "chevron-down" : "chevron-right"} size="sm" />
      </button>
    );
  }
  return (
    <header className={s.cardHead}>
      <div className={s.cardTitles}>
        <h2 className={`${s.cardTitle} sa-num`}>
          Day {day}
          {date ? ` · ${date}` : ""}
        </h2>
        <div className={s.cardHeadline}>{headline}</div>
      </div>
      {onOpen && <Button shape="circle" size="sm" icon="chevron-right" label={`在地图上看 Day ${day}`} onClick={onOpen} />}
    </header>
  );
}

export function ScheduleTimeline({
  rows,
  media,
  density,
  detail = "note",
  selected,
  onSpot,
  extra,
}: {
  rows: readonly ScheduleRow[];
  /** 行首配图（1 倍面板）。 */
  media?: boolean;
  density?: "comfortable" | "compact";
  /** 说明取时间轴那句（建议停留…），还是景点自己的介绍（没有时退回前者）。 */
  detail?: "note" | "desc";
  selected?: string;
  onSpot?: (name: string) => void;
  /** 某一行说明后面再挂点东西（全屏天卡住宿行的「查看住宿 ›」）。 */
  extra?: (row: ScheduleRow) => ReactNode;
}) {
  return (
    <Timeline density={density}>
      {rows.map((r) => {
        const text = detail === "desc" ? (r.desc ?? r.note) : r.note;
        const more = extra?.(r);
        return (
          <TimelineItem
            key={r.key}
            time={r.time}
            title={r.title}
            subtitle={
              text || more ? (
                <>
                  <span className={cx(detail === "desc" && s.clamp)}>{text}</span>
                  {more}
                </>
              ) : undefined
            }
            media={media ? <PoiArt kind={r.art} /> : undefined}
            active={selected !== undefined && r.spot?.name === selected}
            onClick={r.spot && onSpot ? () => onSpot(r.spot!.name) : undefined}
          />
        );
      })}
    </Timeline>
  );
}
