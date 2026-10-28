/**
 * 结构化汇聚：约束求解，不是文本拼接（FL-13 F-13-02）。
 *
 * 把分支文字交给 LLM 总结会稀释硬约束（"老人单段不超过 2 小时"变成"建议适当休息"），
 * 且方案读起来仍然正常（US-11 / F-18-07）。因此：
 *  1. 子 Agent 的返回必须含结构化字段（分段列表、续航余量数值），不能只有自然语言；
 *  2. 约束求解在代码里做，LLM 只负责把求解结果表述出来。
 *
 * 求解结果里带 `violations`：汇聚不隐藏矛盾（F-13-05）。解不开就显式呈现权衡，
 * 而不是挑一个看起来顺眼的方案交付。
 *
 * # 段是自描述的对象，不是平行数组（ACR-047）
 *
 * drive 交的是 `DriveLeg[]`，与契约层 `TripPlanLeg` 同形；`buildLegs` 只是透传加坐标语义，
 * `solve` 拆段也在对象上做。没有跨数组的个数不变量，也就没有"对不齐就整条丢弃"这一档。
 */

import { assertDriveLegs, type DriveLeg, type DriveLegStop } from "@cabinhug/tools";

/**
 * `solve` 拆段时补出来的停靠点占位，表示"这里需要停一次，但还没有具体名称"。
 *
 * 导出是为了让下游（`describeMerged`）能把它和真名字区分开，
 * 表述成"这一处还没有具体名称"，而不是把占位串当地名念出来。
 */
export const PENDING_STOP = "待定停靠点";

/** 出行方案的结构化骨架。字段刻意少而硬，避免 Agent 把自然语言塞进来。 */
export interface TripDraft {
  /**
   * 出发地。不参与求解，只是 drive 分支交回内容的完整形状的一部分。
   */
  origin?: string;
  /**
   * 全程按行车顺序的每一段（去程、换片区、回程都在这一个列表里），是硬约束求解的对象。
   * 空数组 = 分支算不出（正文与 findings 会说明）。
   */
  legs: DriveLeg[];
  /** 续航评估给出的余量百分比；缺失表示该分支未成功。 */
  rangeMarginPct?: number;
  /**
   * 补能点（充电或加油），与段列表分开：补能点是"路过哪儿能补能"，段是"开多久该歇一次"。
   * 段的终点名在这里出现时该段 `reason` 记 `charge`。
   */
  energyStops?: string[];
  /**
   * 分支用工具查到的、车主问到但上面几个字段装不下的事实。
   *
   * 汇聚只读硬字段、丢弃分支散文，这一栏保留分支查到的其余事实
   * （例如"找一天不下雨的回程"查到的天气），应答节点不必再重复调用工具。
   *
   * 提示词对它的硬要求：只写用工具查到的，没查过就不写。
   */
  findings?: string[];
}

/** 从意图四要素里解析出的可求解硬约束。 */
export interface SolvableConstraints {
  /** 单段行车时长上限（分钟）。同行老人/儿童时存在。 */
  maxLegMinutes?: number;
  /** 续航余量下限（百分比）。 */
  minRangeMarginPct?: number;
}

export interface MergeResult {
  draft: TripDraft;
  /** 未被满足的约束，显式呈现，不隐藏（F-13-05）。 */
  violations: string[];
  /** 因分支失败而缺失的信息，需在交付时标注（F-13-04）。 */
  missing: string[];
  /** 是否所有硬约束都满足。 */
  satisfied: boolean;
}

/**
 * 求解结果里"缺失信息"一节的固定标头。
 *
 * trip 与 itinerary 的 describe* 都用它开头；`failure-followup` 按它判断
 * "本轮有没有缺失"来决定要不要追加主动询问。三处都经本常量引用，
 * 字面量不一致会让失败轮不再追问且不报错。
 */
export const MISSING_SECTION_HEADER = "缺失的信息（必须标注，不要假装有）：";

/*
 * 数值约束由意图理解直接给（`Intent.tripLimits`），段列表由 `submit_drive_plan` 直接交（ACR-047），
 * 本模块不用正则从文本里重新解析模型已经读懂的内容。事实在谁手里，就向谁要。
 */

