/**
 * 余额曲线的几何计算，与渲染分开，理由同 model.ts：便于断言。
 *
 * 画错的曲线不会报错。本文件守住以下几条：
 *   ① 缺口不连成直线。停机期间没有数据，连线会被读成"缓慢消耗"。缺口必须断开。
 *   ② 纵轴放大倍数要可见。曲线自适应缩放（不从 0 起），
 *      余额从 50.06 掉到 50.02 也能画成一道陡坡，因此极值显示在旁边。
 *   ③ 单个点不画成曲线。只有一个采样点时画成横线会被读成"余额没变"，
 *      实际含义是"只测过一次"。
 *   ④ 横轴动态缩放时标出跨度。窗口按实际数据从 1 小时伸缩到 7 天，
 *      外形相同的曲线可能分别对应一小时与一星期，刻度是缩放成立的前提。
 */

/** 服务端给的一个采样点。`t` 是整点桶起点的 epoch ms。 */
export interface HistoryPoint {
  t: number;
  v: number;
}

export interface HistorySeries {
  currency: string;
  points: HistoryPoint[];
}

export interface FinanceHistory {
  retentionDays: number;
  /**
   * 采样间隔（服务端给，默认 10 分钟）。缺口判据、空态文案、气泡里的时间格式
   * 全部由它推出来，前端不写死：否则服务端调整周期后，页面文案与缺口判据都会失准。
   */
  stepMs: number;
  /** 服务端保留窗口的左端（now - 7 天）。页面的窗口不会伸到它左边去。 */
  from: number;
  /** 服务端的"现在"。窗口的右端永远是它——曲线讲的永远是"到此刻为止"。 */
  to: number;
  series: Record<string, HistorySeries>;
  note: string;
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
/** 横轴最短 1 小时：10 分钟一采时正好 6 格，再窄刻度就密得没法看了。 */
export const MIN_SPAN_MS = HOUR_MS;
/** 横轴最长 7 天：与服务端的保留窗口一致，再长也没有数据。 */
export const MAX_SPAN_MS = 7 * DAY_MS;

export interface TimeWindow {
  from: number;
  to: number;
  span: number;
}

/**
 * 横轴窗口：**按实际有多少数据伸缩**，夹在 [1 小时, 7 天]。
 *
 * 动态伸缩：固定 7 天时，冷启动那半小时的数据挤在最右边 0.3% 的宽度里，看不出曲线。
 *
 * 所有卡片共用一个窗口：各缩各的会让并排卡片上同一横坐标对应不同时刻，
 * 无法横向比较。各家数据由同一个定时器采集，数据量相同，共用窗口同样能解决冷启动的问题。
 *
 * 一个点都没有时给 `null`：那种情况根本没有曲线可画，也就不该有横轴。
 *
 * `extraEarliest` 是同一张卡上**其它图**的最早时刻（吞吐柱状图的第一个桶）：
 * 它们与余额曲线共用横轴，窗口需把它们也装进去，否则吞吐图早于余额历史的那几天会被裁掉。
 */
export function windowFor(
  history: Pick<FinanceHistory, "from" | "to" | "series">,
  extraEarliest: number[] = [],
): TimeWindow | null {
  let earliest = Number.POSITIVE_INFINITY;
  for (const series of Object.values(history.series)) {
    for (const p of series.points) {
      if (Number.isFinite(p.v) && p.t < earliest) earliest = p.t;
    }
  }
  for (const t of extraEarliest) {
    if (Number.isFinite(t) && t < earliest) earliest = t;
  }
  if (!Number.isFinite(earliest)) return null;

  const to = history.to;
  const span = Math.min(Math.max(to - earliest, MIN_SPAN_MS), MAX_SPAN_MS);
  // 不越过服务端保留窗口的左端，那边没有数据。
  const from = Math.max(to - span, history.from);
  return { from, to, span: to - from };
}

/**
 * 刻度间隔。从下面的候选里挑第一个能让格数 ≤ 6 的。
 *
 * 6 格 = 最多 7 个标签。刻度文字是 `HH:MM` / `MM-DD`，都是 5 个字符（约 30px），
 * 卡片最窄 300px 时曲线宽约 270px，7 个标签正好排得开，再多就开始叠字。
 * 判据是格数而非标签数：n 格有 n+1 个边界，≤7 格会产生 8 个标签。
 * 1 小时窗口正好落在 10 分钟这一档（6 格 / 6~7 个标签），与"最短 1 小时"那条约束配套。
 */
const TICK_LADDER = [
  10 * 60_000,
  // 15 分钟这一档填补空档：刚过一小时（比如 76 分钟）时，10 分钟给 7.6 格太密、
  // 30 分钟只剩 2 格太疏。
  15 * 60_000,
  30 * 60_000,
  HOUR_MS,
  2 * HOUR_MS,
  3 * HOUR_MS,
  6 * HOUR_MS,
  12 * HOUR_MS,
  DAY_MS,
  2 * DAY_MS,
  7 * DAY_MS,
];

export function tickStep(span: number): number {
  return TICK_LADDER.find((s) => span / s <= 6) ?? TICK_LADDER[TICK_LADDER.length - 1];
}

export interface AxisTick {
  t: number;
  /** 与 dots 同坐标系（0~width） */
  x: number;
  label: string;
  /** 文字贴边会被卡片裁掉，两端的标签改成左/右对齐 */
  anchor: "start" | "middle" | "end";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 刻度。落在**本地时间**的整点上，不是 epoch 的整点。
 *
 * 差别在 UTC+5:30 这类半小时时区：按 epoch 对齐的话"每小时"刻度会全部落在 :30，
 * 不像刻度。DST 切换那天会有一格宽窄不均，接受这一代价：
 * 补偿它需要一整套日历运算，而这是一张 270px 宽的缩略图。
 */
export function axisTicks(win: TimeWindow, width = 100): AxisTick[] {
  const step = tickStep(win.span);
  const offsetOf = (t: number): number => -new Date(t).getTimezoneOffset() * 60_000;

  const ticks: AxisTick[] = [];
  const off = offsetOf(win.from);
  let t = Math.ceil((win.from + off) / step) * step - off;
  // 上限是安全网：step 万一算成 0 或负数，这里也不会转成死循环
  for (let guard = 0; t <= win.to && guard < 32; guard += 1, t += step) {
    const d = new Date(t);
    // 日期只在它变化的那一刻（本地零点）出现，其余写时刻：
    // 每个刻度都带日期会叠字，一个都不带则跨天的窗口分不清哪个 14:00。
    const midnight = d.getHours() === 0 && d.getMinutes() === 0;
    const label =
      midnight || step >= DAY_MS
        ? `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
        : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const x = ((t - win.from) / (win.span || 1)) * width;
    ticks.push({
      t,
      x: Math.round(x * 100) / 100,
      label,
      anchor: x < width * 0.08 ? "start" : x > width * 0.92 ? "end" : "middle",
    });
  }
  return ticks;
}

/** 横轴跨度的人话说法，给角标用（"近 7 天"）。 */
export function spanLabel(span: number): string {
  const hours = span / HOUR_MS;
  if (hours < 48) return `近 ${Math.max(1, Math.round(hours))} 小时`;
  return `近 ${Math.round(span / DAY_MS)} 天`;
}

export interface SparkDot {
  /** 视口坐标，viewBox 为 `0 0 width height` */
  x: number;
  y: number;
  t: number;
  v: number;
}

export interface Sparkline {
  /** 折线，一段一条——中间断开的地方就是没有采样的小时 */
  segments: string[];
  /** 与 segments 一一对应的填充区域 */
  areas: string[];
  dots: SparkDot[];
  /**
   * 两侧都断开、连不进任何线段的孤点。
   *
   * 它们必须画成点，不能因为连不成线就丢掉：采样周期为 10 分钟时，
   * 时开时停的网关容易产出一串彼此不相邻的点，丢掉会使图上空白而角标仍显示有采样点。
   */
  orphans: SparkDot[];
  /** 纵轴实际映射的域（极值相等时人为撑开，见下） */
  lo: number;
  hi: number;
  min: number;
  max: number;
  first: number;
  last: number;
  /** last - first。它是窗口内的变化，不是充值额 */
  delta: number;
  /**
   * 时间上不连续的处数。
   *
   * 数的是相邻两点之间的断裂，不是"线段数减一"。后者在所有点都彼此孤立时
   * 会算出 0，把"全是缺口"报成"没有缺口"。
   */
  gaps: number;
  width: number;
  height: number;
}

export interface SparkOptions {
  from: number;
  to: number;
  stepMs: number;
  width?: number;
  height?: number;
  /** 上下留白，给线宽和端点圆点用 */
  pad?: number;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 把采样点摆成一条可画的折线。
 *
 * 横轴用 `windowFor()` 算出的全页共用窗口（按实际数据在 1 小时~7 天之间伸缩），
 * 不按各账户自己的首末点缩放，保证卡片之间同一横坐标对应同一时刻。
 *
 * 纵轴按本账户的极值自适应：从 0 起的话，余额 50 掉到 45 在 32px 高的
 * 图里只有 3 个像素。代价是放大倍数不定，所以调用方必须把
 * `min`/`max` 显示出来（见文件头 ②）。
 *
 * 返回 `null` = 一个点都没有，调用方该说"还没有历史"而不是画一张空图。
 */
export function buildSparkline(points: HistoryPoint[], opts: SparkOptions): Sparkline | null {
  const width = opts.width ?? 100;
  const height = opts.height ?? 32;
  const pad = opts.pad ?? 3;

  const inWindow = points
    .filter((p) => Number.isFinite(p.v) && p.t >= opts.from && p.t <= opts.to)
    .sort((a, b) => a.t - b.t);
  if (inWindow.length === 0) return null;

  const values = inWindow.map((p) => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);

  // 余额一直没变（常见于没有请求的一夜）。此时上下人为撑开，
  // 线落在正中间，避免压在顶端或底端被读成"贴着上限/见底"。
  let lo = min;
  let hi = max;
  if (hi - lo < 1e-9) {
    const spread = Math.max(Math.abs(hi) * 0.05, 1);
    lo = hi - spread;
    hi = hi + spread;
  }

  const span = opts.to - opts.from || 1;
  const inner = height - pad * 2;
  const dots: SparkDot[] = inWindow.map((p) => ({
    x: round(((p.t - opts.from) / span) * width),
    y: round(pad + (1 - (p.v - lo) / (hi - lo)) * inner),
    t: p.t,
    v: p.v,
  }));

  /*
   * 缺口判据：相邻两点间隔超过 2.5 个采样周期就断开。
   * 不按"缺一个桶就断"：定时器偶尔会被慢上游挤过一个桶边界，
   * dt 变成 2 个周期，那不是停机。2.5 个周期以上（连缺两个桶）才判为停机。
   */
  const gapMs = opts.stepMs * 2.5;
  const segments: string[] = [];
  const areas: string[] = [];
  const orphans: SparkDot[] = [];
  let gaps = 0;
  let run: SparkDot[] = [dots[0]];

  const flush = (): void => {
    // 一个点连不成线，但它是真实采样，留成孤点由渲染层画出。
    if (run.length < 2) {
      if (run.length === 1) orphans.push(run[0]);
      run = [];
      return;
    }
    const d = run.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
    segments.push(d);
    areas.push(`${d} L${run[run.length - 1].x} ${height} L${run[0].x} ${height} Z`);
    run = [];
  };

  for (let i = 1; i < dots.length; i += 1) {
    if (dots[i].t - dots[i - 1].t > gapMs) {
      gaps += 1;
      flush();
      run = [dots[i]];
    } else {
      run.push(dots[i]);
    }
  }
  flush();

  return {
    segments,
    areas,
    dots,
    orphans,
    lo,
    hi,
    min,
    max,
    first: values[0],
    last: values[values.length - 1],
    delta: values[values.length - 1] - values[0],
    gaps,
    width,
    height,
  };
}

/** 悬浮时离光标最近的那个采样点。`x` 与 dots 同坐标系。 */
export function nearestDot(dots: SparkDot[], x: number): SparkDot | null {
  if (dots.length === 0) return null;
  let best = dots[0];
  let bestD = Math.abs(dots[0].x - x);
  for (const d of dots) {
    const dist = Math.abs(d.x - x);
    if (dist < bestD) {
      best = d;
      bestD = dist;
    }
  }
  return best;
}

/**
 * 悬浮气泡里的时间。
 *
 * 带日期：七天的图上只写"14:20"无法判断是哪天。
 * 分钟位取自采样点，不写死 `:00`：采样周期细于一小时时，
 * 写死的分钟会让同一小时里的多个点显示成同一时刻。
 */
export function pointTimeLabel(t: number): string {
  const d = new Date(t);
  const p2 = (n: number): string => String(n).padStart(2, "0");
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/**
 * 采样周期的人话说法，给空态文案用（"每 10 分钟采样一次"）。
 * 由 `stepMs` 推出来而不是写死，理由见 `FinanceHistory.stepMs` 上的注释。
 */
export function intervalLabel(stepMs: number): string {
  const min = Math.round(stepMs / 60_000);
  if (min < 60) return `${min} 分钟`;
  const h = min / 60;
  return Number.isInteger(h) ? `${h} 小时` : `${min} 分钟`;
}

/**
 * 窗口内的净变化。
 *
 * 用"净变"：中间充过值又花掉时，它与消耗额不同。
 * 短文案保证带缺口角标的卡片不折行；完整口径在 `deltaTitle()` 的悬浮说明里。
 */
export function deltaLabel(spark: Sparkline): string {
  const d = spark.delta;
  if (Math.abs(d) < 0.005) return "净变持平";
  return `净变 ${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(2)}`;
}

/** 净变的完整口径，避免"净变"被读成消耗额。 */
export const deltaTitle =
  "窗口内第一个采样点到最新采样点的净变化。中间充过值又花掉的话，它与「这段时间花了多少」不是一回事。";

/**
 * 给屏幕阅读器的一句话。悬浮气泡它读不到，所以这里要把要点说全。
 * 跨度必须念出来：横轴是伸缩的，同样的走势可能对应一小时或一星期。
 */
export function sparkAriaLabel(spark: Sparkline, currency: string, span: number): string {
  const parts = [
    `${spanLabel(span)}余额曲线`,
    `${spark.dots.length} 个采样点`,
    `最低 ${spark.min.toFixed(2)}`,
    `最高 ${spark.max.toFixed(2)} ${currency}`,
    deltaLabel(spark),
  ];
  if (spark.gaps > 0) parts.push(`有 ${spark.gaps} 处缺口未采集`);
  return parts.join("，");
}
