/**
 * 单机版费用明细（ACR-066）：`GET /v1/billing?range=today|7d|30d`。
 *
 * 单机版是 BYOK，模型、审核、地图都是车主自己的账号。这一页回答「我的钱花在哪、还剩多少」，
 * 数据全是本机已经记着的：模型调用（`llm_usage` 的单价估算）、审核记录（每条审核 = 一次外部调用）、
 * 高德额度台账（ACR-064 起单机版落 SQLite），外加两家供应商余额（与控制台财务页同一组查询函数）。
 *
 * 两道边界：
 *  1. 默认不挂：只有 `CABINHUG_OWNER_BILLING=on`（仅单机配置会设）时才有这个路由，否则 404。
 *     余额是账户的财务信息，容器部署里的普通车主不该看到公司账户；那边的账在控制台财务页，仅限 admin。
 *  2. 只给本人的数：用量与审核按「本人的会话」过滤（带用户键，不跨用户，ADR-011）。
 *     后台任务（导览预采集、导航规划）记在 `__guide__` 这类占位会话下、不属于任何人，
 *     只有本机只有一个账号时才能确定是车主的；多于一个账号时不计入、不分摊，回包里如实标出。
 *
 * 余额现查、缓存 60 秒（高德没有余额接口，只有额度台账）；查失败时卡片上标「查询失败」与原因，
 * 整个接口照样 200——一家供应商抖动不该让整页报错。
 */
import { Router } from "express";
import type { Response } from "express";

import type { GuardAuditRepository, UsageRepository } from "@cabinhug/db";
import {
  BILLING_RANGES,
  type BillingBalance,
  type BillingRange,
  type BillingRow,
  type BillingService,
  type OwnerBillingSummary,
} from "@cabinhug/shared";
import {
  amapBudgetFromEnv,
  buildAmapPoolSnapshot,
  createRedisAmapLedger,
  createSqliteAmapLedger,
  resolveAmapKeys,
  type AmapPoolSnapshot,
  type AmapUsageLedger,
} from "@cabinhug/tools";

import type { AuthedRequest } from "../auth";
import { aliyunBalance, deepseekBalance, type FinanceAccount, type ProviderDeps } from "../console/finance-providers";

/** 后台任务记账用的占位会话（agent-runtime 装配处）。不属于任何账号。 */
export const BACKGROUND_SESSIONS = ["__guide__", "__nav__", "__dualprobe__"] as const;

/** 每条审核记录对应一次外部审核调用的两层；规则筛与 PII 脱敏是本地的，不花钱。 */
const MODERATION_LAYERS = ["input_moderation", "output_moderation"] as const;

/** 经 DeepSeek 计费的 provider：直连记真 token，经 pi-acp 的按字符估算。 */
const DEEPSEEK_PROVIDERS = new Set(["deepseek", "pi-acp"]);

const DAY_MS = 86_400_000;
const BEIJING_OFFSET_MS = 8 * 3_600_000;
const BALANCE_TTL_MS = 60_000;
const BALANCE_TIMEOUT_MS = 8_000;

export interface OwnerBillingDeps {
  /** 本人名下的全部会话 id。 */
  sessionIdsOf(userId: string): Promise<string[]>;
  /** 本机账号数：只有一个时，后台任务的用量才能确定归车主。 */
  accountCount(): Promise<number>;
  usage: Pick<UsageRepository, "summary">;
  guardAudit: Pick<GuardAuditRepository, "countByLayer">;
  /** 高德今日的额度快照。缺省按环境变量读本机台账（SQLite 优先，其次 Redis）。 */
  amapPool?: () => Promise<AmapPoolSnapshot | undefined>;
  /** 供应商余额。缺省用控制台财务页那两个查询函数现查。 */
  balances?: { deepseek(): Promise<FinanceAccount>; aliyun(): Promise<FinanceAccount> };
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export function ownerBillingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CABINHUG_OWNER_BILLING?.trim().toLowerCase() === "on";
}

