/**
 * 「问它」的两跳：探查跳经 ACP，收口跳直连 `generateObject`。
 *
 * # 与 Challenger 同形，但产出与职责不同
 *
 * `stages/challenge.ts` 负责推翻一张卡，产出落 `research_challenges`。
 * 本文件处理研究员的当面提问，产出是一份 `AgentNote`，不写库：它是研究员的草稿
 * （设计稿 §6：图在 Agent 返回后只写洞察卡、挑战记录、码提案三样）。
 * 因此这里没有 repo、没有 create，只有两跳与一次引用核对。
 *
 * # 探查跳原样复用 `exploreAcp`
 *
 * 该函数是 Challenger 回滚路径的一半，改签名会把两条无关的演进绑在一起。
 * 选哪个 Agent 的 pi 进程不由它的 `agent` 选项决定，而由装配层给的 streamer
 * （`createAcpStreamer(pool.clientFor(agent), …)` 的 `resolve` 回调）决定，
 * 所以每个问答 Agent 各有一条 streamer。
 *
 * # 收口跳只整理，不新增
 *
 * 这一跳没有任何工具，输入只有探查跳的文字。提示词明确规定：探查记录里没提到的
 * 结论、数字、id 一律不许出现，防止模型用常识把"没查到"补成一段分析。
 *
 * # 引用核对在代码里，不在提示词里（约束 2）
 *
 * `citedUnitIds` / `citedThemeIds` 与 tools-endpoint 记下的"本轮工具实际返回过的 id"
 * 取交集，其余剥掉并在 `caveats` 里说明剥了几条。编造的 `unit-0007` 在界面上
 * 与真实 id 无法区分，研究员会据此去查不存在的证据。
 */

import { generateObject } from "ai";

import type { ChatStreamer } from "@cabinhug/acp";
import {
  agentNoteSchema,
  type AgentNote,
  type AskAgentName,
  type SelectionScope,
} from "@cabinhug/research";

import type { StepState } from "../acp/tools-endpoint";
import { exploreAcp } from "../challenge/acp-transport";
import { usageOf, type ResearchModel, type ResearchUsage } from "../llm";

/**
 * 备好的范围上下文。由编排器取数，本文件不依赖仓储。
 *
 * `headline` 一句话说清问的是哪一格 / 行 / 卡 / 屏；`facts` 是已知的数字与定义，
 * 一行一条。被抑制的格只给"样本不足"：明细在快照阶段已清空，
 * 在这里补数字会绕过 G1。
 */
export interface AskContext {
  headline: string;
  facts: readonly string[];
}

export interface AskInput {
  agent: AskAgentName;
  scope: SelectionScope;
  contractId: string;
  question: string;
  /** 第几轮（从 1 起）。第 ≥2 轮不重发范围描述，pi 会话里保留着上一轮。 */
  round: number;
  context: AskContext;
}

export interface AskDeps {
  streamer: ChatStreamer;
  /** 这一次提问落在哪个 pi 会话上（`askSessionKey`）。同一范围的追问同键。 */
  sessionKey: string;
  stepsOf: (sessionKey: string) => StepState | undefined;
  /** 本轮工具返回过哪些 id。引用核对的白名单，必须在 `release` 之前读。 */
  seenIdsOf: (sessionKey: string) => ReadonlySet<string> | undefined;
  timeoutMs: number;
  /** 收口跳的模型。探查跳的模型在 pi 那边，由 `.pi/settings.json` 定。 */
  model: ResearchModel;
  recordUsage?: (u: ResearchUsage) => Promise<void> | void;
  /** 登记本轮取数（顺带把上一轮的计步与 id 账归零）。 */
  register: (key: string) => void;
  /** 摘掉本轮取数并销账。成功与抛错都要调，否则下一轮会带着上一轮的步数起手。 */
  release: (key: string) => void;
}