/**
 * 按单段上限拆分段列表（去程与回程在同一个列表里，一条规则）。
 *
 * 一段超限就均分成 `ceil(minutes / limit)` 个子段：每个子段都不超限、总时长不变；
 * 子段继承原段的 `day` / `direction`，拆分只改分段粒度，不改日程；
 * 中间补出来的终点是 `PENDING_STOP` 占位，下一子段的起点也是它，名字待路线数据填充；
 * 最后一个子段的终点仍是原段的终点。占位就是子段自己的终点，没有对齐问题。
 */
function splitByLimit(legs: readonly DriveLeg[], limit: number): DriveLeg[] {
  const out: DriveLeg[] = [];
  for (const leg of legs) {
    const parts = leg.minutes <= limit ? 1 : Math.ceil(leg.minutes / limit);
    if (parts === 1) {
      out.push({ ...leg, to: { ...leg.to } });
      continue;
    }
    const each = leg.minutes / parts;
    for (let i = 0; i < parts; i += 1) {
      const last = i === parts - 1;
      const pending: DriveLegStop = { kind: "rest", name: PENDING_STOP };
      out.push({
        day: leg.day,
        direction: leg.direction,
        from: i === 0 ? leg.from : PENDING_STOP,
        to: last ? { ...leg.to } : pending,
        minutes: each,
      });
    }
  }
  return out;
}

export function solve(draft: TripDraft, c: SolvableConstraints): MergeResult {
  const violations: string[] = [];
  let legs = draft.legs.map((l) => ({ ...l, to: { ...l.to } }));

  if (c.maxLegMinutes !== undefined && c.maxLegMinutes > 0) {
    legs = splitByLimit(legs, c.maxLegMinutes);
  }

  if (c.minRangeMarginPct !== undefined) {
    if (draft.rangeMarginPct === undefined) {
      violations.push(`续航余量未知，无法确认是否满足 ≥${c.minRangeMarginPct}% 的要求`);
    } else if (draft.rangeMarginPct < c.minRangeMarginPct) {
      violations.push(
        `续航余量 ${draft.rangeMarginPct}% 低于要求的 ${c.minRangeMarginPct}%——需增加充电停靠或改路线`,
      );
    }
  }

  return {
    draft: {
      ...(draft.origin ? { origin: draft.origin } : {}),
      legs,
      rangeMarginPct: draft.rangeMarginPct,
      energyStops: draft.energyStops,
      // 逐字段重建而不是展开 draft：TripDraft 加字段时要同步这里，
      // 否则该字段在 `solve` 之后丢失。
      findings: draft.findings,
    },
    violations,
    missing: [],
    satisfied: violations.length === 0,
  };
}

/**
 * 正文里的段列表，只给没有提交通道的路径（`CABINHUG_LLM=fake` 的确定性桩、图外直调、单测）。
 *
 * 不在散文里抠 JSON 片段猜形状（ACR-047）。这里只认整段正文就是一个 JSON 对象、
 * 形状是 `submit_drive_plan` 的 `legs[]`、且过同一个 `assertDriveLegs`；三条有一条不满足就是
 * "没交"，不猜。ACP 路径上 drive 有提交通道，走不到这里（§4.5「正则降级为兜底」的适用范围）。
 */
export function parseDriveText(text: string): Partial<TripDraft> | undefined {
  const t = text.trim();
  if (!t.startsWith("{")) return undefined;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(t) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!o || typeof o !== "object") return undefined;
  const out: Partial<TripDraft> = {};
  if (typeof o.origin === "string" && o.origin.trim()) out.origin = o.origin.trim();
  if (Array.isArray(o.legs)) {
    const legs = o.legs as DriveLeg[];
    if (legs.length > 0 && assertDriveLegs(legs).length > 0) return undefined;
    out.legs = legs;
  }
  if (Array.isArray(o.energyStops)) out.energyStops = (o.energyStops as unknown[]).filter((x): x is string => typeof x === "string");
  if (Array.isArray(o.findings)) {
    out.findings = (o.findings as unknown[]).filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  }
  if (typeof o.rangeMarginPct === "number") out.rangeMarginPct = o.rangeMarginPct;
  return Object.keys(out).length ? out : undefined;
}

