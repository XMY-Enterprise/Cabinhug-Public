/**
 * 周日历行程卡：主页未选中任何行程时右列唯一的一张卡。
 *
 * 概念图 `output/imagegen/trip-list-dates/B-week-strip.png`：本周条（周一到周日，今天高亮）→
 * 本周内的行程画成跨天的色块（进行中蓝、未来琥珀，右端变化点）→ 不在本周的行程按清单行列出
 * （日期标签「9/27 周六」或「待定」+ 起点 → 终点 + 逐日天气 + 变化点）。
 *
 * 没定日期的行程按默认明天出发画（口径在 contracts 的 `effectiveStartDate`）：明天在本周就是
 * 一条明天起的色块，只是虚线边（`is-tentative`），表示它是默认值不是用户定的日子；
 * 清单里的日期标签仍是「待定」。
 *
 * 周条回答「这周有没有事」：一周内重叠的行程按行叠放成薄胶囊，最多 3 道；胶囊不写字，
 * 一程一支色，与清单里同一程的色条对应。清单列全部行程、一页 3 程。
 * 判断（变化点 / 作废）仍全部来自 contracts 的纯函数；卡不碰网络、不做判断（F-01-04）。
 */

import { useState, type ReactNode } from "react";

import {
  addDaysIso,
  relativeDepartLabel,
  tripDateRange,
  tripPlanStops,
  weekOf,
  weekdayLabel,
  type TripPlanListEntry,
} from "@cabinhug/shared";

import { dayCells, entryNeedsAttention, tripRouteLabel } from "./TripListCard";
import { KIND_SPRITE } from "./sprite-for";

/** 周条下最多叠几行色块。 */
export const MAX_WEEK_BARS = 3;

export interface WeekBar {
  entry: TripPlanListEntry;
  /** 起止列（0 = 周一 … 6 = 周日），已裁到本周。 */
  startCol: number;
  endCol: number;
  /** 行程从上周延续过来 / 延到下周。 */
  clippedStart: boolean;
  clippedEnd: boolean;
  ongoing: boolean;
  /** 没定日期、按默认明天出发画上来的（虚线边）。 */
  tentative: boolean;
}

/**
 * 本周内的行程 → 色块。没定日期的按默认明天起算（`tentative`）；与本周不相交的不进来；
 * 超过 `MAX_WEEK_BARS` 的折进清单。排序沿用列表顺序（进行中 → 最近的未来 → 没定日期）。
 */
