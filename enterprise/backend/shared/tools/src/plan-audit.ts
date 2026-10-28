/**
 * `plan_audit` —— 行程可执行性体检（FL-58 F-58-02 ~ 05 / 12）。
 *
 * # 它是体检，不是求解
 *
 * `solve()`（agent-runtime 的 merge.ts）负责把单段时长拆到上限以内；本工具只回答"这份草案现在站不站得住"：
 * 每天有没有住宿、每段 / 每天开多久、待定停靠占位还在不在、终点回不回得去。
 * 判定用代码，修复由编排层按结论分派，模型只在被分派的那一支里重新提候选。
 *
 * # 三条约束
 *
 * 1. 纯函数、零 IO、零 LLM。同一份草案 + 同一份约束集，两次调用结论逐项相等（有单测）。
 * 2. 限值全部从入参进。工具里没有写死的时长常数：180 / 540 这些数在 agent-runtime 的
 *    `audit-config.ts`（可配置、带默认值来源），`shared/tools` 不读 env。
 * 3. 输入缺失就说缺什么，标 `unverifiable`，不用默认值假装验过。"没有分段数据"与"通过"必须分得开。
 *
 * # 不体检的东西
 *
 * 正餐时段（靠 estStart / estEnd 判会把"模型没给时段"当成"没安排"）与能源项（余量、估算补能点，归 US-61）。
 * 顺序体检（`route_audit`）由编排层另调，结论作为 `order` warning 并进报告；本工具不调它（要坐标、要网络）。
 */

import {
  AUDIT_LEVEL_OF,
  type AuditFinding,
  type AuditItem,
  type AuditReport,
  type TripPlanDaySnapshot,
  type TripPlanLeg,
} from "@cabinhug/shared";

import { defineExternalTool, type ExternalTool } from "./external";

export interface PlanAuditLimits {
  /** 同行者约束抽出的单段上限（分钟）；没有就只按安全上限。 */
  legMaxMin?: number;
  /** 安全单段上限（分钟）。 */
  legSafeMaxMin: number;
  /** 全天累计上限（分钟）。 */
  dailyMaxMin: number;
}

export interface PlanAuditArgs {
  skeleton: TripPlanDaySnapshot[];
  /** 行车分段；缺省 = 草案没有可对齐的分段。 */
  legs?: TripPlanLeg[];
  origin?: string;
  destination: string;
  limits: PlanAuditLimits;
  /**
   * 车主要求的总天数。不知道就不传：多数请求不说天数，
   * 此时这一项整个跳过，不计 passed 也不报，避免一条恒在的噪音。
   */
  requestedDays?: number;
  /** 本会话生效的约束集（`reconcileConstraints().kept`）。 */
  constraints: string[];
  /** 被剔除 / 被用户覆盖的约束（`dropped`），只进 passed 的依据。 */
  overridden?: string[];
  /** 大交通有返程班次（火车 / 飞机往返），闭环由它保证。 */
  hasReturnTransit?: boolean;
  /** 已由编排层调过 `route_audit` 得出的顺序 warning，原样并进报告。 */
  orderWarnings?: Array<{ day?: number; basis: string }>;
  /** 顺序体检没做（无坐标 / 工具异常）时的原因；有它就记一条 unverifiable。 */
  orderUnverifiable?: string;
}

const SINGLE_TRIP_RE = /单程|不回|不返程|不用回/;
const DAY_RETURN_RE = /当天回|不住|不过夜|不住宿/;

/** 地名归一：去空格、去尾缀「市 / 区 / 县」，比"徐州市"与"徐州"是不是一处。 */
export function normalizePlace(name: string): string {
  return name.replace(/\s+/g, "").replace(/(市|区|县)$/, "");
}

function finding(item: AuditItem, level: AuditFinding["level"], basis: string, extra: Partial<AuditFinding> = {}): AuditFinding {
  return { item, level, basis, ...extra };
}

