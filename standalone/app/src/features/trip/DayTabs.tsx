/**
 * 天页签：「全部 / Day 1 / Day 2」。窄处（1 倍面板）不带日期，宽处带「Day 1 · 10/24」与「全部 3 天」。
 * 值 0 = 全部。
 */
import type { TripPlanSnapshot } from "@cabinhug/shared";

import { Segmented } from "../../ui";
import { dayShortDate } from "../../trip";

export const ALL_DAYS = 0;

export function DayTabs({
  plan,
  value,
  onChange,
  wide,
  tone,
  stretch,
}: {
  plan: TripPlanSnapshot;
  value: number;
  onChange(day: number): void;
  wide?: boolean;
  tone?: "solid" | "soft";
  stretch?: boolean;
}) {
  const options = [
    { value: ALL_DAYS, label: wide ? `全部 ${plan.days} 天` : "全部" },
    ...plan.skeleton.map((d) => {
      const date = wide ? dayShortDate(plan, d.day) : undefined;
      return { value: d.day, label: date ? `Day ${d.day} · ${date}` : `Day ${d.day}` };
    }),
  ];
  return <Segmented label="选择哪一天" options={options} value={value} onChange={onChange} tone={tone} stretch={stretch} />;
}
