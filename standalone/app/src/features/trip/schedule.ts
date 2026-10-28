/**
 * 一天的日程行：共享时间轴（`dayTimeline`，与车机端行程抽屉同一份）+ 这几屏要的展示字段。
 * 1 倍面板、2 倍面板、全屏天卡三处都读它，各自挑字段，不各算一遍。
 */
import type { TripPlanSnapshot, TripPlanSpotSnapshot } from "@cabinhug/shared";
import { dayTimeline, type TimelineRow } from "@cabinhug/ui";

import { nightOfStay } from "../../trip";

export interface ScheduleRow {
  key: string;
  kind: TimelineRow["kind"];
  /** 起始时刻「09:30」；时段的后半截在 `range` 里。 */
  time?: string;
  range?: string;
  title: string;
  /** 时间轴给的说明：「建议停留 1.5 小时」「入住 · 车程 20 分钟」「出发」。 */
  note: string;
  /** 景点自己的一句话介绍（模型写在快照里的 `note`）；没有就是 undefined。 */
  desc?: string;
  /** 配图品类：景点取快照的 poiKind，住处 hotel，出发 / 返程 home。 */
  art: string | undefined;
  spot?: TripPlanSpotSnapshot;
}

export function scheduleRows(plan: TripPlanSnapshot, day: number): ScheduleRow[] {
  const d = plan.skeleton.find((x) => x.day === day);
  const night = nightOfStay(plan, day);
  return dayTimeline(plan, day).map((r, i) => {
    const spot = r.kind === "spot" ? d?.spots.find((s) => s.name === r.name) : undefined;
    const [start, end] = (r.time ?? "").split("–").map((x) => x.trim());
    const note = r.kind === "hotel" && night && night > 1 ? `${r.note} · 连住第 ${night} 晚` : r.note;
    return {
      key: `${i}-${r.kind}-${r.name}`,
      kind: r.kind,
      ...(start ? { time: start } : {}),
      ...(end ? { range: `${start}–${end}` } : {}),
      title: r.name,
      note,
      ...(spot?.note ? { desc: spot.note } : {}),
      art: r.kind === "spot" ? spot?.poiKind : r.kind === "hotel" || r.kind === "checkin" ? "hotel" : "home",
      ...(spot ? { spot } : {}),
    };
  });
}