/** 统计窗口。`today` 从北京时间当天零点起，与高德额度台账的「日」同一个口径。 */
export function billingWindow(range: BillingRange, now: number): { since: number; until: number } {
  if (range === "7d") return { since: now - 7 * DAY_MS, until: now };
  if (range === "30d") return { since: now - 30 * DAY_MS, until: now };
  const bj = now + BEIJING_OFFSET_MS;
  return { since: bj - (bj % DAY_MS) - BEIJING_OFFSET_MS, until: now };
}

function toBalance(a: FinanceAccount): BillingBalance {
  return {
    status: a.status,
    ...(a.amount !== undefined ? { amount: a.amount } : {}),
    ...(a.currency ? { currency: a.currency } : {}),
    ...(a.note || a.error ? { note: a.note ?? a.error } : {}),
    consoleUrl: a.consoleUrl,
  };
}

function round(n: number): number {
  return Number(n.toFixed(6));
}

/** 余额：供应商接口现查。查询函数内部已吞掉异常（失败回 status=failed），这里不会 reject。 */
function defaultBalances(env: NodeJS.ProcessEnv, now: () => number): NonNullable<OwnerBillingDeps["balances"]> {
  const deps: ProviderDeps = {
    fetch: (input, init) => fetch(input, init),
    env: (k) => env[k]?.trim() || undefined,
    timeoutMs: BALANCE_TIMEOUT_MS,
    now: () => new Date(now()),
  };
  return { deepseek: () => deepseekBalance(deps), aliyun: () => aliyunBalance(deps) };
}

/** 高德额度：读本机台账，一次上游请求都不发。台账连接惰性建一次，只在路由真被调用时才连。 */
function defaultAmapPool(env: NodeJS.ProcessEnv, now: () => number): () => Promise<AmapPoolSnapshot | undefined> {
  let ledger: AmapUsageLedger | undefined | null = null;
  return async () => {
    if (ledger === null) {
      const sqlite = env.CABINHUG_CACHE_SQLITE?.trim();
      const redis = env.REDIS_URL?.trim();
      ledger = sqlite ? createSqliteAmapLedger(sqlite) : redis ? createRedisAmapLedger(redis) : undefined;
    }
    const keys = resolveAmapKeys((k) => env[k], () => {});
    if (keys.length === 0) return undefined;
    return buildAmapPoolSnapshot(keys, ledger, amapBudgetFromEnv(env.AMAP_DAILY_BUDGET, () => {}), now());
  };
}

function amapService(pool: AmapPoolSnapshot): BillingService {
  const byFamily = new Map<string, number>();
  let used = 0;
  let limit = 0;
  for (const k of pool.keys) {
    for (const [family, n] of Object.entries(k.usage)) byFamily.set(family, (byFamily.get(family) ?? 0) + (n ?? 0));
    // 额度看地点搜索（缺省预算只设了这一族）：退役的 key 今天已经不能用，不算进上限。
    if (k.budget?.place && k.retiredAt === undefined) limit += k.budget.place;
    used += k.usage.place ?? 0;
  }
  const rows: BillingRow[] = [...byFamily.entries()]
    .filter(([, n]) => n > 0)
    .map(([key, calls]) => ({ key, calls }))
    .sort((a, b) => b.calls - a.calls);
  return {
    id: "amap",
    label: "高德开放平台",
    role: "地点搜索、路线规划、天气",
    calls: rows.reduce((s, r) => s + r.calls, 0),
    ...(limit > 0 ? { quota: { used, limit, day: pool.day } } : {}),
    note:
      pool.source === "none"
        ? "本机没有高德额度台账，读不到今天的调用次数"
        : "高德按北京日计额度，这里只有今天；个人 Key 在免费额度内不产生费用",
    rows,
  };
}

