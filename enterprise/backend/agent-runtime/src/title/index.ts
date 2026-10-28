/**
 * 会话标题旁路。
 *
 * # 它是什么
 *
 * 一次性的、脱离主图的小调用：首轮对话收口之后，拿「车主问了什么 + 助手答了什么」
 * 生成一个不超过 15 字的名字，写进 `sessions.title`，再经 SSE 推给端上。
 * 一个会话只生成一次。
 *
 * # 不进主图，也不是子 Agent
 *
 * 标题不进图状态、不影响路由、不参与应答。它的约束是失败必须无声，
 * 车主不应因为标题没起出来而少收到回答；挂进主图会让每一轮都承担它的失败风险。
 *
 * 它也不走 pi/ACP：那条路要起子进程、装工具表、可能还在思考，对一个 15 字的名字
 * 是错的档位。这里固定用非推理模型直连。
 *
 * # 不放在 `sidecar/`
 *
 * `check:arch` 的 `sidecar-isolation` 禁止 `sidecar/` import `../llm`，
 * 那条边界约束的是等待期旁路够不着业务能力。标题旁路不在等待期说话、也不面向车主，
 * 不属于那个语境。
 *
 * # 兜底是截断首句
 *
 * 模型不可用（离线 / `CABINHUG_LLM=fake` / 超时 / 抛错）时回落到"车主首句截断"。
 * 那是如实转述，与旁路 L0「匹配不到就返回 undefined」不冲突：
 * 后者禁止的是用户无法证伪的断言。
 */

import { resolveDeepSeekModel } from "@cabinhug/shared";

import { thinkingForSite } from "../llm/thinking-policy";
import { createConfiguredChatStreamer } from "../llm";

/** 标题长度上限（字符数，按码位算）。 */
export const TITLE_MAX_CHARS = 15;

/**
 * 单次生成的墙钟上限。
 *
 * 8 秒是放弃线而非性能目标：标题晚到不影响功能，但挂着的请求会占住网关一侧的
 * 一个 fire-and-forget 任务。超时用兜底，不重试。
 */
const TITLE_TIMEOUT_MS = 8000;

/**
 * 人设。三条约束：
 *
 * 1. 只输出标题本身，不写「好的，这段对话的标题是：……」之类的前缀。
 * 2. 不要标点、不要引号：15 字的列表项里「」与句号都是噪音。
 *    `sanitizeTitle` 还会再清理一道。
 * 3. 说这段对话在谈什么，不复述结论：「杭州行程规划」是标题，
 *    「明天杭州多云适合出行」是被压扁的回答。
 */
export const TITLE_SYSTEM = [
  "你在给一段车载助手与车主的对话起标题。",
  `只输出标题本身，不超过 ${TITLE_MAX_CHARS} 个汉字。`,
  "不要输出引号、书名号、句号或任何解释性文字，不要写「标题：」。",
  "标题说的是这段对话在谈什么事，不是复述助手给出的结论。",
  "用中文名词短语，例如：杭州周末行程、保养周期确认、充电桩找不到。",
].join("\n");

/** 按码位截断（中文与 emoji 都不会被切成半个字）。 */
function cut(text: string, max: number): string {
  const cp = Array.from(text);
  return cp.length <= max ? text : cp.slice(0, max).join("");
}

/**
 * 把模型输出清理成能直接显示的标题。
 *
 * 纯函数，可单测。模型输出的变体（前缀、引号、换行后补解释、markdown 加粗）
 * 无法靠提示词穷举，在这里逐一去掉。
 * 清理不出内容时返回 `undefined`，由调用方回落兜底，不返回空字符串：
 * 空标题写进库后无法区分"生成过"与"没生成"。
 */
