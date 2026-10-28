/**
 * 补录询问的装配侧（架构文档 §4.6，F-53-04/05/09、F-54-10）。
 *
 * # 状态不放图状态
 *
 * §4.6 约束 4 的不变量：同一辆陈旧的车，在"从未被问过"与"已拒答"两种状态下，
 * 喂给各 Agent 的上下文与工具集逐字段相同。补录状态不进图状态，子图就无从读到它。
 *
 * 因此"上一轮问了什么"放在本服务的会话级 Map 里，冷却放在自己的 PG 表里，
 * 图那一侧只拿到一个字符串：这一轮是否在回答后追加一句话。
 *
 * # 会话级 Map 的生命周期
 *
 * 它只承载"上一轮问了没有"，跨轮但不跨会话，与 ①Working 同一档（§7①）。
 * 丢失的后果只是少记一次拒答；需要跨重启保留的冷却存于 PG。
 * 上限用于防止内存无界，超出时整体丢弃（同 `sessionUsers` 的处理）。
 */

import {
  DEFAULT_ELICITATION_COOLDOWN_DAYS,
  type ElicitationCooldown,
  type ElicitationKind,
  type ElicitationSlot,
} from "@cabinhug/shared";

import {
  elicitationQuestion,
  looksLikeDecline,
  pickElicitation,
  slotsFromFreshness,
  energySlotFor,
  type FreshnessLike,
  type PretripContext,
} from "../graph/elicitation";
import { energyAskPrompt, parseEnergyLevel } from "../graph/energy";

const DAY_MS = 86_400_000;
/** 会话上限，防内存无界。超出时整体丢弃，丢失的只是"上一轮问了没有"。 */
const MAX_SESSIONS = 5_000;

/** 车主口述里抽出来的 ④ 事实。抽不到的项缺席，不给默认值。 */
export interface ElicitedFacts {
  /** 上次保养日期（epoch ms）。 */
  lastServiceAt?: number;
  /** 保养项目原话。 */
  items?: string;
  /** 当前里程（公里），按车主口径原样记，不四舍五入。 */
  odometerKm?: number;
}

