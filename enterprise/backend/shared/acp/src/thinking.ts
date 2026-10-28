/**
 * 思考档（ACR-035）。
 *
 * # 底座只含「后缀规则」，不含会话表
 *
 * `-task` / `-intent` 后缀的会话产出给代码解析，不该思考。
 * 它属于 ACP 的命名约定（`canonicalAgent()` 剥的是同一组后缀），对所有应用成立。
 *
 * `PI_NARRATING_ANSWER_SESSIONS`（supervisor / ownership / service / cabin /
 * test-drive）与 `CABINHUG_PI_ANSWER_THINKING` 实验开关属于车主面 Agent，
 * 留在 `agent-runtime/src/llm/thinking-policy.ts`，由它调这里的默认再叠自己的例外。
 * 放进底座会让其他应用里同名的会话静默继承车主面的档位。
 */

export type ThinkingLevel = "off" | "low" | "high";

/**
 * 产出给代码解析的会话不该思考：这是 ACP 的会话命名约定，不是某个应用的策略。
 * 开启思考时这类会话可能在汇聚超时前产出不了任何 token。
 *
 * 应用自己的例外（钉某个会话、开对照实验）在应用一侧叠加，不改这里。
 */
export function defaultThinkingFor(agent: string): ThinkingLevel {
  return /-(task|intent)$/.test(agent) ? "off" : "high";
}