/** 体检本体。导出给单测与编排层直接调（不必经 invokeTool 也能拿到同一份结论）。 */
export function auditPlan(args: PlanAuditArgs): AuditReport {
  const findings: AuditFinding[] = [];
  let passed = 0;
  const days = [...args.skeleton].sort((a, b) => a.day - b.day);
  const lastDay = days.length ? days[days.length - 1]!.day : 0;
  const constraints = args.constraints ?? [];

  /*
   * ── hotel：除最后一天外每天要有住宿，最后一天则不许有 ──────
   *
   * 两个方向都查："少了"与"多了"（N 天行程排出 N 晚住宿）。两者共用
   * `AUDIT_LEVEL_OF.hotel` 一个等级：它们是同一件事（住宿天数与行程天数对不上）的两侧。
   */
  if (constraints.some((c) => DAY_RETURN_RE.test(c))) {
    passed += 1;
    findings.push(finding("constraint", "warning", "用户声明当天回 / 不住宿，不验住宿"));
  } else {
    const missing = days.filter((d) => d.day !== lastDay && !d.hotel);
    const extra = days.filter((d) => d.day === lastDay && d.hotel);
    if (missing.length === 0 && extra.length === 0) passed += 1;
    for (const d of missing) {
      findings.push(finding("hotel", AUDIT_LEVEL_OF.hotel, `第 ${d.day} 天没有住宿`, { day: d.day }));
    }
    for (const d of extra) {
      findings.push(
        finding("hotel", AUDIT_LEVEL_OF.hotel, `第 ${d.day} 天是返程日，不该有住宿`, { day: d.day }),
      );
    }
  }

  /*
   * ── days：方案的天数与车主要的对不对得上 ──────────────────────
   *
   * 分支少交天数时，合并与落库的方案都会少天，而表述层可能按对话上下文说出车主要的天数，
   * 这一项让天数不足成为体检结论。
   *
   * 车主没说天数时整个跳过：那是常态（"去杭州玩玩"），报一条 unverifiable 只会变成噪音。
   */
  if (args.requestedDays !== undefined && args.requestedDays > 0) {
    if (days.length === args.requestedDays) {
      passed += 1;
    } else {
      const diff = args.requestedDays - days.length;
      findings.push(
        finding(
          "days",
          AUDIT_LEVEL_OF.days,
          diff > 0
            ? `方案只排了 ${days.length} 天，车主要的是 ${args.requestedDays} 天，少 ${diff} 天`
            : `方案排了 ${days.length} 天，超过车主要的 ${args.requestedDays} 天`,
          { actual: days.length, limit: args.requestedDays },
        ),
      );
    }
  }

  /*
   * ── 不检查同名景点跨天重复（dup）：它需要的事实不在输入里（ADR-010）。
   * `spots[].name` 只是字符串，判不出地点类型，而"算不算重复"取决于类型：
   * 夜游压轴、一次游玩拆成两行、连住酒店的入住日与退房日都会合法地同名出现。
   * 按当天挂载的 `hotel.name` 或名字关键词识别住宿都不可靠。
   *
   * 重新启用的前提：提交带上 POI 类型（`poi_search` 的 category），
   * 或把住宿从 `spots` 移回 `lodging` / `hotel` 字段。
   */

  // ── leg / daily / stop：都吃 legs ─────────────────────────────
  if (!args.legs || args.legs.length === 0) {
    findings.push(finding("leg", "unverifiable", "单段行车时长", { missing: "分段数据" }));
    findings.push(finding("daily", "unverifiable", "全天累计行车时长", { missing: "分段数据" }));
    findings.push(finding("stop", "unverifiable", "停靠点是否都已确定", { missing: "分段数据" }));
  } else {
    const legLimit = Math.min(args.limits.legMaxMin ?? Infinity, args.limits.legSafeMaxMin);
    let legOk = true;
    args.legs.forEach((l, i) => {
      if (l.driveMinutes > legLimit) {
        legOk = false;
        findings.push(
          finding("leg", AUDIT_LEVEL_OF.leg, `第 ${i + 1} 段约 ${fmtMin(l.driveMinutes)}，超过单段上限 ${fmtMin(legLimit)}`, {
            leg: i,
            actual: l.driveMinutes,
            limit: legLimit,
            ...(l.day !== undefined ? { day: l.day } : {}),
          }),
        );
      }
    });
    if (legOk) passed += 1;

    const byDay = new Map<number, number>();
    let unknownDay = false;
    for (const l of args.legs) {
      if (l.day === undefined) unknownDay = true;
      else byDay.set(l.day, (byDay.get(l.day) ?? 0) + l.driveMinutes);
    }
    let dailyOk = true;
    for (const [day, total] of byDay) {
      if (total > args.limits.dailyMaxMin) {
        dailyOk = false;
        findings.push(
          finding("daily", AUDIT_LEVEL_OF.daily, `第 ${day} 天累计行车约 ${fmtMin(total)}，超过全天上限 ${fmtMin(args.limits.dailyMaxMin)}`, {
            day,
            actual: total,
            limit: args.limits.dailyMaxMin,
          }),
        );
      }
    }
    if (unknownDay) {
      findings.push(finding("daily", "unverifiable", "有分段对不上具体哪一天，全天累计只算了能对上的天", { missing: "段的归属天" }));
    } else if (dailyOk) {
      passed += 1;
    }

    let stopOk = true;
    args.legs.forEach((l, i) => {
      if (l.pending) {
        stopOk = false;
        findings.push(finding("stop", AUDIT_LEVEL_OF.stop, `第 ${i + 1} 段的停靠点还没定`, { leg: i, ...(l.day !== undefined ? { day: l.day } : {}) }));
      }
    });
    if (stopOk) passed += 1;
  }

  // ── return：闭环 ───────────────────────────────────────────────
  if (constraints.some((c) => SINGLE_TRIP_RE.test(c))) {
    passed += 1;
    findings.push(finding("constraint", "warning", "用户声明单程，不验返程闭环"));
  } else if (args.hasReturnTransit) {
    passed += 1;
  } else if (!args.origin) {
    findings.push(finding("return", "unverifiable", "返程闭环", { missing: "出发地" }));
  } else {
    const last = days.length ? days[days.length - 1]! : undefined;
    const lastSpot = last?.spots.length ? last.spots[last.spots.length - 1]!.name : undefined;
    const lastLegTo = args.legs?.length ? args.legs[args.legs.length - 1]!.toStop : undefined;
    const end = lastLegTo ?? lastSpot;
    if (end && normalizePlace(end) === normalizePlace(args.origin)) {
      // 末站（分段的终点，没有就看最后一天的最后一个景点）回到出发地 = 闭环成立，不需要分段也能验。
      passed += 1;
    } else if (!args.legs || args.legs.length === 0) {
      /*
       * 闭环没验成且没有分段：缺的是分段数据，不报"最后一段没有终点站"。
       * 与上面 leg / daily / stop 三条同一个根因，用同一个 missing 表述，
       * 避免读者误以为有四个独立问题。
       */
      findings.push(finding("return", "unverifiable", "返程闭环", { missing: "分段数据" }));
    } else {
      // 有分段，但最后一段没有终点站（drive 分支不把"回家"当停靠）：这一项验不了，不下 blocker。
      findings.push(finding("return", "unverifiable", "返程闭环", { missing: "返程段（草案的最后一段没有终点站）" }));
    }
  }

  // ── constraint：覆盖只做依据 ─────────────────────────────────
  for (const c of args.overridden ?? []) {
    passed += 1;
    findings.push(finding("constraint", "warning", `约束「${c}」已由用户覆盖或与车辆能源类型不符，不作为 blocker`));
  }

  // ── order：编排层给的顺序结论 ─────────────────────────────────
  if (args.orderUnverifiable) {
    findings.push(finding("order", "unverifiable", "顺序体检", { missing: args.orderUnverifiable }));
  } else if (args.orderWarnings && args.orderWarnings.length > 0) {
    for (const w of args.orderWarnings) findings.push(finding("order", AUDIT_LEVEL_OF.order, w.basis, w.day !== undefined ? { day: w.day } : {}));
  } else if (args.orderWarnings) {
    passed += 1;
  }

  // constraint 类的 warning 只是依据，不交给端上展示：从 findings 里拿掉，只留 passed 计数。
  const visible = findings.filter((f) => f.item !== "constraint");
  return { findings: visible, passed, rounds: 0, budgetExhausted: false };
}

function fmtMin(min: number): string {
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} 分`;
  return r === 0 ? `${h} 小时` : `${h} 小时 ${r} 分`;
}

export function hasBlocker(report: AuditReport): boolean {
  return report.findings.some((f) => f.level === "blocker" && !f.repaired);
}

export const planAuditTool: ExternalTool<PlanAuditArgs, AuditReport> = defineExternalTool<PlanAuditArgs, AuditReport>({
  name: "plan_audit",
  provider: "cabinhug-audit",
  timeoutMs: 2_000,
  async real(args) {
    return auditPlan(args);
  },
  // 纯计算没有"模拟"可言：mock 与 real 同一份逻辑，mock 模式下的体检结论同样真实。
  mock(args) {
    return auditPlan(args);
  },
});
