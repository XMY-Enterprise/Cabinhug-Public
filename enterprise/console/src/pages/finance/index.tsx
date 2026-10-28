/**
 * 财务 —— 「外部账户还剩多少钱」+「这些钱花在哪了」。
 *
 * 与「用量与成本」不同，页面上明示这一区分：
 * 那一页是我们自己记的花费，这一页是供应商那边的余额与账单。
 * 两个数字对不上是常态，所以这里不做任何减法，只如实转述。
 *
 * 交互形态是"卡片当选择器、表格跟着切"：上面五张卡是指标，
 * 点哪张，下面就列哪家的近期账单。账单按需拉（一家 3 次上游请求），
 * 点选时才请求，不在开页时全部请求。
 *
 * 界面约束：
 *  1. 不把不确定说成确定。高德不开放余量查询（`exact=false`），
 *     它那张卡片不显示数字，避免被读成确切余量。
 *  2. 空表格说明是哪一种空。"这家不给查"、"没配凭据"、"查失败了"、
 *     "确实没花钱"外观相同，处置动作不同。见 `BillsEmpty`。
 *
 * 大数字下面的曲线（`BalanceSparkline`）遵守同样两条：只画在
 * `showsAmount` 为真的卡片上，没采到的时段留成缺口不补点。几何计算在
 * `history.ts`，数据来自 `/console/finance/history`（纯读盘，不打上游）。
 * 采样周期（默认 10 分钟）由服务端随响应下发，页面上与它有关的文字与
 * 判据都从 `stepMs` 推导，前端不写死。
 *
 * 横轴按实际数据量在 1 小时~7 天之间伸缩（避免冷启动数据挤在最右边 0.3% 的宽度里），
 * 窗口在本文件算一次、几张卡共用，保证同一横坐标对应同一时刻。
 * 跨度会伸缩，因此需要刻度标出。
 *
 * 有吞吐口径的卡（`throughputSupported`，目前只有 DeepSeek）底部再多一条柱状图
 * （`ThroughputBars`）：每个采样桶里跑了多少 token，数据来自我们自己的 `llm_usage`
 * 埋点（`/console/finance/throughput/:id`），与余额曲线共用横轴，便于对照余额下降与用量。
 * 它是这一页唯一不来自供应商的数字。
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { api, ApiError } from "../../api";
import { BalanceSparkline } from "./Sparkline";
import { ThroughputBars } from "./ThroughputBars";
import { windowFor, type FinanceHistory } from "./history";
import type { ThroughputSeries } from "./throughput";
import {
  ageLabel,
  amountFallback,
  billsTotal,
  defaultAccountId,
  emptyKind,
  levelClass,
  showsAmount,
  type FinanceAccount,
  type FinanceBillPage,
  type FinanceSnapshot,
} from "./model";

const KIND_LABEL: Record<FinanceAccount["kind"], string> = {
  balance: "预付余额",
  subscription: "订阅制",
  quota: "每日免费额度",
};

/** 空表格的四种成因分别提示，不合并成一句"暂无数据"。 */
function BillsEmpty({ page, label }: { page: FinanceBillPage; label: string }): JSX.Element {
  const kind = emptyKind(page);

  if (kind === "unsupported") {
    return (
      <div className="fin-empty">
        <p>
          <strong>{label}</strong> 没有可查的账单接口。
        </p>
        {page.note ? <p className="muted tiny">{page.note}</p> : null}
        {page.consoleUrl ? (
          <a className="btn btn-secondary" href={page.consoleUrl} target="_blank" rel="noreferrer">
            去控制台人工查看 ↗
          </a>
        ) : null}
      </div>
    );
  }

  if (kind === "unconfigured") {
    return (
      <div className="fin-empty">
        <p>还没配置凭据，账单查不了。</p>
        {page.note ? <p className="muted tiny mono">{page.note}</p> : null}
      </div>
    );
  }

  if (kind === "failed") {
    return (
      <div className="fin-empty">
        <p className="error">账单拉取失败。</p>
        {page.error ? <p className="muted tiny mono">{page.error}</p> : null}
      </div>
    );
  }

  // 这一支才是确实没花钱，与上面三种分开说，避免被当成故障。
  return (
    <div className="fin-empty">
      <p>
        {page.coverage}内没有账单记录。
      </p>
      <p className="muted tiny">接口是通的，就是这段时间没有产生费用。</p>
    </div>
  );
}

