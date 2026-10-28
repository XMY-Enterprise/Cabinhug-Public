/**
 * 码提案队列的判定。纯函数，不画界面。
 *
 * # 「采纳」不等于「这个码生效了」
 *
 * 采纳只是往台账里记一条"决定采纳"，`research_codebooks` 一行未动，
 * 下一次 run 仍用旧码表。因此 `ACCEPTED_NOTE` 显示在采纳按钮旁边、点击前可见。
 */

import type { Cannibalization, ProposalRow } from "../../../api/research-proposal";

/** 采纳后的说明，与服务端的 `note` 逐字一致。 */
export const ACCEPTED_NOTE =
  "采纳只是记下「决定采纳」，codebook 一行未动——下一步是开一个新的 codebook 版本，那是一个单独的人工动作";

/** 待审 = 还没被决定。判据是有没有对应的 decided 行，不是提案自己的状态字段。 */
export const isPending = (p: ProposalRow): boolean => p.decided === null;

export function splitProposals(rows: readonly ProposalRow[]): {
  pending: ProposalRow[];
  settled: ProposalRow[];
} {
  return {
    pending: rows.filter(isPending),
    /*
     * 已决的提案另起一组显示，不丢弃：
     * "这件事被考虑过并且被否了"正是台账要保留的信息。
     */
    settled: rows.filter((p) => !isPending(p)),
  };
}

export interface CannibalRow extends Cannibalization {
  /** 占候选成员的比例。评审看的是这个，不是绝对数。 */
  share: number;
}

export interface CannibalView {
  rows: CannibalRow[];
  total: number;
  candidateUnits: number;
  /**
   * 这张表含义的说明。
   *
   * 零重叠既不代表"这个码很干净"，也不代表"算错了"，只表示这批单元在 need_pain 轴上
   * 没有挂别的码。这正是兜底桶的定义（归不上现有码才落进 other），因此零重叠是预期读数，
   * 对"值不值得开一个新码"几乎没有区分度，需在文案中说明。
   */
  note: string;
}

export function cannibalView(
  cannibalization: readonly Cannibalization[],
  candidateUnits: number,
): CannibalView {
  const total = cannibalization.reduce((n, c) => n + c.units, 0);
  const rows = cannibalization.map((c) => ({
    ...c,
    // 分母为 0 时给 0 而不是 NaN，NaN 会渲染成空白。
    share: candidateUnits > 0 ? c.units / candidateUnits : 0,
  }));
  return {
    rows,
    total,
    candidateUnits,
    note:
      total === 0
        ? `${candidateUnits} 个候选单元一个都没挂别的需求码。这是兜底桶的常态（归不上现有码才落进它），` +
          "所以这一栏今天几乎没有区分度——判断这个码值不值得开，还得看定义与代表句"
        : `${candidateUnits} 个候选单元里有 ${total} 个同时挂着别的需求码。` +
          "开这个码会把它们从上面那几个码里分走一部分",
  };
}

/** 决定能否提交。决定必须附理由。 */
export function decideIssue(rationale: string): string | null {
  const t = rationale.trim();
  if (!t) return "要写清为什么——没有理由的不是决定，是随手点了一下";
  // 服务端只校验非空；这里同样只拦空，不另设前端独有的长度下限，避免两处规则漂移。
  return null;
}

export interface DecidedView {
  label: string;
  tone: "ok" | "warn" | "dim";
  /** 决定之后该做什么。采纳须完整说明「codebook 还没动」。 */
  next: string;
}

export function decidedView(decision: string): DecidedView {
  if (decision === "accept") return { label: "已决定采纳", tone: "ok", next: ACCEPTED_NOTE };
  if (decision === "reject") {
    return {
      label: "已驳回",
      tone: "warn",
      next: "提案留在台账里：被驳回的提案证明了这件事被考虑过",
    };
  }
  // 表外的取值原样显示，不换成"未知"，以便发现台账里的异常取值。
  return { label: decision, tone: "dim", next: "这个取值不在 accept / reject 两种里，回去核对台账" };
}
