/**
 * 一天的沿途服务（ACR-065）：充电站 / 餐饮 / 卫生间 / 停车场四格 + 当天高速段的服务区。
 *
 * 数据是行程确认后后台补算好、写进行程的那份（`services`，周边搜索走⑤缓存，TTL 2 周）；
 * 格子的取值、「待查」与「0 个」的区分、骨架变了就作废，都用共享的 `dayServices` / `tripServicesForDay`，
 * 与车机端行程抽屉同一份判断。点一格就在地图上画出这一类点（`onToggle` 不给就是只读，全屏页用）。
 */
import { tripServicesForDay, type TripPlanSnapshot } from "@cabinhug/shared";
import { dayServices, PENDING, serviceCellTitle, servicePoisFor, type ServiceCategoryKey } from "@cabinhug/ui";

import { cx, Icon, type IconName } from "../../ui";
import s from "./DayServices.module.css";

const ICON: Record<ServiceCategoryKey, IconName> = {
  charge: "bolt",
  food: "utensils",
  restroom: "restroom",
  parking: "parking",
};

export function DayServices({
  plan,
  day,
  selected = [],
  onToggle,
}: {
  plan: TripPlanSnapshot;
  day: number;
  selected?: readonly ServiceCategoryKey[];
  onToggle?: (key: ServiceCategoryKey) => void;
}) {
  // 沿途服务只在确认后补算；草案阶段整块不出现，免得一排「待查」像是坏了。
  if (plan.status !== "confirmed") return null;
  const d = tripServicesForDay(plan, day);
  if (!d) return <p className={s.pending}>沿途服务正在后台查询，稍后出现在这里</p>;
  const areas = d.serviceAreas ?? [];
  return (
    <div className={s.services}>
      <div className={s.cells} role="group" aria-label={`Day ${day} 沿途服务`}>
        {dayServices(plan, day).map((c) => {
          const drawable = onToggle !== undefined && c.value !== PENDING && servicePoisFor(plan, day, c.key).length > 0;
          const on = selected.includes(c.key);
          return (
            <button
              key={c.key}
              type="button"
              className={cx(s.cell, on && s.on)}
              disabled={!drawable}
              aria-pressed={onToggle ? on : undefined}
              title={serviceCellTitle(plan, c.value)}
              onClick={() => onToggle?.(c.key)}
            >
              <Icon name={ICON[c.key]} size="sm" />
              <span>{c.label}</span>
              <span className={`${s.value} sa-num`}>{c.value}</span>
            </button>
          );
        })}
      </div>
      {areas.length > 0 && (
        <p className={s.areas}>
          <Icon name="car" size="sm" />
          高速服务区：{areas.join("、")}
        </p>
      )}
    </div>
  );
}
