/**
 * llm/thinking-policy —— 每一处 LLM 调用的思考档都在这里显式声明。
 *
 * # 这张表的作用
 *
 * `deepseek-v4-flash` 不带参数请求时默认 `thinking: enabled`，而 `@ai-sdk/deepseek` 0.1.17
 * 没有关思考的参数。隐式思考时首 token 等于推理时长，可从 0.7 s 涨到 5 s 以上，
 * 复合意图上可超过 120 s 的应答封顶；同一份 prompt 在 `thinking: disabled` 下 0.3 s 出正文。
 *
 * 未声明即跟随模型默认，所以：
 *  - 直连侧每个调用点必须从 `DIRECT_CALL_SITES` 取档，`createConfiguredChatStreamer` 的 `thinking` 是必填；
 *  - `createDeepSeek` 一律经 `withDeepSeekThinking(level)` 包一层 `fetch`，把档位写进请求体，不依赖 SDK 版本；
 *  - pi 侧沿用 `piThinkingLevelFor`（`-task` / `-intent` 后缀 off，应答会话 high）；
 *  - `test/thinking-policy.test.ts` 扫源码：每处 `createConfiguredChatStreamer(` / `createDeepSeek(` 都带声明。
 *
 * # 判据（架构文档 §5.1）
 *
 * 走思考：输出直接给人、且模型要在多步工具之间做取舍（pi 应答会话 `trip` / `buying`）；评测裁判。
 * 不走：输出被代码解析（`-task` / `-intent` / 标题 / 事实抽取 / 联网搜索）、纯表述已求解的内容
 * （narrator / 填充语 / 对照探针）、探针。中间档 `low`：接口接受、pi 目录要 `models.json` 覆盖，
 * 在 `tour-task` 上实测比 off 更糟（推演从正文挪进思考块、token 三倍），只给应答会话做对照实验用。
 */

/*
 * `ThinkingLevel` 与后缀规则定义在 `@cabinhug/acp`（ACR-035），底座只放纯映射、无业务。
 *
 * 下面的 `PI_NARRATING_ANSWER_SESSIONS` 是车主面的五个 Agent 名字，留在这里：
 * 放进底座会让研究面同名会话（如 `service`）静默受到这里的实验开关影响。
 * 详见 `shared/acp/src/thinking.ts` 的文件头。
 */
export type { ThinkingLevel } from "@cabinhug/acp";

import { defaultThinkingFor, type ThinkingLevel } from "@cabinhug/acp";

/**
 * 直连侧（AI SDK / 裸 HTTP）调用点的档位。加调用点先加这里，测试会按源码扫描核对。
 *
 * | 调用点 | 档 | 理由 |
 * |---|---|---|
 * | `main-direct` | high | 没有 ACP 时直连主链路：有工具、给车主，与 pi 应答会话同档 |
 * | `narrator` | off | 求解已经做完，它只把结果说成人话，要求快 |
 * | `title` | off | 代码取一行当标题 |
 * | `filler` | off | 旁路填充语，几秒一句 |
 * | `dual-probe` | off | 控制台双路对照，与 narrator 同人设 |
 * | `probe` | off | 连通性探针，`maxTokens` 8，思考只会浪费 |
 * | `web-search` | off | DeepSeek Anthropic 兼容端点的联网搜索，输出被代码解析（实测关掉后 `server_tool_use` 照常） |
 * | `judge` | high | 评测裁判要推理；显式写出来，不靠隐式默认 |
 * | `service-asks` | off | 问诊轮的配合请求提议：与 narrator 并发、产出 JSON 给代码解析；晚回来即作废 |
 */
export const DIRECT_CALL_SITES = {
  "main-direct": "high",
  narrator: "off",
  title: "off",
  filler: "off",
  "dual-probe": "off",
  probe: "off",
  "web-search": "off",
  judge: "high",
  "service-asks": "off",
} as const satisfies Record<string, ThinkingLevel>;

export type DirectCallSite = keyof typeof DIRECT_CALL_SITES;

export function thinkingForSite(site: DirectCallSite): ThinkingLevel {
  return DIRECT_CALL_SITES[site];
}