/** 分支结果里与汇聚有关的那几项：结论先从提交槽读；没有通道时正文只认 `legs[]` 形状（见 `parseDriveText`）。 */
export interface MergeableBranch {
  agent: string;
  status: string;
  text: string;
  submission?: unknown;
}

/** 把分支结果合成一份方案。失败分支体现在 `missing`，不静默吞掉。 */
export function mergeBranches(
  branches: readonly MergeableBranch[],
  /** 数量上限（ADR-012）：由意图理解直接给，不再从约束文本里解析。缺省 = 没有上限。 */
  limits: SolvableConstraints = {},
): MergeResult {
  const draft: TripDraft = { legs: [] };
  const missing: string[] = [];

  for (const b of branches) {
    if (b.status !== "ok") {
      missing.push(`${b.agent} 分支${b.status === "timeout" ? "超时" : "失败"}`);
      continue;
    }
    const s = ((b.submission as Partial<TripDraft> | undefined) ?? parseDriveText(b.text)) as
      | (Partial<TripDraft> & { findings?: string[] })
      | undefined;
    if (s?.legs?.length) draft.legs = s.legs;
    if (s?.energyStops) draft.energyStops = s.energyStops;
    if (s?.rangeMarginPct !== undefined) draft.rangeMarginPct = s.rangeMarginPct;
    // findings 追加不覆盖：两条分支查的是不同的东西（行程侧查天气/路线，
    // 补能侧查加油站），覆盖会丢掉其中一边。
    if (s?.findings?.length) draft.findings = [...(draft.findings ?? []), ...s.findings];
    // 下面这条判定刻意不算 findings：只交出 findings、没给分段的分支仍算没完成主任务。
    if (!s?.legs?.length && !s?.energyStops && s?.rangeMarginPct === undefined) {
      missing.push(`${b.agent} 分支未返回结构化字段`);
    }
  }

  const result = solve(draft, limits);
  return { ...result, missing, satisfied: result.satisfied && missing.length === 0 };
}

// ── 行车分段进快照（F-62-01）────────────────────────────────

/**
 * 把 `solve()` 的段列表对齐成快照里的 `legs[]`。
 *
 * 段本身是自描述的（ACR-047），这里只做三件事：
 * - `reason`：终点是补能站（`to.kind === "charge"`，或名字在 `energyStops` 里）→ `charge`；
 *   是服务区（`rest`）→ `rest`；过夜 / 景点 / 回到出发地这些终点不是"停靠"，不写 reason。
 * - `pending`：终点是 `PENDING_STOP` 占位。
 * - `day` / `direction` / `fromStop` / `toStop` / `driveMinutes` 原样带过去（分钟取整）。
 */
export function buildLegs(draft: Pick<TripDraft, "legs" | "energyStops">): TripPlanLegOut[] | undefined {
  if (draft.legs.length === 0) return undefined;
  const energy = new Set(draft.energyStops ?? []);
  return draft.legs.map((l) => {
    const leg: TripPlanLegOut = { driveMinutes: Math.round(l.minutes), direction: l.direction, day: l.day };
    if (l.from) leg.fromStop = l.from;
    if (l.to?.name) {
      leg.toStop = l.to.name;
      if (l.to.kind === "charge" || energy.has(l.to.name)) leg.reason = "charge";
      else if (l.to.kind === "rest") leg.reason = "rest";
      if (l.to.name === PENDING_STOP) leg.pending = true;
    }
    return leg;
  });
}

/** 与 `@cabinhug/shared` 的 `TripPlanLeg` 同形；这里不 import 契约类型，避免 merge.ts 反向依赖快照层。 */
export interface TripPlanLegOut {
  day?: number;
  fromStop?: string;
  toStop?: string;
  driveMinutes: number;
  reason?: "rest" | "charge";
  pending?: boolean;
  /** 去程 / 返程：确认路径按方向重算分钟数时靠它分组。 */
  direction?: "outbound" | "return";
}