export interface AskResult {
  note: AgentNote;
  steps: number;
  hitLimit: boolean;
  /** 被剥掉的引用条数。0 表示模型引用的每一条都由工具返回过。 */
  strippedCitations: number;
}

/** 追问轮接在问句前的一句话。测试逐字断言它，不在别处重复定义。 */
export const FOLLOW_ON_NOTE = "承接同一范围的上一轮（你手里还留着上一轮查过的东西）。";

/** 剥掉引用时追加进 `caveats` 的那句话。前缀固定，界面按它认这一条。 */
export const CITATION_CAVEAT_PREFIX = "引用核对：";

/** `caveats` 的上界（与 `agentNoteSchema` 同源）。追加那一句不能把笔记撑破 schema。 */
const CAVEATS_MAX = 5;

/**
 * 问一次。
 *
 * 顺序固定：登记 → 探查 → 读 id 账 → 收口 → 核对引用 → 摘掉。
 * 读 id 账必须在 `release` 之前（`release` 会销掉那一行），之后读到的恒为
 * `undefined`，每一条引用都会被剥掉。
 */
export async function ask(input: AskInput, deps: AskDeps): Promise<AskResult> {
  const brief = composeAskBrief(input);
  const system = composeAskSystem(input);
  /*
   * 用量归到被问的 Agent（`research-analyst` / `-taxonomist` / `-archivist`）。
   * `exploreAcp` 的 `usageFrom` 写死 `research-challenger`，收口模型的 `usageOf` 按模型
   * 种类记，两处都为 Challenger 设计；原样透传会把这三个 Agent 的用量记到别处，
   * 且 `llm_usage` 行数不变、难以察觉。在这里改 `agent` 而不改那两处：
   * 本文件是唯一知道"这次问的是谁"的地方。
   */
  const recordUsage = deps.recordUsage
    ? (u: ResearchUsage) => deps.recordUsage?.({ ...u, agent: `research-${input.agent}` })
    : undefined;

  deps.register(deps.sessionKey);
  try {
    const explored = await exploreAcp(
      { brief, system },
      {
        streamer: deps.streamer,
        sessionKey: deps.sessionKey,
        stepsOf: deps.stepsOf,
        timeoutMs: deps.timeoutMs,
        ...(recordUsage ? { recordUsage } : {}),
      },
    );

    // 在 release 之前读，见函数头。拿不到表示本轮工具没有返回任何 id。
    const seenIds = deps.seenIdsOf(deps.sessionKey) ?? new Set<string>();

    const wrapUp = await generateObject({
      model: deps.model.model,
      schema: agentNoteSchema,
      system,
      prompt: wrapUpPrompt(input.question, explored.text, explored.hitLimit),
      temperature: 0,
    });
    await recordUsage?.(
      usageOf(deps.model, wrapUp.usage, wrapUp.providerMetadata as Record<string, unknown> | undefined),
    );

    const { note, stripped } = checkCitations(wrapUp.object, seenIds);
    return { note, steps: explored.steps, hitLimit: explored.hitLimit, strippedCitations: stripped };
  } finally {
    /*
     * 失败路径同样要摘：否则该键的计步行保留上一轮的步数，
     * 下一轮可能一开始就"步数已用满"（tools-endpoint 文件头第 4 条）。
     */
    deps.release(deps.sessionKey);
  }
}

/**
 * 发给 pi 的 user 消息。
 *
 * 第 1 轮 = 范围描述 + 已知数字 + 问句；第 ≥2 轮 = 只有问句加一句承接。
 * pi 会话里已有范围描述，重发会让同一段上下文在历史里出现两遍，
 * 模型会把它读成研究员再次强调这一格。
 */
export function composeAskBrief(input: AskInput): string {
  if (input.round >= 2) {
    return [FOLLOW_ON_NOTE, "", "── 研究员的问题 ──", input.question.trim()].join("\n");
  }
  return [
    "── 这次问的范围 ──",
    input.context.headline,
    "",
    "── 已知的数字与定义 ──",
    ...factLines(input.context),
    "",
    "── 研究员的问题 ──",
    input.question.trim(),
    "",
    "先用你手上的只读工具去查，再回答。答案里逐条写出你引用的 unitId / themeId——" +
      "没查到就说没查到，不要凭印象给一个数字。",
  ].join("\n");
}

