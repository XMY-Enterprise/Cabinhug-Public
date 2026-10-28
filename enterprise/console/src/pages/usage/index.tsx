/**
 * 用量与成本（F-36-07 / F-30-07 子集）。
 *
 * 回答"用量与成本来自哪里"，所以维度可切（模型 / Agent）并可按日期筛选，
 * 而不是只给一个总数。
 *
 * 页面顶部那句话是职责边界：指标可采样可丢失，审计逐条不可丢失。
 */

import { useCallback, useEffect, useState } from "react";

import { api, ApiError } from "../../api";

/**
 * 维度只剩两个。
 *
 * 不设 `provider`：它只有 deepseek / pi-acp 两个值，两者背后是同一家的同一批模型，
 * 「按模型」已经包含了它。
 * 不设 `day`：时间是筛选条件而不是维度，要能与模型 / Agent 组合，
 * 由页面顶部的日期控件承担。
 */
type Dimension = "model" | "agent";

/** 快捷时间段。`days` = 往前推几天；0 = 今天零点起。 */
type RangeId = "today" | "yesterday" | "week" | "month" | "all" | "custom";

interface UsageBucket {
  key: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  costEstimate: number;
  avgDurationMs: number;
}

interface UsageSummary {
  dimension: Dimension;
  buckets: UsageBucket[];
  total: UsageBucket;
  note: string;
}

const DIMENSIONS: Array<{ id: Dimension; label: string }> = [
  { id: "model", label: "按模型" },
  { id: "agent", label: "按 Agent" },
];

const RANGES: Array<{ id: RangeId; label: string }> = [
  { id: "today", label: "今日" },
  { id: "yesterday", label: "昨日" },
  { id: "week", label: "最近一周" },
  { id: "month", label: "最近一个月" },
  { id: "all", label: "全部" },
];

const dayStart = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const iso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * 快捷段 → 起止。
 *
 * `until` 一律取当天的 23:59:59.999，不是零点：取零点会把"今日"算成一个空区间。
 * `yesterday` 同理要含整个昨天。
 */
function rangeOf(id: RangeId): { since?: string; until?: string } {
  const now = new Date();
  const today = dayStart(now);
  const endOf = (d: Date) => new Date(d.getTime() + 24 * 3600 * 1000 - 1);
  switch (id) {
    case "today":
      return { since: today.toISOString(), until: endOf(today).toISOString() };
    case "yesterday": {
      const y = new Date(today.getTime() - 24 * 3600 * 1000);
      return { since: y.toISOString(), until: endOf(y).toISOString() };
    }
    case "week":
      return { since: new Date(today.getTime() - 6 * 24 * 3600 * 1000).toISOString(), until: endOf(today).toISOString() };
    case "month":
      return { since: new Date(today.getTime() - 29 * 24 * 3600 * 1000).toISOString(), until: endOf(today).toISOString() };
    default:
      return {};
  }
}

