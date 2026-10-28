/**
 * Challenger：带只读工具去推翻一张 Insight Card。
 *
 * # 使用 AI SDK 原生 `tools`
 *
 * 其余三个 Agent 都是一次 `generateObject`。这一个需要工具循环：
 * 找反驳证据时事先不知道要查什么。
 *
 * # 两段式：先查，再结构化收尾
 *
 * 先让模型自己决定查什么，再另起一次 `generateObject` 把结论收成可落库的形状。
 * 不合成一步：带工具的结构化输出在 SDK 里不稳定，查完却没产出 JSON 会让整次挑战作废。
 *
 * # 探查跳有两条路，收口跳只有一条
 *
 * 探查的跑法由 `deps.transport` 选：`direct` 是 AI SDK 的
 * `generateText({ tools, maxSteps })`，`acp` 是给 pi 会话发一次 `session/prompt`、
 * 工具由 pi 自己循环（两条路径的拼法对照见 `acp-transport.ts` 文件头）。
 * 收口跳与两者无关：同一份 `challengeSchema`、同一段 prompt、同一条超限降级，
 * 只认探查跳给的 `{ text, steps, hitLimit }`。
 *
 * # 超限是 inconclusive，不是 holds
 *
 * 工具用完仍没查清楚 → `inconclusive`。判 `holds`（"没找到反例"）会把
 * "没查完"说成"查过了没问题"，这正是这个 Agent 要防的错误。
 *
 * # 追问只追加 system，不替换
 *
 * 研究员补的调查角度经 `composeSystem` 接在 `deps.systemPrompt` 之后。
 * 替换会让同一张表混进另一套口径下的判决，且记录形状相同、无法区分。
 * 两跳用同一份 system，保证查与写在同一套口径下。
 */

import { generateObject } from "ai";
import { z } from "zod";

import { usageOf, type ResearchModel, type ResearchUsage } from "../llm";
import {
  exploreAcp,
  exploreDirect,
  type ChallengerTransport,
  type ExploreAcpDeps,
} from "./acp-transport";
import { CHALLENGE_MAX_STEPS, createChallengeTools, type ChallengeToolDeps } from "./tools";

export const challengeSchema = z.object({
  challenges: z
    .array(
      z.object({
        kind: z.enum(["counter-evidence", "alternative-explanation", "sensitivity"]),
        /** 一句话说清挑战了什么。 */
        summary: z.string().min(4).max(200),
        /** 与结论矛盾的证据单元 id（`findCounterEvidence` 给的那些）。 */
        contradictedUnitIds: z.array(z.string()).max(20),
        verdict: z.enum(["holds", "weakened", "refuted", "inconclusive"]),
      }),
    )
    .min(1)
    .max(6),
});

export type ChallengeOutput = z.infer<typeof challengeSchema>["challenges"][number];

export interface ChallengeInput {
  insightId: string;
  themeId: string;
  card: { claim: string; evidence: string; boundary: string };
  windowFrom: number;
  windowTo: number;
  /**
   * 研究员追问时补的调查角度（C7）。
   *
   * 它表示"再顺着这条线查一遍"，不是新的判定口径，所以由 `composeSystem`
   * 追加在 `deps.systemPrompt` 之后而不替换。替换会丢掉四问与"找不到就说找不到"
   * 的规则，而记录形状相同，库里无法区分。
   */
  extraAngle?: string;
}

/** 追加段的标题。模型要分得清哪部分是口径、哪部分是这一次补的。 */
export const EXTRA_ANGLE_HEADING = "研究员补充的调查角度";

/**
 * 系统提示词 = 口径（不变）+ 可选的追加段。
 *
 * 导出供单测逐字断言"原文全在、追加段在后面"：追加误改成替换时不会报错，
 * 只有测试能检出判定口径被换掉。
 */
export function composeSystem(systemPrompt: string, extraAngle?: string): string {
  const angle = extraAngle?.trim();
  if (!angle) return systemPrompt;
  return [
    systemPrompt,
    "",
    `── ${EXTRA_ANGLE_HEADING} ──`,
    angle,
    "",
    "上面这一段是**额外要查的角度**，不改变前面的判定口径与四问：" +
      "查不出东西就照常判 inconclusive，不要为了回应它而给一个更强的判决。",
  ].join("\n");
}

