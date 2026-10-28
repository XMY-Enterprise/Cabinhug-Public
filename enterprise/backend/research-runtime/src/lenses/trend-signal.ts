/**
 * 镜头五·趋势与信号。
 *
 * # 分母随窗口变，所以原始量与标准化率必须同屏
 *
 * 只看 `raw`（每周命中数）会把"这周车主话多"读成"这个需求涨了"；
 * 只看 `rate` 会让一周只有 3 轮的格与 300 轮的格显得同样有分量。
 * 两条线与前 90 天基线一起画。
 *
 * # 拐点先归因到自己的变更
 *
 * `signals[].verdict` 有三档，其中 `own-change`：一条 `config-change(ASR_ENGINE)`
 * 落在某周、该周之后 `asr-error` 出现台阶，多半是识别引擎更换所致，而非用户行为变化。
 * 系统自身的变更比车主用车习惯的变化频繁得多，因此先排除它。
 */

import type { ResearchSystemEvent, TrendSignalData, TrendSeries } from "@cabinhug/research";

import { labelOf, type CodedTurn, type LabelMap } from "./input";

const WEEK_MS = 7 * 86_400_000;

/** 台阶判据：变更后均值与变更前均值差多少个百分点算"有台阶"。 */
export const STEP_THRESHOLD_PP = 0.05;
/** 一条序列在整窗里的波动小于它就是噪声，不值得解读。 */
export const NOISE_THRESHOLD_PP = 0.02;

export interface TrendOptions {
  windowFrom: number;
  windowTo: number;
  labels: LabelMap;
  events: readonly ResearchSystemEvent[];
  /** 前 90 天的同码提及率，算基线用；没有历史就给空。 */
  baseline: Record<string, number>;
  /** 最多画几条线。 */
  maxSeries?: number;
}

/** 周桶的起点对齐到 windowFrom 而不是自然周，避免第一桶不满而显得是低谷。 */
function bucketIndex(at: number, from: number): number {
  return Math.floor((at - from) / WEEK_MS);
}

export function buildTrendSignal(turns: readonly CodedTurn[], opts: TrendOptions): TrendSignalData {
  const bucketCount = Math.max(1, Math.ceil((opts.windowTo - opts.windowFrom) / WEEK_MS));
  const turnsPerBucket = new Array<number>(bucketCount).fill(0);
  const seenTurn = new Set<string>();

  for (const t of turns) {
    const i = Math.min(bucketCount - 1, Math.max(0, bucketIndex(t.occurredAt, opts.windowFrom)));
    const key = `${i}|${t.turnId ?? t.unitId}`;
    if (seenTurn.has(key)) continue;
    seenTurn.add(key);
    turnsPerBucket[i] += 1;
  }

  const byCode = new Map<string, number[]>();
  for (const t of turns) {
    const i = Math.min(bucketCount - 1, Math.max(0, bucketIndex(t.occurredAt, opts.windowFrom)));
    for (const code of t.needPains) {
      if (code === "none") continue;
      const arr = byCode.get(code) ?? new Array<number>(bucketCount).fill(0);
      arr[i] += 1;
      byCode.set(code, arr);
    }
  }

  const series: TrendSeries[] = [...byCode.entries()]
    .map(([code, raw]) => ({
      code,
      label: labelOf(opts.labels, code),
      raw,
      // 分母是该周的轮次；该周没轮次时给 0 而不是留空，空点在折线上会被连过去。
      rate: raw.map((n, i) => (turnsPerBucket[i] === 0 ? 0 : n / turnsPerBucket[i])),
      baseline: opts.baseline[code] ?? 0,
    }))
    .sort((a, b) => b.raw.reduce((x, y) => x + y, 0) - a.raw.reduce((x, y) => x + y, 0))
    .slice(0, opts.maxSeries ?? 10);

  /** 落在窗内的系统变更事件，按周归位。 */
  const eventBuckets = opts.events
    .filter((e) => e.at >= opts.windowFrom && e.at <= opts.windowTo)
    .map((e) => ({ event: e, bucket: Math.min(bucketCount - 1, Math.max(0, bucketIndex(e.at, opts.windowFrom))) }));

  const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

  const signals = series.map((s) => {
    const spread = Math.max(...s.rate) - Math.min(...s.rate);
    if (spread < NOISE_THRESHOLD_PP) {
      return { code: s.code, verdict: "noise" as const, reason: `整窗波动 ${(spread * 100).toFixed(1)} 个百分点，不足以解读` };
    }

    // 检查是否有自身变更正好落在台阶上。
    for (const { event, bucket } of eventBuckets) {
      if (bucket <= 0 || bucket >= s.rate.length - 1) continue;
      const before = mean(s.rate.slice(0, bucket));
      const after = mean(s.rate.slice(bucket));
      if (Math.abs(after - before) >= STEP_THRESHOLD_PP) {
        return {
          code: s.code,
          verdict: "own-change" as const,
          reason:
            `第 ${bucket} 周前后由 ${(before * 100).toFixed(1)}% 变到 ${(after * 100).toFixed(1)}%，` +
            `同周有我们自己的变更：${event.summary}。先排除它再当成需求变化`,
        };
      }
    }

    return {
      code: s.code,
      verdict: "signal" as const,
      reason: `整窗波动 ${(spread * 100).toFixed(1)} 个百分点，窗内没有能解释它的系统变更`,
    };
  });

  return {
    buckets: turnsPerBucket.map((t, i) => ({ weekStart: opts.windowFrom + i * WEEK_MS, turns: t })),
    series,
    events: eventBuckets.map((e) => e.event),
    signals,
  };
}