export function sanitizeTitle(raw: string): string | undefined {
  // 只取第一行：模型常常"标题 + 换行 + 为什么这么起"。
  let t = raw.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  t = t.replace(/[*`#]/g, "").trim();
  // 「标题：」「Title:」这类前缀
  t = t.replace(/^(标题|题目|title)\s*[:：]\s*/i, "");
  // 成对包裹符（可能套好几层）
  for (let i = 0; i < 3; i += 1) {
    const stripped = t.replace(/^[「『"'“”‘’《〈【\[(（]+/, "").replace(/[」』"'“”‘’》〉】\])）]+$/, "").trim();
    if (stripped === t) break;
    t = stripped;
  }
  // 结尾标点
  t = t.replace(/[。．.!！?？,，、;；:：~～]+$/, "").trim();
  if (t.length === 0) return undefined;
  return cut(t, TITLE_MAX_CHARS);
}

/**
 * 兜底：把车主首句截成标题。
 *
 * 截断时留一个省略号且总长仍在 15 以内（14 + 1），让读者看出是截短而非标题出错。
 */
export function fallbackTitle(firstUserText: string): string | undefined {
  const t = firstUserText.replace(/\s+/g, " ").trim();
  if (t.length === 0) return undefined;
  const cp = Array.from(t);
  return cp.length <= TITLE_MAX_CHARS ? t : `${cut(t, TITLE_MAX_CHARS - 1)}…`;
}

export interface TitleInput {
  /** 归账用（成本口径）：这次调用烧的 token 记到哪个会话名下。 */
  sessionId: string;
  /** 首轮的轮次 id，同样是归账用。 */
  turnId: string;
  /** 车主首句原文。 */
  userText: string;
  /** 助手首轮回答全文；被撤回或为空时传空串。 */
  assistantText: string;
}

/** 生成一个标题。除非首句为空，总能给出结果（模型不可用时回落截断）。 */
export type TitleWriter = (input: TitleInput) => Promise<string | undefined>;

/**
 * 造一个标题生成器。
 *
 * 与 `createFillerWriter` 不同（那个在离线路径下返回 `undefined`），这里任何情况下
 * 都返回可用的 writer：标题的兜底本身完整可用，离线时会话列表也应有名字。
 */
export function createTitleWriter(
  config: Parameters<typeof createConfiguredChatStreamer>[0],
  /** 用量出口（与主链路同一个计价闭包）。缺省不记（单测/离线）。 */
  recordUsage?: (sample: {
    sessionId: string;
    turnId: string;
    agent: string;
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
    durationMs: number;
    status: "ok" | "failed";
  }) => void,
): TitleWriter {
  // 离线路径不建 streamer：Fake 模型输出固定 tag（"【fake】第1轮回复…"），
  // 用作标题会像真的生成过。
  const offline = process.env.CABINHUG_LLM === "fake";
  const streamer = offline
    ? undefined
    : createConfiguredChatStreamer(config, {
        system: TITLE_SYSTEM,
        // 模型 id 不跟 `DEEPSEEK_MODEL` 走（那是主链路调档用的）；是否思考由下面的 thinking 决定：
        // DeepSeek 的模型默认思考，只换模型关不掉。
        model: resolveDeepSeekModel(process.env.CABINHUG_TITLE_MODEL),
        thinking: thinkingForSite("title"),
      });

  return async (input) => {
    const fallback = fallbackTitle(input.userText);
    if (!streamer) return fallback;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
    try {
      // 输入两端都截断：长问答全文不提升标题质量，只增加 token 成本。
      const prompt = [
        `车主：${cut(input.userText, 200)}`,
        input.assistantText.trim().length > 0 ? `助手：${cut(input.assistantText, 300)}` : "",
        "",
        "给这段对话起标题：",
      ]
        .filter((l) => l.length > 0 || l === "")
        .join("\n");

      let text = "";
      for await (const chunk of streamer([{ role: "user", content: prompt }], {
        // `agent` 让它在轨迹与成本表里与主链路分开，避免污染 `llm.*.ttft` 的分位数。
        agent: "title",
        signal: controller.signal,
        ...(recordUsage
          ? {
              onUsage: (s) =>
                recordUsage({
                  sessionId: input.sessionId,
                  turnId: input.turnId,
                  agent: "title",
                  provider: s.provider,
                  model: s.model,
                  promptTokens: s.promptTokens,
                  completionTokens: s.completionTokens,
                  ...(s.cacheHitTokens !== undefined ? { cacheHitTokens: s.cacheHitTokens } : {}),
                  ...(s.cacheMissTokens !== undefined
                    ? { cacheMissTokens: s.cacheMissTokens }
                    : {}),
                  durationMs: s.durationMs,
                  status: s.status,
                }),
            }
          : {}),
      })) {
        text += chunk;
        // 超长后不再收流，后面是会被清理掉的解释。
        if (text.length > 120) break;
      }
      return sanitizeTitle(text) ?? fallback;
    } catch {
      // 抛错、超时、被 abort 都走这里。不重试，回落兜底。
      return fallback;
    } finally {
      clearTimeout(timer);
    }
  };
}
