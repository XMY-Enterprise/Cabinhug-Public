/**
 * 财务视图接口 `/console/finance` —— 「这套系统的外部账户还剩多少钱」。
 *
 * 与 `/console/usage` 的分工：
 *   usage   = 我们花了多少（自己记的账，按模型/Agent 聚合，口径由我们定）
 *   finance = 供应商那边还剩多少（钱在对方系统里，我们只有读的权限）
 * 两者对不上是常态（对方按 token 结算有延迟、有最低计费、有赠额），
 * 所以这一页不做任何相减推算，只如实转述对方给的数字。
 *
 * 三条约束：
 *  1. admin 独有：余额是财务信息，ops 的止血权限不含账户金额。
 *  2. 默认吃缓存（`FINANCE_TTL_MS`，默认 60s）：高德那条探针本身消耗当日额度，
 *     每开一次页就打五家会让这一页成为烧额度的来源。
 *  3. 强制刷新限流：`?refresh=1` 每分钟 4 次，超了返回 429 而不是排队。
 *
 * 账单在 `/console/finance/bills/:accountId`，按需拉，不进首屏：
 * 一家账单要按账期打 3 次上游，五家一起进首屏就是十几次调用，
 * 而多数时候只需看其中一家。
 *
 * 余额的采样历史在 `/console/finance/history`（纯读盘，永不打上游），
 * 由本路由内的定时器喂：一个采样周期（默认 10 分钟）至多采集一次，
 * 写进 `finance-history.json`。定时器常驻：只在开页时记点的话，
 * "最近 7 天"多数时候是空的。
 * 代价按周期算：10 分钟一次 = 每天 144 轮上游调用（含高德那条消耗当日额度的
 * 探针），换来的是卡片上那条能看出"什么时候开始掉得快"的曲线。嫌贵就把
 * `CABINHUG_FINANCE_HISTORY_INTERVAL_MIN` 调大，或 `CABINHUG_FINANCE_HISTORY=off`
 * 把定时器与记点一起停。
 *
 * 调用吞吐在 `/console/finance/throughput/:accountId`（只读我们自己的
 * `llm_usage` 表，同样永不打上游）：与余额历史同一套桶宽与窗口，摆在卡片底部
 * 让"余额掉得快的那段"能对上"那段跑了多少 token"。口径见 finance-throughput.ts。
 */

import { Router } from "express";
import type { Response } from "express";

import type { UsageRepository } from "@cabinhug/db";
import {
  amapBudgetFromEnv,
  buildAmapPoolSnapshot,
  createRedisAmapLedger,
  resolveAmapKeys,
  type AmapUsageLedger,
} from "@cabinhug/tools";

import { requireRole, type ConsoleRequest } from "../auth/console";
import { defaultStateFile, emptyState, loadState, saveState, type FinanceState } from "./finance-state";
import {
  bucketStart,
  defaultHistoryFile,
  intervalMs,
  RETENTION_MS,
  emptyHistory,
  loadHistory,
  recordSnapshot,
  saveHistory,
  toApi,
  type FinanceHistory,
} from "./finance-history";
import { auditAction } from "./audit";
import {
  THROUGHPUT_ACCOUNTS,
  throughputSupported,
  toThroughputApi,
  type ThroughputApiResponse,
} from "./finance-throughput";
import {
  FINANCE_PROVIDERS,
  type FetchLike,
  type FinanceAccount,
  type FinanceBillPage,
  type FinanceLevel,
  type ProviderDeps,
} from "./finance-providers";

export interface FinanceSnapshot {
  checkedAt: string;
  /** 本次结果是不是缓存里拿的——页面要如实标出来，否则"刷新了但没变"没法解释。 */
  cached: boolean;
  /** stored=1 快路径给的"上次的样子"。前端据此标"快照 · 正在刷新"。 */
  stored?: boolean;
  ttlMs: number;
  thresholds: { warnCny: number; dangerCny: number };
  accounts: FinanceAccount[];
  note: string;
}

