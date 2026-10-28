/**
 * 全屏行程页（定稿 04）：导航栏「行程」进来。标题与去回程 → 天页签与三个视图 → 底部出行提示。
 *
 *   每日安排  一天一张卡并排（封面贴纸 + 时间轴 + 每站一句介绍），选了某天就只放那一张
 *   住宿信息  每家酒店住哪几晚、地址、估价（标「估算」）
 *   出行提示  快照里的声明、天气、行前物品、补能点
 */
import { useState } from "react";

import { tipItemsFromKeys, type TripPlanSnapshot } from "@cabinhug/shared";
import { SPRITES } from "@cabinhug/ui";

import {
  Badge,
  Breadcrumb,
  Button,
  Callout,
  Card,
  Icon,
  PoiArt,
  Segmented,
  Stat,
  StatRow,
} from "../../ui";
import {
  dateRangeLabel,
  durationLabel,
  driveSummary,
  hotelStays,
  isConfirmed,
} from "../../trip";
import { ALL_DAYS, DayTabs } from "./DayTabs";
import { GuideBadge, GuideProgress } from "../guide/GuideStatus";
import type { GuideApi } from "../guide/useGuide";
import { DayHeader, ScheduleTimeline } from "./DaySchedule";
import { DayServices } from "./DayServices";
import { scheduleRows } from "./schedule";
import s from "./TripBoard.module.css";

type View = "days" | "hotels" | "tips";

export function TripBoard({
  plan,
  title,
  day,
  onDay,
  onExit,
  onClose,
  onAsk,
  onOpenDay,
  guide,
}: {
  plan: TripPlanSnapshot;
  /** 面包屑末段：这段对话的标题，没有就用行程名。 */
  title: string;
  day: number;
  onDay(day: number): void;
  /** 退出全屏：回地图，面板开着。 */
  onExit(): void;
  /** 关掉：回地图，面板收起。 */
  onClose(): void;
  onAsk(): void;
  /** 天卡右上 ›：回地图看这一天。 */
  onOpenDay(day: number): void;
  /** 点一站打开它的导览页（行程定下来之后才有）。 */
  guide: GuideApi;
}) {
  const [view, setView] = useState<View>("days");
  const confirmed = isConfirmed(plan);
  const range = dateRangeLabel(plan, true);
  const drive = driveSummary(plan);
  const shown =
    day === ALL_DAYS
      ? plan.skeleton
      : plan.skeleton.filter((d) => d.day === day);
  return (
    <div className={s.board}>
      <header className={s.top}>
        <Breadcrumb
          icon="chevron-left"
          onIcon={onExit}
          items={[{ label: "行程", onClick: onExit }, { label: title }]}
        />
        <div className={s.tools}>
          <button
            type="button"
            className={s.avatar}
            onClick={onAsk}
            aria-label="叫助手"
            title="叫助手"
          >
            <img src={SPRITES.light.assistant} alt="" draggable={false} />
          </button>
          <Button icon="fullscreen" onClick={onExit}>
            退出全屏
          </Button>
          <Button variant="ghost" icon="x" label="关闭" onClick={onClose} />
        </div>
      </header>

      <section className={s.hero}>
        <div className={s.heading}>
          <div className={s.titleLine}>
            <h1 className={s.route}>
              {plan.origin
                ? `${plan.origin} → ${plan.destination}`
                : plan.destination}
            </h1>
            <Badge tone={confirmed ? "ok" : "pending"}>
              {confirmed ? "已确认" : "草案 · 未保存"}
            </Badge>
          </div>
          <div className={`${s.meta} sa-num`}>
            {durationLabel(plan)}
            {range ? ` · ${range}` : ""}
          </div>
        </div>
        <StatRow>
          {drive.outbound && (
            <Stat icon="car" label="去程">
              {drive.outboundKm ? `${drive.outboundKm} · ` : ""}
              {drive.outbound}
            </Stat>
          )}
          {drive.back && (
            <Stat icon="car" label="回程">
              {drive.back}
            </Stat>
          )}
          {plan.weather && (
            <Stat icon="cloud" label={plan.destination}>
              {plan.weather.label}
            </Stat>
          )}
        </StatRow>
      </section>

      <div className={s.toolbar}>
        <DayTabs plan={plan} value={day} onChange={onDay} wide />
        <span className={s.toolbarGrow}>
          <GuideProgress jobs={guide.jobs} />
        </span>
        <Segmented<View>
          label="视图"
          tone="solid"
          options={[
            { value: "days", label: "每日安排", icon: "calendar" },
            { value: "hotels", label: "住宿信息", icon: "bed" },
            { value: "tips", label: "出行提示", icon: "bulb" },
          ]}
          value={view}
          onChange={setView}
        />
      </div>

      <div className={s.content}>
        {view === "days" && (
          <div
            className={s.days}
            style={{
              gridTemplateColumns: `repeat(${shown.length}, minmax(320px, ${shown.length === 1 ? "640px" : "1fr"}))`,
            }}
          >
            {shown.map((d) => (
              <Card key={d.day} as="article" className={s.dayCard}>
                <DayHeader
                  plan={plan}
                  day={d.day}
                  variant="card"
                  onOpen={() => onOpenDay(d.day)}
                />
                <PoiArt kind={d.spots[0]?.poiKind} size="cover" />
                <DayServices plan={plan} day={d.day} />
                <ScheduleTimeline
                  rows={scheduleRows(plan, d.day)}
                  detail="desc"
                  onSpot={confirmed ? guide.openSpot : undefined}
                  extra={(r) =>
                    r.kind === "hotel" ? (
                      <button
                        type="button"
                        className={s.inlineLink}
                        onClick={() => setView("hotels")}
                      >
                        查看住宿 <Icon name="chevron-right" size="sm" />
                      </button>
                    ) : r.spot ? (
                      <GuideBadge state={guide.stateOf(r.spot.name)} />
                    ) : null
                  }
                />
              </Card>
            ))}
          </div>
        )}
        {view === "hotels" && <HotelList plan={plan} />}
        {view === "tips" && <TripTips plan={plan} />}
      </div>

      {plan.caveats.length > 0 && (
        <Callout tone="warn" title="出行提示">
          {plan.caveats.join("；")}
        </Callout>
      )}
    </div>
  );
}