export interface ElicitationDeps {
  /**
   * 从车主这一轮的原话里抽出 ④ 事实。由模型做，不写正则（§4.5）。
   *
   * 这里不走"让模型自己调工具"的 A 型：`ownership` 是 B 型子图，自己 `invokeTool`
   * 做双路检索，应答走直连 narrator，模型在这条路上拿不到 `vehicle_profile_write`。
   * 因此理解人话交给模型（本函数），决定写不写交给编排层，与该子图的 B 型形态一致。
   */
  extract(userText: string): Promise<ElicitedFacts | undefined>;
  /**
   * 复述 + 一次确认。返回车主在弹窗上是否批准。
   *
   * `summary` 就是复述本身（AC-53-5）：车主看到的那一屏写的就是要落库的那几个数。
   * 走既有权限门（B 型子图自行 `guardGate.check()` 的既有形态），不新造通路。
   */
  /**
   * @param threadKey 中断总线按 threadId 登记（见 `interrupt-bus.ts` 文件头）。
   *   传会话 id 会让弹窗送不出去，运行时只打一句「中断没有出口（本轮的流已关闭）」。
   */
  confirm(input: {
    threadKey: string;
    summary: string;
    details: string[];
  }): Promise<boolean>;
  /** 确认之后落库。分两次调用（保养一次、里程一次）由本服务决定。 */
  write(input: {
    vin: string;
    op: "maintenance" | "odometer";
    odometerKm: number;
    at?: number;
    items?: string;
  }): Promise<unknown>;
  /**
   * 档案里此刻的里程。用于把仓储层的「只前进」规则提前到复述之前。
   *
   * 该规则在下游是静默的：`advanceOdometerWithin` 在 `新值 <= 旧值` 时直接
   * `return false`，而 `vehicle_profile_write` 照样返回一份 profile，链路上没有
   * 任何一处报告"没写"。
   *
   * 因此先读一次：写不进去的项不放进复述、也不发出去，
   * 改为在同一屏上说明"这个数比档案里的小，这次不改里程"。
   *
   * 未注入时不做该判定（离线 / 单测路径）。
   */
  odometerOf?(vin: string): Promise<number | undefined>;
  /** 体检这辆车。拿不到（未接入 / 出错）时返回 undefined，此时不问。 */
  freshness(userId: string, vin?: string): Promise<FreshnessLike | undefined>;
  listCooldown(vin: string, since: number): Promise<ElicitationCooldown[]>;
  decline(input: {
    vin: string;
    ownerId: string;
    kind: ElicitationKind;
    at: number;
  }): Promise<unknown>;
  /**
   * 一次补录问答收口时记的冷却，不是拒答（见仓储层 `touch` 的说明）。
   *
   * 写入被"只前进"规则丢弃、车主没点确认弹窗、只答了两项中的一项，这三种情况下
   * 体检结果都不变；没有这条冷却，下一个合适载体轮次会再问同一句话。
   * 未注入时不记。
   */
  touchCooldown?(input: {
    vin: string;
    ownerId: string;
    kind: ElicitationKind;
    at: number;
  }): Promise<unknown>;
  /** 冷却天数。策略值，走热配置，不硬编码。 */
  cooldownDays(): number | Promise<number>;
  /**
   * 车主报了余量之后，算这一趟的缺口（F-54-05）。
   *
   * 余量只作为入参传入，不落任何库（§4.6 / AC-54-8）：它是"此刻"的值，
   * 写进 ④ 会变成一条很快过期的事实。返回的是给应答用的上下文文本。
   */
  /**
   * 组装出发前上下文。由装配层实现：它要读 ④ 的能源类型与行程计划，
   * 而本服务不连库。
   *
   * @param markAsked 传入行程 key，返回"这一趟是不是已经问过了"。
   */
  pretrip?(
    userId: string,
    userText: string,
    markAsked: (planKey: string) => boolean,
  ): Promise<PretripContext | undefined>;
  energyGap?(input: {
    userId: string;
    vin: string;
    level: { value: number; unit: "L" | "%" };
    /** 本次里程。拿不到时缺口算不出来，如实说明缺什么，不编造数值。 */
    distanceKm?: number;
  }): Promise<string | undefined>;
  /**
   * 一次补录的留痕（F-53-12 / AC-53-12）。
   *
   * 记录这一次问答的五段：问了什么 → 车主答了什么 → 复述内容 → 确认结果 →
   * 写了哪几个字段。缺任何一段，都无法解释档案为何被修改。
   *
   * 不记用户话语之外的新增 PII：`answer` 是车主原话，
   * 不额外抽取、不额外存储。未注入时静默跳过（离线/单测路径）。
   */
  audit?(entry: {
    vin: string;
    ownerId: string;
    asked: ElicitationKind;
    answer: string;
    restatement: string;
    approved: boolean;
    written: string[];
    /**
     * 车主说了、但没有落进档案的项。
     *
     * 与 `written` 分开记，留痕才能解释档案为何没有被修改。
     */
    ignored?: string[];
  }): Promise<unknown>;
  now(): number;
}

export interface NextInput {
  sessionKey: string;
  userId: string;
  vin?: string;
  /** 本轮路由到的 Agent（规范名）。 */
  agent?: string;
  /** 本轮正常回答是否产出。 */
  answered: boolean;
  /**
   * 出发前上下文。`undefined` = 这一轮不是出发前。
   *
   * 规划阶段不传：那时问到的值到出发时已过期（AC-54-1）。
   */
  pretrip?: PretripContext;
  /**
   * 本轮还剩几个问题位。`undefined` = 不限（问诊轮之外没有其他提问占位）。
   *
   * 问诊轮里问诊追问先拿位（`graph/prompt-budget.ts`），剩下的才轮到这里。
   * `<= 0` 时在一切副作用之前返回：后面会写 `asked`，没问出口却记成问过，
   * 下一轮会把车主的话当成对它的拒答去结算。
   */
  questionBudgetLeft?: number;
}