export interface FinanceRouterDeps {
  /** 注入点：单测用假 fetch 脱网跑；生产传 undefined 走全局 fetch。 */
  fetch?: FetchLike;
  now?: () => number;
  /**
   * 落盘路径。缺省 = `CABINHUG_FINANCE_STATE_FILE` 或 `var/finance-cache.json`；
   * 传 `null` 关掉持久化（测试用——不关的话每跑一次测试都往仓里写文件）。
   */
  stateFile?: string | null;
  /**
   * 余额历史的落盘路径。缺省跟着 `stateFile`：后者为 `null`（测试）时历史也关。
   * 与缓存分开放的理由见 finance-history.ts 的文件头——历史丢一小时补不回来。
   */
  historyFile?: string | null;
  /**
   * 采样定时器。缺省在有 `historyFile` 时开。
   * 测试传 `false`：不关的话每个 app 实例都挂一个定时器去打注入的假 fetch。
   */
  historyTick?: boolean;
  /**
   * 吞吐图的数据源：`llm_usage` 的按桶聚合。只用到 `throughput()` 这一个只读方法，
   * 类型也只收窄到它：这是本路由唯一用到的仓储，财务页对用量只读，
   * 不引入 UsageRepository 的写方法。缺省时吞吐接口回 503。
   */
  usage?: Pick<UsageRepository, "throughput">;
}

/**
 * 预警阈值。可配是因为不同账户的"低"不在一个量级：
 * DeepSeek 跑一天几块钱，阿里云护栏按次算更便宜，统一阈值会让告警变噪音。
 * 默认值偏保守，需要按账户细分时再拆。
 */
function thresholds(): { warnCny: number; dangerCny: number } {
  const warn = Number(process.env.CABINHUG_FINANCE_WARN_CNY ?? 50);
  const danger = Number(process.env.CABINHUG_FINANCE_DANGER_CNY ?? 10);
  return {
    warnCny: Number.isFinite(warn) ? warn : 50,
    dangerCny: Number.isFinite(danger) ? danger : 10,
  };
}

function ttlMs(): number {
  const v = Number(process.env.CABINHUG_FINANCE_TTL_MS ?? 60_000);
  return Number.isFinite(v) && v >= 0 ? v : 60_000;
}

function timeoutMs(): number {
  const v = Number(process.env.CABINHUG_FINANCE_TIMEOUT_MS ?? 12_000);
  return Number.isFinite(v) && v > 0 ? v : 12_000;
}

/**
 * 账单缓存比余额长得多（默认 10 分钟）：账单是已经结算完的历史，
 * 一分钟前和现在不会不一样；而拉一次账单要按账期打 3 次上游请求，
 * 跟余额同一个 60s 口径的话，人在几张卡片之间来回点就会把上游打满。
 */
function billsTtlMs(): number {
  const v = Number(process.env.CABINHUG_FINANCE_BILLS_TTL_MS ?? 600_000);
  return Number.isFinite(v) && v >= 0 ? v : 600_000;
}

/** 只给已经拿到确切金额的账户打等级；拿不到数字的（高德）由适配器自己定。 */
export function levelFor(
  account: FinanceAccount,
  t: { warnCny: number; dangerCny: number },
): FinanceLevel | undefined {
  if (account.level) return account.level;
  if (account.status !== "ok" || !account.exact || account.amount === undefined) return undefined;
  if (account.amount <= t.dangerCny) return "danger";
  if (account.amount <= t.warnCny) return "warn";
  return "ok";
}

