/**
 * 单测里造 `submit_drive_plan` 的段列表（ACR-047）。
 *
 * 部分用例按「legMinutes + stops + legDays」的平行数组写夹具；`legsFrom` 把那三样按固定规则
 * （同一天相邻两段之间一个停靠点，跨天边界隔一晚住宿，最后一段到目的地）翻成自描述的段，
 * 夹具只需一个调用而不必逐段手写。只用于夹具，生产上模型直接交段。
 */
import type { DriveLeg, DriveStopKind } from "@cabinhug/tools";

export function leg(
  day: number,
  direction: "outbound" | "return",
  from: string,
  to: string,
  minutes: number,
  kind: DriveStopKind = "rest",
): DriveLeg {
  return { day, direction, from, to: { kind, name: to }, minutes };
}

export interface LegsFromOpts {
  origin?: string;
  destination?: string;
  /** 回程段（按同一规则翻）：每段分钟数与它们之间的停靠点；缺省 = 没有回程。 */
  returnMinutes?: number[];
  returnStops?: string[];
  returnDays?: number[];
}

/** 平行数组夹具 → 段列表。`legDays` 缺省 = 全在第 1 天（没给天 = 一天连着开）。 */
export function legsFrom(minutes: number[], stops: string[] = [], legDays?: number[], opts: LegsFromOpts = {}): DriveLeg[] {
  const origin = opts.origin ?? "出发地";
  const destination = opts.destination ?? "目的地";
  const days = legDays ?? minutes.map(() => 1);
  const out: DriveLeg[] = [];
  let si = 0;
  let from = origin;
  minutes.forEach((m, i) => {
    const last = i === minutes.length - 1;
    const sameDayNext = !last && days[i] === days[i + 1];
    let to: string;
    let kind: DriveStopKind;
    if (last) {
      to = destination;
      kind = "overnight";
    } else if (sameDayNext) {
      to = stops[si] ?? "待定停靠点";
      si += 1;
      kind = "rest";
    } else {
      to = `第${days[i]}天落脚处`;
      kind = "overnight";
    }
    out.push({ day: days[i]!, direction: "outbound", from, to: { kind, name: to }, minutes: m });
    from = to;
  });
  const rm = opts.returnMinutes;
  if (rm?.length) {
    const rs = opts.returnStops ?? [];
    const rd = opts.returnDays ?? rm.map(() => days[days.length - 1] ?? 1);
    let ri = 0;
    let rfrom = destination;
    rm.forEach((m, i) => {
      const last = i === rm.length - 1;
      const sameDayNext = !last && rd[i] === rd[i + 1];
      let to: string;
      let kind: DriveStopKind;
      if (last) {
        to = origin;
        kind = "origin";
      } else if (sameDayNext) {
        to = rs[ri] ?? "待定停靠点";
        ri += 1;
        kind = "rest";
      } else {
        to = `第${rd[i]}天落脚处`;
        kind = "overnight";
      }
      out.push({ day: rd[i]!, direction: "return", from: rfrom, to: { kind, name: to }, minutes: m });
      rfrom = to;
    });
  }
  return out;
}

/** 给假 streamer 用：整段正文就是一个 JSON 对象（`parseDriveText` 只认这种）。 */
export function driveText(legs: DriveLeg[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ legs, findings: [], ...extra });
}
