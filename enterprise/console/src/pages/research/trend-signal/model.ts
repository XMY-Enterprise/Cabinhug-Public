/**
 * 趋势与信号的视图模型。纯函数。
 *
 * # `own-change` 不是"信号"
 *
 * 一条主题的提及率在某周前后出现台阶，而同一周我方更换了 ASR 引擎，
 * 此时变化多半来自我方改动而非车主行为。这类条目在列表里压暗并写明原因，
 * 不与真正的信号并列：我方系统的改动远比车主用车习惯的变化频繁。
 *
 * # 事件按"改的是系统"还是"改的是语料口径"分两条轨道
 *
 * Brief §3⑥ 要的是「我方变更 / 外部事件」两轨，但 `SystemEventKind` 的五个取值
 * 全是我方变更，本部署没有外部事件（政策、天气、油价）的数据源。
 * 恒空的「外部事件」轨会被误读为"这段时间外部无事发生"，因此两轨改为
 * 「系统变更 / 语料与口径」，外部事件缺位由说明条写明。
 */

export interface TrendData {
  buckets: Array<{ weekStart: number; turns: number }>;
  series: Array<{ code: string; label: string; raw: number[]; rate: number[]; baseline: number }>;
  events: Array<{ at: number; kind: string; summary: string; key?: string | null }>;
  signals: Array<{ code: string; verdict: "signal" | "own-change" | "noise"; reason: string }>;
}

export interface TrendPoint {
  weekStart: number;
  weekLabel: string;
  turns: number;
  /** 每条序列一列：`raw_<code>` 与 `rate_<code>`。 */
  [k: string]: number | string;
}

export interface TrendSignalRow {
  code: string;
  label: string;
  verdict: "signal" | "own-change" | "noise";
  reason: string;
  /** `own-change` 与 `noise` 压暗：它们不是可据以派活的信号。 */
  dimmed: boolean;
  verdictLabel: string;
}

export type EventTrack = "system" | "corpus";

export interface TrendEventMark {
  at: number;
  kind: string;
  track: EventTrack;
  /** 落在哪一周。事件轨与轨迹图共用同一条按周分档的横轴。 */
  weekLabel: string;
  label: string;
  summary: string;
}

export interface TrendSeriesMeta {
  code: string;
  label: string;
  baseline: number;
  selected: boolean;
}

export interface TrendView {
  points: TrendPoint[];
  /** 被选中、真正上图的那几条。 */
  series: Array<{ code: string; label: string; baseline: number }>;
  /** 全部可选序列（工具条的分段器用它）。 */
  options: TrendSeriesMeta[];
  events: TrendEventMark[];
  signals: TrendSignalRow[];
}

const VERDICT_LABEL: Record<string, string> = {
  signal: "信号",
  "own-change": "我们自己的变更",
  noise: "噪声",
};

/** 事件分轨。五个 kind 全是我方变更，只是改的东西不同——见文件头。 */
const TRACK_OF: Record<string, EventTrack> = {
  "config-change": "system",
  "guard-policy-change": "system",
  deploy: "system",
  "kb-sync": "corpus",
  "codebook-lock": "corpus",
};

export const TRACK_LABEL: Record<EventTrack, string> = {
  system: "系统变更（配置 / 安全策略 / 发版）",
  corpus: "语料与口径（知识库同步 / codebook 锁版）",
};

/**
 * `other` 是兜底桶，默认不占三条轨道之一：它恒为最大的一条，
 * 默认选中会让未归类的内容占据最显眼的位置。
 */
const CATCH_ALL = "other";

const weekLabel = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

export interface TrendWeekEvents {
  weekLabel: string;
  count: number;
  /** 竖线旁只写一条，其余进 tooltip，保证标签可读。 */
  label: string;
  /** 全部摘要，鼠标悬停时给出。 */
  detail: string;
}

/**
 * 事件按轨道 → 周 归并。
 *
 * 实测一个窗里有 24 次 `config-change`，逐个画竖线加标签会难以辨认。
 * 归并只做计数，不做任何比率："这周有几次我方变更"本身就是要读的数。
 */
export function eventTracks(events: readonly TrendEventMark[], track: EventTrack): TrendWeekEvents[] {
  const byWeek = new Map<string, TrendEventMark[]>();
  for (const e of events) {
    if (e.track !== track) continue;
    const list = byWeek.get(e.weekLabel) ?? [];
    list.push(e);
    byWeek.set(e.weekLabel, list);
  }
  return [...byWeek.entries()].map(([weekLabel, list]) => ({
    weekLabel,
    count: list.length,
    label: list.length === 1 ? list[0].summary : `${list[0].summary} 等 ${list.length} 项`,
    detail: list.map((e) => e.summary).join("\n"),
  }));
}

export interface TrendViewOptions {
  /** 用户在工具条里选的序列码；不给就取前 `maxSeries` 条（跳过 `other`）。 */
  selected?: readonly string[];
  maxSeries?: number;
}

/** 事件时刻 → 它落在哪一周。查表，不做任何比率计算。 */
function bucketLabelAt(buckets: TrendData["buckets"], at: number): string {
  let hit = buckets[0];
  for (const b of buckets) {
    if (b.weekStart <= at) hit = b;
  }
  return hit ? weekLabel(hit.weekStart) : "";
}

export function trendView(data: TrendData, opts: TrendViewOptions = {}): TrendView {
  const maxSeries = opts.maxSeries ?? 3;
  const chosen =
    opts.selected && opts.selected.length > 0
      ? data.series.filter((s) => opts.selected?.includes(s.code)).slice(0, maxSeries)
      : data.series.filter((s) => s.code !== CATCH_ALL).slice(0, maxSeries);

  const chosenCodes = new Set(chosen.map((s) => s.code));

  const points: TrendPoint[] = data.buckets.map((b, i) => {
    const p: TrendPoint = { weekStart: b.weekStart, weekLabel: weekLabel(b.weekStart), turns: b.turns };
    for (const s of chosen) {
      p[`raw_${s.code}`] = s.raw[i] ?? 0;
      p[`rate_${s.code}`] = s.rate[i] ?? 0;
    }
    return p;
  });

  const byCode = new Map(data.series.map((s) => [s.code, s.label]));

  return {
    points,
    series: chosen.map((s) => ({ code: s.code, label: s.label, baseline: s.baseline })),
    options: data.series.map((s) => ({
      code: s.code,
      label: s.label,
      baseline: s.baseline,
      selected: chosenCodes.has(s.code),
    })),
    events: data.events.map((e) => ({
      at: e.at,
      kind: e.kind,
      track: TRACK_OF[e.kind] ?? "system",
      weekLabel: bucketLabelAt(data.buckets, e.at),
      // 竖线标签：标明这一天我方做了什么变更。
      label: `${e.summary}（${weekLabel(e.at)}）`,
      summary: e.summary,
    })),
    signals: data.signals.map((s) => ({
      code: s.code,
      label: byCode.get(s.code) ?? s.code,
      verdict: s.verdict,
      reason: s.reason,
      dimmed: s.verdict !== "signal",
      verdictLabel: VERDICT_LABEL[s.verdict] ?? s.verdict,
    })),
  };
}
