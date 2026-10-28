/**
 * Challenger 探查那一跳的两条 transport（ACR-038）。
 *
 * # 只有探查跳有两种跑法，收口跳不变
 *
 * `challenger.ts` 是两段式：先带只读工具查（本文件），再 `generateObject(challengeSchema)`
 * 收口（不在本文件，也不随本文件改动）。两条路径给收口跳的形状相同，都是
 * `{ text, steps, hitLimit }`，所以切开关不改判定口径、表或端点。
 *
 * # 两条路径的 system / user 拼法不逐字相同
 *
 * | | direct | acp |
 * |---|---|---|
 * | 判定口径（四问） | `composeSystem()` 拼进 `system` 参数 | pi 进程启动时经 `--append-system-prompt` 注入（`bin/pi-approved.sh`，进程级） |
 * | 追问角度 | 同样拼进 `system`（`composeSystem` 的追加段） | 进**本轮 user 消息的第一段**，标题用同一个 `EXTRA_ANGLE_HEADING` |
 * | brief | `prompt` 参数 | user 消息，接在角度段后面 |
 *
 * 角度在 acp 下不能走 system：系统提示词按进程固定，一个 pi 进程先后服务多次挑战，
 * 放进去的角度会影响后续所有挑战。两段文字的内容与顺序一致（口径在前、角度在后、
 * brief 最后），区别只在"哪一段算 system"。判定口径两条路读同一个文件
 * （`pi-research/prompts/challenger.md`，见 `index.ts` 的装配）。
 *
 * # `temperature: 0` 在 acp 下没有对应物
 *
 * pi 不暴露 temperature，接受这一差异：思考档恒 `off`（`research-app.ts` 的
 * `thinkingFor`），产出还要经收口跳结构化，探查跳的随机性只影响"查了什么"，
 * 不影响"怎么判"。
 *
 * # `hitLimit` 只从回调面取，不数文本
 *
 * pi 的工具调用不进 `agent_message_chunk`（底座 `update-bridge` 只投影文本片），
 * 流拼出的文字里看不见工具调用。步数的唯一真相源是 `tools-endpoint` 按 pi 会话计的表。
 * 数文本关键词为 ADR-012 所禁止，也数不准。
 */

import { generateText } from "ai";

import type { ChatStreamer, LlmUsageSample } from "@cabinhug/acp";

import type { StepState } from "../acp/tools-endpoint";
import type { ResearchUsage } from "../llm";
/*
 * 与 `challenger.ts` 互相 import（它调本文件的两个 explore，本文件取它的标题常量）。
 * 环是安全的：这里只在函数体里读那个常量，此时两个模块都已求值完毕。
 * 不复制字面量：追加段的标题在两条 transport 上必须逐字相同。
 */
import { EXTRA_ANGLE_HEADING } from "./challenger";

export type ChallengerTransport = "direct" | "acp";

/** 开关的环境变量名。冒烟脚本与测试都读这一个常量，不各写一份字面量。 */
export const CHALLENGER_TRANSPORT_ENV = "RESEARCH_CHALLENGER_TRANSPORT";

/** 开关缺省 `acp`；`direct` 是回滚值（`.env.example` 的 `RESEARCH_CHALLENGER_TRANSPORT` 一行）。 */
export const DEFAULT_CHALLENGER_TRANSPORT: ChallengerTransport = "acp";

/** ACP 一次探查的超时。缺省 3 分钟：8 步工具循环加模型思考，通常 1–2 分钟。 */
export const CHALLENGER_ACP_TIMEOUT_ENV = "RESEARCH_CHALLENGER_ACP_TIMEOUT_MS";
export const DEFAULT_ACP_TIMEOUT_MS = 180_000;

/** 超时后等流自己收尾（好让 `onUsage` 还有机会报一次用量）的宽限。 */
const TIMEOUT_GRACE_MS = 1_000;

/** 超时时接在过程记录末尾的那句话。收口跳会读到它，冒烟与用例按它断言。 */
export const ACP_TIMEOUT_NOTE = "⚠️ 探查超时";

/**
 * 读开关。缺省是 `acp`，`direct` 是回滚值：回滚即把 `RESEARCH_CHALLENGER_TRANSPORT`
 * 设成 `direct`，无需改代码。
 *
 * 认不出的值一律回缺省并 warn，不切到另一条路径：两条路径产出的记录形状相同，
 * 拼错的环境变量若静默换路径，库里无从分辨。
 */
