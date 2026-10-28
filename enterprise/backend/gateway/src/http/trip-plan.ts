/**
 * 座舱 HUD 的只读状态端点。
 *
 * `GET /v1/trip-plan/current`：座舱 HUD 轮询的唯一入口。
 *
 * 返回两样：
 *   - `plan`：已确认行程，没有就是 `null`；
 *   - `home`：车主常住地，没有行程时 HUD 的地图落点。
 *
 * # 常住地挂在这条路由上而不是另起一条
 *
 * 端上的网络在 Rust（§2.2 C2），加一条路由就要加一个 Tauri 命令、一条
 * `GatewayClient` 方法、一份 capability，以及第二个 60 秒轮询。而这两样
 * 回答的是同一个问题：HUD 现在该显示什么，有行程画行程，没有就画家。
 * 路由名不改，改名会打断已在运行的 Rust 客户端。
 *
 * 网关红线不变：只做 鉴权 → 查仓储 → 原样返回。不判过期、不做 HUD 映射：
 * 那些是确定性规则，落在端上的 shared 映射函数里，网关不分担其中任何一部分。
 *
 * 无行程返回 `200 {plan: null, home}` 而不是 404：轮询端把 404 当异常会反复告警，
 * 而"还没确认过行程"是常态不是异常。
 */

import { Router, json } from "express";
import type { Response } from "express";

import type {
  NavPlan,
  NavPlanOrigin,
  NavPlanRequest,
  NavPlanResponse,
  TripPlanListEntry,
  TripPlanReview,
} from "@cabinhug/shared";
import type {
  CommittedTripPlan,
  OwnerProfileRepository,
  StoredTripPlanReview,
  TripPlanRepository,
  TripPlanReviewRepository,
} from "@cabinhug/db";

import type { AuthedRequest } from "../auth";

/**
 * 出发地 → 今天第一站这一段（屏底状态栏的预计里程 / 用时 / 路况）。
 *
 * 每次 `/current` 都问 runtime 一次，缓存在 runtime 的⑤里（规划 3 分钟、地名坐标 1 小时），
 * 车机 60 秒一轮，三轮里只有一轮真打高德。网关这边不缓存：⑤只保留一份，避免两处缓存过期不一致。
 * 超时 4 秒，比 pretrip 短：它是每轮都跑的，不能拖慢首帧；拿不到就不带字段，端上显示「暂无」。
 */
