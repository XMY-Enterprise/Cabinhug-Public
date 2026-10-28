/**
 * 四条 `🔍` 查类能力：C2 找反例 / C3 这是我们自己干的吗 /
 * C4 谁被漏掉了 / C5 换个阈值还成立吗。
 *
 * # 这一层只把「格」翻成工具要的参数
 *
 * 四个工具（`challenge/tools.ts`）也被 Challenger 的工具循环使用；本模块是不经模型的
 * 入口：`scope` → 工具参数 → 直调 `execute` → 原样回结果 + 来源标注。
 *
 * 不另写查询：工具的只读性由 `test/challenge.test.ts` 的源码扫描守着，
 * 绕过工具另写查询会让这条扫描失效。
 *
 * # 一个需求码下有多个主题，全查
 *
 * 实测（codebook 0.1.0）：36 个主题落在 10 个需求码上，每个码 2–4 个，没有 `null`。
 * 只取证据量最大的主题会丢掉同码下的其余主题，而界面上看不出来：某一格的反例
 * 实际只来自其中一个主题。所以逐个查完合并，每条带主题来源，代价是最多 4 次工具调用。
 *
 * # 一律不写库
 *
 * `🔍` 层的产出直接回给界面，不落 `research_insights` / `research_challenges` /
 * 任何表，因此不涉及 `inputs_hash`（它只管落库的产出）。
 * 界面需说明"这是即时查询结果，不是一条被记录的结论"。
 */

import type { createChallengeTools } from "../challenge/tools";
import { TOOL_LIMIT_MAX } from "../challenge/tools";

type Tools = ReturnType<typeof createChallengeTools>;

/**
 * 直调工具的 `execute`。
 *
 * 第二个参数是 AI SDK 给模型循环用的 `ToolExecutionOptions`（`toolCallId` /
 * `messages` / `abortSignal`）。四个工具的实现都不读它；这一层不经模型，
 * 没有 toolCallId 可给，所以传空对象，并在此集中说明。
 */
const NO_TOOL_CONTEXT = {} as never;

/** 一个需求码下最多查几个主题。实测最多 4 个，留一倍余量；超出时标记截断。 */
export const MAX_THEMES_PER_CODE = 8;

/** C5 缺省探哪几个 delta。翻转与不翻转都列出来。 */
export const DEFAULT_DELTAS: readonly number[] = [-0.1, -0.05, 0.05, 0.1];

export interface ThemeRef {
  id: string;
  name: string;
}

export interface LookupDeps {
  tools: Tools;
  /** 这个需求码下的全部主题。顺序即结果顺序（按证据量降序更好读，由调用方保证）。 */
  themesByCode(code: string): Promise<ThemeRef[]>;
  /**
   * 这次研究合同声明的窗口，不是"最近 90 天"。
   *
   * 用别的窗口查出的系统变更与格里的数字不在同一段时间上，且不会报错。
   * 它是构造期定死的字段而不是回调：`createChallengeToolDeps` 构造时也用这个窗口，
   * 回调形式会允许工具与 C3 落在两个不同的窗上。
   */
  window: { from: number; to: number };
}

/** 四条能力共用的返回信封：谁查的、查了哪些主题、有没有被截断。 */
interface WithThemes {
  themes: ThemeRef[];
  /** 该码下的主题总数。与 `themes.length` 不等即说明被截断了。 */
  themeTotal: number;
  truncated: boolean;
}

async function themesFor(deps: LookupDeps, code: string): Promise<WithThemes> {
  const all = await deps.themesByCode(code);
  const themes = all.slice(0, MAX_THEMES_PER_CODE);
  return { themes, themeTotal: all.length, truncated: all.length > themes.length };
}

// ── C2 找反例 ────────────────────────────────────────────

export interface CounterEvidenceItem {
  unitId: string;
  text: string;
  themeId: string;
  themeName: string;
}

export interface CounterEvidenceList extends WithThemes {
  /** 合并后的条数。 */
  count: number;
  units: CounterEvidenceItem[];
  /**
   * 每个主题各出了几条。0 条的主题也保留：合并后无法看出哪个主题没有反例，
   * 而这正是这条能力要回答的。
   */
  perTheme: Array<{ themeId: string; themeName: string; count: number }>;
}

