/**
 * 洞察卡的读取面。
 *
 * # 卡片与「当前口径」必须一次取回
 *
 * G5 比对的是"这张卡的口径 vs 此刻的口径"。分两跳查时两个值来自不同时刻，
 * 中间若重算了快照，卡片会被误判为过期或未过期，且不报错。所以端点一次返回两者。
 */

import { api } from "./index";
import type { InsightCard } from "@cabinhug/research/types";

export type { InsightCard };

/** 置信五分量 + c + 最低项 + 建议。与 `@cabinhug/research` 的 `confidenceOf` 同形。 */
export interface ConfidenceBreakdown {
  coverage: number;
  quality: number;
  agreement: number;
  triangulation: number;
  freshness: number;
  c: number;
  lowest: string;
  suggestion: string;
}

export interface ResearchInsight {
  id: string;
  themeId: string;
  /**
   * 这张卡属于哪一格，从主题关联得到。主题 id 的形状切不出唯一解，
   * 前端不得从 id 反推。
   */
  needPainCode: string | null;
  themeName: string;
  /** signal | candidate | validated。没有任何自动路径把它变成后两者。 */
  level: string;
  card: InsightCard;
  confidence: ConfidenceBreakdown;
  upgradeNeeds: string[];
  /**
   * 这张卡基于哪份快照。
   *
   * null 表示「口径未知」，不是「口径一致」：早期写入的行没有记录快照 hash，
   * 无法确定其来源快照。
   */
  inputsHash: string | null;
  owner: string;
  reviewAt: string | null;
  createdAt: string;
}

export interface InsightsPayload {
  insights: ResearchInsight[];
  /** 此刻的口径。没有快照时 null。 */
  currentInputsHash: string | null;
}

/** 取这个合同下的全部卡（含六栏正文）。 */
export function fetchInsights(contractId: string): Promise<InsightsPayload> {
  return api.get<InsightsPayload>(
    `/console/research/insights?full=1&contract=${encodeURIComponent(contractId)}`,
  );
}