export function weekBars(
  entries: readonly TripPlanListEntry[],
  week: readonly string[],
  today: string,
  max = MAX_WEEK_BARS,
): WeekBar[] {
  if (week.length !== 7) return [];
  const first = week[0]!;
  const last = week[6]!;
  const out: WeekBar[] = [];
  for (const entry of entries) {
    const range = tripDateRange(entry.plan, today);
    if (range.end < first || range.start > last) continue;
    const startCol = Math.max(0, week.indexOf(range.start) >= 0 ? week.indexOf(range.start) : 0);
    const endCol = week.indexOf(range.end) >= 0 ? week.indexOf(range.end) : 6;
    out.push({
      entry,
      startCol,
      endCol,
      clippedStart: range.start < first,
      clippedEnd: range.end > last,
      ongoing: range.start <= today && today <= range.end,
      tentative: range.tentative,
    });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 清单每页几程：卡高扣掉周条与三行色块（薄胶囊）后放得下的行数。
 */
export const LIST_PAGE_SIZE = 3;

/**
 * 每一程一支颜色：周条里的胶囊与清单行左侧的色条同一支，
 * 看清单就知道周条上那根线是谁的。按在列表里的位置轮转取，四支循环；
 * 颜色本身在 hud.css 的 `--hud-trip-c0..c3`（琥珀 / 蓝 / 绿 / 紫，没有红——红只给拥堵和读不到）。
 */
export const TRIP_COLOR_COUNT = 4;
export function tripColorIndex(entries: readonly TripPlanListEntry[], planId: string): number {
  const i = entries.findIndex((e) => e.planId === planId);
  return (i < 0 ? 0 : i) % TRIP_COLOR_COUNT;
}

/** 页码钳到 1..pageCount（pageCount 为 0 也回 1），行程数变少时不停在越界页。派生值，不用 effect 追。 */
export function clampPage(page: number, pageCount: number): number {
  const max = Math.max(1, pageCount);
  if (!Number.isFinite(page)) return 1;
  return Math.min(max, Math.max(1, Math.floor(page)));
}

export function pageOf<T>(items: readonly T[], page: number, size: number): T[] {
  const p = clampPage(page, Math.ceil(items.length / size));
  return items.slice((p - 1) * size, p * size);
}

/** 周条标题：「9/7 – 9/13」。 */
export function weekRangeLabel(week: readonly string[]): string {
  if (week.length !== 7) return "";
  const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  return `${md(week[0]!)} – ${md(week[6]!)}`;
}

/** 清单行的日期标签：「9/27 周六」；没定日期「待定」（默认明天出发是口径不是日子，标签不冒充日期）。 */
export function listDateLabel(entry: TripPlanListEntry): string {
  const start = entry.plan.startDate;
  if (!start) return "待定";
  const [, mm, dd] = start.split("-");
  if (!mm || !dd) return "待定";
  return `${Number(mm)}/${Number(dd)} ${weekdayLabel(start)}`;
}

/**
 * 清单行左侧那张缩略图取哪一枚精灵（定稿 `内部文档`）。
 *
 * 按快照自己给的品类取，不按地名猜，与地图标记同一条规则（见 `sprite-for.ts` 文件头）。
 * 取这一程的第一个景点；一程里没有景点（只有酒店/补能点）就用通用景点图。
 *
 * 它是品类图，不是这个地方的照片。定稿里画的是照片，但没有这样的图源，
 * 也不拿别处的风景图冒充。
 */
export function tripThumbSprite(
  poiIcons: Readonly<Record<string, string>>,
  entry: TripPlanListEntry,
): string | undefined {
  const spot = tripPlanStops(entry.plan).find((s) => s.kind === "spot");
  const key = KIND_SPRITE[spot?.poiKind ?? ""] ?? "spot";
  return poiIcons[key] ?? poiIcons.spot;
}


export interface TripCalendarCardProps {
  entries: readonly TripPlanListEntry[];
  /** 本地今天（YYYY-MM-DD）。 */
  today: string;
  selectedPlanId?: string;
  homeCity?: string;
  weatherIcons: Readonly<Record<string, string>>;
  /** 清单行的缩略图图源（`SPRITES[theme].poi`）。不给就不画那一列，行照常渲染。 */
  poiIcons?: Readonly<Record<string, string>>;
  onSelect?: (planId: string) => void;
  onOpenReview?: (planId: string) => void;
  footer?: ReactNode;
  /**
   * 紧凑形态（手机竖屏）：只有周条工具条 + 七列 + 色块，不渲染清单与页脚：
   * 竖屏提示卡槽位只有 144u 高，清单与翻页进抽屉（`onOpenList`）。车机不传。
   */
  compact?: boolean;
  /** 工具条右端「全部 N 程 ›」：给了才渲染；抽屉里那份完整卡不给。 */
  onOpenList?: () => void;
}

export function TripCalendarCard({
  entries,
  today,
  selectedPlanId,
  homeCity,
  weatherIcons,
  poiIcons,
  onSelect,
  onOpenReview,
  footer,
  compact = false,
  onOpenList,
}: TripCalendarCardProps) {
  /*
   * 翻页状态留在组件里：换周 / 换页是看一眼的动作，轮询与选中都不重置它；
   * 重开主页回到本周第 1 页。页码用派生值钳位，行程数变少不会停在越界页。
   */
  const [weekOffset, setWeekOffset] = useState(0);
  const [listPage, setListPage] = useState(1);
  const week = weekOf(addDaysIso(today, weekOffset * 7));
  const bars = weekBars(entries, week, today);
  /*
   * 清单列全部行程，包括画在周条上的那几程：胶囊不写字，
   * 「这根线是谁」要靠清单里同色那一行来回答，两边互斥就对不上。
   */
  const rest = entries;
  const pageCount = Math.ceil(rest.length / LIST_PAGE_SIZE);
  const page = clampPage(listPage, pageCount);
  const pageItems = pageOf(rest, page, LIST_PAGE_SIZE);
  return (
    <section className={`hud-card hud-trips hud-trips--calendar${compact ? " hud-trips--compact" : ""}`} aria-label="我的行程">
      {/*
        换周的 ‹ › 与周范围并进头部这一行（定稿 `trip-plan-home-final.png`）：
        定稿的卡从上到下是「头 → 周条 → 日期行 → 清单」，没有单独一行工具条。
      */}
      <header className="hud-tips__head hud-trips__head">
        <CalendarIcon />
        <h2 className="hud-tips__title hud-trips__title">
          我的行程
          {/*
            标题右上角的角标，形态照 iOS 未读角标：一枚圆底片，里面写着现在有几程（产品决定）。
            有行程就显示，一程没有就整个不画，空的角标会让人找原因。

            它恒为琥珀，不随变化等级转红。design-system.md §4 的红色规则：
            「红只给『拥堵』和『读不到』两个判定，不给强调、不给未读角标、不给删除按钮」。
            哪一程出了变化，由清单里那一行自己的变化点回答。
          */}
          {entries.length > 0 && (
            <span className="hud-trips__title-count" role="img" aria-label={`共 ${entries.length} 程`}>
              {entries.length}
            </span>
          )}
        </h2>
        <div className="hud-week__toolbar">
          <button type="button" className="hud-week__nav" aria-label="上一周" onClick={() => setWeekOffset((o) => o - 1)}>
            ‹
          </button>
          <span className="hud-week__range">{weekRangeLabel(week)}</span>
          {/*
            「本周」常驻占位，不在本周时才看得见、点得到（`is-hidden` = visibility:hidden）。
            条件渲染会让工具条换周时变宽、把标题挤成两行；常驻占位保证换周时头部不动。
          */}
          <button
            type="button"
            className={`hud-week__today${weekOffset === 0 ? " is-hidden" : ""}`}
            onClick={() => setWeekOffset(0)}
            aria-hidden={weekOffset === 0 || undefined}
            tabIndex={weekOffset === 0 ? -1 : undefined}
          >
            本周
          </button>
          <button type="button" className="hud-week__nav" aria-label="下一周" onClick={() => setWeekOffset((o) => o + 1)}>
            ›
          </button>
          {onOpenList && (
            <button type="button" className="hud-week__all" onClick={onOpenList} aria-label={`查看全部 ${entries.length} 程`}>
              全部 {entries.length} 程 ›
            </button>
          )}
        </div>
      </header>

      <div className="hud-week" role="grid" aria-label={weekOffset === 0 ? "本周" : "所选的一周"}>
        <div className="hud-week__head" role="row">
          {week.map((d, i) => (
            <div
              key={d}
              role="columnheader"
              className={`hud-week__col${d === today ? " is-today" : ""}`}
              aria-label={`${weekdayLabel(d)} ${d}`}
            >
              <span className="hud-week__dow">{weekdayLabel(d).replace("周", "")}</span>
              <span className="hud-week__date">{Number(d.slice(-2))}</span>
              {i === 6 ? null : null}
            </div>
          ))}
        </div>
        <div className="hud-week__bars" role="row">
          {bars.length === 0 ? (
            <span className="hud-week__empty">{weekOffset === 0 ? "本周没有行程" : "这一周没有行程"}</span>
          ) : (
            bars.map((b) => {
              const attention = entryNeedsAttention(b.entry);
              const critical = attention && b.entry.review?.severity === "critical";
              const cls = [
                "hud-week__bar",
                b.ongoing ? "is-ongoing" : "",
                b.clippedStart ? "is-clipped-start" : "",
                b.clippedEnd ? "is-clipped-end" : "",
                b.entry.planId === selectedPlanId ? "is-selected" : "",
                b.tentative ? "is-tentative" : "",
                attention ? "has-attention" : "",
                critical ? "is-critical" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <div
                  key={b.entry.planId}
                  className={`hud-week__lane${attention ? " has-attention" : ""}${critical ? " is-critical" : ""}`}
                  style={{ gridColumn: `${b.startCol + 1} / ${b.endCol + 2}` }}
                >
                  {/* 薄胶囊不写字：一天宽的格子写不下目的地名；谁是谁看颜色对清单。 */}
                  <button
                    type="button"
                    className={cls}
                    style={{ ["--trip-color" as string]: `var(--hud-trip-c${tripColorIndex(entries, b.entry.planId)})` }}
                    aria-label={`${b.entry.plan.destination} · ${b.entry.plan.days}天${b.ongoing ? "（进行中）" : b.tentative ? "（待定）" : ""}`}
                    onClick={() => onSelect?.(b.entry.planId)}
                  />
                  {attention && (
                    <button
                      type="button"
                      className="hud-trips__flag hud-week__flag"
                      aria-label={critical ? "行程有重要变化，点击查看" : "行程有变化，点击查看"}
                      onClick={() => onOpenReview?.(b.entry.planId)}
                    >
                      <span className="hud-trips__flag-dot" />
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {!compact && rest.length > 0 && (
        <ul className="hud-trips__list hud-trips__list--calendar">
          {pageItems.map((entry) => {
            const attention = entryNeedsAttention(entry);
            const critical = attention && entry.review?.severity === "critical";
            const { cells, overflow } = dayCells(entry);
            const cls = [
              "hud-trips__row",
              entry.planId === selectedPlanId ? "is-selected" : "",
              attention ? "has-attention" : "",
              critical ? "is-critical" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <li
                className={cls}
                key={entry.planId}
                style={{ ["--trip-color" as string]: `var(--hud-trip-c${tripColorIndex(entries, entry.planId)})` }}
              >
                {poiIcons && (
                  <img
                    className="hud-trips__thumb"
                    src={tripThumbSprite(poiIcons, entry)}
                    alt=""
                    aria-hidden="true"
                    draggable={false}
                  />
                )}
                <button type="button" className="hud-trips__main" onClick={() => onSelect?.(entry.planId)}>
                  {/* 目的地整行不截断；日期标签放第二行开头：它是琥珀描边的，仍是第二行里最先看到的。 */}
                  <span className="hud-trips__route">{tripRouteLabel(entry.plan, homeCity)}</span>
                  <span className="hud-trips__meta">
                    <span className="hud-trips__date">{listDateLabel(entry)}</span>
                    {entry.plan.days} 天 · {relativeDepartLabel(entry.plan, today)}
                  </span>
                </button>
                <span className="hud-trips__days" aria-label="逐日天气">
                  {cells.map((c) =>
                    c.kind && weatherIcons[c.kind] ? (
                      <img key={c.day} className="hud-trips__weather" src={weatherIcons[c.kind]} alt="" aria-hidden="true" />
                    ) : (
                      <span key={c.day} className="hud-trips__dot hud-trips__dot--unknown" aria-hidden="true" />
                    ),
                  )}
                  {overflow > 0 && <span className="hud-trips__more">+{overflow}</span>}
                </span>
                {attention ? (
                  <button
                    type="button"
                    className="hud-trips__flag"
                    aria-label={critical ? "行程有重要变化，点击查看" : "行程有变化，点击查看"}
                    onClick={() => onOpenReview?.(entry.planId)}
                  >
                    <span className="hud-trips__flag-dot" />
                  </button>
                ) : (
                  <span className="hud-trips__flag hud-trips__flag--none" aria-hidden="true" />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!compact && pageCount > 1 && (
        <nav className="hud-trips__pager" aria-label={`第 ${page} 页，共 ${pageCount} 页`}>
          <button type="button" className="hud-trips__pager-btn" aria-label="上一页" disabled={page <= 1} onClick={() => setListPage(page - 1)}>
            ‹
          </button>
          <span className="hud-trips__pager-num">
            <b>{page}</b> / {pageCount}
          </span>
          <button type="button" className="hud-trips__pager-btn" aria-label="下一页" disabled={page >= pageCount} onClick={() => setListPage(page + 1)}>
            ›
          </button>
        </nav>
      )}
      {footer}
    </section>
  );
}

function CalendarIcon() {
  return (
    <svg className="hud-tips__weather hud-trips__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M3 10h18M8 3v4M16 3v4" strokeLinecap="round" />
    </svg>
  );
}