export function createFinanceRouter(deps: FinanceRouterDeps = {}): Router {
  const router = Router();
  const now = deps.now ?? (() => Date.now());
  const stateFile = deps.stateFile === undefined ? defaultStateFile() : deps.stateFile;

  /*
   * 内存缓存从盘上水化：重启后 stored=1 立刻有内容可回，
   * 页面不必等五家上游都应答完才能显示"上一次看到的样子"。
   */
  const persisted: FinanceState = stateFile ? loadState(stateFile) : emptyState();
  // 默认路径跟着 cwd 走（经 pnpm --filter 启动时是包目录）。
  if (stateFile) console.log(`[finance] 快照落盘：${stateFile}${persisted.snapshot ? "（已水化上次采集）" : "（空白）"}`);
  let cache: { at: number; snapshot: FinanceSnapshot } | null = persisted.snapshot;
  let refreshHits: number[] = [];
  const billsCache = new Map<string, { at: number; page: FinanceBillPage }>(
    Object.entries(persisted.bills),
  );

  /*
   * 历史落盘的默认值只在什么都没注入时才给真实路径。
   *
   * 仅跟随 `stateFile` 不够：测试里有几处传的是 tmp 目录下的 stateFile，
   * 那样历史会落到仓库的 `var/finance-history.json`，定时器还会拿注入的假 fetch
   * 采点，往七天曲线里掺假数据。所以判据是 `deps.stateFile === undefined`
   * （= 生产装配）；显式传了任何落盘参数的调用方，要历史就自己写出 `historyFile`。
   */
  const historyFile =
    deps.historyFile === undefined
      ? deps.stateFile === undefined && process.env.CABINHUG_FINANCE_HISTORY !== "off"
        ? defaultHistoryFile()
        : null
      : deps.historyFile;
  let history: FinanceHistory = historyFile ? loadHistory(historyFile) : emptyHistory();
  if (historyFile) {
    const kinds = Object.keys(history.series).length;
    console.log(
      `[finance] 余额历史：${historyFile}（${kinds} 个账户有历史，每 ${intervalMs() / 60_000} 分钟一个点，保留 7 天）`,
    );
  }

  function persist(): void {
    if (!stateFile) return;
    saveState(stateFile, {
      version: 1,
      snapshot: cache,
      bills: Object.fromEntries(billsCache),
    });
  }

  /** 记一次点。历史关掉时是空操作，调用方不必到处判空。 */
  function record(snapshot: FinanceSnapshot, atMs: number): void {
    if (!historyFile) return;
    history = recordSnapshot(history, snapshot.accounts, atMs);
    saveHistory(historyFile, history);
  }

  /**
   * 高德台账的连接惰性建一次：财务页每 60 秒才刷一次，开页就连是白连；
   * 每次 `providerDeps()` 都连则是每刷一次漏一个连接。与配额/配对的 Redis 客户端不共用。
   */
  let amapLedger: AmapUsageLedger | undefined | null = null;
  function amapLedgerOnce(): AmapUsageLedger | undefined {
    if (amapLedger !== null) return amapLedger;
    const url = process.env.REDIS_URL?.trim();
    amapLedger = url ? createRedisAmapLedger(url) : undefined;
    return amapLedger;
  }

  function providerDeps(): ProviderDeps {
    return {
      // 全局 fetch 惰性取：模块级取会把测试注入的桩固化掉。
      fetch: deps.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init)),
      env: (k: string) => {
        const v = process.env[k];
        return v && v.trim() ? v.trim() : undefined;
      },
      timeoutMs: timeoutMs(),
      now: () => new Date(now()),
      // 池子状态只读台账，一次上游请求都不发。
      amapPool: () =>
        buildAmapPoolSnapshot(
          resolveAmapKeys((k) => process.env[k], () => {}),
          amapLedgerOnce(),
          amapBudgetFromEnv(process.env.AMAP_DAILY_BUDGET, () => {}),
          now(),
        ),
    };
  }

  async function collect(): Promise<FinanceAccount[]> {
    const d = providerDeps();
    // 并发打五家：串行的话一家超时就把整页拖到 60 秒。
    // 适配器内部已各自吞掉异常，这里不会有 reject。
    return Promise.all(
      FINANCE_PROVIDERS.map(async (p) => ({
        ...(await p.account(d)),
        billsSupported: Boolean(p.bills),
        // 有没有吞吐可看与账单一样是"选卡之前就该知道的事"，随快照下发，页面不猜
        throughputSupported: throughputSupported(p.id),
      })),
    );
  }

  /** 采集一轮：打上游 → 定级 → 更新缓存 → 落盘 → 记一个历史点。 */
  async function collectSnapshot(): Promise<FinanceSnapshot> {
    const t = thresholds();
    const at = now();
    const accounts = (await collect()).map((a) => ({ ...a, level: levelFor(a, t) }));
    const snapshot: FinanceSnapshot = {
      checkedAt: new Date(at).toISOString(),
      cached: false,
      ttlMs: ttlMs(),
      thresholds: t,
      accounts,
      note: "余额来自各供应商接口，口径由对方定义；我们自己的花费口径在「用量与成本」页，两者对不上属正常",
    };
    cache = { at, snapshot };
    persist();
    record(snapshot, at);
    return snapshot;
  }

  /*
   * 定时采集。
   *
   * 判据是"当前这个桶有没有尝试过"，不是"距上次是否满一个周期"：
   * 后者在网关重启后从重启时刻重新起算，采样点会漂移，横轴上的"每 10 分钟"不再成立。
   * 按桶判还能自愈：停机一段时间再起来，当前桶没记过就立刻补一个点
   * （补的是"现在"，不补中间的空桶）。
   *
   * 醒的频率与采样周期无关：每 20 秒醒一次，使桶一换就尽快落点；
   * 醒得比周期慢会让点普遍晚到，间距忽宽忽窄。打上游的次数由桶去重限定为每周期一次。
   */
  function historyTick(): void {
    if (!historyFile) return;
    const b = bucketStart(now());
    if (history.lastAttemptBucket === b) return;
    // 先占桶再采集：上游超时十几秒期间不能让下一次 tick 又进来打一轮。
    history = { ...history, lastAttemptBucket: b };
    saveHistory(historyFile, history);
    void collectSnapshot().catch((err) => {
      // 采集失败不重试：这个周期留缺口，不补造点。
      console.warn(`[finance] 定时采集失败，本周期无采样点：${String(err)}`);
    });
  }

  const tickEnabled = deps.historyTick ?? Boolean(historyFile);
  if (tickEnabled) {
    // unref：这个定时器不该让进程活着，也不该挂住测试的事件循环。
    setInterval(historyTick, 20_000).unref();
    // 启动即补当前这个桶，重启后不必等满一个周期。
    historyTick();
  }

  router.get(
    "/console/finance",
    // 强制刷新会真实调用五家外部接口（其中一家消耗额度），属于有后果的操作，必须留痕。
    auditAction("finance.read"),
    requireRole("admin"),
    async (req: ConsoleRequest, res: Response) => {
      /*
       * stored=1：只回"上一次看到的样子"，永不打上游、不受限流。
       * 这是页面秒开的那一跳——前端先拿它铺满界面，再并行发真正的采集。
       * 没有历史时回 204：`null` 会被 JSON 层弄丢，空对象会被当成数据。
       */
      if (req.query.stored === "1" || req.query.stored === "true") {
        if (!cache) {
          res.status(204).end();
          return;
        }
        res.json({ ...cache.snapshot, cached: true, stored: true });
        return;
      }

      const refresh = req.query.refresh === "1" || req.query.refresh === "true";
      const ttl = ttlMs();

      if (!refresh && cache && now() - cache.at < ttl) {
        res.json({ ...cache.snapshot, cached: true });
        return;
      }

      if (refresh) {
        const cutoff = now() - 60_000;
        refreshHits = refreshHits.filter((x) => x > cutoff);
        if (refreshHits.length >= 4) {
          res
            .status(429)
            .json({ error: "finance_rate_limited", message: "强制刷新过于频繁（每分钟 4 次），请稍后再试" });
          return;
        }
        refreshHits.push(now());
      }

      res.json(await collectSnapshot());
    },
  );

  /*
   * 余额历史：纯读盘，永不打上游，因此不落审计：audit.ts 约定普通读取不记，
   * 开页时的 `finance.read` 已记下谁看了财务页。
   * 与 `/console/finance/bills/:accountId` 路径不重叠，路由顺序无关。
   */
  router.get(
    "/console/finance/history",
    requireRole("admin"),
    (_req: ConsoleRequest, res: Response) => {
      res.json(toApi(history, now()));
    },
  );

  /*
   * 调用吞吐：读我们自己的 `llm_usage` 表，永不打上游，因此与历史一样不落审计。
   * 窗口与桶宽逐字沿用余额历史的（`intervalMs()` / `RETENTION_MS`）：
   * 两张图叠在同一张卡上，横轴必须是同一条。
   * 缓存 `ttlMs()`（默认 60s）：聚合一次是一条 group by，不贵，但一页开着轮询
   * 也不该每次都扫 7 天的表；`?refresh=1` 绕过缓存，不限流（是自己的库）。
   */
  const throughputCache = new Map<string, { at: number; page: ThroughputApiResponse }>();
  router.get(
    "/console/finance/throughput/:accountId",
    requireRole("admin"),
    async (req: ConsoleRequest, res: Response) => {
      const accountId = String(req.params.accountId ?? "");
      const spec = THROUGHPUT_ACCOUNTS[accountId];
      if (!spec) {
        // 与账单那条的 unsupported 不同：这里根本没有这一栏，页面也不会来问，404 即可
        res.status(404).json({ error: "throughput_unsupported", message: `该账户没有吞吐口径：${accountId}` });
        return;
      }
      if (!deps.usage) {
        res.status(503).json({ error: "throughput_unavailable", message: "用量仓储未接入，吞吐不可查" });
        return;
      }

      const refresh = req.query.refresh === "1" || req.query.refresh === "true";
      const hit = throughputCache.get(accountId);
      if (!refresh && hit && now() - hit.at < ttlMs()) {
        res.json({ ...hit.page, cached: true });
        return;
      }

      const step = intervalMs();
      const to = now();
      const from = bucketStart(to, step) - RETENTION_MS;
      try {
        const rows = await deps.usage.throughput({
          since: new Date(from),
          until: new Date(to),
          stepMs: step,
          providers: spec.providers,
          modelPrefix: spec.modelPrefix,
        });
        const page = toThroughputApi(accountId, spec, rows, { stepMs: step, from, to });
        throughputCache.set(accountId, { at: to, page });
        res.json(page);
      } catch (err) {
        // 查库失败就是失败，不回空数组——空数组会被画成"7 天一次调用都没有"
        res.status(502).json({ error: "throughput_failed", message: String(err) });
      }
    },
  );

  /*
   * 账单按需拉：点了哪张卡才打哪家。
   *
   * 不随余额一起返回：账单按账期逐月请求（一家 3 次），五家合计十几次上游调用，
   * 而多数时候只需看一家。
   */
  router.get(
    "/console/finance/bills/:accountId",
    auditAction("finance.bills"),
    requireRole("admin"),
    async (req: ConsoleRequest, res: Response) => {
      const accountId = String(req.params.accountId ?? "");
      const provider = FINANCE_PROVIDERS.find((p) => p.id === accountId);
      if (!provider) {
        res.status(404).json({ error: "unknown_account", message: `没有这个账户：${accountId}` });
        return;
      }

      // 这家没有账单接口，不回 404 也不回空数组：
      // 空数组会被读成"这段时间没花钱"，实际是"查不了"，处置动作不同。
      if (!provider.bills) {
        res.json({
          accountId,
          status: "unsupported",
          rows: [],
          coverage: "—",
          consoleUrl: provider.billsConsoleUrl ?? "",
          durationMs: 0,
          note: provider.billsUnsupportedReason,
        } satisfies FinanceBillPage);
        return;
      }

      const hit = billsCache.get(accountId);

      // stored=1：同余额那条——只回上次的，没有就 204，永不打上游。
      if (req.query.stored === "1" || req.query.stored === "true") {
        if (!hit) {
          res.status(204).end();
          return;
        }
        res.json({ ...hit.page, cached: true, stored: true });
        return;
      }

      const refresh = req.query.refresh === "1" || req.query.refresh === "true";
      const ttl = billsTtlMs();
      if (!refresh && hit && now() - hit.at < ttl) {
        res.json({ ...hit.page, cached: true });
        return;
      }

      const page = await provider.bills(providerDeps());
      billsCache.set(accountId, { at: now(), page });
      persist();
      res.json({ ...page, cached: false });
    },
  );

  return router;
}
