/**
 * 图的 `challenge` 节点：每张洞察卡一次挑战。
 *
 * `challenge()` 的三个注入回调（`themeMembers` / `sliceBySegment` /
 * `thresholdSensitivity`）的真实现见 `../challenge/deps.ts`。
 *
 * # 挑战记录由本节点写，不由模型的工具写
 *
 * 四个工具全部只读（`challenge.test.ts` 有源码扫描覆盖）。
 * 负责挑刺的模型不得有权改动被挑的对象，因此模型只返回判决，落库在这一层。
 *
 * # 一条 refuted 不会自动把卡降级
 *
 * 本节点不碰 `research_insights.level`。挑战的结论进 `research_challenges`，
 * 降级与升级一样，都是人工决定。
 */

import type { ResearchRepository } from "@cabinhug/db";

import { challengeSessionKey } from "../challenge/acp-transport";
import { challenge, type ChallengeDeps } from "../challenge/challenger";
import type { ChallengeToolDeps } from "../challenge/tools";
import type { ResearchUsage } from "../llm";

export interface ChallengeAllOptions {
  repo: ResearchRepository;
  window: { from: number; to: number };
  deps: ChallengeDeps;
  recordUsage?: (u: ResearchUsage) => Promise<void>;
  /**
   * ACP 路径的回调面登记。只在 `deps.transport === "acp"` 时给。
   *
   * 取数按会话键挂上去，pi 子进程里的工具调用回调时按 pi 会话 id 反解到同一个键。
   * 未登记时不报错：端点回"挑战会话已结束"，模型的工具全部失效，
   * 但模型仍会产出看似完整的挑战记录。
   */
  acpSessions?: {
    register(key: string, deps: ChallengeToolDeps): void;
    release(key: string): void;
  };
}

interface InsightRow {
  id: string;
  themeId: string;
  card: { claim?: string; evidence?: string; boundary?: string } | null;
}

/**
 * 逐卡挑战，返回写了多少条挑战记录。
 *
 * 与 Synthesizer 相同：单张失败不拖垮整个 run。
 * 一次挑战最多 8 步工具循环再加一次收口生成，是整条链上最容易超时的一跳。
 */
export async function challengeAll(
  insightIds: readonly string[],
  opts: ChallengeAllOptions,
): Promise<number> {
  if (insightIds.length === 0) return 0;

  let written = 0;
  for (const insightId of insightIds) {
    try {
      written += (await challengeOne(insightId, opts)).written;
    } catch (err) {
      console.warn(
        `[research-runtime] Challenger 在洞察 ${insightId} 上失败，跳过：` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(`[research-runtime] Challenger：${insightIds.length} 张卡 → ${written} 条挑战记录`);
  return written;
}

export interface ChallengeOneResult {
  /** 写进库的挑战记录条数。 */
  written: number;
  /** 走了几步工具循环。 */
  steps: number;
  /** 每条记录的判决。界面拿它显示"这一次挑出了什么"，不必再查一次库。 */
  verdicts: string[];
  /** 卡不在库里。`written` 同为 0，调用方需与"挑战无产出"区分。 */
  missing?: true;
}

/**
 * 一张卡一次挑战。批量（整 run）、单卡触发（C6）、追问（C7）三条路径共用它，
 * 不另开写入路径。
 *
 * 共用保证 `level` 不被碰、`payload` 记 steps、`createdBy` 记模型名三项在各路径一致；
 * 任何一项遗漏都不会报错。
 */
export async function challengeOne(
  insightId: string,
  opts: ChallengeAllOptions & {
    /** 追问补的调查角度（C7）。给了就追加进 system，并记进 payload。 */
    extraAngle?: string;
    /**
     * 哪一次点击写的（C6/C7 的 `runId`）。整 run 批量走的是图，没有它。
     *
     * 它是追问轮数的计数单位：一轮追问会写多条记录（`challengeSchema`
     * 允许一次返回 1–6 条），按记录条数计会让第一次追问就用光三次额度。
     */
    runId?: string;
  },
): Promise<ChallengeOneResult> {
  const row = (await opts.repo.insights.byId(insightId)) as InsightRow | null;
  if (!row) {
    console.warn(`[research-runtime] 洞察 ${insightId} 不存在，跳过挑战`);
    return { written: 0, steps: 0, verdicts: [], missing: true };
  }

  const angle = opts.extraAngle?.trim() || undefined;
  const card = row.card ?? {};

  /*
   * 会话键。追问与它追的那张卡同键：C7 不把 `runId` 传给它，
   * 于是落回 `challenge:<insightId>`，与批量路径及同卡的其它追问共用同一个 pi 会话，
   * 模型带着上一轮查过的内容继续查（ACR-038）。
   * C6 单卡触发带 runId，一次点击一个独立会话。
   */
  const sessionKey = challengeSessionKey(insightId, angle ? undefined : opts.runId);
  const deps: ChallengeDeps = {
    ...opts.deps,
    ...(opts.recordUsage ? { recordUsage: opts.recordUsage } : {}),
    ...(opts.deps.acp ? { acp: { ...opts.deps.acp, sessionKey } } : {}),
  };
  if (deps.transport === "acp") opts.acpSessions?.register(sessionKey, deps);

  let result: Awaited<ReturnType<typeof challenge>>;
  try {
    result = await challenge(
      {
        insightId,
        themeId: row.themeId,
        card: {
          claim: card.claim ?? "",
          evidence: card.evidence ?? "",
          boundary: card.boundary ?? "",
        },
        windowFrom: opts.window.from,
        windowTo: opts.window.to,
        ...(angle ? { extraAngle: angle } : {}),
      },
      deps,
    );
  } finally {
    // 摘掉之后的 invoke 一律回"挑战会话已结束"，防止下一张卡的工具调用
    // 拿到这一张的窗。失败路径同样要摘。
    if (deps.transport === "acp") opts.acpSessions?.release(sessionKey);
  }

  await opts.recordUsage?.(result.usage);

  for (const c of result.challenges) {
    await opts.repo.challenges.create({
      insightId,
      kind: c.kind,
      /*
       * 判决之外的过程记录（步数、摘要）一并存，供评审追溯查了什么。
       *
       * `angle` 是"这一条由追问产生"的判据。不新增 `kind` 取值：`kind` 直接来自
       * `challengeSchema` 的 enum，加取值即改判定口径。payload 里的 `angle`
       * 还记录了追问的角度。
       */
      payload: {
        summary: c.summary,
        steps: result.steps,
        /*
         * 探查跳走的路径。两条路径写进同一张表、形状相同，靠这一栏区分；
         * ACR-038 的回滚判据（acp 下 `inconclusive` 占比是否较 direct 基线上升）按它分组。
         */
        transport: result.transport,
        ...(angle ? { angle } : {}),
        ...(opts.runId ? { runId: opts.runId } : {}),
      },
      contradictedUnitIds: c.contradictedUnitIds,
      verdict: c.verdict,
      /*
       * 表注释约定这一列记模型名，以便跨模型版本区分挑战的执行者。
       * acp 下记 pi 实际运行的模型（`.pi/settings.json` 的 `defaultModel`）：
       * 收口跳的模型可能与之不同，而探查由 pi 执行。
       */
      createdBy: result.model ?? opts.deps.model.modelName,
    });
  }
  return {
    written: result.challenges.length,
    steps: result.steps,
    verdicts: result.challenges.map((c) => c.verdict),
  };
}