/**
 * 两跳共用的 system：只放范围上下文。
 *
 * 角色的职责说明（"我准备什么 / 我绝不决定什么"）是 pi 进程级的系统提示词
 * （`pi-research/prompts/<agent>.md`，经 `--append-system-prompt` 注入），
 * 不在这里重复，避免两套会分叉的口径。
 * 与 `stages/challenge.ts` 同口径：acp 路径上 `system` 只有收口跳读得到。
 */
export function composeAskSystem(input: AskInput): string {
  return [
    `你正在回答研究员针对一个具体范围提的问题（研究合同 ${input.contractId}）。`,
    "",
    "── 这次问的范围 ──",
    input.context.headline,
    "",
    "── 已知的数字与定义 ──",
    ...factLines(input.context),
  ].join("\n");
}

/**
 * 已知数字那几行。
 *
 * 一条都没有时明确说出，不留白：留白会被模型读成"这一格什么都没有"，
 * 而实际含义是"未提供数字，需自行去查"。
 */
function factLines(context: AskContext): string[] {
  if (context.facts.length === 0) return ["- （这一范围上没有已知数字，自己用工具查）"];
  return context.facts.map((f) => `- ${f}`);
}

/** 收口跳的 prompt。只整理，不新增：这一跳没有任何工具。 */
function wrapUpPrompt(question: string, exploredText: string, hitLimit: boolean): string {
  return [
    `研究员问的是：${question.trim()}`,
    "",
    "下面是你刚才的探查过程记录：",
    exploredText || "（没有产出文字）",
    "",
    "把上面这段整理成一份结构化笔记。**只整理，不新增**：" +
      "探查记录里没提到的结论、数字、证据 id 一律不许出现——你在这一跳手里没有任何工具，" +
      "查不了任何东西，凭印象补上的那一条与查出来的那一条在界面上长得一模一样。",
    "`citedUnitIds` / `citedThemeIds` 只填探查记录里出现过的 id；一条都没有就留空数组。",
    hitLimit
      ? "⚠️ 工具步数已用满或探查超时：没查清楚的写进 `caveats`，**不要当成查过了**。"
      : "没查清楚的写进 `caveats`，不要把没查到说成没有。",
  ].join("\n");
}

/**
 * 引用核对：只留工具实际返回过的 id（约束 2）。
 *
 * 剥掉的条数要写明，否则被剥空引用的笔记会被误读为"这次没有引用"，
 * 而实际是"引用全部无法核实"。
 */
export function checkCitations(
  raw: AgentNote,
  seenIds: ReadonlySet<string>,
): { note: AgentNote; stripped: number } {
  const citedUnitIds = raw.citedUnitIds.filter((id) => seenIds.has(id));
  const citedThemeIds = raw.citedThemeIds.filter((id) => seenIds.has(id));
  const stripped =
    raw.citedUnitIds.length - citedUnitIds.length + (raw.citedThemeIds.length - citedThemeIds.length);
  if (stripped === 0) return { note: { ...raw, citedUnitIds, citedThemeIds }, stripped };

  /*
   * `caveats` 的上界是 5（由 schema 定，冒烟会用 `agentNoteSchema` 再验一次产出）。
   * 满了就挤掉模型写的最后一条；核对这一句永远保留，
   * 它是"这份笔记的引用有问题"的唯一提示。
   */
  const line = `${CITATION_CAVEAT_PREFIX}剥掉 ${stripped} 条工具没返回过的 id`;
  const caveats = [...raw.caveats.slice(0, CAVEATS_MAX - 1), line];
  return { note: { ...raw, citedUnitIds, citedThemeIds, caveats }, stripped };
}