function BillsTable({ page }: { page: FinanceBillPage }): JSX.Element {
  const { total, currency, pricedCount, unpricedCount, mixedCurrency } = billsTotal(page.rows);

  return (
    <table className="table">
      <thead>
        <tr>
          <th>账期</th>
          <th>项目</th>
          <th className="fin-num">金额</th>
          <th>状态</th>
          <th>备注</th>
        </tr>
      </thead>
      <tbody>
        {page.rows.map((r, i) => (
          <tr key={`${r.period}|${r.item}|${i}`}>
            <td className="mono">{r.period}</td>
            <td>{r.item}</td>
            <td className="fin-num mono">
              {r.amount === undefined ? "-" : `${r.amount.toFixed(2)} ${r.currency}`}
            </td>
            <td>{r.status ?? "-"}</td>
            <td className="muted tiny">
              {r.note ?? ""}
              {r.link ? (
                <>
                  {r.note ? " · " : ""}
                  <a href={r.link} target="_blank" rel="noreferrer">
                    发票 ↗
                  </a>
                </>
              ) : null}
            </td>
          </tr>
        ))}
        {pricedCount > 0 && !mixedCurrency ? (
          <tr className="total-row">
            <td>合计</td>
            <td>
              {pricedCount} 项
              {unpricedCount > 0 ? `（另有 ${unpricedCount} 项无金额）` : ""}
            </td>
            <td className="fin-num mono">
              {total.toFixed(2)} {currency}
            </td>
            <td colSpan={2} />
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}

export function FinancePage(): JSX.Element {
  const [data, setData] = useState<FinanceSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [history, setHistory] = useState<FinanceHistory | null>(null);
  const [historyBusy, setHistoryBusy] = useState(true);

  /** 按账户存：目前只有 DeepSeek 有，但"哪些有"由服务端的快照说了算 */
  const [throughput, setThroughput] = useState<Record<string, ThroughputSeries>>({});
  const [throughputBusy, setThroughputBusy] = useState<Record<string, boolean>>({});

  const [selected, setSelected] = useState<string | null>(null);
  const [bills, setBills] = useState<FinanceBillPage | null>(null);
  const [billsError, setBillsError] = useState<string | null>(null);
  const [billsBusy, setBillsBusy] = useState(false);

  /*
   * 吞吐按账户拉，且只拉服务端声明支持的。失败静默：不在页面顶部报错，
   * 由 `ThroughputBars` 在自己的位置提示"暂不可用"。
   * 每个账户只在 busy 表里没它时发起，快照两段式回来两次也只拉一次。
   */
  const loadThroughput = useCallback((accounts: FinanceAccount[], refresh: boolean) => {
    for (const a of accounts) {
      if (!a.throughputSupported) continue;
      setThroughputBusy((cur) => {
        if (!refresh && cur[a.id] !== undefined) return cur;
        api
          .get<ThroughputSeries>(`/console/finance/throughput/${a.id}${refresh ? "?refresh=1" : ""}`)
          .then((series) => setThroughput((prev) => ({ ...prev, [a.id]: series })))
          .catch(() => {})
          .finally(() => setThroughputBusy((prev) => ({ ...prev, [a.id]: false })));
        return { ...cur, [a.id]: true };
      });
    }
  }, []);

  const load = useCallback((refresh: boolean) => {
    setBusy(true);
    setError(null);
    api
      .get<FinanceSnapshot>(`/console/finance${refresh ? "?refresh=1" : ""}`)
      .then((snapshot) => {
        setData(snapshot);
        // 默认落在第一个账单可查的账户上，避免首屏是一张空表。
        setSelected((cur) => cur ?? defaultAccountId(snapshot.accounts));
        loadThroughput(snapshot.accounts, refresh);
      })
      .catch((e: unknown) =>
        setError(
          e instanceof ApiError
            ? e.code === "finance_rate_limited"
              ? "强制刷新过于频繁（每分钟 4 次），稍等一会儿再点"
              : e.code
            : String(e),
        ),
      )
      .finally(() => setBusy(false));
  }, [loadThroughput]);

  /*
   * 两段式加载：先用落盘的上次快照立即渲染（stored 路径不打上游，毫秒级），
   * 同时并行发起真正的采集，回来后整体替换。
   * stored 只在画面还空着时应用（functional setState），采集先回来时不回写旧数据。
   * 204（从没采集过）与快照取不到都静默，等待采集结果。
   */
  useEffect(() => {
    api
      .get<FinanceSnapshot | undefined>("/console/finance?stored=1")
      .then((snapshot) => {
        if (!snapshot) return;
        setData((cur) => cur ?? snapshot);
        setSelected((cur) => cur ?? defaultAccountId(snapshot.accounts));
        // 吞吐是纯读库的，不必等现查的快照：stored 快照已包含哪些账户支持吞吐
        loadThroughput(snapshot.accounts, false);
      })
      .catch(() => {});
    /*
     * 余额历史与快照并行拉：它是纯读盘（服务端不为它打上游），
     * 排在采集后面会让曲线多等十几秒。
     * 失败静默：不在页面顶部报错，由 `BalanceSparkline` 在自己的位置提示"暂不可用"。
     */
    api
      .get<FinanceHistory>("/console/finance/history")
      .then(setHistory)
      .catch(() => {})
      .finally(() => setHistoryBusy(false));
    load(false);
  }, [load, loadThroughput]);

  // 选中变化就拉那一家的账单，同样两段式：先铺上次的（毫秒级），再用现查的替换。
  useEffect(() => {
    if (!selected) return;
    let stale = false;
    setBillsBusy(true);
    setBillsError(null);
    setBills(null);
    api
      .get<FinanceBillPage | undefined>(`/console/finance/bills/${selected}?stored=1`)
      .then((page) => {
        if (!stale && page) setBills((cur) => cur ?? page);
      })
      .catch(() => {});
    api
      .get<FinanceBillPage>(`/console/finance/bills/${selected}`)
      .then((page) => {
        if (!stale) setBills(page);
      })
      .catch((e: unknown) => {
        if (!stale) setBillsError(e instanceof ApiError ? e.code : String(e));
      })
      .finally(() => {
        if (!stale) setBillsBusy(false);
      });
    return () => {
      stale = true;
    };
  }, [selected]);

  /*
   * 横轴窗口在这里算一次，发给每张卡，保证各卡同一横坐标对应同一时刻，可以横向比较。
   */
  const spanWindow = useMemo(() => {
    // 吞吐图与余额曲线共用横轴：窗口需把吞吐的第一个桶也装进去，
    // 否则吞吐早于余额历史的那几天会被裁掉。
    const seriesList = Object.values(throughput);
    const extra = seriesList.flatMap((s) => (s.buckets.length > 0 ? [s.buckets[0].t] : []));
    // 余额历史还没到（或暂不可用）时，用吞吐自己的窗口边界兜底，柱状图不必等待
    const base = history ?? (seriesList[0] ? { from: seriesList[0].from, to: seriesList[0].to, series: {} } : null);
    return base ? windowFor(base, extra) : null;
  }, [history, throughput]);

  const danger = (data?.accounts ?? []).filter((a) => a.status === "failed" || a.level === "danger");
  const selectedAccount = data?.accounts.find((a) => a.id === selected);

  return (
    <div className="page">
      <h1>财务</h1>
      <p className="muted">
        各外部供应商账户的余额 / 订阅 / 额度状态。这里的数字由对方接口给出，
        与「用量与成本」页我们自己记的花费<strong>不是同一本账</strong>，对不上属正常。
      </p>

      <div className="filters">
        <button type="button" className="btn" onClick={() => load(true)} disabled={busy}>
          {busy ? "查询中…" : "强制刷新"}
        </button>
        <span className="spacer" />
        {data ? (
          <span className="muted tiny">
            {data.stored ? (
              // 这是上次落盘的快照，不是现查结果；需标出，否则已充值的欠费账户仍显示为欠费。
              <>
                上次快照 · {ageLabel(data.checkedAt)}采集
                {busy ? <span className="fin-refreshing">（正在刷新…）</span> : "（刷新失败，显示的是旧数据）"}
              </>
            ) : (
              <>
                {new Date(data.checkedAt).toLocaleString("zh-CN")} 采集
                {data.cached ? `（缓存，${Math.round(data.ttlMs / 1000)}s 内不重复请求上游）` : "（实时）"}
              </>
            )}
          </span>
        ) : null}
      </div>

      {error ? <p className="error">{error}</p> : null}

      {danger.length > 0 ? (
        <div className="banner banner-warn">
          {danger.length} 个账户需要处理：
          {danger.map((a) => a.label.replace(/（.*$/, "")).join("、")}
        </div>
      ) : null}

      {!data ? (
        busy ? (
          // 首次使用（盘上还没有快照）：渲染五张灰卡作为骨架，表明将有五个账户。
          <div className="fin-grid" aria-hidden="true">
            {Array.from({ length: 5 }, (_, i) => (
              <section key={i} className="fin-card fin-card--skeleton">
                <div className="fin-skel fin-skel-name" />
                <div className="fin-skel fin-skel-amount" />
                <div className="fin-skel fin-skel-line" />
                <div className="fin-skel fin-skel-line" />
              </section>
            ))}
          </div>
        ) : (
          <p className="muted">尚未采集过，点「强制刷新」发起第一次查询。</p>
        )
      ) : (
        <>
          <div className="fin-grid">
            {data.accounts.map((a) => (
              <section
                key={a.id}
                className={`fin-card ${levelClass(a)} ${a.id === selected ? "fin-card--selected" : ""}`}
                // 卡片是选择器。用 section+role 而不是 <button>：卡里有「去控制台」这个
                // 链接，交互元素不能嵌在 button 里（HTML 不允许，键盘行为也会冲突）。
                role="button"
                tabIndex={0}
                aria-pressed={a.id === selected}
                onClick={() => setSelected(a.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelected(a.id);
                  }
                }}
              >
                <header className="fin-card-head">
                  <span className="fin-name">{a.label}</span>
                  <span className="fin-kind">{KIND_LABEL[a.kind]}</span>
                </header>

                {/* 只有拿到确切金额才显示大数字。exact=false 的一律走下面那行说明文字。 */}
                {showsAmount(a) ? (
                  <div className="fin-amount">
                    <span className="fin-amount-num">{a.amount?.toFixed(2)}</span>
                    <span className="fin-amount-cur">{a.currency ?? "CNY"}</span>
                  </div>
                ) : (
                  <div className="fin-amount fin-amount--none">{amountFallback(a)}</div>
                )}

                {/*
                  曲线只画在有确切余额的卡片上，判据与大数字同一个 `showsAmount`。
                  高德（exact=false）与 RAGFlow（订阅制、无余额口径）不画，
                  否则"查不到"会被画成"一直没变"。
                */}
                {showsAmount(a) ? (
                  <BalanceSparkline
                    history={history}
                    window={spanWindow}
                    loading={historyBusy}
                    accountId={a.id}
                    currency={a.currency ?? "CNY"}
                  />
                ) : null}

                {a.detail.length > 0 ? (
                  <dl className="fin-detail">
                    {a.detail.map((d) => (
                      <div key={d.label}>
                        <dt>{d.label}</dt>
                        <dd className="mono">{d.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}

                {a.error ? <p className="error tiny">{a.error}</p> : null}
                {a.note ? <p className="muted tiny">{a.note}</p> : null}

                {/*
                  吞吐放在卡片底部、所有供应商给的数字之后：它是这张卡上唯一来自
                  我们自己埋点的数字，与供应商数据分开摆放。
                */}
                {a.throughputSupported ? (
                  <ThroughputBars
                    series={throughput[a.id] ?? null}
                    window={spanWindow}
                    loading={throughputBusy[a.id] !== false}
                  />
                ) : null}

                <footer className="fin-card-foot">
                  <a
                    className="btn-link"
                    href={a.consoleUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    去控制台 ↗
                  </a>
                  <span className="spacer" />
                  {/* 账单是否可查在选卡之前就要显示 */}
                  <span className="muted tiny">{a.billsSupported ? "账单可查" : "无账单接口"}</span>
                </footer>
              </section>
            ))}
          </div>

          <p className="muted tiny">
            预警阈值：≤ ¥{data.thresholds.warnCny} 转黄、≤ ¥{data.thresholds.dangerCny} 转红
            （<code>CABINHUG_FINANCE_WARN_CNY</code> / <code>CABINHUG_FINANCE_DANGER_CNY</code> 可改）。
            {data.note}
          </p>

          <section className="fin-bills">
            <div className="fin-bills-head">
              <h2>近期账单</h2>
              <span className="fin-bills-target">{selectedAccount?.label ?? "—"}</span>
              <span className="spacer" />
              {bills ? (
                <span className="muted tiny">
                  {bills.status === "ok" ? bills.coverage : ""}
                  {bills.stored && billsBusy ? " · 上次快照，正在刷新…" : bills.stored ? " · 上次快照" : bills.cached ? " · 缓存" : ""}
                </span>
              ) : null}
            </div>
            <p className="muted tiny">点上面的卡片切换账户。</p>

            {!bills && billsBusy ? (
              <p className="muted">载入中…</p>
            ) : billsError ? (
              <p className="error">{billsError}</p>
            ) : !bills ? (
              <p className="muted">选一个账户查看账单。</p>
            ) : bills.rows.length === 0 ? (
              <BillsEmpty page={bills} label={selectedAccount?.label ?? bills.accountId} />
            ) : (
              <>
                <BillsTable page={bills} />
                {bills.note ? <p className="muted tiny">{bills.note}</p> : null}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