export interface ElicitationService {
  /**
   * 结算上一轮的提问。在本轮开始时调用，输入是车主这一轮说的话。
   *
   * 三种拒答里本函数认前两种（明确说不用 / "待会儿说"）与第三种的一半
   * （忽略后转移话题：上一轮问了，这一轮一个数字都没有）。
   * 答案抽取由 `tryFill` 负责；这里的拒答判定偏保守：宁可少记一次拒答，
   * 也不把一次真实回答记成拒答（那会让车主不再被问）。
   */
  /**
   * @returns 本轮要追加给应答的上下文（能源缺口测算结果），没有就 undefined。
   *   与"编排层已完成的求解结果"同一条路：求解在代码里做完，模型只表述。
   */
  settle(
    sessionKey: string,
    threadKey: string,
    userId: string,
    userText: string,
  ): Promise<string | undefined>;
  /** 本轮要不要追加一句提问；返回文案或 undefined。 */
  next(input: NextInput): Promise<string | undefined>;
  /** 测试与运维：清掉会话级记忆。 */
  reset(): void;
  /**
   * 这一轮是不是出发前，以及这一趟的能源形态（F-54-04）。
   *
   * `undefined` = 不是出发前 ⇒ 不问余量。规划阶段问到的值到出发时已过期（AC-54-1）。
   */
  pretripOf?(userId: string, userText: string): Promise<PretripContext | undefined>;
}

/**
 * ④ 的两项由同一句话问出（见 `elicitationQuestion`），因此一起收口：
 * 只给一项记冷却时，另一项照问，车主看到的仍是同一句话。
 */
const PROFILE_KINDS: readonly ElicitationKind[] = ["odometer", "last_service"];

/** 一句回答是否可能是答案：只看有没有数字，内容抽取交给 `tryFill`。 */
function looksLikeAnswer(text: string): boolean {
  return /[0-9０-９]|[一二三四五六七八九十万千百]/.test(text);
}