export async function findCounterEvidence(
  deps: LookupDeps,
  needPainCode: string,
  limit = 10,
): Promise<CounterEvidenceList> {
  const capped = Math.min(Math.max(1, limit), TOOL_LIMIT_MAX);
  const ctx = await themesFor(deps, needPainCode);
  const units: CounterEvidenceItem[] = [];
  const perTheme: CounterEvidenceList["perTheme"] = [];

  for (const t of ctx.themes) {
    const out = await deps.tools.findCounterEvidence.execute!(
      { themeId: t.id, limit: capped },
      NO_TOOL_CONTEXT,
    );
    perTheme.push({ themeId: t.id, themeName: t.name, count: out.count });
    for (const u of out.units) units.push({ ...u, themeId: t.id, themeName: t.name });
  }

  return { ...ctx, count: units.length, units, perTheme };
}

// ── C3 这是我们自己干的吗 ─────────────────────────────────

export interface SystemEventOverlap {
  window: { from: number; to: number };
  count: number;
  events: Array<{
    at: number;
    kind: string;
    summary: string;
    /**
     * 是否落在近半窗。矩阵的方向比的就是近半窗 vs 前半窗，
     * 所以只有近半窗里的变更才可能解释掉这次方向变化。
     */
    inRecentHalf: boolean;
  }>;
}

export async function systemEventsFor(deps: LookupDeps): Promise<SystemEventOverlap> {
  const { window } = deps;
  const out = await deps.tools.listSystemEvents.execute!(window, NO_TOOL_CONTEXT);
  const midpoint = (window.from + window.to) / 2;
  return {
    window,
    count: out.count,
    // 时间倒序：最近发生的最可能是这次变化的解释。
    events: out.events
      .map((e) => ({ at: e.at, kind: e.kind, summary: e.summary, inRecentHalf: e.at >= midpoint }))
      .sort((a, b) => b.at - a.at),
  };
}

// ── C4 谁被漏掉了 ────────────────────────────────────────

export interface SegmentSlice extends WithThemes {
  perTheme: Array<{
    themeId: string;
    themeName: string;
    slices: Array<{ segment: string; n: number; share: number }>;
    /** 最大的那一份，回答"是否只集中在一小撮车上"。 */
    topShare: number;
    topSegment: string | null;
  }>;
}

export async function sliceBySegment(deps: LookupDeps, needPainCode: string): Promise<SegmentSlice> {
  const ctx = await themesFor(deps, needPainCode);
  const perTheme: SegmentSlice["perTheme"] = [];

  for (const t of ctx.themes) {
    const out = await deps.tools.sliceBySegment.execute!({ themeId: t.id }, NO_TOOL_CONTEXT);
    const top = [...out.slices].sort((a, b) => b.share - a.share)[0];
    perTheme.push({
      themeId: t.id,
      themeName: t.name,
      slices: out.slices,
      topShare: top?.share ?? 0,
      topSegment: top?.segment ?? null,
    });
  }

  return { ...ctx, perTheme };
}

// ── C5 换个阈值还成立吗 ──────────────────────────────────

export interface ThresholdSensitivity {
  code: string;
  probes: Array<{ delta: number; flips: boolean; detail: string }>;
  /** 是否有任何一个 delta 翻了象限。 */
  anyFlips: boolean;
  /** 最小的翻转幅度。没有翻转时为 `null`，不写 0（0 会被读成"动一点就翻"）。 */
  minFlipDelta: number | null;
}

export async function thresholdSensitivity(
  deps: LookupDeps,
  code: string,
  deltas: readonly number[] = DEFAULT_DELTAS,
): Promise<ThresholdSensitivity> {
  const probes: ThresholdSensitivity["probes"] = [];
  for (const delta of deltas) {
    const out = await deps.tools.thresholdSensitivity.execute!({ code, delta }, NO_TOOL_CONTEXT);
    probes.push({ delta, flips: out.flips, detail: out.detail });
  }
  const flipped = probes.filter((p) => p.flips).map((p) => Math.abs(p.delta));
  return {
    code,
    probes,
    anyFlips: flipped.length > 0,
    minFlipDelta: flipped.length > 0 ? Math.min(...flipped) : null,
  };
}