async function fetchLeg(
  runtimeUrl: string,
  plan: unknown,
  home: { lat?: number; lon?: number } | undefined,
  timeoutMs = 4_000,
): Promise<unknown | undefined> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${runtimeUrl}/internal/trip/leg`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan, home }),
      signal: ac.signal,
    });
    if (!r.ok) return undefined;
    const body = (await r.json()) as { leg?: unknown; skipped?: string };
    return body.leg;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 打开 App 时的读时重算。
 *
 * 行前物品与天气是确认那一刻算的，出发前几天天气可能已变化。
 * 端上在打开（与从后台切回前台）的那一次带 `?refreshPretrip=1`，
 * 网关据此让 runtime 用最新天气重算一遍。
 *
 * 网关这一侧只做字段级组装：算天气要工具、要 registry，由 runtime 负责
 * （本文件顶部的红线：只做 鉴权 → 查仓储 → 原样返回）。
 * 重算不落库：库里那份是用户批准过的行程，环境数据不改写它。
 */
async function refreshPretrip(
  runtimeUrl: string,
  plan: unknown,
  timeoutMs = 6_000,
): Promise<{ pretripItems?: unknown; weather?: unknown } | undefined> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${runtimeUrl}/internal/trip/pretrip-refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan }),
      signal: ac.signal,
    });
    if (!r.ok) return undefined;
    const body = (await r.json()) as { pretripItems?: unknown; weather?: unknown; skipped?: string };
    // `skipped`（行程过期 / 重算失败）不是错误，只是这次没有新值可用。
    if (!body.pretripItems) return undefined;
    return { pretripItems: body.pretripItems, weather: body.weather };
  } catch {
    // 超时、runtime 没起、网络抖动，一律当"这次没算成"，不把 HUD 变成一次报错。
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 目的地推荐的读时补齐（兜底路径）。
 *
 * 推荐在行程确认/变更后由 runtime 在后台算好，写回库里那份快照；
 * 库里有值时这一跳不发，避免每次打开 App 都重复一次计费的联网搜索。
 * 这一跳服务两种行程：后台推荐启用前确认的老行程，以及后台那次没算成的。
 *
 * 与上面 `refreshPretrip` 同族同形状，两处不同：
 *
 *  - 超时 25 秒而不是 6 秒。天气那条的 6 秒按天气接口的耗时定；
 *    推荐要经一次联网搜索，实测 11.7 / 12.4 / 14.0 秒（工具侧超时 30 秒），6 秒等不到结果。
 *  - `skipped` 有三种（`expired` / `empty` / `failed`），对端上都是同一件事：
 *    这次没有推荐，卡上就少一页。
 *
 * 两条重算必须并发（见调用处）：串行最坏 31 秒，端上首帧会明显卡住。
 */
async function refreshHighlights(
  runtimeUrl: string,
  plan: unknown,
  timeoutMs = 25_000,
): Promise<unknown | undefined> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${runtimeUrl}/internal/trip/highlights-refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan }),
      signal: ac.signal,
    });
    if (!r.ok) return undefined;
    const body = (await r.json()) as { destinationHighlights?: unknown; skipped?: string };
    return body.destinationHighlights;
  } catch {
    // 超时、runtime 没起、网络抖动，一律当"这次没算成"，端上照常拿到没有推荐的行程。
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 出发导航规划的网关挂等预算。分配：runtime 分支 55 s → 网关 60 s → Rust 65 s → 端上 60 s 硬顶。
 * 端上的顶比这里短是刻意的：端上的判据是"用户等了多久"，服务端晚到的结果按序号丢弃。
 */
export const NAV_PLAN_TIMEOUT_MS = 60_000;

/**
 * 出发导航规划的转发。与 `refreshPretrip` 同族：AbortController 挂等、非 200 与 `skipped` 都当"这次没算成"。
 * 返回 undefined = 没有方案；调用方回 `status:"failed"`，不回 5xx，端上据此按今天的直连走。
 */
async function requestNavPlan(
  runtimeUrl: string,
  body: { userId: string; plan: unknown; origin: NavPlanOrigin; vin?: string },
  timeoutMs: number,
): Promise<{ plan: NavPlan; elapsedMs?: number } | undefined> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${runtimeUrl}/internal/trip/nav-plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    if (!r.ok) return undefined;
    const upstream = (await r.json()) as { plan?: NavPlan; elapsedMs?: number; skipped?: string };
    if (!upstream.plan) return undefined;
    return { plan: upstream.plan, ...(upstream.elapsedMs !== undefined ? { elapsedMs: upstream.elapsedMs } : {}) };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** 端上定位的新鲜度（分钟）：由 `origin.at` 算，算不出就不给，runtime 只在有值时写 caveat。 */
export function originAgeMinutes(at: unknown, now = Date.now()): number | undefined {
  if (typeof at !== "string") return undefined;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, Math.round((now - t) / 60_000));
}

/** 落库行 → 契约形状：去掉 userId 与签名（端上不需要，也不该拿到别人的 id 形态）。 */
function toContractReview(r: StoredTripPlanReview): TripPlanReview {
  const { userId: _u, signature: _s, ...rest } = r;
  return rest;
}

/**
 * 活动行程（进行中 + 未来 + 未定日期）各带最新一份核查。失败回空数组：列表是配角，
 * 拿不到不让主行程那一半变成报错（与常住地同一取舍）。
 */
async function listActive(
  repo: TripPlanRepository,
  reviews: TripPlanReviewRepository | undefined,
  userId: string,
): Promise<TripPlanListEntry[]> {
  let rows: CommittedTripPlan[];
  try {
    rows = await repo.activeForUser(userId);
  } catch (e) {
    console.warn("[trip-plan] 活动行程列表读取失败（回空列表）", e);
    return [];
  }
  let latest = new Map<string, StoredTripPlanReview>();
  if (reviews && rows.length > 0) {
    try {
      latest = await reviews.latestForPlans(rows.map((r) => r.planId));
    } catch (e) {
      console.warn("[trip-plan] 核查读取失败（列表不带核查）", e);
    }
  }
  return rows.map((r) => {
    const review = latest.get(r.planId);
    return {
      planId: r.planId,
      plan: r.plan,
      committedAt: r.committedAt.toISOString(),
      // 仓储的 updatedAt 可选（内存夹具不必补）：没改过就是确认那一刻。
      updatedAt: (r.updatedAt ?? r.committedAt).toISOString(),
      ...(review ? { review: toContractReview(review) } : {}),
    };
  });
}

export function createTripPlanRouter(
  repo: TripPlanRepository,
  ownerProfiles?: OwnerProfileRepository,
  /** runtime 内部地址；不传 = 不提供重算能力（单挂测试与旧装配点照常工作）。 */
  runtimeUrl?: string,
  /** 出发导航规划的挂等预算；测试注入小值，生产不传。 */
  navPlanTimeoutMs = NAV_PLAN_TIMEOUT_MS,
  /**
   * 每日核查仓储。不传 = 没有核查面：`plans[]` 每项无 `review`，ack 路由回 503，
   * 单挂测试与旧装配点照常工作。
   */
  reviews?: TripPlanReviewRepository,
): Router {
  const router = Router();

  /*
   * 「知道了」：把这一份核查标成已看过。归属只认鉴权身份，仓储的 `ack` 带 userId，
   * 错人 / 不存在一律 404，不区分（区分即告诉调用方"这个 id 存在但不是你的"）。
   * 重复点是幂等的：已确认的返回原行、`ackedAt` 不变。
   */
  router.post("/v1/trip-plan/:planId/review/ack", json(), async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!reviews) {
      res.status(503).json({ error: "reviews_unavailable" });
      return;
    }
    const body = (req.body ?? {}) as { reviewId?: unknown };
    const reviewId = typeof body.reviewId === "string" ? body.reviewId.trim() : "";
    if (!reviewId) {
      res.status(400).json({ error: "reviewId_required" });
      return;
    }
    const acked = await reviews.ack(req.userId, reviewId);
    if (!acked || acked.planId !== req.params.planId) {
      res.status(404).json({ error: "review_not_found" });
      return;
    }
    res.json({ review: toContractReview(acked) });
  });

  /*
   * 出发导航规划：点「开始行程」的唯一入口。网关红线不变：
   * 鉴权 → 按鉴权身份查行程（不接受 body 里的 plan，否则端上可替别人规划）→ 补起点
   * （body 有 → fix；无 → 常住地 home；都无 → failed/no_origin，不打 runtime）→ 转发 → 原样透传 plan。
   * 失败一律 200 + `status:"failed"`（与 trip-plan / guide 同一取舍）：端上据此走今天的直连，5xx 会把降级渲染成报错。
   */
  router.post("/v1/trip-plan/nav-plan", json(), async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const startedAt = Date.now();
    const body = (req.body ?? {}) as NavPlanRequest;
    const current = await repo.currentForUser(req.userId).catch(() => null);
    if (!current) {
      res.json({ status: "failed", reason: "no_plan" } satisfies NavPlanResponse);
      return;
    }
    let origin: NavPlanOrigin | undefined;
    const o = body.origin;
    if (o && typeof o.lat === "number" && typeof o.lon === "number" && Number.isFinite(o.lat) && Number.isFinite(o.lon)) {
      const age = originAgeMinutes(o.at);
      origin = { lat: o.lat, lon: o.lon, source: "fix", ...(age !== undefined ? { ageMinutes: age } : {}) };
    } else {
      const owner = await ownerProfiles?.currentForUser(req.userId).catch(() => undefined);
      if (owner?.home) origin = { lat: owner.home.lat, lon: owner.home.lon, source: "home" };
    }
    if (!origin) {
      res.json({ status: "failed", reason: "no_origin" } satisfies NavPlanResponse);
      return;
    }
    if (!runtimeUrl) {
      res.json({ status: "failed", reason: "failed" } satisfies NavPlanResponse);
      return;
    }
    const reply = await requestNavPlan(
      runtimeUrl,
      {
        userId: req.userId,
        plan: current.plan,
        origin,
        ...(typeof body.vin === "string" && body.vin.trim() ? { vin: body.vin.trim() } : {}),
      },
      navPlanTimeoutMs,
    );
    if (!reply) {
      res.json({
        status: "failed",
        reason: Date.now() - startedAt >= navPlanTimeoutMs ? "timeout" : "failed",
        elapsedMs: Date.now() - startedAt,
      } satisfies NavPlanResponse);
      return;
    }
    // plan 原样透传（网关红线）：字段增减由 shared 契约管，这里不挑不拣。
    res.json({ status: "ready", plan: reply.plan, elapsedMs: Date.now() - startedAt } satisfies NavPlanResponse);
  });

  router.get("/v1/trip-plan/current", async (req: AuthedRequest, res: Response) => {
    // demoAuth 之后 userId 恒在；防御性判空保证单独挂载测试时不会查错人。
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    /*
     * 常住地拿不到不阻塞行程：HUD 没有落点只是退回写死的默认中心，
     * 而拿不到行程是"主功能没了"。未注入仓储（单挂测试）时同理。
     */
    const [current, owner] = await Promise.all([
      repo.currentForUser(req.userId),
      ownerProfiles?.currentForUser(req.userId).catch((e) => {
        console.warn("[trip-plan] 常住地读取失败（HUD 退回默认中心）", e);
        return undefined;
      }),
    ]);
    const home = owner?.home;
    /*
     * 活动行程列表 + 每程最新核查。与 `current` 同一跳回去：60 s 轮询已经在打这条，
     * 为列表再开一条路由要多一个 Tauri 命令与第二个轮询（本文件头的理由）。
     * 网关不判核查作废、不算变化：那是 contracts 的纯函数，由端上计算（`reviewIsStale` / `reviewNeedsAttention`）。
     * 列表取不到不阻塞主行程：与常住地同一取舍。
     */
    const plans = await listActive(repo, reviews, req.userId);
    /*
     * 每一程都带上出发段（端上可以选中任意一程，状态栏跟着切）。并发问 runtime，
     * 高德那一跳由⑤缓存吸收；任一程拿不到只是那一程不带 `leg`。
     */
    if (runtimeUrl !== undefined && plans.length > 0) {
      const legs = await Promise.all(plans.map((p) => fetchLeg(runtimeUrl, p.plan, home)));
      plans.forEach((p, i) => {
        if (legs[i]) (p.plan as { leg?: unknown }).leg = legs[i];
      });
    }
    const currentReview = current ? plans.find((p) => p.planId === current.planId)?.review : undefined;
    if (!current) {
      res.json({ plan: null, plans, ...(home ? { home } : {}) });
      return;
    }
    /*
     * opt-in 重算：只有端上明确要求这一次才算。
     * 默认路径行为不变，Rust 客户端按 60 秒轮询这条路由。
     */
    const wantRefresh = req.query.refreshPretrip === "1" && runtimeUrl !== undefined;
    /*
     * 两条重算并发，不串行。
     *
     * 串行最坏 6 + 25 = 31 秒，而这是端上打开 App 的首帧那一跳。
     * 并发后最坏就是慢的那一条（25 秒），且任一条失败不影响另一条：
     * 天气失败照样能出推荐，反之亦然。
     *
     * 一个 query 参数管两件事是刻意的：端上"打开时刷一次环境数据"是一件事，
     * 拆两个开关会出现"刷了一半"的状态。
     */
    /*
     * 推荐只在库里没有时才现算。
     *
     * 它已在确认/变更那一刻由 runtime 后台算好并落库，库里那份是权威；
     * 再打一次只会为同一份结果重复一次按次计费的联网搜索。
     * 判空看的是快照本身，不看 `wantRefresh`：两者是不同的问题
     * （"要不要重算天气" vs "这一程有没有推荐"）。
     */
    const storedHighlights = (current.plan as { destinationHighlights?: unknown })
      .destinationHighlights;
    const [fresh, highlights] = wantRefresh
      ? await Promise.all([
          refreshPretrip(runtimeUrl, current.plan),
          storedHighlights ? undefined : refreshHighlights(runtimeUrl, current.plan),
        ])
      : [undefined, undefined];
    // 当前这一程的出发段：列表里已经算过就直接拿，不在列表里（罕见）才单独问一次。
    const currentLeg =
      (plans.find((p) => p.planId === current.planId)?.plan as { leg?: unknown } | undefined)?.leg ??
      (runtimeUrl !== undefined ? await fetchLeg(runtimeUrl, current.plan, home) : undefined);
    const plan = {
      ...current.plan,
      ...(fresh ?? {}),
      ...(highlights ? { destinationHighlights: highlights } : {}),
      ...(currentLeg ? { leg: currentLeg } : {}),
    };

    res.json({
      plan,
      committedAt: current.committedAt.toISOString(),
      plans,
      // 端上列表默认高亮哪一行：快照里没有 planId，只能网关说。
      currentPlanId: current.planId,
      ...(currentReview ? { review: currentReview } : {}),
      // 让端上与排障能分辨"这次是新算的还是库里的"。
      ...(wantRefresh
        ? {
            pretripRefreshed: fresh !== undefined,
            // 库里已有 = 这一跳没现算，但端上照样拿得到推荐。两件事分开报，
            // 避免排障时把"没刷"读成"没有"。
            highlightsRefreshed: highlights !== undefined,
            highlightsFromStore: storedHighlights !== undefined,
          }
        : {}),
      ...(home ? { home } : {}),
    });
  });

  return router;
}