export function UsagePage(): JSX.Element {
  const [dimension, setDimension] = useState<Dimension>("model");
  const [range, setRange] = useState<RangeId>("month");
  /** 自定义区间的两个端点（`yyyy-mm-dd`）。只在 range==="custom" 时生效。 */
  const [from, setFrom] = useState(() => iso(new Date(Date.now() - 29 * 24 * 3600 * 1000)));
  const [to, setTo] = useState(() => iso(new Date()));
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setData(null);
    const q = new URLSearchParams({ dimension });
    /*
     * 自定义区间：把 `to` 补到当天末尾。日期输入给的是零点，
     * 直接当 until 会把用户选的最后一天整天排除掉。
     */
    const r =
      range === "custom"
        ? {
            since: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
            until: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
          }
        : rangeOf(range);
    if (r.since) q.set("since", r.since);
    if (r.until) q.set("until", r.until);
    api
      .get<UsageSummary>(`/console/usage?${q}`)
      .then(setData)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.code : String(e)));
  }, [dimension, range, from, to]);

  useEffect(load, [load]);

  function exportCsv(): void {
    if (!data) return;
    const head = "维度,调用次数,输入tokens,输出tokens,缓存命中tokens,缓存写入tokens,成本估算,平均耗时ms";
    const rows = data.buckets.map((b) =>
      [
        b.key,
        b.calls,
        b.promptTokens,
        b.completionTokens,
        b.cacheHitTokens,
        b.cacheMissTokens,
        b.costEstimate,
        b.avgDurationMs,
      ].join(","),
    );
    const blob = new Blob([`${[head, ...rows].join("\n")}\n`], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cabinhug-usage-${dimension}-${range}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="page">
      <h1>用量与成本</h1>
      <p className="muted">
        单价来自配置项 <code>LLM_PRICE_*_PER_1K</code>（可热改），涨价时改配置不发版。
      </p>

      {/*
        时间是筛选条件不是维度：它要能与"按模型/按 Agent"组合。
      */}
      <div className="uz-toolbar">
        <div className="uz-seg" role="group" aria-label="统计维度">
          {DIMENSIONS.map((d) => (
            <button
              key={d.id}
              type="button"
              className={dimension === d.id ? "is-on" : ""}
              onClick={() => setDimension(d.id)}
            >
              {d.label}
            </button>
          ))}
        </div>

        <div className="uz-seg" role="group" aria-label="时间范围">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              className={range === r.id ? "is-on" : ""}
              onClick={() => setRange(r.id)}
            >
              {r.label}
            </button>
          ))}
          <button
            type="button"
            className={range === "custom" ? "is-on" : ""}
            onClick={() => setRange("custom")}
          >
            自定义
          </button>
        </div>

        {range === "custom" && (
          <div className="uz-dates">
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="起始日期" />
            <span className="muted">→</span>
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="结束日期" />
          </div>
        )}

        <span className="spacer" />
        <button type="button" className="btn btn-secondary" onClick={exportCsv} disabled={!data}>
          导出 CSV
        </button>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {!data ? (
        <p className="muted">载入中…</p>
      ) : data.buckets.length === 0 ? (
        <p className="muted">
          {range === "all"
            ? "还没有用量记录（跑一轮对话后再看）。"
            : "这段时间没有用量记录——换个时间范围试试（这与「从来没有」不是一回事）。"}
        </p>
      ) : (
        <>
          <TotalStrip total={data.total} buckets={data.buckets.length} dimension={dimension} />
          {/*
            按成本倒序，不按调用次数：这一页要回答"钱花在哪"。
            服务端按次数排（那是它的通用口径），这里只在展示层重排，不改接口。
            调用次数与成本排序差别可能很大（实测 supervisor-intent 调 211 次花 ¥0，
            v4-flash 调 316 次花 ¥2.76）。
          */}
          {(() => {
            /*
             * 分两组渲染。
             *
             * 有 token 记录的铺成卡片；没有的归到一起、把原因说一次，
             * 避免每张卡重复同一句话。
             * 不隐藏它们：调用次数与耗时是真的，只是成本算不出来。
             */
            const sorted = [...data.buckets].sort(
              (x, y) => y.costEstimate - x.costEstimate || y.calls - x.calls,
            );
            const costed = sorted.filter((b) => b.promptTokens > 0 || b.completionTokens > 0);
            const unrecorded = sorted.filter((b) => b.promptTokens === 0 && b.completionTokens === 0);
            return (
              <>
                <div className="uz-grid">
                  {costed.map((b) => (
                    <UsageCard key={b.key} b={b} total={data.total} dimension={dimension} />
                  ))}
                </div>
                {unrecorded.length > 0 && (
                  <section className="uz-unrecorded">
                    <div className="uz-unrecorded-head">
                      <span className="uz-chip uz-chip--warn">无 token 记录</span>
                      <b>{unrecorded.length} 项的成本算不出来</b>
                      <span className="muted tiny">
                        ——<b>不是花了 ¥0</b>。经 pi-acp 的调用在 2026-08-27 之前不记 token，
                        历史数据补不回来；此后的调用已按字符估算入账。
                      </span>
                    </div>
                    <ul className="uz-unrecorded-list">
                      {unrecorded.map((b) => (
                        <li key={b.key}>
                          <span className="mono">{b.key}</span>
                          <span className="spacer" />
                          <span className="muted tiny">
                            {fmt(b.calls)} 次 · 平均 {fmt(b.avgDurationMs)}ms
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </>
            );
          })()}

          {/* 明细表保留：卡片用于浏览，表用于逐列比较（如按输出 token 排序）。 */}
          <details className="uz-table-fold">
            <summary>明细表（可逐列比较）</summary>
          <table className="table">
            <thead>
              <tr>
                <th>{DIMENSIONS.find((d) => d.id === dimension)?.label.slice(1)}</th>
                <th>调用次数</th>
                <th>输入 tokens</th>
                <th>输出 tokens</th>
                <th>成本估算</th>
                <th>平均耗时</th>
              </tr>
            </thead>
            <tbody>
              {data.buckets.map((b) => (
                <tr key={b.key}>
                  <td className="mono">{b.key}</td>
                  <td>{b.calls}</td>
                  <td>{b.promptTokens}</td>
                  <td>{b.completionTokens}</td>
                  <td>¥{b.costEstimate.toFixed(4)}</td>
                  <td>{b.avgDurationMs}ms</td>
                </tr>
              ))}
              <tr className="total-row">
                <td>总计</td>
                <td>{data.total.calls}</td>
                <td>{data.total.promptTokens}</td>
                <td>{data.total.completionTokens}</td>
                <td>¥{data.total.costEstimate.toFixed(4)}</td>
                <td>{data.total.avgDurationMs}ms</td>
              </tr>
            </tbody>
          </table>
          </details>
          <p className="muted tiny">{data.note}</p>
        </>
      )}
    </div>
  );
}

/** 千分位。用量页的数字常达六位，分节便于读出量级。 */
const fmt = (n: number): string => n.toLocaleString("zh-CN");

/**
 * 顶部总计条。
 *
 * "一共花了多少"是这一页第一个要回答的问题，所以排在卡片之前。
 * 只放总数不放占比：总计的占比恒等于 100%。
 */
function TotalStrip({
  total,
  buckets,
  dimension,
}: {
  total: UsageBucket;
  buckets: number;
  dimension: Dimension;
}): JSX.Element {
  const label = DIMENSIONS.find((d) => d.id === dimension)?.label.slice(1) ?? "";
  return (
    <div className="uz-total">
      <div className="uz-total-main">
        <span className="uz-total-num">¥{total.costEstimate.toFixed(2)}</span>
        <span className="uz-total-cap">总成本估算 · {buckets} 个{label}</span>
      </div>
      <dl className="uz-total-meta">
        <div>
          <dt>调用</dt>
          <dd>{fmt(total.calls)}</dd>
        </div>
        <div>
          <dt>输入</dt>
          <dd>{fmt(total.promptTokens)}</dd>
        </div>
        <div>
          <dt>输出</dt>
          <dd>{fmt(total.completionTokens)}</dd>
        </div>
        <div>
          <dt>平均耗时</dt>
          <dd>{fmt(total.avgDurationMs)}ms</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * 一个维度值一张卡。
 *
 * # 配色只用语义色，不给卡片发身份色
 *
 * 这套控制台里颜色表达状态（绿=正常、黄=需注意、红=失败，见 nav-icons 的同一条判断），
 * 不作身份区分，避免"这个黄是分类还是告警"的歧义。
 * 所以主色一律 accent，黄色只留给需要注意的那一格：
 * 有调用却没有 token 记录（那一行算不出成本）。
 *
 * # 占比条画的是成本，不是次数
 *
 * "谁把钱花掉了"与"谁调得最多"经常不是同一个：
 * 实测 supervisor-intent 调 211 次花 ¥0，v4-flash 调 316 次花 ¥2.76。
 */
function UsageCard({
  b,
  total,
  dimension,
}: {
  b: UsageBucket;
  total: UsageBucket;
  dimension: Dimension;
}): JSX.Element {
  const share = total.costEstimate > 0 ? (b.costEstimate / total.costEstimate) * 100 : 0;
  // 有调用却零 token：这一行的成本算不出来，要明示，
  // 否则 ¥0.00 会被读成"这个便宜"，实际是没记到它的用量。
  const noTokens = b.calls > 0 && b.promptTokens === 0 && b.completionTokens === 0;
  const cacheable = b.cacheHitTokens + b.cacheMissTokens;
  const hitRate = cacheable > 0 ? Math.round((b.cacheHitTokens * 100) / cacheable) : null;

  return (
    <section className="uz-card">
      <header className="uz-head">
        <span className="uz-name mono">{b.key}</span>
        <span className="uz-chip">{DIMENSIONS.find((d) => d.id === dimension)?.label.slice(1)}</span>
      </header>

      <div className="uz-hero">
        <span className="uz-hero-num">¥{b.costEstimate.toFixed(2)}</span>
        <span className="uz-hero-unit">成本</span>
        {/* 占比条：成本占总额多少 */}
        <span className="uz-bar" title={`占总成本 ${share.toFixed(1)}%`}>
          <i style={{ width: `${Math.max(share, 1.5)}%` }} />
        </span>
        <span className="uz-share">{share.toFixed(1)}%</span>
      </div>
      <div className="uz-sub">
        {fmt(b.calls)} 次调用 · 平均 {fmt(b.avgDurationMs)}ms
      </div>

      <div className="uz-panels">
        <div className="uz-panel uz-panel--in">
          <div className="uz-panel-key">
            <span className="mono">输入</span>
            <b>{fmt(b.promptTokens)}</b>
            <span className="uz-panel-sub">tokens</span>
          </div>
          <div className="uz-panel-val">
            {hitRate === null ? (
              // 拿不到缓存数据（pi-acp 那条路）时不写 0%，否则会被读成"一次没命中"
              <span className="uz-na">缓存无数据</span>
            ) : (
              <>
                <span className="uz-panel-big">{hitRate}%</span>
                <span className="uz-panel-sub">缓存命中</span>
              </>
            )}
          </div>
        </div>

        <div className="uz-panel uz-panel--out">
          <div className="uz-panel-key">
            <span className="mono">输出</span>
            <b>{fmt(b.completionTokens)}</b>
            <span className="uz-panel-sub">tokens</span>
          </div>
          <div className="uz-panel-val">
            <span className="uz-panel-big">
              {b.calls > 0 ? fmt(Math.round((b.promptTokens + b.completionTokens) / b.calls)) : 0}
            </span>
            <span className="uz-panel-sub">每次均 tokens</span>
          </div>
        </div>
      </div>
    </section>
  );
}
