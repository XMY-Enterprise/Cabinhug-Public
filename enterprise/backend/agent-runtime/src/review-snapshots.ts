/**
 * trip-review 的按轮暂存区（ACR-037 第 5 步）：①Working 层，进程内存、按 (会话, 轮)、不落库。
 *
 * # 它存的是什么
 *
 * 裁决会话（`trip-review-task`）这一轮要读、要改的对象：四条腿的提交、编排层的汇聚与体检闭包、
 * 当前快照与体检结果。`itinerary_assemble` / `plan_edit` 两个工具经 `@cabinhug/tools` 的 `ReviewAssembler`
 * 注入点找到它；工具层不持有进程状态（与 `branch-submissions.ts` 同一形态）。
 *
 * # 键与 branch-submissions 同一空间
 *
 * `sessionId` 是 threadId、`turnId` 是 `currentTurnId(threadId)`，与 tools-endpoint 给工具的 ctx 一致。
 * 键对不上时 `plan_edit` 找不到要改的快照，模型会收到"本轮没有进行中的裁决"。
 *
 * # 生命周期
 *
 * `reviewLoop` 进场 `open`、离场 `close`（finally）。不 sweep：一轮只开一次，关掉就没了。
 */

import type { AuditReport, TripPlanSnapshot } from "@cabinhug/shared";

import type { BranchResult } from "./graph/fanout";

/** 汇聚产物的最小形状：`ItineraryMergeOutput` 是它的超集。 */
export interface MergeLike {
  plan: TripPlanSnapshot;
  violations: string[];
  missing: string[];
  findings: string[];
}

export interface ReviewSessionState<M extends MergeLike = MergeLike> {
  branches: BranchResult[];
  /** 编排层的汇聚闭包（带同一份 MergeOptions）。 */
  assemble: (branches: BranchResult[]) => M;
  /** 编排层的代码体检闭包（`plan_audit` + 顺序体检）。 */
  audit: (plan: M["plan"]) => Promise<AuditReport>;
  /** 当前快照与它的体检结果，`plan_edit` 改的是这个。 */
  merged: M;
  report: AuditReport;
  /** `plan_edit` 生效的次数（span 与验收用）。 */
  edits: number;
  /** 每次 `plan_edit` 生效后记一次 `task.draft.updated`。 */
  onDraft?: (plan: M["plan"]) => Promise<void>;
  /** 时钟（毫秒），单测注入。 */
  now: () => number;
  threadId?: string;
}

const sessions = new Map<string, ReviewSessionState>();

function key(sessionId: string, turnId: string): string {
  return `${sessionId}#${turnId}`;
}

export function openReviewSession<M extends MergeLike>(sessionId: string, turnId: string, state: ReviewSessionState<M>): void {
  sessions.set(key(sessionId, turnId), state as unknown as ReviewSessionState);
}

export function getReviewSession(sessionId: string, turnId: string | undefined): ReviewSessionState | undefined {
  if (!turnId) return undefined;
  return sessions.get(key(sessionId, turnId));
}

export function closeReviewSession(sessionId: string, turnId: string): void {
  sessions.delete(key(sessionId, turnId));
}

export function __resetReviewSessions(): void {
  sessions.clear();
}
