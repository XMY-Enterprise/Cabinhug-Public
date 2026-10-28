/**
 * 「问它」三条能力（C10–C12）的判定与措辞。纯函数，不画界面。
 *
 * # 三个角色各自「它准备什么 / 它绝不决定什么」逐字来自设计稿 §4
 *
 * `AgentNote` 的 schema 里没有 `verdict` / `level` / 码表改动这些字段，
 * 模型在结构上无法越权。界面写出这两句，是让提问者看出该问谁：
 * 角色职责之外的问题，它的回答不作数。
 *
 * # 上界从后端读取
 *
 * `ASK_MAX_ROUNDS` 从 `@cabinhug/research/agent-note` 引入，不复制字面量，
 * 避免界面显示的剩余轮数与服务端判定不一致。
 */

import { ASK_MAX_ROUNDS, agentNoteSchema, type AgentNote } from "@cabinhug/research/agent-note";

export { ASK_MAX_ROUNDS };
export type { AgentNote };

/**
 * 问句的字数上限，与规则筛的 `MAX_INPUT_CHARS` 同值，超出时服务端拒绝。
 *
 * 与 `MAX_ANGLE_CHARS`（挑战面的追问角度）同值但不共用常量：两者约束不同端点的
 * 不同字段，需要能各自调整。
 */
export const MAX_QUESTION_CHARS = 500;

/** 三条 ask 能力的 `key`。与后端 `ASK_AGENT_OF` 的键逐字相同。 */
export type AskCapabilityKey = "ask-analyst" | "ask-taxonomist" | "ask-archivist";

/** 这条能力是不是「问它」。抽屉按它决定开哪个面板。 */
export const isAskCapability = (key: string): key is AskCapabilityKey => key.startsWith("ask-");

export interface AskRole {
  /** 角色名，沿用设计稿与能力目录里的中文名。 */
  name: string;
  /** 它准备什么。 */
  prepares: string;
  /** 它绝不决定什么。必填，是这个面板存在的前提。 */
  neverDecides: string;
}

/**
 * 三个角色各一行，与设计稿 §4 的表逐字一致。
 *
 * 写成穷举的 `Record` 而不是 `key.replace("ask-", "")` 再查表：
 * 后者对拼错的 key 也会算出一个貌似合理的角色名。
 */
export const ASK_ROLES: Record<AskCapabilityKey, AskRole> = {
  "ask-analyst": {
    name: "分析师",
    prepares: "命题、解释、主题边界",
    neverDecides: "质量门判定、等级升降",
  },
  "ask-taxonomist": {
    name: "分类学家",
    prepares: "码提案、定义漂移报告、一致率解读",
    neverDecides: "采纳提案、锁版",
  },
  "ask-archivist": {
    name: "档案员",
    prepares: "证据检索、回溯链、脱敏核对",
    neverDecides: "权利与展示边界",
  },
};

/**
 * 这段问句发不发得出去。
 *
 * 前端只拦空与超长两样，不复制服务端的 9 条注入规则：两份规则表会漂移，
 * 导致前后端判定不一致。
 */
export function questionIssue(text: string): string | null {
  const t = text.trim();
  if (!t) return "先写清要问什么";
  if (t.length > MAX_QUESTION_CHARS) {
    return `问题请控制在 ${MAX_QUESTION_CHARS} 字以内（现在 ${t.length} 字）`;
  }
  return null;
}

export interface AskQuota {
  used: number;
  remaining: number;
  /** 还能不能问。到顶了输入框与按钮都要按这个禁用。 */
  can: boolean;
  /** 当前状况的说明。到顶时说明接下来该做什么，而不是"操作失败"。 */
  note: string;
}

/**
 * 还能问几轮。
 *
 * `round` 是服务端 202 返回的轮次（第一次问返回 1），不是前端自行计数：
 * 同一范围的额度按 pi 会话键计算，跨浏览器标签共用。
 */
export function askQuota(round: number, limit: number = ASK_MAX_ROUNDS): AskQuota {
  const used = Math.max(0, Math.min(round, limit));
  const remaining = Math.max(0, limit - used);
  return {
    used,
    remaining,
    can: remaining > 0,
    note:
      remaining > 0
        ? `还能问 ${remaining} 轮（同一范围最多 ${limit} 轮）`
        : `已问满 ${limit} 轮，换个范围再问`,
  };
}

/** 一次提问的入参。请求体形状只在此处定义。 */
export const askExtra = (question: string): { question: string } => ({ question: question.trim() });

/**
 * 把 `done` 帧的产物收成一条 `AgentNote`。
 *
 * 用 `agentNoteSchema` 而不是手写 `typeof`：形状的唯一真相源是后端 schema，
 * 手写校验漏字段时不报错，界面对应段落会静默变空。
 * 解析失败回 `null`，由界面说明"这次没拿到笔记"。
 */
export function noteOf(result: unknown): AgentNote | null {
  if (typeof result !== "object" || result === null) return null;
  const parsed = agentNoteSchema.safeParse((result as { note?: unknown }).note);
  return parsed.success ? parsed.data : null;
}
