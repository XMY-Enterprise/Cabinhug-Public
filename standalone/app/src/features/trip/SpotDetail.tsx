/**
 * 景点详情（定稿 03 右栏）：配图、名字、标签、到达与离开、介绍、当天沿途餐饮、两个出口。
 *
 * 只摆快照里有的：介绍是模型写在快照里的那一句（`spot.note`），餐饮是确认后后台查的沿途服务
 * （`services`，按天不按点——所以标题写「当天沿途」，不写「周边」）。没有的那一节整节不出现，
 * 不留一个空的「开放时间」。
 */
import {
  tripServicesForDay,
  type GuideJobState,
  type TripPlanSnapshot,
  type TripPlanSpotSnapshot,
} from "@cabinhug/shared";
import { stayLabel } from "@cabinhug/ui";

import {
  Badge,
  Breadcrumb,
  Button,
  Disclosure,
  PoiArt,
  Stat,
  StatRow,
} from "../../ui";
import { isConfirmed, poiKindLabel } from "../../trip";
import { GuideAction } from "../guide/GuideStatus";
import s from "./SpotDetail.module.css";

const FOOD_SHOWN = 6;

export function SpotDetail({
  plan,
  day,
  spot,
  seq,
  onClose,
  onLocate,
  guideState,
  onOpenGuide,
  onFetchGuide,
}: {
  plan: TripPlanSnapshot;
  day: number;
  spot: TripPlanSpotSnapshot;
  /** 地图上的编号（没上图就没有）。 */
  seq: number | undefined;
  onClose(): void;
  onLocate(): void;
  guideState: GuideJobState | undefined;
  onOpenGuide(): void;
  onFetchGuide(): void;
}) {
  const kind = poiKindLabel(spot.poiKind);
  const stay =
    spot.estStart && spot.estEnd
      ? stayLabel(spot.estStart, spot.estEnd)
      : undefined;
  // 骨架变过的那份不作数（`tripServicesForDay` 比对停靠点指纹），与沿途服务格子同一判断。
  const food = tripServicesForDay(plan, day)?.pois?.food ?? [];
  const placed = spot.lat !== undefined && spot.lon !== undefined;
  return (
    <section className={s.detail} aria-label={`${spot.name} 详情`}>
      <header className={s.head}>
        <Breadcrumb
          icon="chevron-left"
          onIcon={onClose}
          items={[
            { label: `Day ${day}` },
            ...(seq !== undefined ? [{ label: `第${seq}站` }] : []),
            { label: "景点详情" },
          ]}
        />
        <Button
          variant="ghost"
          size="sm"
          icon="x"
          label="关闭详情"
          onClick={onClose}
        />
      </header>
      <div className={s.scroll}>
        <PoiArt kind={spot.poiKind} size="hero" />
        <h2 className={s.name}>{spot.name}</h2>
        {(kind || stay || spot.indoor) && (
          <div className={s.tags}>
            {kind && <Badge tone="info">{kind}</Badge>}
            {stay && <Badge tone="brand">建议停留 {stay}</Badge>}
            {spot.indoor && <Badge>室内</Badge>}
          </div>
        )}
        {(spot.estStart || spot.estEnd) && (
          <StatRow>
            {spot.estStart && (
              <Stat icon="calendar" label="计划到达">
                {spot.estStart}
              </Stat>
            )}
            {spot.estEnd && (
              <Stat icon="clock" label="预计离开">
                {spot.estEnd}
              </Stat>
            )}
          </StatRow>
        )}
        <GuideAction
          confirmed={isConfirmed(plan)}
          state={guideState}
          onOpen={onOpenGuide}
          onFetch={onFetchGuide}
        />
        {spot.note && (
          <Disclosure title="景点介绍" icon="doc" defaultOpen>
            {spot.note}
          </Disclosure>
        )}
        {food.length > 0 && (
          <Disclosure title="当天沿途餐饮" icon="utensils">
            <ul className={s.list}>
              {food.slice(0, FOOD_SHOWN).map((f) => (
                <li key={f.name}>{f.name}</li>
              ))}
            </ul>
          </Disclosure>
        )}
        {placed && <p className={s.source}>位置与品类来源：高德开放平台</p>}
      </div>
      <footer className={s.actions}>
        <Button block onClick={onClose}>
          返回行程
        </Button>
        <Button
          block
          variant="primary"
          icon="pin"
          disabled={!placed}
          onClick={onLocate}
        >
          在地图中定位
        </Button>
      </footer>
    </section>
  );
}
