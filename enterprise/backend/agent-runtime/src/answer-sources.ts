/**
 * 本轮回复引用的数据来源（天气等第三方数据的署名），按轮暂存。
 *
 * # 按轮收集，不由模型写进正文
 *
 * 写进正文会被 TTS 念出，且模型可能漏写、错写。本轮用了哪家数据由工具本身
 * （`citation` 声明）确定，所以由工具观察者在调用成功时登记，`turn_end` 时一次带走。
 *
 * # 形态与 search-results 相同
 *
 * 进程内 Map、按 (真会话 id, turnId) 键、轮结束即弃、不落库。
 * runtime 重启丢失的后果只是这一轮不带来源，正文照常。
 */

import type { CitedSource } from "@cabinhug/shared";
import { citedSourceOf } from "@cabinhug/tools";

import { currentTurnOf } from "./interrupt-bus";

const store = new Map<string, Map<string, CitedSource>>();

function key(sessionId: string, turnId: string): string {
  return `${sessionId}#${turnId}`;
}

/**
 * 工具观察者的入口：一次成功调用若声明了署名，就登记到该 thread 进行中的那一轮。
 *
 * 观察者手上只有 threadId（ACP 侧的命名），换算成真会话 id + 轮次后再登记，
 * 与 turn-runner 收口时的键一致。归不到轮的调用（轮次已收口、后台 cron）
 * 没有回复可挂，直接丢弃。
 */
export function recordCitation(threadId: string, toolName: string, result: unknown): void {
  const cited = citedSourceOf(toolName, result);
  if (!cited) return;
  const turn = currentTurnOf(threadId);
  if (turn) recordAnswerSource(turn.sessionId, turn.turnId, cited);
}

/** 同一 url 只留一份（一轮里 weather 常被调好几次）。 */
function recordAnswerSource(sessionId: string, turnId: string, source: CitedSource): void {
  const k = key(sessionId, turnId);
  let sources = store.get(k);
  if (!sources) {
    sources = new Map();
    store.set(k, sources);
  }
  if (!sources.has(source.url)) sources.set(source.url, source);
}

/** 读本轮累计的来源（按登记顺序，不删除；清理归 sweep）。 */
export function peekAnswerSources(sessionId: string, turnId: string): CitedSource[] {
  return [...(store.get(key(sessionId, turnId))?.values() ?? [])];
}

/** 轮级清理，与 `sweepSearchResults` 同一时机调用。 */
export function sweepAnswerSources(sessionId: string, turnId: string): void {
  store.delete(key(sessionId, turnId));
}

/** 测试用：全量复位。 */
export function __resetAnswerSources(): void {
  store.clear();
}
