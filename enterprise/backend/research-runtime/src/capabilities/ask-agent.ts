/**
 * C10–C12「问它」的编排。
 *
 * 与 `challenge-card.ts` 同形：端点立即回 `runId`，后台执行，进度经 SSE。
 * 一次提问是最多 8 步工具循环再加一次收口生成，是整条链上最容易超时的一跳，
 * 同步返回会被客户端超时断开，而调用仍在后台继续。
 *
 * # 轮数在进程内存里
 *
 * `follow-up.ts` 数的是库里的挑战记录（`countFollowUps`），因为挑战有落库的产出。
 * 笔记不落库，所以这边数进程内的一张表，重启归零。重启后同一范围可再问五轮，
 * 这可以接受：pi 会话也随进程结束，重启后的提问本就是全新会话。
 * 跨重启计数需要先给笔记建表。
 *
 * # 本模块不依赖 pi 与仓储
 *
 * 两跳在 `stages/ask.ts`，取数在 `index.ts` 的装配层。这里只做三件事：
 * 说明在问谁 → 调用 → 把结果交给运行台账。
 */

import type { AgentNote, AskAgentName, SelectionScope } from "@cabinhug/research";

import type { AskContext, AskResult } from "../stages/ask";
import type { CapabilityRuns } from "./runs";

export interface AskAgentDeps {
  /**
   * 备料：把范围翻成模型看得懂的上下文（格的 n/N/pct、行的码定义、卡的命题、屏的合同摘要）。
   * 范围在库里找不到时返回 null："这一格没算过"与"这一格没问题"不同。
   */
  context(input: {
    agent: AskAgentName;
    scope: SelectionScope;
    contractId: string;
  }): Promise<AskContext | null>;

  /** 执行一次提问。两跳与引用核对都在 `stages/ask.ts` 里。 */
  runAsk(args: {
    runId: string;
    agent: AskAgentName;
    scope: SelectionScope;
    contractId: string;
    question: string;
    round: number;
    /** 这一次落在哪个 pi 会话上。由端点算好（它也拿它数轮数），不在这里再算一遍。 */
    sessionKey: string;
    context: AskContext;
  }): Promise<AskResult>;
}

export interface AskAgentInput {
  agent: AskAgentName;
  scope: SelectionScope;
  contractId: string;
  question: string;
  round: number;
  sessionKey: string;
}

/**
 * 同一范围问过几轮。键是 `askSessionKey`，与 pi 会话一一对应，
 * 因此"还剩几轮"与"是否带上一轮上下文"一致。
 */
const rounds = new Map<string, number>();

/** 这个范围已经问过几轮。没问过是 0。 */
export const askRoundsUsed = (sessionKey: string): number => rounds.get(sessionKey) ?? 0;

/**
 * 记一轮。在受理时记，不在跑完时记：跑完才记时连点五次会全部受理，
 * 五个 pi prompt 同时进入同一个会话。
 */
export function recordAskRound(sessionKey: string): number {
  const next = askRoundsUsed(sessionKey) + 1;
  rounds.set(sessionKey, next);
  return next;
}

/** 仅供测试：清空轮数表，避免用例之间轮数累积。 */
export function resetAskRoundsForTests(): void {
  rounds.clear();
}

/** 一次提问的产出：笔记本体 + 这一跳的过程数据。 */
export interface AskAgentResult {
  agent: AskAgentName;
  round: number;
  note: AgentNote;
  steps: number;
  hitLimit: boolean;
  /** 被剥掉的引用条数（`stages/ask.ts` 的核对）。0 表示模型引用的每一条都在工具返回中出现过。 */
  strippedCitations: number;
}

/**
 * 起一次提问。同步返回 runId，后台执行。
 *
 * 返回的 promise 只供测试使用：生产路径拿到 runId 即返回。
 */
export function startAskAgent(
  runs: CapabilityRuns,
  deps: AskAgentDeps,
  input: AskAgentInput,
): { runId: string; done: Promise<void> } {
  const rec = runs.start(`ask-${input.agent}`);
  const done = run(runs, deps, input, rec.runId).catch((err: unknown) => {
    // 兜底未预料的失败，否则成为未捕获的 rejection，界面上的流会一直等到超时。
    runs.fail(rec.runId, err instanceof Error ? err.message : String(err));
  });
  return { runId: rec.runId, done };
}

async function run(
  runs: CapabilityRuns,
  deps: AskAgentDeps,
  input: AskAgentInput,
  runId: string,
): Promise<void> {
  runs.note(runId, `装配：读 ${describeScope(input.scope)} 的上下文`, "装配");
  const context = await deps.context({
    agent: input.agent,
    scope: input.scope,
    contractId: input.contractId,
  });
  if (!context) {
    // 「这一范围在库里找不到」与「问不出东西」不同，前者通常是还没跑过 run。
    runs.fail(runId, `${describeScope(input.scope)} 在这个合同下找不到——先 POST /internal/research/runs 算一次`);
    return;
  }

  /*
   * 把问句原样回显进进度。
   *
   * 这是唯一有用户文本进模型的一跳，问句需要可追溯；这条进度在探查之前写入，
   * 即使探查超时，面板上也能看到问的是什么。
   */
  runs.note(runId, `第 ${input.round} 轮问${input.agent}：${input.question}`);
  runs.note(runId, "探查中：模型自己循环调只读工具，最多 8 步", "exploring");

  const out = await deps.runAsk({ runId, ...input, context });

  /*
   * 记录探查跳的步数：冒烟按它判断第二轮的计步从 0 重新起算，
   * 这是按轮重置生效的唯一外部可观测证据。
   */
  runs.note(runId, `探查完成：走了 ${out.steps} 步${out.hitLimit ? "（步数用满或超时）" : ""}`, "summarizing");

  const result: AskAgentResult = {
    agent: input.agent,
    round: input.round,
    note: out.note,
    steps: out.steps,
    hitLimit: out.hitLimit,
    strippedCitations: out.strippedCitations,
  };
  runs.finish(
    runId,
    result,
    `完成：引用 ${out.note.citedUnitIds.length} 条证据 / ${out.note.citedThemeIds.length} 个主题` +
      (out.strippedCitations > 0 ? `，剥掉 ${out.strippedCitations} 条查无实据的引用` : ""),
  );
}

/** 进度里对范围的可读描述。只进日志与面板，不进任何判据。 */
function describeScope(scope: SelectionScope): string {
  switch (scope.kind) {
    case "cell":
      return `${scope.needPainCode} × ${scope.sceneCode} 这一格`;
    case "row":
      return `${scope.needPainCode} 这一行`;
    case "col":
      return `${scope.sceneCode} 这一列`;
    case "card":
      return `洞察卡 ${scope.insightId}`;
    default:
      return "这一屏";
  }
}
