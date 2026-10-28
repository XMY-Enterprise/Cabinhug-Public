/**
 * [ACR-066] 单机版费用明细 `GET /v1/billing`。
 *
 * 守四条：
 *  1. 开关关着就没有这个接口（404）——余额是账户的财务信息，容器部署里的车主不该看到；
 *  2. 只汇总本人的会话；后台任务的占位会话只在本机只有一个账号时计入，多账号不计入、不分摊；
 *  3. 供应商余额查询失败时卡片如实标注，整个接口照样 200；
 *  4. 余额缓存 60 秒，失败的结果不缓存。
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { describe, test } from "node:test";

import express from "express";

import type { UsageBucket } from "@cabinhug/db";
import type { OwnerBillingSummary } from "@cabinhug/shared";
import type { AmapPoolSnapshot } from "@cabinhug/tools";

import type { FinanceAccount } from "../src/console/finance-providers";
import {
  BACKGROUND_SESSIONS,
  billingWindow,
  createOwnerBillingRouter,
  ownerBillingEnabled,
  type OwnerBillingDeps,
} from "../src/http/owner-billing";

const NOW = Date.parse("2026-10-27T06:00:00Z"); // 北京时间 14:00

function bucket(key: string, calls: number, cost: number): UsageBucket {
  return {
    key,
    calls,
    promptTokens: calls * 1000,
    completionTokens: calls * 100,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    costEstimate: cost,
    avgDurationMs: 800,
  };
}

function total(buckets: UsageBucket[]): UsageBucket {
  return buckets.reduce(
    (t, b) => ({
      ...t,
      calls: t.calls + b.calls,
      promptTokens: t.promptTokens + b.promptTokens,
      completionTokens: t.completionTokens + b.completionTokens,
      costEstimate: t.costEstimate + b.costEstimate,
    }),
    bucket("总计", 0, 0),
  );
}

const ACCOUNT = (id: string, over: Partial<FinanceAccount> = {}): FinanceAccount => ({
  id,
  label: id,
  kind: "balance",
  status: "ok",
  exact: true,
  amount: 42.5,
  currency: "CNY",
  detail: [],
  consoleUrl: `https://${id}.example/console`,
  durationMs: 1,
  ...over,
});

const POOL: AmapPoolSnapshot = {
  day: "2026-10-27",
  source: "memory",
  observations: [],
  keys: [{ name: "AMAP_SERVER_KEY", fp: "fp1", usage: { place: 30, direction: 12 }, budget: { place: 450 }, ratio: { place: 30 / 450 } }],
};

interface Seen {
  usage: Array<{ dimension: string; sessionIds?: readonly string[]; since?: Date }>;
  guard: Array<{ sessionIds: readonly string[] }>;
  balance: Record<string, number>;
}

function fakeDeps(over: Partial<OwnerBillingDeps> & { accounts?: number } = {}): { deps: OwnerBillingDeps; seen: Seen } {
  const seen: Seen = { usage: [], guard: [], balance: { deepseek: 0, aliyun: 0 } };
  const agents = [bucket("drive-task", 3, 0.03), bucket("guide-spots-task", 2, 0.02)];
  const deps: OwnerBillingDeps = {
    sessionIdsOf: async (userId) => (userId === "u1" ? ["s1", "s2"] : ["s9"]),
    accountCount: async () => over.accounts ?? 1,
    usage: {
      summary: async (opts) => {
        seen.usage.push(opts);
        const buckets = opts.dimension === "agent" ? agents : [bucket("pi-acp", 4, 0.04), bucket("deepseek", 1, 0.01)];
        return { buckets, total: total(buckets) };
      },
    },
    guardAudit: {
      countByLayer: async (opts) => {
        seen.guard.push(opts);
        return [
          { layer: "input_moderation", count: 6 },
          { layer: "output_moderation", count: 5 },
        ];
      },
    },
    amapPool: async () => POOL,
    balances: {
      deepseek: async () => {
        seen.balance.deepseek += 1;
        return ACCOUNT("deepseek");
      },
      aliyun: async () => {
        seen.balance.aliyun += 1;
        return ACCOUNT("aliyun");
      },
    },
    env: { CABINHUG_OWNER_BILLING: "on" },
    now: () => NOW,
    ...over,
  };
  return { deps, seen };
}

function appWith(userId: string | null, deps: OwnerBillingDeps, enabled?: boolean) {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { userId?: string }).userId = userId ?? undefined;
    next();
  });
  app.use(createOwnerBillingRouter(deps, enabled));
  return app;
}

async function get(app: express.Express, path: string) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    const text = await r.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // express 缺省的 404 是 HTML
    }
    return { status: r.status, body };
  } finally {
    server.close();
  }
}

describe("开关", () => {
  test("只认 on", () => {
    assert.equal(ownerBillingEnabled({ CABINHUG_OWNER_BILLING: "on" }), true);
    assert.equal(ownerBillingEnabled({ CABINHUG_OWNER_BILLING: " ON " }), true);
    assert.equal(ownerBillingEnabled({ CABINHUG_OWNER_BILLING: "1" }), false);
    assert.equal(ownerBillingEnabled({}), false);
  });

  test("关着就没有这个接口：404，且一次查询都不发", async () => {
    const { deps, seen } = fakeDeps({ env: {} });
    const r = await get(appWith("u1", deps), "/v1/billing");
    assert.equal(r.status, 404);
    assert.equal(seen.usage.length + seen.guard.length + seen.balance.deepseek + seen.balance.aliyun, 0);
  });
});

describe("GET /v1/billing", () => {
  test("车辆级 token（没有本人）回 403", async () => {
    const r = await get(appWith(null, fakeDeps().deps), "/v1/billing");
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { error: "owner_only" });
  });

  test("时间段不认识回 400", async () => {
    const r = await get(appWith("u1", fakeDeps().deps), "/v1/billing?range=1y");
    assert.equal(r.status, 400);
  });

  test("单账号：本人会话 + 后台占位会话；审核只看本人会话；三张卡", async () => {
    const { deps, seen } = fakeDeps();
    const r = await get(appWith("u1", deps), "/v1/billing?range=7d");
    assert.equal(r.status, 200);
    const body = r.body as OwnerBillingSummary;
    assert.equal(body.range, "7d");
    assert.equal(body.background, "included");
    assert.deepEqual(seen.usage[0]?.sessionIds, ["s1", "s2", ...BACKGROUND_SESSIONS]);
    assert.equal(seen.usage[0]?.since?.getTime(), NOW - 7 * 86_400_000);
    assert.deepEqual(seen.guard[0]?.sessionIds, ["s1", "s2"]);

    assert.deepEqual(
      body.services.map((s) => s.id),
      ["deepseek", "aliyun", "amap"],
    );
    const [llm, guard, amap] = body.services;
    assert.equal(llm?.calls, 5);
    assert.equal(llm?.costEstimate, 0.05);
    assert.equal(llm?.balance?.amount, 42.5);
    assert.deepEqual(
      llm?.rows.map((x) => x.key),
      ["drive-task", "guide-spots-task"],
    );
    assert.equal(guard?.calls, 11);
    assert.equal(guard?.costEstimate, undefined, "没有单价就不给花费");
    assert.deepEqual(amap?.quota, { used: 30, limit: 450, day: "2026-10-27" });
    assert.equal(amap?.calls, 42);
    assert.equal(body.totalCostEstimate, 0.05);
  });

  test("多账号：后台任务不计入，只按本人会话", async () => {
    const { deps, seen } = fakeDeps({ accounts: 2 });
    const r = await get(appWith("u1", deps), "/v1/billing");
    const body = r.body as OwnerBillingSummary;
    assert.equal(body.background, "excluded");
    assert.deepEqual(seen.usage[0]?.sessionIds, ["s1", "s2"]);
  });

  test("余额查询失败：卡片标失败与原因，接口照样 200", async () => {
    const { deps } = fakeDeps({
      balances: {
        deepseek: async () => ACCOUNT("deepseek"),
        aliyun: async () => ACCOUNT("aliyun", { status: "failed", exact: false, amount: undefined, error: "HTTP 403" }),
      },
    });
    const r = await get(appWith("u1", deps), "/v1/billing");
    assert.equal(r.status, 200);
    const guard = (r.body as OwnerBillingSummary).services.find((s) => s.id === "aliyun");
    assert.equal(guard?.balance?.status, "failed");
    assert.equal(guard?.balance?.note, "HTTP 403");
    assert.equal(guard?.balance?.amount, undefined);
  });

  test("没有高德台账快照时不出高德卡", async () => {
    const { deps } = fakeDeps({ amapPool: async () => undefined });
    const r = await get(appWith("u1", deps), "/v1/billing");
    assert.deepEqual(
      (r.body as OwnerBillingSummary).services.map((s) => s.id),
      ["deepseek", "aliyun"],
    );
  });

  test("用量库查不动回 503，不回半张表", async () => {
    const { deps } = fakeDeps({
      usage: {
        summary: async () => {
          throw new Error("db down");
        },
      },
    });
    const r = await get(appWith("u1", deps), "/v1/billing");
    assert.equal(r.status, 503);
  });

  test("余额缓存 60 秒；失败的结果不缓存", async () => {
    let t = NOW;
    let aliyunFails = true;
    const { deps, seen } = fakeDeps({
      now: () => t,
      balances: {
        deepseek: async () => {
          seen.balance.deepseek += 1;
          return ACCOUNT("deepseek");
        },
        aliyun: async () => {
          seen.balance.aliyun += 1;
          return aliyunFails ? ACCOUNT("aliyun", { status: "failed", exact: false, error: "timeout" }) : ACCOUNT("aliyun");
        },
      },
    });
    const app = appWith("u1", deps);
    await get(app, "/v1/billing");
    aliyunFails = false;
    t += 30_000;
    await get(app, "/v1/billing");
    assert.equal(seen.balance.deepseek, 1, "60 秒内不重查");
    assert.equal(seen.balance.aliyun, 2, "失败的不缓存，下一次就重查");
    t += 31_000;
    await get(app, "/v1/billing");
    assert.equal(seen.balance.deepseek, 2, "过了 60 秒重查");
  });
});

describe("统计窗口", () => {
  test("今天从北京时间零点起", () => {
    const w = billingWindow("today", NOW);
    assert.equal(new Date(w.since).toISOString(), "2026-10-26T16:00:00.000Z");
    assert.equal(w.until, NOW);
  });

  test("北京时间凌晨也落在当天", () => {
    const t = Date.parse("2026-10-26T17:30:00Z"); // 北京 10-27 01:30
    assert.equal(new Date(billingWindow("today", t).since).toISOString(), "2026-10-26T16:00:00.000Z");
  });

  test("7 天 / 30 天往回倒推", () => {
    assert.equal(billingWindow("30d", NOW).since, NOW - 30 * 86_400_000);
  });
});
