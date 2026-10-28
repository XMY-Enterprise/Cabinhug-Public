/**
 * C8「从兜底桶提码」。
 *
 * 实跑 666 轮落进 `other`，是十个码里最大的一堆，对应的动作是补 codebook，
 * C8 是这个动作的入口。
 *
 * # 产出是提案，不是新码
 *
 * codebook 是测量仪器：改一个码的定义，等于让锁版前后所有数字换了含义。
 * 采纳一条提案要开一个新版本，由人决定（§06 / 编码本文件头）。
 * 所以本模块不写 `research_codebooks`（G3），只往 `research_decisions`
 * 追加一条 `code-proposal-raised`。
 *
 * # 两条记录
 *
 * `research_decisions` 是「人工决定」表，一条待审的提案本身不是决定，
 * `decided_by` / `decided_at` 没有真值可填。形状与该表已有的
 * `aftersales-approve` / `aftersales-appeal` 一致：
 *
 * | 记录 | `decidedBy` 是谁 | 什么时候写 |
 * |---|---|---|
 * | `code-proposal-raised` | **决定把这件事提上议程的研究员**（点按钮那个人，经网关注入） | C8 跑完 |
 * | `code-proposal-decided` | 决定采纳 / 驳回的那个人 | 审阅界面点采纳或驳回 |
 *
 * 两条靠 `subjectId`（提案 id）串起来。第一条的 `decidedBy` 有真值：
 * 点「从兜底桶提码」的人做了"提上议程"这个决定，不是"采纳"。
 *
 * # 「会从哪几个现有码里吸走多少」由代码算，不问模型
 *
 * 模型给的数字没有出处，而这一栏是评审判断"这个码值不值得开新版本"的唯一依据。
 * 所以它不进提示词，`nameTheme` 的入参里也没有这个字段。
 */

import { randomUUID } from "node:crypto";

import type { CapabilityRuns } from "./runs";

/** 兜底桶码。三处写死同一个值，见 `lenses/evidence-matrix.ts` 的注释。 */
export const CATCH_ALL_CODE = "other";

/** 两条记录的 kind。表注释里的清单须与这两个常量一致。 */
export const PROPOSAL_RAISED = "code-proposal-raised";
export const PROPOSAL_DECIDED = "code-proposal-decided";

/** 一次提多少个码。兜底桶下实测 4 个主题，留一倍余量。 */
export const MAX_PROPOSALS = 8;

/** 每条提案带几句代表句：足以看出这个码在说什么，又不让 payload 过大。 */
export const EXEMPLARS_PER_PROPOSAL = 5;

export interface ThemeMembers {
  id: string;
  name: string;
  memberUnitIds: string[];
  counterUnitIds: string[];
}

/** 「它会从哪个现有码里吸走多少」，一行一个码。 */
export interface Cannibalization {
  code: string;
  units: number;
}

export interface CodeProposal {
  proposalId: string;
  /** 从哪个主题提出来的。评审时要回得去看那一簇。 */
  themeId: string;
  themeName: string;
  codeName: string;
  definition: string;
  include: string;
  exclude: string;
  exemplars: string[];
  /** 候选成员数。`cannibalization` 的分母。 */
  candidateUnits: number;
  cannibalization: Cannibalization[];
  /**
   * 重叠合计。单独给出，因为 `cannibalization` 为空数组时无法区分
   * "算过了，没有重叠"与"这一栏没算"。
   */
  cannibalizedTotal: number;
}

export interface ProposeCodeDeps {
  /** 兜底桶码下的主题。为空时无从提码，这不是失败。 */
  catchAllThemes(): Promise<ThemeMembers[]>;
  /** 一批单元的脱敏文本。这一层只拿得到脱敏文本，拿不到原文。 */
  textsByIds(unitIds: readonly string[]): Promise<Map<string, string>>;
  /**
   * 这批单元在 need_pain 轴上还挂着哪些别的码。
   *
   * 回的是 `码 → 单元数`，`other` 自己已被剔掉（它是分母不是分子）。
   */
  otherCodesFor(unitIds: readonly string[]): Promise<Cannibalization[]>;
  /** 调 Namer 起名。与给主题起名是同一个函数，C8 不需要新的 Agent。 */
  nameOne(input: {
    runId: string;
    themeId: string;
    examples: string[];
    counterExamples: string[];
  }): Promise<{ name: string; definition: string; include: string; exclude: string } | null>;
  /** 落一条 `code-proposal-raised`。`decidedBy` 由调用方给真实身份。 */
  raise(input: { proposalId: string; actor: string; proposal: CodeProposal }): Promise<string>;
}

export interface ProposeCodeResult {
  /** 提出来的提案 id。 */
  proposalIds: string[];
  /** 兜底桶下一共几个主题。与 `proposalIds.length` 不等即有主题没提成。 */
  themeTotal: number;
  proposals: CodeProposal[];
}

export function startProposeCode(
  runs: CapabilityRuns,
  deps: ProposeCodeDeps,
  input: { actor: string },
): { runId: string; done: Promise<void> } {
  const rec = runs.start("propose-code");
  const done = run(runs, deps, input, rec.runId).catch((err: unknown) => {
    runs.fail(rec.runId, err instanceof Error ? err.message : String(err));
  });
  return { runId: rec.runId, done };
}