export interface ChallengeDeps extends ChallengeToolDeps {
  model: ResearchModel;
  systemPrompt: string;
  /**
   * 探查跳的跑法。未传时为 `direct`；收口跳与它无关，两条路径共用。
   * 装配点在 `index.ts`，开关是 `RESEARCH_CHALLENGER_TRANSPORT`。
   */
  transport?: ChallengerTransport;
  /**
   * acp 路径的接线。`transport === "acp"` 时必须提供，缺失即抛错：
   * 静默回落到直连会让开关失效，而两条路径的记录形状相同。
   * `sessionKey` 由 `challengeOne` 按卡补（装配层拿不到）。
   */
  acp?: Omit<ExploreAcpDeps, "sessionKey" | "recordUsage"> & { sessionKey?: string };
  /**
   * 探查跳的用量记账（acp 路径用）。收口跳那一份仍由调用方按 `ChallengeResult.usage` 记，
   * 两跳各记各的，不重不漏。
   */
  recordUsage?: (u: ResearchUsage) => Promise<void> | void;
}

export interface ChallengeResult {
  challenges: ChallengeOutput[];
  /** 实际走了几步工具循环。超上限时会是 `CHALLENGE_MAX_STEPS`。 */
  steps: number;
  usage: ResearchUsage;
  /** 这一次的探查跳跑在哪条路上。落进 `payload.transport`，两条路径的记录因此分得开。 */
  transport: ChallengerTransport;
  /** acp 下 pi 实际跑的模型名（`.pi/settings.json`）。direct 下 undefined。 */
  model?: string;
}

export async function challenge(input: ChallengeInput, deps: ChallengeDeps): Promise<ChallengeResult> {
  const brief = [
    `要挑战的结论：${input.card.claim}`,
    `它给的证据：${input.card.evidence}`,
    `它声明的边界：${input.card.boundary}`,
    "",
    `主题 id：${input.themeId}`,
    `时间窗：${input.windowFrom} – ${input.windowTo}（查系统变更时用它）`,
    "",
    "请按四问逐条查，然后给出判决。",
  ].join("\n");

  // 两跳用同一份 system，保证查与写在同一套口径下。
  const system = composeSystem(deps.systemPrompt, input.extraAngle);

  /*
   * 探查跳分叉。acp 路径的判定口径在 pi 的系统提示词里（进程级），
   * 追问角度进 user 消息第一段，拼法对照见 `acp-transport.ts` 文件头。
   * 下面的收口跳两条路径逐字共用。
   */
  const transport = deps.transport ?? "direct";
  const exploreInput = { brief, system, ...(input.extraAngle ? { extraAngle: input.extraAngle } : {}) };
  const explored =
    transport === "acp"
      ? await exploreAcp(exploreInput, acpDepsOf(deps))
      : await exploreDirect(exploreInput, {
          model: deps.model,
          tools: createChallengeTools(deps),
          maxSteps: CHALLENGE_MAX_STEPS,
        });

  const { steps, hitLimit } = explored;

  const wrapUp = await generateObject({
    model: deps.model.model,
    schema: challengeSchema,
    system,
    prompt: [
      brief,
      "",
      "你已经查过了，下面是你的过程记录：",
      explored.text || "（没有产出文字）",
      "",
      hitLimit
        ? "⚠️ 工具步数已用满。没查清楚的条目请判 `inconclusive`——**不要判 holds**：" +
          "那会把「没查完」说成「查过了没问题」。"
        : "把结论收成结构化记录。",
    ].join("\n"),
    temperature: 0,
  });

  let challenges = wrapUp.object.challenges;
  if (hitLimit) {
    // 兜底：模型仍判 holds 时强制降成 inconclusive。
    challenges = challenges.map((c) => (c.verdict === "holds" ? { ...c, verdict: "inconclusive" as const } : c));
  }

  return {
    challenges,
    steps,
    usage: usageOf(deps.model, wrapUp.usage, wrapUp.providerMetadata as Record<string, unknown> | undefined),
    transport,
    ...(explored.model ? { model: explored.model } : {}),
  };
}

/**
 * 取 acp 的接线，缺一样即抛错。
 *
 * 不回落到 direct：开关为 acp 而实际跑 direct 时记录形状相同，
 * `payload.transport` 也无法写对。让这张卡失败。
 */
function acpDepsOf(deps: ChallengeDeps): Parameters<typeof exploreAcp>[1] {
  if (!deps.acp?.sessionKey) {
    throw new Error(
      "transport=acp 但没有 ACP 接线（streamer / sessionKey）——" +
        "装配点在 index.ts，会话键由 challengeOne 按卡补",
    );
  }
  return {
    ...deps.acp,
    sessionKey: deps.acp.sessionKey,
    ...(deps.recordUsage ? { recordUsage: deps.recordUsage } : {}),
  };
}