export function createOwnerBillingRouter(deps: OwnerBillingDeps, enabled = ownerBillingEnabled(deps.env)): Router {
  const router = Router();
  // 关着就是一个空路由：请求落到后面的 404，与「没有这个接口」不可区分。
  if (!enabled) return router;

  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => Date.now());
  const balances = deps.balances ?? defaultBalances(env, now);
  const amapPool = deps.amapPool ?? defaultAmapPool(env, now);
  const balanceCache = new Map<string, { at: number; value: Promise<FinanceAccount> }>();

  function balanceOf(id: "deepseek" | "aliyun"): Promise<FinanceAccount> {
    const hit = balanceCache.get(id);
    if (hit && now() - hit.at < BALANCE_TTL_MS) return hit.value;
    const value = balances[id]();
    balanceCache.set(id, { at: now(), value });
    // 失败的结果不留缓存：下一次打开页面就重查，而不是把「查询失败」挂满一分钟。
    void value.then((a) => {
      if (a.status === "failed" && balanceCache.get(id)?.value === value) balanceCache.delete(id);
    });
    return value;
  }

  router.get("/v1/billing", async (req: AuthedRequest, res: Response) => {
    // 车辆级 token 没有「本人」：车机是共享终端，不回任何人的账。
    if (!req.userId) {
      res.status(403).json({ error: "owner_only" });
      return;
    }
    const raw = typeof req.query.range === "string" ? req.query.range : "today";
    if (!(BILLING_RANGES as readonly string[]).includes(raw)) {
      res.status(400).json({ error: "bad_range" });
      return;
    }
    const range = raw as BillingRange;
    const at = now();
    const { since, until } = billingWindow(range, at);

    let summary: OwnerBillingSummary;
    try {
      const [own, accounts] = await Promise.all([deps.sessionIdsOf(req.userId), deps.accountCount()]);
      const background = accounts <= 1 ? "included" : "excluded";
      const sessionIds = background === "included" ? [...own, ...BACKGROUND_SESSIONS] : own;
      const window = { since: new Date(since), until: new Date(until) };

      const [byAgent, byProvider, moderation, pool, ds, ali] = await Promise.all([
        deps.usage.summary({ dimension: "agent", ...window, sessionIds }),
        deps.usage.summary({ dimension: "provider", ...window, sessionIds }),
        deps.guardAudit.countByLayer({ sessionIds: own, ...window, layers: MODERATION_LAYERS }),
        amapPool().catch(() => undefined),
        balanceOf("deepseek"),
        balanceOf("aliyun"),
      ]);

      const others = byProvider.buckets.filter((b) => !DEEPSEEK_PROVIDERS.has(b.key));
      const llm: BillingService = {
        id: "deepseek",
        label: "大模型 · DeepSeek",
        role: "对话、行程规划、景点导览",
        calls: byAgent.total.calls,
        costEstimate: byAgent.total.costEstimate,
        balance: toBalance(ds),
        note:
          "花费按本机记的 token 与配置的单价估算（经 pi-acp 的调用按字符估），只能说「至少花了这么多」，以 DeepSeek 账单为准" +
          (others.length > 0 ? `；其中 ${others.map((o) => `${o.key} ${o.calls} 次`).join("、")} 不走 DeepSeek` : ""),
        rows: byAgent.buckets.map((b) => ({
          key: b.key,
          calls: b.calls,
          promptTokens: b.promptTokens,
          completionTokens: b.completionTokens,
          costEstimate: b.costEstimate,
        })),
      };

      const guardProvider = env.GUARD_PROVIDER?.trim() || "aliyun";
      const guard: BillingService = {
        id: "aliyun",
        label: "阿里云内容审核",
        role: "输入与输出的内容安全审核",
        calls: moderation.reduce((s, r) => s + r.count, 0),
        balance: toBalance(ali),
        note:
          guardProvider === "aliyun"
            ? "每条审核记录对应一次阿里云调用（放行也计）；按次计费，单价以阿里云账单为准"
            : `当前审核走 ${guardProvider}，这些条数不对应阿里云调用`,
        rows: moderation.map((r) => ({ key: r.layer, calls: r.count })),
      };

      const services = [llm, guard, ...(pool ? [amapService(pool)] : [])];
      summary = {
        range,
        since: new Date(since).toISOString(),
        until: new Date(until).toISOString(),
        generatedAt: new Date(at).toISOString(),
        totalCostEstimate: round(services.reduce((s, x) => s + (x.costEstimate ?? 0), 0)),
        background,
        services,
      };
    } catch (err) {
      console.warn("[billing] 汇总失败", err);
      res.status(503).json({ error: "billing_unavailable" });
      return;
    }
    res.json(summary);
  });

  return router;
}
