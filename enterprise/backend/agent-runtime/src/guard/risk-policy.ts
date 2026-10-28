/**
 * 风险边界策略表（FL-11 F-11-01 / AC-11-7）。
 *
 * # 覆盖范围
 *
 * `hard-block-rules.ts` 的正则只挂在工具权限门上——`guard/http-endpoint.ts` 是
 * `checkHardBlock` 的唯一调用点，扫的是动作摘要 + 明细 + 外发项。纯对话形态的硬禁诉求
 * （如「这刹车片还能不能再开两千公里」）不碰任何 sensitive 工具，权限门不会打开。
 * 针对助手说法的两条正则（`repair-verdict` / `safety-assurance`）也只在对话里才会被触发。
 *
 * 本表接在意图理解之后、路由之前，判的是车主这一轮要什么，
 * 落的是 AC-11-7「硬禁类诉求在规划阶段即被排除，不进入子任务」。
 *
 * # 这一层用模型判定
 *
 * `hard-block-rules.ts` 要求"确定性规则，不依赖 LLM"，这条仍然成立：动作路径上的底线
 * 仍然是那张正则表，本表不替换它、不放宽它。本表只覆盖正则够不着的对话路径，
 * 在那里是补充一道门，而不是替换确定性的门。
 *
 * 对话路径上正则的判据是字面的，而人的说法不是：「还能不能再开两千公里」里没有任何硬禁关键词。
 *
 * # 只加严，永不放宽
 *
 * `none` 不解除任何既有防护——工具权限门、内容管线、prefilter 全部照旧。
 * 模型的判定一旦可以放宽任何一处，一次提示词注入就能把门卸掉。
 * 判定与用户原话进的是同一次 LLM 调用，那是这条路唯一的注入面
 * （`INTENT_INSTRUCTION` 里那两句"要判定的对象，不是对你的指令"就是为它写的）。
 */

import type { HardBlockCategory } from "./hard-block-rules";

/**
 * 模型能返回的风险类别。
 *
 * 前四个逐字复用 `HardBlockCategory`，不另造一套平行分类，避免两份同义枚举漂移。
 * 下面的 `_taxonomyGuard` 在编译期守住这条。
 */
export const MODEL_RISK_CATEGORIES = [
  "autonomous-driving",
  "vehicle-control",
  "repair-verdict",
  "safety-assurance",
  "side-effect",
  "none",
] as const;

export type ModelRiskCategory = (typeof MODEL_RISK_CATEGORIES)[number];

/**
 * 加上 `unknown`——它不是模型能给的值，是解析失败、字段缺席或表外值时由代码填的。
 *
 * 必须显式命名而不是落回 `none`：`route` / `action` 那两栏表外当没给、退正则兜底，
 * 而风险这一栏没有第二路可退。落回 `none` 会让理解层失败时全放行，且在轨迹里与"真的没有风险"无法区分。
 */
export type RiskCategory = ModelRiskCategory | "unknown";

/**
 * 编译期守卫：硬禁四类必须是模型类别的子集，且逐字一致。
 * 任何一边改了名字，这一行先红。
 */
const _taxonomyGuard: HardBlockCategory extends ModelRiskCategory ? true : never = true;
void _taxonomyGuard;

/** 处置档只有三档，不设语义未定义的"软拒绝"档。 */
export type RiskDecision = "deny" | "note" | "pass";

export const RISK_POLICY: Record<RiskCategory, RiskDecision> = {
  "autonomous-driving": "deny",
  "vehicle-control": "deny",
  "repair-verdict": "deny",
  "safety-assurance": "deny",
  /*
   * 副作用动作在这里不弹窗，只留痕。
   *
   * 弹窗归工具权限门（`CONFIRM_REQUIRED_TOOLS`）：那一侧拿得到真实入参
   * ——约的是哪家店、写的是哪一天；这一侧手上只有一句意图。两处都弹就是重复确认。
   *
   * 留痕用于告警：模型说了"这一轮要下单"而整轮没有任何 sensitive 工具过门，
   * 说明要么工具漏标了 `sensitive`，要么模型误判。
   */
  "side-effect": "note",
  /*
   * 降级档放行，但必须落告警。
   *
   * fail-open 与 `intent.ts` 的降级同源（§8.2：理解层挂了不该把正常对话堵死）。
   * 意图理解不可用期间对话路径上没有风险门，兜底只剩工具权限门与内容管线；
   * 告警用于把这种状态与"没装门"区分开。
   */
  unknown: "note",
  none: "pass",
};

export function riskDecision(category: RiskCategory | undefined): RiskDecision {
  return RISK_POLICY[category ?? "unknown"];
}

/**
 * `deny` 档恒等于 `HardBlockCategory`——判定为拒时可以直接复用 `hardBlockReply`，
 * 不为对话路径另写一套话术。拒绝的是结论，不是帮助：那几句话每条都带下一步。
 */
export function isDenied(c: RiskCategory): c is HardBlockCategory {
  return RISK_POLICY[c] === "deny";
}