async function run(
  runs: CapabilityRuns,
  deps: ProposeCodeDeps,
  input: { actor: string },
  runId: string,
): Promise<void> {
  runs.note(runId, `装配：查兜底桶（${CATCH_ALL_CODE}）下的主题`, "装配");
  const all = await deps.catchAllThemes();
  if (all.length === 0) {
    /*
     * 「兜底桶还没被聚类」与「提码失败」不同。聚类只跳过 `needPainCode === "none"`，
     * `other` 应当有主题；一个都没有说明上一次 run 没跑完聚类。
     */
    runs.fail(runId, `兜底桶（${CATCH_ALL_CODE}）下还没有主题——先跑一次 run 把它聚出来，再来提码`);
    return;
  }

  const themes = all.slice(0, MAX_PROPOSALS);
  if (themes.length < all.length) {
    runs.note(runId, `兜底桶下有 ${all.length} 个主题，本次只提前 ${themes.length} 条`);
  }
  runs.note(runId, `兜底桶下 ${all.length} 个主题，逐个提一条码提案`);

  const proposals: CodeProposal[] = [];
  const failed: string[] = [];
  for (const [i, theme] of themes.entries()) {
    const label = `${i + 1}/${themes.length}：${theme.name}`;
    runs.note(runId, `起名 ${label}（${theme.memberUnitIds.length} 个候选单元）`, "起名");
    try {
      const proposal = await buildOne(runs, deps, theme, runId);
      if (!proposal) {
        // 没出成也记入进度，否则少提的条目会被误读为簇更少。
        failed.push(theme.name);
        runs.note(runId, `跳过 ${theme.name}：一条脱敏代表句都没有，起不了名`);
        continue;
      }
      proposals.push(proposal);
      runs.note(
        runId,
        `提案 ${label} → 「${proposal.codeName}」` +
          `（吸走 ${proposal.cannibalizedTotal}/${proposal.candidateUnits}）`,
        "落库",
      );
    } catch (err) {
      failed.push(theme.name);
      runs.note(runId, `失败 ${theme.name}：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (proposals.length === 0) {
    runs.fail(runId, `${themes.length} 个主题一条提案都没提成：${failed.join("、")}`);
    return;
  }

  const ids: string[] = [];
  for (const p of proposals) {
    ids.push(await deps.raise({ proposalId: p.proposalId, actor: input.actor, proposal: p }));
  }

  const result: ProposeCodeResult = { proposalIds: ids, themeTotal: all.length, proposals };
  runs.finish(
    runId,
    result,
    failed.length === 0
      ? `完成：${ids.length} 条码提案进了待审队列。codebook 一行未动——采纳要开新版本，那是人的决定`
      : `完成：${ids.length} 条码提案，${failed.length} 个主题没提成（${failed.join("、")}）`,
  );
}

async function buildOne(
  runs: CapabilityRuns,
  deps: ProposeCodeDeps,
  theme: ThemeMembers,
  runId: string,
): Promise<CodeProposal | null> {
  const texts = await deps.textsByIds([...theme.memberUnitIds, ...theme.counterUnitIds]);

  /*
   * 代表句取成员里前 N 条有脱敏文本的。
   *
   * Namer 的入参约定是"离质心最近的 5 条"，这一层拿不到质心距离
   * （`centroid_embedding_id` 在主题上，逐条算距离要读 285 个向量）。
   * 取前 N 条是近似，不声称最典型；代表句只用来让模型看懂这一簇，不进任何计数。
   */
  const examples = theme.memberUnitIds
    .map((id) => texts.get(id))
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .slice(0, EXEMPLARS_PER_PROPOSAL);
  if (examples.length === 0) return null;

  const counterExamples = theme.counterUnitIds
    .map((id) => texts.get(id))
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .slice(0, 2);

  const named = await deps.nameOne({ runId, themeId: theme.id, examples, counterExamples });
  if (!named) return null;

  // 这一步在 `nameOne` 之后：算出的数字不能进提示词。
  const cannibalization = await deps.otherCodesFor(theme.memberUnitIds);
  runs.note(
    runId,
    cannibalization.length === 0
      ? `重叠：${theme.name} 的 ${theme.memberUnitIds.length} 个候选单元，一个都没挂别的需求码`
      : `重叠：${cannibalization.map((c) => `${c.code} ${c.units}`).join("、")}`,
  );

  return {
    proposalId: `prop-${randomUUID()}`,
    themeId: theme.id,
    themeName: theme.name,
    codeName: named.name,
    definition: named.definition,
    include: named.include,
    exclude: named.exclude,
    exemplars: examples,
    candidateUnits: theme.memberUnitIds.length,
    cannibalization,
    cannibalizedTotal: cannibalization.reduce((n, c) => n + c.units, 0),
  };
}

/**
 * 待审 = 提出来了、还没被决定。
 *
 * 判据是"有没有对应的 `code-proposal-decided`"，不是提案的状态字段：
 * 这张表只追加，记录发生过什么，不设可改成"已处理"的列。
 */
export function pendingProposals<T extends { kind: string; subjectId: string }>(rows: readonly T[]): T[] {
  const decided = new Set(rows.filter((r) => r.kind === PROPOSAL_DECIDED).map((r) => r.subjectId));
  return rows.filter((r) => r.kind === PROPOSAL_RAISED && !decided.has(r.subjectId));
}
