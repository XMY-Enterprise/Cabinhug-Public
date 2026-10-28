/**
 * L1 导游生成器的装配。
 *
 * # 不放在 `sidecar/` 里
 *
 * `check:arch` 的 `sidecar-isolation` 禁止 `sidecar/` import `../llm`：
 * 能力边界靠依赖守，不靠提示词。所以接口在 `sidecar/l1.ts`，实现在这里，
 * 由 `index.ts` 注入，"旁路够不着业务能力"由机器检查。
 *
 * # 复用 `createConfiguredChatStreamer` 而不是直接调 SDK
 *
 * 它提供配置热生效（改 key/模型不重启，§8.4：重启会打断 SSE 与挂起中的 HITL）
 * 与 `CABINHUG_LLM=fake` 的离线路径。直接 `new` 一个 provider 会绕过 `ConfigStore`，
 * 控制台改了模型后导游仍用旧的。
 */

import { resolveDeepSeekModel } from "@cabinhug/shared";

import { thinkingForSite } from "./llm/thinking-policy";
import { createConfiguredChatStreamer } from "./llm";
import { GUIDE_SYSTEM, guideMessages, type FillerWriter } from "./sidecar/l1";

/**
 * 单次生成的墙钟上限。
 *
 * 超时是语义而不是错误处理：一句填等待的闲话，晚到就没有意义，
 * 主回答可能已经在念了。超时返回 `undefined`，旁路回落 L0，用户侧无感。
 *
 * 6 秒按上一句的播报时长定：一句 25 字念 5 秒，预生成在那段时间里跑完才赶得上，
 * 超过 6 秒即使生成成功也已错过该填的空档。
 */
const WRITE_TIMEOUT_MS = 6000;

/**
 * 采样温度，按实测取值（3 档 × 30 句）。
 *
 * 不传温度时 DeepSeek 的输出近似确定：同一个地名连问多次会返回一字不差的同一句，
 * prompt 里要求换角度也压不住。
 *
 * | 温度 | 被过滤 | 原样重复 | 备注 |
 * |---|---|---|---|
 * | 0.8 | 1/30 | 4/30 | 还是会卡在同一句上 |
 * | **1.0** | **0/30** | **1/30** | 取这一档 |
 * | 1.3 | 0/30 | 0/30 | 开始编具体的：街道名、地方特产、"出了名是…" |
 *
 * 1.3 那一档开始编造街道名与特产，过滤器拦不住，
 * 而这类内容正是本设计靠"限制输入"而不是"靠过滤"防范的。所以不取更高档。
 */
const TEMPERATURE = 1.0;

/**
 * 造一个导游生成器。离线路径（`CABINHUG_LLM=fake`）返回 `undefined`：
 * Fake 模型输出固定 tag，接进 L1 只会给确定性测试多一条路径，
 * 旁路没有 writer 时全程 L0，行为完整可用。
 */
export function createFillerWriter(
  config: Parameters<typeof createConfiguredChatStreamer>[0],
  /**
   * 用量出口（与主链路同一个计价闭包）。垫场话的 LLM 调用同样计入会话成本。
   * 缺省不记（单测/离线）。
   */
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
): FillerWriter | undefined {
  if (process.env.CABINHUG_LLM === "fake") return undefined;

  /*
   * 模型 id 不跟 `DEEPSEEK_MODEL` 走（那是主链路调档用的）；是否思考由 `thinking` 决定。
   * DeepSeek 默认思考，这条路径要求快，档位显式 off。
   */
  const streamer = createConfiguredChatStreamer(config, {
    system: GUIDE_SYSTEM,
    model: resolveDeepSeekModel(process.env.SIDECAR_FILLER_MODEL),
    temperature: Number(process.env.SIDECAR_FILLER_TEMPERATURE) || TEMPERATURE,
    thinking: thinkingForSite("filler"),
  });

  return async (input) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WRITE_TIMEOUT_MS);
    try {
      let text = "";
      /*
       * 多轮，不是单轮。已说过的句子以 `assistant` 身份回填，
       * 连贯性来自模型自己的上文；摊成一条 prompt 里的"别重复这些"时，
       * 生成的句子彼此不连贯。
       */
      for await (const chunk of streamer(guideMessages(input), {
        // `agent` 让它在轨迹里与主链路的 LLM 跳分开，
        // 避免这条旁路的调用干扰主链路 `llm.*.ttft` 的分位数。
        agent: "sidecar-filler",
        signal: controller.signal,
        ...(recordUsage
          ? {
              onUsage: (s) =>
                recordUsage({
                  sessionId: input.sessionId,
                  turnId: input.turnId,
                  agent: "sidecar-filler",
                  provider: s.provider,
                  model: s.model,
                  promptTokens: s.promptTokens,
                  completionTokens: s.completionTokens,
                  ...(s.cacheHitTokens !== undefined ? { cacheHitTokens: s.cacheHitTokens } : {}),
                  ...(s.cacheMissTokens !== undefined ? { cacheMissTokens: s.cacheMissTokens } : {}),
                  durationMs: s.durationMs,
                  status: s.status,
                }),
            }
          : {}),
      })) {
        text += chunk;
        // 长度已超限就不必把整段流收完，后置过滤会拒。
        if (text.length > 200) break;
      }
      return text.trim() || undefined;
    } catch {
      // 抛错、超时、被 abort 都走这里。不重试：重试只会更晚。
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };
}
