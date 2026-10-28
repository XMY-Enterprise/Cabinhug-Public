/**
 * 失败后的主动询问（F-13-04 的表述面）。
 *
 * # 职责
 *
 * 端上"部分结果"横幅与 describe* 的缺失节让用户看见缺了什么；
 * 本模块在本轮有"我们没跑成"类缺失时，在回答末尾追加一句主动询问
 * （重试 / 先按现有的来），把下一步的决定权交还给用户。
 *
 * # 确定性追加，不依赖提示词
 *
 * 与 elicitation 同形态：追加由代码做，可单测、必然发生；写进提示词的"请追问用户"
 * 在长上下文里会被模型忽略。判据沿用 talkedMoney 的 marker includes 检查：describe 系列与
 * caveats 的措辞是代码产物（不是模型输出），按导出常量匹配是确定性的。
 *
 * # 什么算"该追问"，什么不算
 *
 * 只有我们没跑成的缺失才追问（再试一次可能就有了）：
 *  - 分支超时/失败（MISSING_SECTION_HEADER 节存在，或 solverDegraded）；
 *  - 双路的检索失败 / 用车数据读取失败（CAVEAT_*_FAILED）。
 * "查了但没有"不追问：零命中、数据不足、日期超出预报覆盖，再试一次结果相同
 * （与 state.ts 对 missing 两类的区分一致）。
 *
 * # 一轮至多一问
 *
 * 追问与 elicitation 互斥（answerNode 接线处保证）：语音场景下一段回答后挂两个问题，
 * 车主不知道该答哪个。失败追问优先，因为它关系到刚交付的答案是否完整。
 */

import { MISSING_SECTION_HEADER } from "./merge";
import { CAVEAT_RAG_FAILED, CAVEAT_USAGE_FAILED } from "./subgraphs/ownership";

export interface FailureFollowupInput {
  /** 本轮有分支彻底没跑成（超时/失败/没交结构化字段）。 */
  solverDegraded: boolean;
  /** 本轮各节点的求解结果文本（describe* 产物 / 双路合成上下文）。 */
  agentResults: Record<string, string> | undefined;
}

/**
 * 返回要追加在回答末尾的那一句询问；无需追问时返回 undefined。
 *
 * 语音友好：一句话、至多两个选项、不带列表符号。
 */
export function failureFollowup(input: FailureFollowupInput): string | undefined {
  const texts = Object.values(input.agentResults ?? {});
  const has = (marker: string): boolean => texts.some((t) => t.includes(marker));

  // 双路的"我们没跑成"两式。两路都挂时合并成一问，不连着问两句。
  const ragFailed = has(CAVEAT_RAG_FAILED);
  const usageFailed = has(CAVEAT_USAGE_FAILED);
  if (ragFailed && usageFailed) {
    return "刚才查资料和读你的用车数据都没成功，需要我再试一次吗？";
  }
  if (ragFailed) {
    return "刚才查资料没成功，知识库里可能有相关内容——需要我再查一次吗？";
  }
  if (usageFailed) {
    return "刚才没读到你的用车数据，需要我再试一次吗？";
  }

  // fanout 类缺失：有缺失节（部分分支没跑成）或整体降级（全没跑成）。
  if (input.solverDegraded || has(MISSING_SECTION_HEADER)) {
    return "有一部分信息这次没查到。要我重新查一遍，还是先按现在的来？";
  }

  return undefined;
}
