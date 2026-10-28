/**
 * 拍照问诊的结构化报告（FL-20 F-20-06 / F-20-08 / F-20-09 / F-20-15）。
 *
 * 端云共用的读形状：服务端 answer 节点在问诊轮拼出来存进图状态 `diagnosis` 通道，
 * 端上经 `GET /v1/session/:id/diagnosis` 只读，不解析回答文本。
 *
 * 分工：
 *  - `risk` / `selfChecks` / `stopNowSigns` / `questionsForShop` 来自 `assessRisk`（规则，不是模型感觉）；
 *  - `observation` 来自观察层：只描述看到的，名称与级别来自手册图标目录；
 *  - `prompts` 是这一轮请车主配合的事：单选 / 多选 / 开放题 / 操作引导 / 拍照，来自封闭题库、
 *    观察层的补拍指引与模型提议三路，由服务端预算器统一裁决（问题位 ≤ 2 / 轮、≤ 2 轮 / 会话）；
 *    回传都是车主点一下发出的一轮用户消息——这里不解析答案；
 *  - `answer` 是这一轮的回答正文——「可能的原因」由它承担，不另起一次 LLM 抽 JSON。
 *
 * 硬禁（F-20-11）不在这里：报告里没有任何"结论"字段，`risk.action` 三档措辞里没有「没问题 / 放心」。
 */

import type { InteractionPrompt } from "./interaction";

export type DiagnosisRiskLevel = "low" | "medium" | "high";

/** 三档行动建议（F-20-06）。没有「可以放心开」——低风险也只是「可继续观察」。 */
export const DIAGNOSIS_RISK_ACTION: Readonly<Record<DiagnosisRiskLevel, string>> = {
  low: "可继续观察",
  medium: "建议尽快检查",
  high: "建议立即停止",
};

export interface DiagnosisObservedItem {
  /** 手册目录对上的名称；`null` = 未能对上（那时看 `suspected`）。 */
  name: string | null;
  /**
   * 手册图标目录里的符号 id（如 `seatbelt_unfastened`）。`null` = 连 top 候选都没有。
   *
   * 端上拿它换对应的图标：手册里存着每个符号的图片
   * （`data/kb-src/icons/<车型>/<symbolId>.png`，也用于成对核验），
   * 端上按同一个 id 取已切好的一份，让「安全带未系」与「胎压报警」这类条目一眼可分。
   *
   * `suspected` 为真时这里也有值（top 候选的 id）：图标是"像什么"的线索，
   * 与"敢不敢下结论"是两件事，后者由 `suspected` 单独说。
   */
  symbolId: string | null;
  /** 只能说「疑似」：目录闸门没过、只有 top 候选。 */
  suspected: boolean;
  class: "fault" | "reminder" | "status" | null;
  severity: "stop" | "check_soon" | "info" | null;
  /** 观察层的受控词表原值（red / amber / … ；lit / unlit / …）。 */
  color: string;
  state: string;
  manualAnchor: string | null;
  /**
   * 手册图标目录里这一条的原文说明。`null` = 目录里没取到。
   *
   * 颜色、类别与锚点只是分类，不是解释：车主仍不知道该做什么，
   * 而在车里时也不便去翻锚点指向的手册章节。
   *
   * 来源与 `name` / `severity` 同一张表（`data/kb-src/icons/<车型>-indicators.md` 的「原文说明」列），
   * 不是模型写的：这一列是手册原话的摘录，端上原样显示，不再加工。
   * `suspected` 为真时也有值（top 候选那条的说明）——与名称同一条链，"疑似"由 `suspected` 单独说。
   */
  description: string | null;
}

/** 封闭题库的存储形状。它不出现在报告上，下发时映射成 `InteractionPrompt`。 */
export interface DiagnosisQuestion {
  id: string;
  text: string;
  options: string[];
  /**
   * 这道题语义上能不能多选。缺省 false = 单选。
   *
   * 逐题判，不能一刀切：「什么时候出现」的冷车与热车可以同时成立，
   * 而「车现在是停着的吗」允许同时选「停着」和「在开」，答案就没法用了。
   * 下发时由 `toBankPrompt` 映射成 `multi` / `single`。
   */
  multi?: boolean;
}

export interface DiagnosisReport {
  /** 写它的那条图线程（`thread_id`）；端上只用 `at` 判新旧。 */
  threadId: string;
  /** ISO 时间。 */
  at: string;
  agent: "service" | "ownership";
  risk: {
    level: DiagnosisRiskLevel;
    /** `DIAGNOSIS_RISK_ACTION[level]` 的副本，端上不再查表。 */
    action: string;
    /** 判定依据，每条都可被追问（来自 `assessRisk.basis`）。 */
    basis: string[];
  };
  /** 这一轮没有照片时为 `null`。 */
  observation: {
    items: DiagnosisObservedItem[];
    unreadable: boolean;
    /** 补拍指引（F-20-08）：具体到方向；空数组 = 不用补拍。 */
    retakeHints: string[];
    /** 车机「警报」页读到的条目。 */
    alerts: Array<{ code: string; title: string }>;
  } | null;
  /**
   * 这一轮请车主配合的事；空数组 = 什么都不用配合。取代旧的 `questions` 字段。
   * 顺序就是端上的渲染顺序（拍照 → 引导 → 提问）。
   */
  prompts: InteractionPrompt[];
  /** 已经提问过几轮（含本轮）；只有本轮带了提问型 prompt 才 +1。 */
  askedRounds: number;
  /** 已经发过的 prompt id（跨轮累计，避免重复）。 */
  askedIds: string[];
  selfChecks: string[];
  stopNowSigns: string[];
  questionsForShop: string[];
  /** 这一轮的回答正文（报告页正文）。 */
  answer: string;
  /** 报告页脚的免责，只此一处（F-20-14）。 */
  disclaimer: string;
}

export const DIAGNOSIS_DISCLAIMER = "以上是按可能性排序的判断，不是维修结论；是否需要维修请由专业人员检查确认。";