function HotelList({ plan }: { plan: TripPlanSnapshot }) {
  const stays = hotelStays(plan);
  if (stays.length === 0)
    return <p className={s.empty}>这份行程没有安排住宿。</p>;
  return (
    <div className={s.cards}>
      {stays.map(({ hotel, days }) => (
        <Card key={hotel.name} as="article" className={s.hotel}>
          <PoiArt kind="hotel" size="thumb" />
          <div className={s.hotelBody}>
            <h3 className={s.hotelName}>{hotel.name}</h3>
            <div className={`${s.hotelLine} sa-num`}>
              Day {days.join("、")} · 住 {days.length} 晚
            </div>
            {hotel.address && (
              <div className={s.hotelLine}>{hotel.address}</div>
            )}
            <div className={s.hotelTags}>
              {hotel.area && <Badge tone="info">{hotel.area}</Badge>}
              {hotel.rating && <Badge tone="brand">评分 {hotel.rating}</Badge>}
              {hotel.estPrice && (
                <>
                  <span className={`${s.price} sa-num`}>{hotel.estPrice}</span>
                  <Badge size="sm">估算</Badge>
                </>
              )}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function TripTips({ plan }: { plan: TripPlanSnapshot }) {
  const items = tipItemsFromKeys((plan.pretripItems ?? []).map((x) => x.key));
  const blocks = [
    plan.weather && {
      icon: "cloud" as const,
      title: "天气",
      body: `${plan.destination} ${plan.weather.label}`,
    },
    items.length > 0 && {
      icon: "umbrella" as const,
      title: "行前带上",
      body: items.map((i) => i.label).join("、"),
    },
    plan.transit?.summary && {
      icon: "route" as const,
      title: "交通",
      body: plan.transit.summary,
    },
    plan.energyStops?.length && {
      icon: "bolt" as const,
      title: "整程补能",
      body: plan.energyStops.join("、"),
    },
    ...plan.caveats.map((c) => ({
      icon: "alert" as const,
      title: "注意",
      body: c,
    })),
  ].filter(Boolean) as Array<{
    icon: "cloud" | "umbrella" | "route" | "bolt" | "alert";
    title: string;
    body: string;
  }>;
  if (blocks.length === 0)
    return <p className={s.empty}>这份行程没有额外的出行提示。</p>;
  return (
    <div className={s.cards}>
      {blocks.map((b, i) => (
        <Card key={`${b.title}-${i}`} className={s.tip}>
          <Icon name={b.icon} className={s.tipIcon} />
          <div>
            <div className={s.tipTitle}>{b.title}</div>
            <div>{b.body}</div>
          </div>
        </Card>
      ))}
    </div>
  );
}
