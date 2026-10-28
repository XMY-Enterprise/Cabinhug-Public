/**
 * 上下文的渲染与按 Agent 投影（ACR-036 §4.9）。
 *
 * # 两个区，按变化频率分，不按重要性分
 *
 * 前缀缓存只认「从第 0 个 token 起完全相同」的前缀（DeepSeek 自动缓存、64 token 一块）。
 * 所以布局的判据是内容是否变化：
 *
 * - Z1 锚定块：一个线程内钉死的长期事实。进直连的 `system` 之后、pi 的首条 prompt。
 *   它必须确定性渲染：同一份 `UserContext` 两次渲染逐字相同，否则每轮换一次前缀，
 *   不报错，只表现为成本上升与首字变慢。
 * - Z3 本轮尾区：每轮重建的内容（今天几号、里程多久没更新、手上那件事办到哪了）。
 *   只放在最后一条 user 消息里，放到历史前面会让整段历史的缓存每轮作废。
 *
 * # 按 Agent 投影而不是过滤
 *
 * 每个 Agent 拿到的是按它那一行拼出来的独立块，表外的段不存在，
 * 与工具 ACL（`listForAgent`）和 lane 白名单（`LANE_CHANNELS`）同一取向。
 */

import {
  CONTEXT_BLOCK_HEADER,
  isContextUnavailable,
  type ContextMaybe,
  type ContextSection,
  type UserContext,
} from "@cabinhug/shared";

/** 规范 Agent 名（`canonicalAgent` 剥掉 `-task` / `-intent` / `-voice` 之后的那个）。 */
export type ContextAgent =
  | "supervisor-intent"
  | "supervisor"
  | "trip"
  | "itinerary"
  | "drive"
  | "hotel"
  | "tour"
  | "transit"
  | "ownership"
  | "service"
  | "buying"
  | "test-drive"
  | "cabin";

/** 本轮尾区能放的项。哪个 Agent 放哪几项见 `CONTEXT_ACL`。 */
export type TurnItem =
  /** 今天几号 + 接下来的节假日。内容同 `acp-client/connection.ts` 的 `withDateline`。 */
  | "dateline"
  /** 里程是多久以前的（相对表述，所以只能在这里，不能进 Z1）。 */
  | "odometer-freshness"
  /** 手上那件事办到哪一步了（一行，不含正文）。 */
  | "task-status"
  /** 正在办的那件事的正文（只给路由到的那个 Agent）。 */
  | "task-draft"
  /** 上一轮问过的那个问题与候选。 */
  | "task-pending";

/**
 * 投影表。新增业务 Agent 时要在这里加一行（接线点之一），漏了则该 Agent
 * 只拿到最小集（见 `FALLBACK`），不报错。
 *
 * `anchor` 是进 Z1 的段，`turn` 是进 Z3 的项。事实放错列的后果：
 * 该进 turn 的进了 anchor，一个线程内无法更新；该进 anchor 的进了 turn，每轮重复占用尾区。
 */
export const CONTEXT_ACL: Record<ContextAgent, { anchor: readonly ContextSection[]; turn: readonly TurnItem[] }> = {
  // 意图理解：要知道他名下有什么（好判 adjust 还是新规划），不要行程正文（probe 不抄内容，ADR-010 的代价条款）。
  "supervisor-intent": {
    anchor: ["identity", "trips", "reminders"],
    turn: ["dateline", "task-status", "task-pending"],
  },
  // 通用应答：只给身份与车，别的与它无关。
  supervisor: { anchor: ["identity", "vehicle"], turn: ["dateline"] },
  trip: {
    anchor: ["identity", "vehicle", "home", "companions", "trips", "preferences"],
    turn: ["dateline", "task-status", "task-draft"],
  },
  // itinerary 与 trip 同一份：应答会话本来就复用 trip（见 `answerNode` 的 ANSWER_AGENTS）。
  itinerary: {
    anchor: ["identity", "vehicle", "home", "companions", "trips", "preferences"],
    turn: ["dateline", "task-status", "task-draft"],
  },
  // 四条 -task 分支：只要算得上的事实，不要身份与偏好（它们的输出被代码解析）。
  drive: { anchor: ["vehicle", "home", "companions"], turn: ["dateline"] },
  hotel: { anchor: ["home", "companions"], turn: ["dateline"] },
  tour: { anchor: ["home", "companions"], turn: ["dateline"] },
  transit: { anchor: ["home"], turn: ["dateline"] },
  ownership: {
    anchor: ["identity", "vehicle", "reminders", "usage"],
    turn: ["dateline", "odometer-freshness", "task-status"],
  },
  service: { anchor: ["identity", "vehicle", "reminders"], turn: ["dateline", "odometer-freshness", "task-status"] },
  buying: { anchor: ["identity", "preferences"], turn: ["dateline", "task-status"] },
  "test-drive": { anchor: ["identity"], turn: ["dateline", "task-status"] },
  cabin: { anchor: ["companions"], turn: ["dateline"] },
};

