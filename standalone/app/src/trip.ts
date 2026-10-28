/**
 * 行程面板的纯函数：标题、日期、地图站点、路程。只读 `TripPlanSnapshot` 里**有**的东西，
 * 没有的不编（距离、过路费不在快照里，就不画；天气不在窗口内，就照 caveats 说）。
 */
import type { TripPlanSnapshot } from "@cabinhug/shared";
import type { TripMapStop } from "@cabinhug/ui";

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function parseDate(iso: string | undefined): Date | undefined {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return undefined;
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!));
}

function md(d: Date): string {
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** 第 `day` 天（1 起）的日期标签，如「10/31 周六」。没有出发日期就是 undefined。 */
export function dayDateLabel(plan: Pick<TripPlanSnapshot, "startDate">, day: number): string | undefined {
  const start = parseDate(plan.startDate);
  if (!start) return undefined;
  const d = new Date(start.getTime() + (day - 1) * 86_400_000);
  return `${md(d)} ${WEEK[d.getUTCDay()]}`;
}

/** 「上海 → 杭州 · 2 天 1 晚 · 10/31–11/1」。 */
export function tripTitle(plan: TripPlanSnapshot): string {
  const route = plan.origin ? `${plan.origin} → ${plan.destination}` : plan.destination;
  const nights = plan.days > 1 ? ` ${plan.days - 1} 晚` : "";
  const parts = [route, `${plan.days} 天${nights}`];
  const start = parseDate(plan.startDate);
  if (start) {
    const end = new Date(start.getTime() + (plan.days - 1) * 86_400_000);
    parts.push(plan.days > 1 ? `${md(start)}–${md(end)}` : md(start));
  }
  return parts.join(" · ");
}

/**
 * 这份草案最近一次是不是在 `sessionId` 这段对话里改的。
 *
 * 缺省 `tasks` 档下草案按「人」存、每人一份（ACR-036 的工作任务），不跟会话走：
 * 在 A 对话里排过苏州、又在 B 对话里排杭州，A 那边读到的已经是杭州。面板要说清这一点，
 * 否则车主对着旧对话点「定下来」，定下的会是另一份。
 *
 * 判据取 `updatedTurnId` 的前缀：它是编排层的线程号 `${sessionId}#${毫秒}`（turn-runner.ts 建线程处）。
 * 这个格式若哪天变了，这里只会多提示一句「来自另一段对话」，不会定错东西。
 */
export function draftFromSession(plan: Pick<TripPlanSnapshot, "updatedTurnId">, sessionId: string): boolean {
  return plan.updatedTurnId.startsWith(`${sessionId}#`);
}

export function isConfirmed(plan: TripPlanSnapshot): boolean {
  return plan.status === "confirmed";
}

/** 地图上的点：景点按天编号，住宿单列；没有坐标的点不画（宁可少一个点，不标猜的位置，ADR-008）。 */
export function mapStops(plan: TripPlanSnapshot): TripMapStop[] {
  const out: TripMapStop[] = [];
  for (const day of plan.skeleton) {
    for (const s of day.spots) {
      if (s.lat === undefined || s.lon === undefined) continue;
      out.push({ name: s.name, day: day.day, kind: "spot", poiKind: s.poiKind, lat: s.lat, lon: s.lon, estStart: s.estStart, estEnd: s.estEnd });
    }
    const h = day.hotel;
    if (h && h.lat !== undefined && h.lon !== undefined && !out.some((x) => x.kind === "hotel" && x.name === h.name)) {
      const days = plan.skeleton.filter((d) => d.hotel?.name === h.name).map((d) => d.day);
      out.push({ name: h.name, day: day.day, kind: "hotel", lat: h.lat, lon: h.lon, days });
    }
  }
  return out;
}

function minutesLabel(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `约 ${h} 小时${m ? ` ${m} 分` : ""}` : `约 ${m} 分`;
}

/**
 * 时间轴上景点的序号，与地图上的编号同一套：`AmapTripLayer` 按 `mapStops` 的顺序给景点 `++seq`，
 * 没坐标的点不上图也不编号。键是「第几天:名字」（同名景点可能在不同天各去一次）。
 */
export function spotNumbers(plan: TripPlanSnapshot): Map<string, number> {
  const out = new Map<string, number>();
  let seq = 0;
  for (const s of mapStops(plan)) if (s.kind === "spot") out.set(`${s.day}:${s.name}`, ++seq);
  return out;
}

/** 去程 / 回程的行车时长（只算快照里的分段；分段不全就不写这一程）。 */
export function routeLines(plan: TripPlanSnapshot): string[] {
  const legs = plan.legs ?? [];
  const lines: string[] = [];
  for (const [dir, label] of [["outbound", "去程"], ["return", "回程"]] as const) {
    const these = legs.filter((l) => l.direction === dir && !l.pending);
    if (these.length === 0) continue;
    const total = these.reduce((n, l) => n + l.driveMinutes, 0);
    const rests = these.filter((l) => l.reason === "rest" && l.toStop).map((l) => l.toStop!);
    lines.push(`${label} ${minutesLabel(total)}${rests.length ? ` · 中途歇 ${rests.join("、")}` : ""}`);
  }
  if (lines.length === 0 && plan.transit?.summary) lines.push(plan.transit.summary);
  return lines;
}

// ── 定稿四屏（内部文档）用到的派生值 ───────────────────────────────

/** 「3天2晚」「1天」。 */
export function durationLabel(plan: Pick<TripPlanSnapshot, "days">): string {
  return plan.days > 1 ? `${plan.days}天${plan.days - 1}晚` : `${plan.days}天`;
}

/** 「10/24–10/26」；`withYear` 时「2026/10/24–10/26」。没有出发日期就是 undefined。 */
export function dateRangeLabel(plan: Pick<TripPlanSnapshot, "startDate" | "days">, withYear = false): string | undefined {
  const start = parseDate(plan.startDate);
  if (!start) return undefined;
  const end = new Date(start.getTime() + (plan.days - 1) * 86_400_000);
  const head = withYear ? `${start.getUTCFullYear()}/${md(start)}` : md(start);
  return plan.days > 1 ? `${head}–${md(end)}` : head;
}

/** 第 `day` 天的「10/25」（不带星期，页签用）。 */
export function dayShortDate(plan: Pick<TripPlanSnapshot, "startDate">, day: number): string | undefined {
  const start = parseDate(plan.startDate);
  return start ? md(new Date(start.getTime() + (day - 1) * 86_400_000)) : undefined;
}

/** 这一天的主题行：「老城漫步 · 西湖风光」——theme 与 area 不同才都写。 */
export function dayHeadline(d: Pick<TripPlanSnapshot["skeleton"][number], "theme" | "area">): string {
  return d.area && d.area !== d.theme ? `${d.theme} · ${d.area}` : d.theme;
}

/**
 * 「今天」落在行程的第几天；不在行程日期里（还没出发、已经回来、没有日期）就是 undefined。
 * `now` 取本地日历日：车主说的「今天」是他所在时区的那一天。
 */
export function todayIndex(plan: Pick<TripPlanSnapshot, "startDate" | "days">, now: Date): number | undefined {
  const start = parseDate(plan.startDate);
  if (!start) return undefined;
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const i = Math.round((today - start.getTime()) / 86_400_000) + 1;
  return i >= 1 && i <= plan.days ? i : undefined;
}

function clockMinutes(hhmm: string | undefined): number | undefined {
  const m = hhmm ? /^(\d{1,2}):(\d{2})$/.exec(hhmm) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
}

/**
 * 概要卡上「下一站 / 首站」那一格。
 *
 * 只有今天就在行程里、且景点带时刻时才说「下一站」（还没开始的第一个点）；
 * 其余情况说的是那一天的「首站」——不在路上就没有"下一站"可言。今天的点都过了就不写这一格。
 */
export function nextStopOf(
  plan: TripPlanSnapshot,
  day: number,
  now: Date,
): { label: "下一站" | "首站"; name: string } | undefined {
  const spots = plan.skeleton.find((d) => d.day === day)?.spots ?? [];
  if (spots.length === 0) return undefined;
  if (todayIndex(plan, now) !== day) return { label: "首站", name: spots[0]!.name };
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const timed = spots.filter((s) => clockMinutes(s.estStart) !== undefined);
  if (timed.length === 0) return { label: "首站", name: spots[0]!.name };
  const next = timed.find((s) => clockMinutes(s.estStart)! >= nowMin);
  return next ? { label: "下一站", name: next.name } : undefined;
}

/**
 * 去程 / 回程：分钟数来自规划时拆好的行车分段（`legs`），里程只有读时算的 `leg`（出发地 →
 * 今天第一站）给得出，且只配在去程上。分段缺了的那一程不写——不拿另一程的数凑。
 */
export function driveSummary(plan: TripPlanSnapshot): { outbound?: string; outboundKm?: string; back?: string } {
  const legs = plan.legs ?? [];
  const total = (dir: "outbound" | "return") => {
    const these = legs.filter((l) => l.direction === dir && !l.pending);
    return these.length ? minutesLabel(these.reduce((n, l) => n + l.driveMinutes, 0)) : undefined;
  };
  const outbound = total("outbound");
  const back = total("return");
  const km = plan.leg?.distanceKm;
  return {
    ...(outbound ? { outbound } : {}),
    ...(outbound && km !== undefined ? { outboundKm: `${Math.round(km)} km` } : {}),
    ...(back ? { back } : {}),
  };
}

const POI_KIND_LABEL: Record<string, string> = {
  temple: "寺庙",
  park: "公园广场",
  amusement_park: "游乐园",
  museum: "博物馆",
  mountain: "山岳",
  wetland: "湿地",
  beach: "海滩",
  old_town: "历史街区",
  food: "美食",
  hotel: "住宿",
  charge: "充电站",
  home: "出发地",
  spot: "景点",
};

/** 品类标签「历史街区」；没有品类（模型没给、高德类目没对上）就不写，不猜。 */
export function poiKindLabel(kind: string | undefined): string | undefined {
  return kind ? POI_KIND_LABEL[kind] : undefined;
}

/** 一家酒店住哪几晚：连住的同一家合成一行（名字相同即同一家，与 `mapStops` 同一判断）。 */
export function hotelStays(plan: TripPlanSnapshot): Array<{ hotel: NonNullable<TripPlanSnapshot["skeleton"][number]["hotel"]>; days: number[] }> {
  const out: Array<{ hotel: NonNullable<TripPlanSnapshot["skeleton"][number]["hotel"]>; days: number[] }> = [];
  for (const d of plan.skeleton) {
    if (!d.hotel) continue;
    const same = out.find((x) => x.hotel.name === d.hotel!.name);
    if (same) same.days.push(d.day);
    else out.push({ hotel: d.hotel, days: [d.day] });
  }
  return out;
}

/** 这一晚是这家店连住的第几晚（1 起）；不住店就是 undefined。 */
export function nightOfStay(plan: TripPlanSnapshot, day: number): number | undefined {
  const name = plan.skeleton.find((d) => d.day === day)?.hotel?.name;
  if (!name) return undefined;
  let n = 0;
  for (const d of plan.skeleton) {
    if (d.day > day) break;
    n = d.hotel?.name === name ? n + 1 : 0;
  }
  return n;
}
