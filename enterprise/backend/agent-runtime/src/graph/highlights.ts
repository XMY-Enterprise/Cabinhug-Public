/**
 * 目的地推荐的取数点。
 *
 * # 不放进 `supervisor.ts`
 *
 * 行前物品（`collectPretripItems`）在 `supervisor.ts` 里，挂在行程确认那一跳
 * （坐标解析之后、权限门之前）。推荐不在那条链上：它一次要十几秒（实测 11.7~14.0 秒），
 * 串进确认会让弹窗延迟十几秒。
 *
 * 推荐走确认后的后台补算：行程一确认/一变更，这里在后台算一次，算完写回那一行的快照。
 * 确认那一跳不等它；落库只是不同步。
 *
 * 落库让这张卡在端上每 60 秒一轮的常规轮询中保持稳定，不随轮询消失。
 *
 * 读时补齐那条路作兜底（`/internal/trip/highlights-refresh`）：
 * 老行程与后台没算成的行程靠它补，网关只在库里没有时才调。
 *
 * 本文件与图（graph）没有直接关系，只是与 `supervisor.ts` 的 `collectPretripItems` 同族。
 */

import { hasHighlights, tripDayIndex } from "@cabinhug/shared";
import type { DestinationHighlights, PhotoTipRef, TripPlanSnapshot } from "@cabinhug/shared";
import { invokeTool } from "@cabinhug/tools";

/**
 * 算一次目的地推荐。抛错直接抛出，调用方（端点）负责翻译成 `skipped`。
 *
 * 目的地取 `plan.destination`（用户说的那个地方，如「舟山普陀山」），
 * 不取 skeleton 里的景点名（如「普济寺」）：按后者搜会命中大量同名地点。
 */
export async function collectDestinationHighlights(
  plan: TripPlanSnapshot,
  sessionId = "trip-highlights",
): Promise<DestinationHighlights> {
  const destination = plan.destination?.trim();
  if (!destination) throw new Error("行程没有目的地，无从搜起");

  // `invokeTool` 回的是四件套的 `ToolResult`（`{ data, source }`），不是裸数据。
  const r = (await invokeTool(
    "destination_highlights",
    { destination, ...(plan.startDate ? { date: plan.startDate } : {}) },
    { sessionId, agent: "trip" },
  )) as { data: { foods: ToolEntry[]; spots: ToolEntry[]; photoTips: PhotoTipRef[] } };
  const data = r.data;

  return {
    destination,
    foods: data.foods.map(toEntry),
    spots: data.spots.map(toEntry),
    photoTips: data.photoTips,
    // 排障时判断"这份是什么时候算的"只能看这一栏。
    computedAt: new Date().toISOString(),
  };
}

/** 工具侧的形状：出处是嵌套对象，有才有、没有就整个缺席。 */
interface ToolEntry {
  name: string;
  note: string;
  source?: { url: string; title?: string };
}

/**
 * 工具形状 → 端云契约形状。
 *
 * 两边刻意不同：工具那侧 `source` 是个整体（"这条有没有出处"是一个二值判断，
 * 嵌套对象让它不可能只有一半）；契约这侧摊平成 `sourceUrl`/`sourceTitle`，
 * 便于过 JSON、zod 与端上渲染时少一层判空。
 *
 * 摊平时不造值：`source` 缺席 → 两个字段都不出现，而不是空串。
 * 空串在端上表示"有出处但没写"，与"没有出处"不同。
 */
function toEntry(e: ToolEntry): DestinationHighlights["foods"][number] {
  return {
    name: e.name,
    note: e.note,
    ...(e.source ? { sourceUrl: e.source.url } : {}),
    ...(e.source?.title ? { sourceTitle: e.source.title } : {}),
  };
}


// ── 确认后的后台补算与回写 ──────────────────────────

/**
 * 这份推荐是不是给这一程算的。
 *
 * 判据只有目的地，不含日期：推荐的内容是"这个地方吃什么、拍哪儿"，
 * 属于周级变化，改出发日不会让它失效（改目的地会）。
 * 日期仍会触发一次重算（它进了工具的缓存键），重算期间旧的那份继续可用，
 * 避免改出发日时卡片空缺十几秒。
 */
function highlightsMatchPlan(h: DestinationHighlights, plan: TripPlanSnapshot): boolean {
  return h.destination.trim() === plan.destination?.trim();
}

/** 去掉推荐这一栏（删键，不写 undefined：它要过 JSON，留空键端上要多判一种形态）。 */
function withoutHighlights(plan: TripPlanSnapshot): TripPlanSnapshot {
  if (!plan.destinationHighlights) return plan;
  const { destinationHighlights: _drop, ...rest } = plan;
  return rest;
}

/**
 * 行程变更时决定推荐这一栏的去留（新的那份算好之前，屏幕上放什么）。
 *
 * 三条，按顺序：
 *  1. 新快照自带、且对得上新目的地 → 用它；
 *  2. 库里那份对得上新目的地 → 沿用，等后台算完再覆盖；
 *  3. 其余（改了目的地 / 自带的是上一程的）→ 立刻清掉。
 *
 * 第 3 条：别的目的地的推荐挂在这一程上是错误信息，比这一栏暂时空着更糟。
 */
