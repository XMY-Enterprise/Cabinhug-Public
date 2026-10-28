/**
 * 码提案的读写面。
 *
 * # 提案不是码
 *
 * codebook 是测量仪器：改一个码的定义，等于让锁版前后所有数字换了含义。
 * 采纳一条提案只是记下"决定采纳"；开新版本是单独的、由人执行的动作。
 * 界面上每一处都要说明这一点，否则采纳后容易误以为码已生效，而下一次 run 仍用旧码表。
 */

import { api } from "./index";

/** 「它会从哪个现有码里吸走多少」：由服务端用代码计算，不由模型填写。 */
export interface Cannibalization {
  code: string;
  units: number;
}

export interface CodeProposalBody {
  proposalId: string;
  themeId: string;
  themeName: string;
  codeName: string;
  definition: string;
  include: string;
  exclude: string;
  exemplars: string[];
  candidateUnits: number;
  cannibalization: Cannibalization[];
  /** 重叠合计。单独给出，使空数组时能区分"算过且无重叠"与"未计算"。 */
  cannibalizedTotal: number;
}

export interface ProposalDecision {
  /** accept | reject。不设第三种。 */
  decision: string;
  decidedBy: string;
  decidedAt: string;
  rationale: string;
}

export interface ProposalRow {
  proposalId: string;
  /** 提出者是点按钮的研究员，不是模型：由他决定把这件事提上议程。 */
  raisedBy: string;
  raisedAt: string;
  proposal: CodeProposalBody | null;
  /** 还没被决定就是 `null`，那就是「待审」。 */
  decided: ProposalDecision | null;
}

/**
 * 待审队列复用 `GET /console/research/review`，不另开端点。
 *
 * 待审提案与图里挂起的 `interrupt()` 同属"等人决定的事"；
 * 网关在这条链上只做鉴权与透传，另开路由没有收益。
 */
export async function fetchProposals(): Promise<ProposalRow[]> {
  const res = await api.get<{ codeProposals?: ProposalRow[] }>("/console/research/review");
  return res.codeProposals ?? [];
}

/**
 * 采纳 / 驳回。
 *
 * 复用既有的 `review/:threadId/resume` 人工决定通路，不另建机制：
 * 该通路上 `decidedBy` 由网关注入真实身份，另建机制需要重复这一步，且遗漏时不报错。
 *
 * `threadId` 用提案 id：这条决定不属于任何一条图执行，而路由要一个路径段。
 */
export function decideProposal(
  proposalId: string,
  decision: "accept" | "reject",
  rationale: string,
): Promise<{ ok: boolean; decision: string; note: string }> {
  return api.post(`/console/research/review/${encodeURIComponent(proposalId)}/resume`, {
    kind: "code-proposal-decided",
    rationale,
    payload: { proposalId, decision },
  });
}