export function readChallengerTransport(
  env: Record<string, string | undefined> = process.env,
): ChallengerTransport {
  const raw = env[CHALLENGER_TRANSPORT_ENV]?.trim();
  if (!raw) return DEFAULT_CHALLENGER_TRANSPORT;
  if (raw === "direct" || raw === "acp") return raw;
  console.warn(
    `[research-runtime] ${CHALLENGER_TRANSPORT_ENV}=${raw} 不认识——只有 direct / acp，本次按缺省 ${DEFAULT_CHALLENGER_TRANSPORT} 跑`,
  );
  return DEFAULT_CHALLENGER_TRANSPORT;
}

/** 超时毫秒数。非正数与非数字一律回缺省，不接受"0 = 永不超时"那种读法。 */
export function readChallengerAcpTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const n = Number(env[CHALLENGER_ACP_TIMEOUT_ENV]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ACP_TIMEOUT_MS;
}

/** 探查跳的产出。两条路径都给这一份，收口跳只认它。 */
export interface ExploreResult {
  /** 过程记录：模型这一跳说了什么。收口跳把它原样贴进 prompt。 */
  text: string;
  /** 走了几步工具循环。 */
  steps: number;
  /** 步数用满或超时。收口跳据此把 `holds` 强制降成 `inconclusive`。 */
  hitLimit: boolean;
  /** 实际跑的模型名（acp 下来自 pi 的 `.pi/settings.json`）。拿不到就 undefined。 */
  model?: string;
}

/** 探查跳的输入。两条路径共用，`system` 只有 direct 使用，见文件头的对照表。 */
export interface ExploreInput {
  brief: string;
  /** 判定口径（`composeSystem` 的产物）。acp 下它已在 pi 的系统提示词里。 */
  system: string;
  /** 研究员补的调查角度（C7）。acp 下它进 user 消息第一段。 */
  extraAngle?: string;
}

/** direct 路径的依赖：模型与工具。 */
export interface ExploreDirectDeps {
  model: { model: Parameters<typeof generateText>[0]["model"] };
  tools: Parameters<typeof generateText>[0]["tools"];
  maxSteps: number;
}

/**
 * 直连探查：AI SDK 自己跑工具循环。
 *
 * 参数与引入 ACP 之前的 `generateText` 调用保持一致：它是 ACR-038 的回滚路径，
 * 回滚只需切一行环境变量。
 */
export async function exploreDirect(
  input: ExploreInput,
  deps: ExploreDirectDeps,
): Promise<ExploreResult> {
  const explored = await generateText({
    model: deps.model.model,
    system: input.system,
    prompt: input.brief,
    tools: deps.tools,
    maxSteps: deps.maxSteps,
    temperature: 0,
  });

  const steps = explored.steps?.length ?? 1;
  return { text: explored.text, steps, hitLimit: steps >= deps.maxSteps };
}

/** acp 路径的依赖。由 `index.ts` 装配、`challengeOne` 按卡补上 `sessionKey`。 */
export interface ExploreAcpDeps {
  streamer: ChatStreamer;
  /** 这一次挑战的会话键（`challengeSessionKey`）。pi 会话按它索引。 */
  sessionKey: string;
  /** 这个会话键走了几步、有没有撞上界。真相源是 `tools-endpoint`。 */
  stepsOf: (sessionKey: string) => StepState | undefined;
  timeoutMs: number;
  /** 探查跳的用量记账。直连路径的探查跳不记用量，acp 路径记。 */
  recordUsage?: (u: ResearchUsage) => Promise<void> | void;
}

/**
 * ACP 探查：给 pi 会话发一次 `session/prompt`，工具由 pi 自己循环。
 *
 * 追问角度接在 brief 前面而不是拼进 system，理由见文件头。
 */