export function createElicitationService(deps: ElicitationDeps): ElicitationService {
  /**
   * sessionKey → 上一轮问了什么、问的是哪辆车。
   *
   * vin 必须一起记：冷却按 (vin, kind) 记，而提问时用的常是"这位车主的默认车"。
   * 结算那一轮的默认车可能已经切换，冷却会记到别的车上，
   * 表现为"说了不用还一直问"。
   */
  const asked = new Map<string, { kind: ElicitationKind; vin: string }>();
  /**
   * 问能源余量时的那一份出发前上下文。
   *
   * 单位与里程都留到结算那一轮：结算时按同一单位解析，
   * 且无需再解析车主上一轮的话。
   */
  const lastAsk = new Map<string, { energyType?: "bev" | "phev" | "icev"; distanceKm?: number }>();
  /**
   * 已经问过余量的行程。按行程而不是按会话：同一次行程只问一次（AC-54-1），
   * 而车主可能分好几次会话聊同一趟。改期/重规划会换 key，于是自动重置。
   */
  const askedTrips = new Set<string>();
  /**
   * sessionKey → 这一轮刚被回答、且补录仍在「确认 → 落库」路上的槽位。
   *
   * # 防止同轮重复提问
   *
   * `settle()` 在轮首消费掉"上一轮问了什么"，随后把确认弹窗脱手发出
   * （车主点击可能需要 10 分钟量级，见 `tryFill` 的说明）。`next()` 在同一轮末尾
   * 重新体检，此时写入尚未发生、体检结果不变，会在车主刚回答完的那一轮
   * 把同一句话再问一遍。
   *
   * 因此从"发出确认"到"这条链收口"为止，这些 kind 不进候选。
   * 与 `asked` 同一档：跨轮不跨会话，丢失的代价只是可能多问一次。
   */
  const filling = new Map<string, Set<ElicitationKind>>();

  /**
   * 一次补录问答收口：给 ④ 的两项各记一次冷却（不是拒答）。
   *
   * 三种"答了但档案没变"的情况都靠它收口，否则会反复提问：
   *  1. 报的里程不大于档案里的值 ⇒ 仓储层「只前进」丢弃，`odometerAt` 永远是 null，
   *     体检永远判 `unknown`；
   *  2. 车主没点确认弹窗（超时收敛成拒绝）；
   *  3. 只答了两项里的一项。
   */
  async function markAsked(vin: string, ownerId: string): Promise<void> {
    if (!deps.touchCooldown) return;
    for (const kind of PROFILE_KINDS) {
      try {
        await deps.touchCooldown({ vin, ownerId, kind, at: deps.now() });
      } catch (err) {
        // 记不上只是下次可能再问一遍，不该让这条脱手的链炸掉（fail-open）。
        console.error(
          `[elicitation] 冷却登记失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const cooldownSet = async (vin: string | undefined): Promise<Set<ElicitationKind>> => {
    if (!vin) return new Set();
    const days = (await deps.cooldownDays()) || DEFAULT_ELICITATION_COOLDOWN_DAYS;
    const rows = await deps.listCooldown(vin, deps.now() - days * DAY_MS);
    return new Set(rows.map((r) => r.kind));
  };

  /**
   * 试着把车主这一轮的话变成一次补录。返回 true 表示"这是一次回答"（不论最终写没写）。
   *
   * 未确认前一个字段都不写（AC-53-5）。车主在弹窗上否掉时同样返回 true：
   * 那是一次回答，只是不认那几个数，不是拒答，不进拒答冷却。
   */
  async function tryFill(
    sessionKey: string,
    threadKey: string,
    vin: string,
    ownerId: string,
    asked: ElicitationKind,
    userText: string,
  ): Promise<boolean> {
    let facts: ElicitedFacts | undefined;
    try {
      facts = await deps.extract(userText);
    } catch (err) {
      console.error(
        `[elicitation] 抽取失败，本次不落库：${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
    const stated = facts?.odometerKm;
    const at = facts?.lastServiceAt;
    if (stated === undefined && at === undefined) return false;

    /*
     * 「里程只前进」规则在仓储层（`advanceOdometerWithin`），且在下游是静默的：
     * 值不大于档案里的就不 update，写工具照样返回一份 profile。
     *
     * 判定提前到这里，保证不写的项不出现在复述里（AC-53-5：车主看到的那一屏
     * 写的就是要落库的那几个数），留痕也据实。
     */
    let km = stated;
    let ignoredOdometer: number | undefined;
    if (stated !== undefined && deps.odometerOf) {
      try {
        const current = await deps.odometerOf(vin);
        if (current !== undefined && stated <= current) {
          ignoredOdometer = current;
          km = undefined;
        }
      } catch (err) {
        // 读不到时原样提交：接受一次可能的静默丢弃，不因此放弃整条补录。
        console.error(
          `[elicitation] 读当前里程失败，按原样提交：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 没有可写的项时不弹窗。它仍是一次回答：返回 true，
    // 由调用方按"答过了"收口（记冷却、不记拒答）。
    if (at === undefined && km === undefined) {
      const why = `里程 ${stated} 公里比档案里已经记着的 ${ignoredOdometer} 公里小，没有采纳`;
      await deps
        .audit?.({
          vin,
          ownerId,
          asked,
          answer: userText,
          restatement: why,
          approved: false,
          written: [],
          ignored: ["odometerKm"],
        })
        .catch(() => undefined);
      await markAsked(vin, ownerId);
      return true;
    }

    // 复述：车主要能一眼看出哪个数记错了，所以日期与里程都回显。
    const parts: string[] = [];
    if (at !== undefined) {
      parts.push(`${new Date(at).toLocaleDateString("zh-CN")} 做过保养${facts?.items ? `（${facts.items}）` : ""}`);
    }
    if (km !== undefined) parts.push(`当前里程 ${km} 公里`);
    // 没采纳的那一项也写在同一屏上：点"同意"之后什么变、什么不变，
    // 车主在点之前就能看到。
    const notes =
      ignoredOdometer === undefined
        ? []
        : [`您说的 ${stated} 公里比档案里记着的 ${ignoredOdometer} 公里小，这次不改里程`];
    const summary = `把下面这些记进车辆档案：${[...parts, ...notes].join("；")}`;

    /*
     * 确认与落库不 await，但 `confirm` 本身在这里同步发起：
     *  - 弹窗事件的发出是同步的（`check()` 一进去就 `onInterrupt`），
     *    必须发生在这一轮的流仍开着时，否则运行时打出
     *    「中断没有出口（本轮的流已关闭）——用户不会看到确认弹窗」；
     *  - 等用户点击是异步的，权限门的确认超时是 10 分钟。
     *    补录是顺带动作，不能让它阻塞这一轮的回答。
     *
     * 调用方 await 到这里（抽取完成、弹窗已发出）即返回，
     * 批准之后的落库由这条脱手的链自己完成。
     */
    // 从"确认已发出"到"这条链收口"为止，④ 的两项不进候选，
    // 否则本轮末尾的 `next()` 会拿未变的体检结果把同一句话再问一遍。
    filling.set(sessionKey, new Set(PROFILE_KINDS));
    if (filling.size > MAX_SESSIONS) filling.clear();

    void deps
      .confirm({ threadKey, summary, details: [...parts, ...notes] })
      .then(async (approved) => {
        const written: string[] = [];
        // 留痕在最后统一记一次：批没批、写了哪几个字段，记在同一条里。
        const trail = async () =>
          deps.audit?.({
            vin,
            ownerId,
            asked,
            answer: userText,
            restatement: summary,
            approved,
            written,
            ...(ignoredOdometer === undefined ? {} : { ignored: ["odometerKm"] }),
          });
        if (!approved) {
          // 没批也留痕："看到复述并否决"与"没有弹过窗"需要区分。
          await trail();
          return; // 是回答，只是没批：不写、也不记拒答
        }
        /*
         * 保养与里程分两次写：`appendMaintenance` 会顺带推进里程，
         * 但车主可能只说了里程。只写能写的那一项，
         * 答一半是常态，不追问另一半（AC-53-8）。
         *
         * 里程必须先写。`appendMaintenance` 顺带推进里程时不带来源；
         * 先写保养的话，轮到 `op: "odometer"` 时里程已等于目标值，
         * `advanceOdometerWithin` 判"没前进"直接跳过，`odometer_source` 会一直是 null。
         */
        if (km !== undefined) {
          await deps.write({ vin, op: "odometer", odometerKm: km });
          written.push("odometerKm");
        }
        if (at !== undefined) {
          await deps.write({
            vin,
            op: "maintenance",
            at,
            // 里程取车主说的那个数，即使它没被采纳为"当前里程"：
            // 这条记录的来源本就是 `owner-stated`，写 0 会变成"0 公里时保养过"。
            odometerKm: km ?? stated ?? 0,
            items: facts?.items?.trim() || "车主自述的一次保养",
          });
          written.push("maintenance");
        }
        await trail();
      })
      .catch((err: unknown) => {
        console.error(
          `[elicitation] 确认或落库失败：${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(async () => {
        // 冷却先落、再放行；顺序反过来时，两者之间的一轮会再问同一句话。
        await markAsked(vin, ownerId);
        filling.delete(sessionKey);
      });
    return true;
  }

  return {
    async settle(sessionKey, threadKey, userId, userText) {
      const last = asked.get(sessionKey);
      if (!last) return undefined;
      asked.delete(sessionKey);

      /*
       * 能源余量单独一条路：它不落库，所以不走 tryFill 的复述 + 确认。
       *
       * 没有副作用就不弹确认窗：车主说"还有 45 升"，只用于算一次缺口，
       * 随会话过期消失（§4.6：瞬时事实不进档案）。
       */
      if (last.kind === "energy_level") {
        const prev = lastAsk.get(sessionKey);
        const ask = energyAskPrompt(prev?.energyType);
        const level = ask ? parseEnergyLevel(userText, ask.unit) : undefined;
        if (level && !looksLikeDecline(userText)) {
          lastAsk.delete(sessionKey);
          try {
            return await deps.energyGap?.({
              userId,
              vin: last.vin,
              level,
              distanceKm: prev?.distanceKm,
            });
          } catch (err) {
            // 算不出来就不算，不编造数值。这一轮照常回答（fail-open）。
            console.error(
              `[elicitation] 缺口测算失败：${err instanceof Error ? err.message : String(err)}`,
            );
            return undefined;
          }
        }
        lastAsk.delete(sessionKey);
        // 没报出余量 ⇒ 当成拒答走下面的冷却，回答侧按"不答"降级（AC-54-7）。
      }
      /*
       * 明确拒绝优先，即使句子里有数字（"先不用了，我 5 分钟后到"）。
       */
      if (!looksLikeDecline(userText)) {
        // 不像拒绝，就先试着当成回答来抽。抽到了 ⇒ 复述 → 一次确认 → 落库。
        if (await tryFill(sessionKey, threadKey, last.vin, userId, last.kind, userText)) return;
        // 抽不到、但看起来像在说数字（可能在聊别的）⇒ 不记拒答也不写，安全地什么都不做。
        if (looksLikeAnswer(userText)) return;
      }
      try {
        await deps.decline({ vin: last.vin, ownerId: userId, kind: last.kind, at: deps.now() });
      } catch (err) {
        // 记不上冷却只是下次可能再问一遍，不该让这一轮问答失败（fail-open）。
        console.error(
          `[elicitation] 拒答留痕失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    async next({ sessionKey, userId, vin, agent, answered, pretrip, questionBudgetLeft }) {
      // 本轮的问题位已经用完：不查库、不记 asked，视为这一轮没有合适载体。
      if (questionBudgetLeft !== undefined && questionBudgetLeft <= 0) return undefined;
      // 先看载体与回答状态，不满足就不查库：这一步每轮都跑，
      // 而绝大多数轮次都不是合适载体。
      // 明说要出发的那一轮不看路由（见 pickElicitation 的 `departing`）。
      const departing = pretrip !== undefined;
      if (!answered || (!agent && !departing)) return undefined;
      const picked = await resolve();
      if (!picked) return undefined;
      asked.set(sessionKey, { kind: picked.slot.kind, vin: picked.vin });
      if (asked.size > MAX_SESSIONS) asked.clear();
      /*
       * 能源余量的问句按能源类型分支（F-54-03）：燃油问升、纯电问百分比。
       * 走 `energyAskPrompt` 而不是 `elicitationQuestion` 的兜底文案，
       * 避免问错单位（对燃油车问"还剩百分之多少"）。
       */
      if (picked.slot.kind === "energy_level") {
        const ask = energyAskPrompt(pretrip?.energyType);
        if (ask) {
          // 记下问的是哪种单位：结算时按同一种解析。
          lastAsk.set(sessionKey, {
            energyType: pretrip?.energyType,
            distanceKm: pretrip?.distanceKm,
          });
          return ask.ask;
        }
      }
      return elicitationQuestion(picked.slot.kind);

      async function resolve(): Promise<{ slot: ElicitationSlot; vin: string } | undefined> {
        // 先用一次不查库的预筛：载体不对就直接 undefined。
        if (!pickElicitation({ slots: [PROBE], agent, answered, cooldown: new Set(), departing })) {
          return undefined;
        }
        let report: FreshnessLike | undefined;
        try {
          report = await deps.freshness(userId, vin);
        } catch (err) {
          // 体检失败就不问；不问是安全的缺省。
          console.error(
            `[elicitation] 体检失败，本轮不问：${err instanceof Error ? err.message : String(err)}`,
          );
          return undefined;
        }
        /*
         * 体检报的是哪辆车，冷却就按哪辆车记。
         *
         * 提问时传的 vin 常是 undefined（"这位车主的默认车"），结算那一轮的默认车
         * 可能已经切换，冷却会记到另一辆车上。因此把体检回来的 vin 带到 asked 里。
         * 报不出 vin（未建档）就不问。
         */
        const askedVin = report?.vin ?? undefined;
        if (!askedVin) return undefined;
        /*
         * ④ 的缺口与出发前的能源槽位进同一个 `pickElicitation`（AC-54-10），
         * 它至多返回一个。`energy_level` 是 `perishable`，出发前优先于 ④ 的两项：
         * 出发之后再问出发时的余量没有意义。
         */
        const energySlot = energySlotFor(pretrip);
        const slots = [
          ...slotsFromFreshness(report),
          ...(energySlot ? [energySlot] : []),
        ];
        if (slots.length === 0) return undefined;
        // 冷却 = 库里仍在冷却期的项 ∪ 本会话里补录仍在途的项。
        // 后者只存于内存（跨轮不跨会话），防止同一轮里再问一遍。
        const cooldown = await cooldownSet(askedVin);
        for (const kind of filling.get(sessionKey) ?? []) cooldown.add(kind);
        const slot = pickElicitation({
          slots,
          agent,
          answered,
          cooldown,
          departing,
        });
        return slot ? { slot, vin: askedVin } : undefined;
      }
    },

    reset() {
      asked.clear();
      lastAsk.clear();
      askedTrips.clear();
      filling.clear();
    },

    async pretripOf(userId, userText) {
      if (!deps.pretrip) return undefined;
      return deps.pretrip(userId, userText, (planKey) => {
        // 同一次行程只问一次（AC-54-1）。改期/重规划换 planKey ⇒ 自动重置。
        if (askedTrips.has(planKey)) return true;
        askedTrips.add(planKey);
        if (askedTrips.size > MAX_SESSIONS) askedTrips.clear();
        return false;
      });
    },
  };
}

/**
 * 预筛用的哑槽位：只为了让 `pickElicitation` 判一次"这一轮是不是合适载体"，
 * 避免在明显不该问的轮次上查库。它不会被返回给调用方。
 */
const PROBE: ElicitationSlot = {
  kind: "odometer",
  reason: "",
  weight: 0,
  timeliness: "deferrable",
  state: "pending",
};