export function carryOverHighlights(
  prev: TripPlanSnapshot | undefined,
  next: TripPlanSnapshot,
): TripPlanSnapshot {
  const own = next.destinationHighlights;
  if (own && highlightsMatchPlan(own, next)) return next;
  const inherited = prev?.destinationHighlights;
  if (inherited && highlightsMatchPlan(inherited, next)) {
    return { ...next, destinationHighlights: inherited };
  }
  return withoutHighlights(next);
}

/**
 * 补算要用到的仓储面。只声明这两个方法，不 import `@cabinhug/db`，单测给个假的即可。
 *
 * 读的那一半是 `confirmedById` 而不是 `currentForUser`：见下面 `once()` 里那道核对。
 */
export interface HighlightsPlanStore {
  confirmedById(
    userId: string,
    planId: string,
  ): Promise<{ planId: string; sessionId: string; plan: TripPlanSnapshot } | null>;
  update(
    userId: string,
    planId: string,
    sessionId: string,
    plan: TripPlanSnapshot,
  ): Promise<unknown>;
}

export interface HighlightsBackfillTarget {
  userId: string;
  planId: string;
  sessionId: string;
  plan: TripPlanSnapshot;
}

export interface HighlightsBackfill {
  /** 确认/变更之后调。不返回 Promise：主动作不等它。 */
  schedule(target: HighlightsBackfillTarget): void;
  /** 等当前在跑的补算全部结束（测试与优雅退出用）。 */
  idle(): Promise<void>;
}

export interface HighlightsBackfillOptions {
  /** 取推荐（测试注入）。 */
  collect?: (plan: TripPlanSnapshot) => Promise<DestinationHighlights>;
  /** 今天（YYYY-MM-DD，测试注入）。 */
  today?: () => string;
}

/**
 * 行程确认/变更 → 后台算一次目的地推荐 → 写回那一行。
 *
 * 三条取舍：
 *
 *  1. fire-and-forget。它要十几秒，串进确认那一跳会让弹窗延迟。失败只记一行日志：
 *     确认行程是主动作，不受这个副作用影响。
 *  2. 写回前重读那一行。计算期间用户可能又改了行程，拿旧快照去 `update` 会覆盖新改动。
 *     因此以库里那一行的最新内容为底，只加推荐这一栏；那一行没了 / 被取消，
 *     或目的地变了，就整个丢弃这次的结果。重读按 `planId`，理由在 `once()` 里。
 *  3. 同一程只跑一个。在跑时再次调度只记一个"再跑一次"，跑完补一轮，中间的请求合并掉。
 */
export function createHighlightsBackfill(
  store: HighlightsPlanStore,
  opts: HighlightsBackfillOptions = {},
): HighlightsBackfill {
  const collect = opts.collect ?? ((plan: TripPlanSnapshot) => collectDestinationHighlights(plan));
  const today = opts.today ?? (() => new Date().toISOString().slice(0, 10));
  /** planId → 是否有"跑完再来一次"的请求。键在表里 = 正在跑。 */
  const running = new Map<string, boolean>();
  const waiters: Array<Promise<void>> = [];

  const once = async (t: HighlightsBackfillTarget): Promise<void> => {
    // 已经结束的行程不值得烧一次联网搜索——它连卡都不会上（tripPlanToHud 返回 null）。
    if (tripDayIndex(t.plan, today()) === null) return;
    const highlights = await collect(t.plan);
    // 三段全空 = 这次什么都没搜到。不写，避免把"没有"存成一个空对象。
    if (!hasHighlights(highlights)) return;

    /*
     * 写回前重读这一行（`confirmedById`），不读"当前行程"。
     *
     * 「当前行程」= 最新一条 confirmed，而车主能从列表里载入并变更任何一程：
     * 改的不是最新那一程时，按当前行程重读会对不上 `planId`，推荐被整份丢掉；
     * `update` 又不改 `committedAt`，那一程不会重新成为当前行程。
     * `route-services.ts` 的沿途服务回写按同一方式处理。
     *
     * 要核对的是"这一行还在不在、还是不是 confirmed"，以及目的地在计算期间有没有变过。
     */
    const cur = await store.confirmedById(t.userId, t.planId);
    if (!cur) return; // 期间被取消 / 不属于这个人 / 没有这一行
    if (!highlightsMatchPlan(highlights, cur.plan)) return; // 期间改了目的地，这份属于旧版本
    await store.update(t.userId, cur.planId, cur.sessionId, {
      ...cur.plan,
      destinationHighlights: highlights,
    });
  };

  const loop = async (t: HighlightsBackfillTarget): Promise<void> => {
    try {
      do {
        running.set(t.planId, false);
        try {
          await once(t);
        } catch (err) {
          console.warn("[highlights] 后台补算失败（这一程这次就没有推荐页）", err);
        }
      } while (running.get(t.planId));
    } finally {
      running.delete(t.planId);
    }
  };

  return {
    schedule(t) {
      if (running.has(t.planId)) {
        running.set(t.planId, true); // 在跑 → 记一次重跑，不再排一个新任务
        return;
      }
      const p = loop(t);
      waiters.push(p);
      void p.finally(() => {
        const i = waiters.indexOf(p);
        if (i >= 0) waiters.splice(i, 1);
      });
    },
    async idle() {
      while (waiters.length > 0) await Promise.all([...waiters]);
    },
  };
}