export async function exploreAcp(input: ExploreInput, deps: ExploreAcpDeps): Promise<ExploreResult> {
  const content = [angleBlock(input.extraAngle), input.brief].filter(Boolean).join("\n\n");

  /*
   * 用量在流结束时由底座回调一次（估算值，`EST_TOKENS_PER_CHAR`）。
   * 串成一条链而不是各自 fire-and-forget：记账先后无关紧要，但必须能等到记完，
   * 避免挑战写完时用量尚未落库。
   */
  let usageDone: Promise<void> = Promise.resolve();
  let model: string | undefined;
  const controller = new AbortController();
  const onUsage = (s: LlmUsageSample): void => {
    model = s.model;
    const u = usageFrom(s);
    usageDone = usageDone.then(() => deps.recordUsage?.(u)).then(
      () => undefined,
      (err: unknown) =>
        console.warn(
          `[research-runtime] 探查跳用量记账失败：${err instanceof Error ? err.message : String(err)}`,
        ),
    );
  };

  const it = deps.streamer([{ role: "user", content }], {
    threadId: deps.sessionKey,
    agent: "challenger",
    signal: controller.signal,
    onUsage,
  })[Symbol.asyncIterator]();

  let text = "";
  let timedOut = false;
  const deadline = Date.now() + deps.timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      timedOut = true;
      break;
    }
    const step = await raceWithDeadline(it.next(), remaining);
    if (step === TIMED_OUT) {
      timedOut = true;
      break;
    }
    if (step.done) break;
    text += step.value;
  }

  if (timedOut) {
    console.warn(
      `[research-runtime] 探查超时（${deps.timeoutMs}ms，会话 ${deps.sessionKey}）——` +
        "按步数用满处理，仍然进收口跳",
    );
    controller.abort();
    // 让流自己收尾：底座在 `finally` 里回调 `onUsage`。
    // 只等宽限期：流可能已无输出，这正是超时的原因。
    await raceWithDeadline(Promise.resolve(it.return?.(undefined)), TIMEOUT_GRACE_MS);
    text = text ? `${text}\n\n${ACP_TIMEOUT_NOTE}` : ACP_TIMEOUT_NOTE;
  }
  await usageDone;

  const st = deps.stepsOf(deps.sessionKey);
  if (!st) {
    // 一步工具都没调时（模型直接出文字）也会走到这里。不编造步数。
    console.warn(
      `[research-runtime] 会话 ${deps.sessionKey} 没有步数记录——这一跳按 0 步记` +
        "（模型可能一个工具都没调）",
    );
  }
  return {
    text,
    steps: st?.steps ?? 0,
    hitLimit: timedOut || st?.hitLimit === true,
    ...(model ? { model } : {}),
  };
}

/**
 * 一次挑战的会话键。追问与它追的那张卡同键（ACR-038），落到同一个 pi 会话里，
 * 模型带着上一轮的上下文继续查。
 *
 * C6 单卡触发带 `runId`，每次点击各起一个会话，是一次独立的挑战，
 * 与批量路径不共享上下文。C7 追问不传 runId 给本函数，见 `stages/challenge.ts`。
 */
export function challengeSessionKey(insightId: string, runId?: string): string {
  return runId ? `challenge:${insightId}:${runId}` : `challenge:${insightId}`;
}

/** 追问角度那一段。标题与 `composeSystem` 同一个常量，措辞逐字相同。 */
function angleBlock(extraAngle?: string): string {
  const angle = extraAngle?.trim();
  if (!angle) return "";
  return [
    `── ${EXTRA_ANGLE_HEADING} ──`,
    angle,
    "",
    "上面这一段是**额外要查的角度**，不改变你的判定口径与四问：" +
      "查不出东西就照常判 inconclusive，不要为了回应它而给一个更强的判决。",
  ].join("\n");
}

/** 估算用量 → 研究面的记账形状。`provider` 记 `pi-acp`，与直连那条分得开。 */
function usageFrom(s: LlmUsageSample): ResearchUsage {
  return {
    agent: "research-challenger",
    provider: "pi-acp",
    model: s.model,
    promptTokens: s.promptTokens,
    completionTokens: s.completionTokens,
    /*
     * 恒 0：pi 路径拿不到 reasoning 计数，且这一档的思考恒关
     * （`research-app.ts` 的 `thinkingFor`）。不记估算值。
     */
    reasoningTokens: 0,
  };
}

const TIMED_OUT = Symbol("timed-out");

/**
 * 等一个 promise，但最多等这么久。
 *
 * 超时后那个 promise 仍在执行，先接住它的失败，否则稍后 reject 时成为
 * 未处理的 rejection。
 */
async function raceWithDeadline<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  p.then(
    () => undefined,
    () => undefined,
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<typeof TIMED_OUT>((res) => {
        timer = setTimeout(() => res(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