/**
 * pi 侧按会话名单独钉档位的例外表。key 是会话名（带 `-task`），写规范名不生效且不报错：
 * `piThinkingLevelFor` 收到的是会话名；`thinking-policy.test.ts` 断言每个 key 都以 `-task` 结尾。
 *
 * - `tour-plan-task: high`（ACR-037）：多天行程 Plan 层的语义裁决会话。
 *   产出虽然给代码解析，但要做"两个博物馆别排同一天、门票绑日、夜游压轴"这类取舍；
 *   60 s 独立超时 + 不合法即回落 1b 骨架保证有结果，思考只影响质量。
 *   `acp/pool.ts` 的 processKey 是 `tour-plan:high`，与 `tour:off` 各自独立进程。
 *
 * `tour-task` 不设 `low`：DeepSeek 上 low 不缩短推演，只把它从正文挪进思考块，token 约三倍。
 * 正文过长应从 tour.md 提示词修。
 */
export const PI_OVERRIDES: Readonly<Record<string, ThinkingLevel>> = {
  "tour-plan-task": "high",
  // 装配体检修复的裁决：与 tour-plan 同一理由，产出给代码解析，但判断本身要推演。
  "trip-review-task": "high",
};

/** 只表述、不规划的五个应答会话：low 对照实验只对它们生效（`trip` / `buying` 要做规划，不参与）。 */
export const PI_NARRATING_ANSWER_SESSIONS = ["supervisor", "ownership", "service", "cabin", "test-drive"] as const;

/**
 * pi 会话的档位。
 *
 * `-task` / `-intent` 后缀（产出给代码解析）→ off；其余（应答，车主直接读）→ high。
 * 见 README「思考档位」：off 会让应答把规划漏进正文、丢台风预警，所以只对后缀会话关思考。
 * `CABINHUG_PI_ANSWER_THINKING`（off / low / high）只覆盖 `PI_NARRATING_ANSWER_SESSIONS` 五个会话，
 * 缺省不设 = high；这是对照实验的开关，实验没结论前不在 .env 里固定它。
 */
export function piThinkingLevelFor(agent: string, env: NodeJS.ProcessEnv = process.env): ThinkingLevel {
  const pinned = PI_OVERRIDES[agent];
  if (pinned) return pinned;
  /*
   * 后缀规则由底座给（`defaultThinkingFor`），它判 off 时就是 off：
   * 实验开关只作用于应答会话，而应答会话没有 `-task` / `-intent` 后缀。
   */
  const base = defaultThinkingFor(agent);
  if (base === "off") return base;
  const experiment = env.CABINHUG_PI_ANSWER_THINKING;
  if (
    (experiment === "off" || experiment === "low" || experiment === "high") &&
    (PI_NARRATING_ANSWER_SESSIONS as readonly string[]).includes(agent)
  ) {
    return experiment;
  }
  return "high";
}

/**
 * DeepSeek `chat/completions` 请求体里表达档位的字段。
 *
 * `thinking.type` 是开关；`reasoning_effort: "low"` 接口接受（README「中间档」），
 * high 不传 `reasoning_effort`——与 pi 侧 `high` 档的请求形状一致。
 */
export function deepseekThinkingFields(level: ThinkingLevel): Record<string, unknown> {
  if (level === "off") return { thinking: { type: "disabled" } };
  if (level === "low") return { thinking: { type: "enabled" }, reasoning_effort: "low" };
  return { thinking: { type: "enabled" } };
}

/** Anthropic 兼容端点（`/anthropic/v1/messages`）的同一件事：不带字段时它默认思考，实测关掉后联网搜索照常。 */
export function anthropicThinkingFields(level: ThinkingLevel): Record<string, unknown> {
  return level === "off" ? { thinking: { type: "disabled" } } : { thinking: { type: "enabled" } };
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/**
 * 给 AI SDK 的 provider 包一层 `fetch`：凡是发往 `chat/completions` 的 JSON 请求，都把档位字段合进去。
 *
 * 放在 `fetch` 这一层而不是 `providerOptions`：`@ai-sdk/deepseek` 0.1.17 不透传思考参数，
 * 升级 SDK 另行处理（ACR-022）。请求体已带同名字段时以请求体为准、不覆盖，
 * 这样 SDK 将来自己传时不会冲突。
 */
export function withDeepSeekThinking(level: ThinkingLevel, base: FetchLike = fetch): FetchLike {
  const fields = deepseekThinkingFields(level);
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (init?.method?.toUpperCase() === "POST" && /\/chat\/completions(\?|$)/.test(url) && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        return base(input, { ...init, body: JSON.stringify({ ...fields, ...body }) });
      } catch {
        /* 不是 JSON 就原样放过：这里只处理 SDK 拼的 JSON 请求 */
      }
    }
    return base(input, init);
  };
}
