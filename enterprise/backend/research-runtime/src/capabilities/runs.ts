/**
 * `✎` / `💬` 层能力的运行台账。进程内，不落库。
 *
 * # 不复用图的检查点
 *
 * `runState` 读 LangGraph 的检查点表，那是整张研究图的状态。一次 C1 只归纳一格，
 * 不是图的一次运行，没有 thread、节点或 `interrupt()`。放进图会让人工评审入口
 * `GET review` 多出一批停不下来的线程。
 *
 * # 只存内存
 *
 * 这里存的是进度，不是产出。产出（洞察卡）在 `research_insights` 里，重启后仍可查。
 * 重启只丢失"那次点击跑到哪一步"，界面此时收到 404 `run_not_found`
 * （`handleRunStream` 的既有分支），与事实一致。
 *
 * 不为进度建表：进度表需要清理、迁移与备份，而它的价值只在那 10–60 秒里。
 *
 * # 阶段名与图的 `stage` 共用一个字段
 *
 * `RunState` 是运行流唯一的形状，共用可避免前端出现两套渲染分支；
 * 对用户而言两者都表示"它现在在干什么"。
 */

import { randomUUID } from "node:crypto";

import type { RunState } from "../internal-api/run-stream";

/** 跑完多久之后从内存里清掉。界面收到 `done` 即停止轮询，保留 10 分钟供回看。 */
export const RUN_TTL_MS = 10 * 60_000;

/** 终态阶段名。与 `run-stream.ts` 的 `isTerminalStage` 同一个字面量。 */
export const DONE_STAGE = "done";

export interface CapabilityRunRecord {
  runId: string;
  capability: string;
  stage: string;
  notes: string[];
  /** 失败原因。原样保留服务端的原因，不换成「运行失败请重试」。 */
  error?: string;
  /** 产出。C1 是写进去的洞察 id 列表。 */
  result?: unknown;
  startedAt: number;
  endedAt?: number;
  usage: { totalTokens: number; models: string[] } | null;
}

export interface CapabilityRuns {
  start(capability: string): CapabilityRunRecord;
  /** 追加一条可读进度。给了 `stage` 时同时切换阶段。 */
  note(runId: string, note: string, stage?: string): void;
  addUsage(runId: string, totalTokens: number, model: string): void;
  fail(runId: string, message: string): void;
  finish(runId: string, result: unknown, note?: string): void;
  get(runId: string): CapabilityRunRecord | null;
  /** 运行流要的形状。不认识这个 id 就回 null，让它回 404。 */
  state(runId: string): RunState | null;
}

export function createCapabilityRuns(opts: { ttlMs?: number; now?: () => number } = {}): CapabilityRuns {
  const ttl = opts.ttlMs ?? RUN_TTL_MS;
  const now = opts.now ?? Date.now;
  const runs = new Map<string, CapabilityRunRecord>();

  /*
   * 每次读写时顺带清理，不用 setInterval：常驻定时器需要在测试里显式关闭，
   * 否则造成句柄泄漏。
   */
  const prune = (): void => {
    const t = now();
    for (const [id, r] of runs) {
      if (r.endedAt !== undefined && t - r.endedAt > ttl) runs.delete(id);
    }
  };

  const touch = (runId: string): CapabilityRunRecord | null => runs.get(runId) ?? null;

  return {
    start(capability) {
      prune();
      const rec: CapabilityRunRecord = {
        runId: `cap-${randomUUID()}`,
        capability,
        stage: "starting",
        notes: [],
        startedAt: now(),
        usage: null,
      };
      runs.set(rec.runId, rec);
      return rec;
    },

    note(runId, note, stage) {
      const r = touch(runId);
      if (!r) return;
      r.notes.push(note);
      if (stage) r.stage = stage;
    },

    /**
     * 用量累加，模型名去重。
     *
     * 累加而不是覆盖：一格下有几个主题就调几次模型，只记最后一次会低估花费。
     */
    addUsage(runId, totalTokens, model) {
      const r = touch(runId);
      if (!r) return;
      const prev = r.usage ?? { totalTokens: 0, models: [] as string[] };
      r.usage = {
        totalTokens: prev.totalTokens + totalTokens,
        models: prev.models.includes(model) ? prev.models : [...prev.models, model],
      };
    },

    fail(runId, message) {
      const r = touch(runId);
      if (!r) return;
      r.error = message;
      r.stage = DONE_STAGE;
      r.endedAt = now();
    },

    finish(runId, result, note) {
      const r = touch(runId);
      if (!r) return;
      if (note) r.notes.push(note);
      r.result = result;
      r.stage = DONE_STAGE;
      r.endedAt = now();
    },

    get(runId) {
      prune();
      return touch(runId);
    },

    state(runId) {
      prune();
      const r = touch(runId);
      if (!r) return null;
      return { stage: r.stage, notes: r.notes, pending: [], error: r.error, result: r.result };
    },
  };
}