/** 表外的 Agent 名（新加的、或拼错的）一律给最小集，不给空——空块会让模型以为"这个人没有车"。 */
const FALLBACK: { anchor: readonly ContextSection[]; turn: readonly TurnItem[] } = {
  anchor: ["identity"],
  turn: ["dateline"],
};

export function aclFor(agent: string): { anchor: readonly ContextSection[]; turn: readonly TurnItem[] } {
  return CONTEXT_ACL[agent as ContextAgent] ?? FALLBACK;
}

/**
 * 预算。用字符数近似 token（中文约 1.5 字符 / token），不引分词依赖：
 * 目的是限制长度，不是精确计费。
 */
export const ANCHOR_BUDGET_CHARS = 450;
export const TURN_BUDGET_CHARS = 450;

/**
 * 超预算时的丢弃顺序：排在前面的先丢。
 * trips 排最后：名下有哪几程决定了意图层（尤其在换会话后）判 adjust 还是新规划。
 * preferences 排最前：丢了它只损失一点个性化。
 */
const DROP_ORDER: readonly ContextSection[] = [
  "preferences",
  "usage",
  "reminders",
  "home",
  "companions",
  "vehicle",
  "identity",
  "trips",
];

function fmtDate(ms: number): string {
  return new Date(ms + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** 一段读不到时的写法。如实说明，不留空：空会被当成"没有"。 */
function unavailableLine(title: string, reason: string): string {
  return `${title}：这次读不到（${reason}）。不代表没有，不要说"你没有"。`;
}

/**
 * 渲染一段。返回 `undefined` 表示这一段没有内容（这个人确实没有），整段不出现。
 *
 * 每一行都必须是确定性的：不含当前时间、不含相对时间、不含检索分数、
 * 数组顺序由调用方保证稳定（`assemble` 那边已排序）。
 */
function renderSection(section: ContextSection, ctx: UserContext): string | undefined {
  const v = ctx[section] as ContextMaybe<unknown> | undefined;
  if (v === undefined) return undefined;

  switch (section) {
    case "identity": {
      if (isContextUnavailable(v)) return unavailableLine("身份", v.reason);
      const x = v as import("@cabinhug/shared").ContextIdentity;
      const who = x.displayName ? `${x.displayName}（${x.role}）` : x.role;
      return `车主：${who}`;
    }
    case "vehicle": {
      if (isContextUnavailable(v)) return unavailableLine("车辆档案", v.reason);
      const x = v as import("@cabinhug/shared").ContextVehicle;
      const parts: string[] = [];
      if (x.model) parts.push(x.modelYear ? `${x.model}（${x.modelYear} 款）` : x.model);
      if (x.energyType) parts.push(`能源类型 ${x.energyType}`);
      if (typeof x.odometerKm === "number") parts.push(`里程 ${Math.round(x.odometerKm)} km`);
      if (typeof x.maintenanceIntervalKm === "number") parts.push(`保养周期 ${x.maintenanceIntervalKm} km`);
      return parts.length ? `车辆：${parts.join("，")}` : undefined;
    }
    case "home": {
      if (isContextUnavailable(v)) return unavailableLine("常住地", v.reason);
      const x = v as import("@cabinhug/shared").ContextHome;
      return `常住地：${x.city}`;
    }
    case "companions": {
      if (isContextUnavailable(v)) return unavailableLine("同行人", v.reason);
      const xs = v as readonly import("@cabinhug/shared").ContextCompanion[];
      if (xs.length === 0) return undefined;
      const lines = xs.map((c) => {
        const tail = [c.relation, c.ageBand, ...c.needs].filter(Boolean).join("/");
        return tail ? `${c.label}（${tail}）` : c.label;
      });
      return `常一起坐车的：${lines.join("、")}`;
    }
    case "trips": {
      if (isContextUnavailable(v)) return unavailableLine("已确认的行程", v.reason);
      const xs = v as readonly import("@cabinhug/shared").ContextTripPointer[];
      if (xs.length === 0) return "已确认的行程：一份都没有。";
      const lines = xs.map((t) => {
        const bits = [t.ref, t.destination, `${t.days} 天`];
        if (t.startDate) bits.push(t.startDate);
        if (t.navDay !== undefined) bits.push(`正在走第 ${t.navDay} 天`);
        if (t.reviewSeverity === "critical") bits.push("有要紧的核查提醒");
        return bits.join(" ");
      });
      return `已确认的行程 ${xs.length} 份（要正文就调 trip_plan_get）：\n${lines.map((l) => `- ${l}`).join("\n")}`;
    }
    case "reminders": {
      if (isContextUnavailable(v)) return unavailableLine("车辆提醒", v.reason);
      const xs = v as readonly import("@cabinhug/shared").ContextReminder[];
      if (xs.length === 0) return undefined;
      const lines = xs.map((r) => {
        const bits = [r.kind];
        if (r.dueAt !== undefined) bits.push(`约 ${fmtDate(r.dueAt)} 到期`);
        if (typeof r.remainingKm === "number") bits.push(`还剩 ${r.remainingKm} km`);
        if (r.degraded) bits.push("（数据不足，走的通用周期）");
        return bits.join(" ");
      });
      return `待办提醒：${lines.join("；")}`;
    }
    case "preferences": {
      if (isContextUnavailable(v)) return unavailableLine("偏好", v.reason);
      const xs = v as readonly string[];
      if (xs.length === 0) return undefined;
      return `他的偏好（他自己说过的，不是记录）：${xs.join("；")}`;
    }
    case "usage": {
      if (isContextUnavailable(v)) return unavailableLine("用车画像", v.reason);
      const x = v as import("@cabinhug/shared").ContextUsage;
      return x.usable ? `用车画像：${x.summary}` : `用车画像：${x.summary}（可能已过时）`;
    }
  }
}

/**
 * 渲染锚定块（Z1）。它在一个线程内钉死，因此不能含任何随时间变化的内容。
 *
 * 超预算时按 `DROP_ORDER` 从前往后丢，并在末尾写明丢了什么：
 * 静默截断会让模型以为相应的段确实没有内容。
 */
export function renderAnchor(ctx: UserContext, sections: readonly ContextSection[]): string {
  const kept = DROP_ORDER.filter((s) => sections.includes(s));
  const dropped: ContextSection[] = [];

  const build = (use: readonly ContextSection[]): string => {
    // 输出顺序固定按 `CONTEXT_SECTIONS` 的声明序，与丢弃顺序无关：
    // 留下的段不因丢弃而换位置（换位置 = 换前缀 = 缓存失效）。
    const order: readonly ContextSection[] = [
      "identity",
      "vehicle",
      "home",
      "companions",
      "trips",
      "reminders",
      "usage",
      "preferences",
    ];
    const lines = order
      .filter((s) => use.includes(s))
      .map((s) => renderSection(s, ctx))
      .filter((l): l is string => l !== undefined);
    return lines.join("\n");
  };

  let use = [...kept];
  let body = build(use);
  // 从最先该丢的那一段开始扔，直到进预算。
  for (const s of DROP_ORDER) {
    if (body.length <= ANCHOR_BUDGET_CHARS) break;
    if (!use.includes(s)) continue;
    use = use.filter((x) => x !== s);
    dropped.push(s);
    body = build(use);
  }

  const head = `${CONTEXT_BLOCK_HEADER}\n【车主档案】`;
  const tail = dropped.length ? `\n（${dropped.join("、")}这几项因为太长没放进来，需要时问我）` : "";
  return body ? `${head}\n${body}${tail}` : `${head}\n（这个人的档案还是空的）`;
}

/** 本轮尾区的一项：标题 + 正文。正文为空的项不出现。 */
export interface TurnFact {
  item: TurnItem;
  text: string;
}

/**
 * 渲染本轮尾区（Z3）。调用方按 `aclFor(agent).turn` 决定给哪几项。
 *
 * 与锚定块相反，这里放随时间变化的内容：它每轮重建，
 * 位置在最后一条 user 消息里，变化不影响前面任何一个 token。
 */
export function renderTurn(facts: readonly TurnFact[], allowed: readonly TurnItem[]): string | undefined {
  const lines = facts
    .filter((f) => allowed.includes(f.item))
    .map((f) => f.text.trim())
    .filter((t) => t.length > 0);
  if (lines.length === 0) return undefined;

  let body = lines.join("\n");
  if (body.length > TURN_BUDGET_CHARS) {
    // 尾区超预算时从后往前丢：靠前的是日期与任务状态（判断要用），
    // 靠后的是草案正文（丢了只少一些细节，且可以用工具取回）。
    const kept: string[] = [];
    let used = 0;
    for (const l of lines) {
      if (used + l.length > TURN_BUDGET_CHARS && kept.length > 0) break;
      kept.push(l);
      used += l.length + 1;
    }
    body = `${kept.join("\n")}\n（本轮状态太长，后面几项略去）`;
  }
  return `${CONTEXT_BLOCK_HEADER}\n${body}`;
}
