/**
 * 挑战记录的读取面。
 *
 * # 不新开端点，借 `GET insights/:id`
 *
 * 上游的 `insights.byId` 已 `include: { challenges: true }`，网关的
 * `/console/research/insights/:id` 已存在。网关在这条链上只做鉴权与透传，新增路由没有收益。
 *
 * # verdict 是四态，不是三态
 *
 * `holds | weakened | refuted | inconclusive`，以代码为准
 * （`challenger.ts` 的 `challengeSchema`）。按三态渲染的界面遇到第四态
 * 会落入默认分支，显示成别的状态。
 */

import { api } from "./index";

export interface ChallengeRecord {
  id: string;
  /** counter-evidence | alternative-explanation | sensitivity。没有"追问"这一类。 */
  kind: string;
  /** holds | weakened | refuted | inconclusive。 */
  verdict: string;
  /**
   * `{ summary, steps }`；追问产生的那些另有 `angle`，C6/C7 写的那些另有 `runId`。
   *
   * `runId` 是追问轮数的计数单位：一轮追问会写多条记录，
   * 按条数计会在第一次追问时就用光三次额度。
   */
  payload: { summary?: string; steps?: number; angle?: string; runId?: string } | null;
  contradictedUnitIds: string[];
  /** 模型名——挑战是谁做的，跨模型版本要能分辨。 */
  createdBy: string;
  createdAt: string;
}

/**
 * 一张卡的挑战记录，按时间正序（上游 `orderBy: createdAt asc`）。
 *
 * 顺序不在这里重排：追问产生的记录要接在它追问的那一次后面，
 * 先后只能由落库时间决定。按 verdict 或 kind 重排会让追问记录排到其对象前面。
 */
export async function fetchChallenges(insightId: string): Promise<ChallengeRecord[]> {
  const res = await api.get<{ insight: { challenges?: ChallengeRecord[] } | null }>(
    `/console/research/insights/${encodeURIComponent(insightId)}`,
  );
  return res.insight?.challenges ?? [];
}
