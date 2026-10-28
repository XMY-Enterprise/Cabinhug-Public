/**
 * 人工决定。
 *
 * # 研究面唯一有个体后果的动作
 *
 * 售后线索放行会让某一台具体的车收到一条提醒。方法本体 §14 把这类动作
 * 归为"高风险个体影响"：它从聚合研究落到了对个体的差异化触达。
 *
 * 三条硬约束，各有一条单测覆盖：
 *  1. 逐条：一次只能放行一个 `vin`，没有批量端点；
 *  2. admin + rationale：没有理由不构成决定；
 *  3. 申诉永远可用：对同一 `vin` 的申诉入口不设条件、不设窗口。
 *
 * # 升级也只能走这里
 *
 * `signal → candidate` 没有自动路径，ODS 高分也不是：分数只排序（analysis.md §4）。
 */

import type { ResearchRepository } from "@cabinhug/db";
import { anyGateFailed, type Gates } from "@cabinhug/research";

/** 研究面发出的提醒用这个 kind——与 worker 的 `maintenance` 分开，各自独立冷却。 */
export const RESEARCH_REMINDER_KIND = "research-lead";

/** 升级到 candidate 的置信下限。 */
export const PROMOTE_MIN_CONFIDENCE = 0.6;

export type DecisionKind =
  | "codebook-lock"
  | "promote"
  | "decision-record"
  | "aftersales-approve"
  | "aftersales-appeal"
  /**
   * 码提案的决定（C8）。
   *
   * 这里只记"决定"这一半：提案本身由 C8 写成 `code-proposal-raised`，
   * 其 `decidedBy` 是把它提上议程的研究员；本条的 `decidedBy` 是决定采纳/驳回的人。
   * 两条靠 `subjectId`（提案 id）串起来，形状与 `aftersales-approve` / `-appeal` 相同。
   *
   * 采纳只记下"决定采纳"，不改 codebook。开新版本是单独的人工动作；
   * 接到这里会绕过 `codebook-lock` 的治理链。
   */
  | "code-proposal-decided";

export interface PromoteCheckInput {
  gates: Gates;
  confidence: number;
  challenges: Array<{ verdict: string }>;
}

/**
 * 升级前置。返回缺什么而不是 true/false，端点据此告诉人"还差哪几样"。
 */
export function promoteBlockers(input: PromoteCheckInput): string[] {
  const missing: string[] = [];

  if (anyGateFailed(input.gates)) {
    const failed = (Object.keys(input.gates) as Array<keyof Gates>)
      .filter((k) => input.gates[k].status === "fail")
      .map((k) => `${k}（${input.gates[k].reason}）`);
    missing.push(`四道门未全过：${failed.join("；")}`);
  }
  if (input.confidence < PROMOTE_MIN_CONFIDENCE) {
    missing.push(`置信 C = ${input.confidence.toFixed(2)} < ${PROMOTE_MIN_CONFIDENCE}`);
  }
  // 未过挑战只能是 Signal：未经挑战的卡仍是未验证的猜想。
  const usable = input.challenges.filter((c) => c.verdict === "holds" || c.verdict === "weakened");
  if (usable.length === 0) {
    missing.push("还没有一条 verdict ∈ {holds, weakened} 的挑战记录（inconclusive 不算）");
  }
  return missing;
}

export interface AftersalesApproveInput {
  opportunityId: string;
  /** 只能一个；带多个直接拒，没有批量放行。 */
  vin: string;
  userId: string;
  message: string;
  decidedBy: string;
  rationale: string;
}

export class BatchApprovalRejected extends Error {
  constructor(n: number) {
    super(
      `research_aftersales_no_batch: 一次只能放行一个 vin（收到 ${n} 个）。` +
        "售后线索是对个体的差异化触达，逐条放行是它的前提，不是流程摩擦",
    );
  }
}

export interface DecisionDeps {
  repo: ResearchRepository;
  /** 写一条 `vehicle_reminders`。由 index.ts 注入（研究仓储不写车主表）。 */
  createReminder: (input: {
    userId: string;
    vin: string;
    kind: string;
    message: string;
    basis: string[];
  }) => Promise<{ id: string }>;
  /** 让一条提醒失效。 */
  invalidateReminder: (id: string) => Promise<void>;
}

/**
 * 放行一条售后线索。
 *
 * 提醒文案强制带上出处与申诉入口：收到的人需要知道这条提醒的来源，以及如何让它停下。
 */
export async function approveAftersales(
  input: AftersalesApproveInput,
  deps: DecisionDeps,
): Promise<{ reminderId: string; decisionId: string }> {
  if (input.rationale.trim().length === 0) {
    throw new Error("research_decision_no_rationale: 没有理由的不是决定，是随手点了一下");
  }

  const reminder = await deps.createReminder({
    userId: input.userId,
    vin: input.vin,
    kind: RESEARCH_REMINDER_KIND,
    message: `${input.message}（来自用车研究，可申诉）`,
    basis: ["research", input.opportunityId],
  });

  const decision = await deps.repo.decisions.record({
    kind: "aftersales-approve",
    subjectId: input.opportunityId,
    decidedBy: input.decidedBy,
    rationale: input.rationale,
    payload: { vin: input.vin, userId: input.userId, reminderId: reminder.id },
  });

  return { reminderId: reminder.id, decisionId: decision.id };
}

/** 申诉：让提醒失效并留痕。不设条件、不设窗口，申诉入口永远可用。 */
export async function appealAftersales(
  input: { reminderId: string; vin: string; decidedBy: string; rationale: string },
  deps: DecisionDeps,
): Promise<{ decisionId: string }> {
  await deps.invalidateReminder(input.reminderId);
  const decision = await deps.repo.decisions.record({
    kind: "aftersales-appeal",
    subjectId: input.reminderId,
    decidedBy: input.decidedBy,
    rationale: input.rationale,
    payload: { vin: input.vin },
  });
  return { decisionId: decision.id };
}
