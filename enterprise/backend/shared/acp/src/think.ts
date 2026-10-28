/**
 * 模型思考时长的分段（F-44-04）。
 *
 * # 记录思考时长
 *
 * pi 跑的是推理模型，思考阶段可占一轮耗时的大部分；`agent_thought_chunk` 在
 * `connection.ts` 不向端上展示（FL-03 F-03-04），不单独记录的话这段耗时在轨迹里
 * 没有任何事件。
 *
 * 展示思考内容是产品决策，记录时长不是。这里只记时长与片数，不留内容。
 *
 * # 按间隔分段
 *
 * 一轮里模型会思考多次：想 → 调工具 → 拿到结果再想。记成一整段会横跨
 * 中间的工具调用，看起来像思考与工具并行，而实际是交替的。
 *
 * 工具调用走另一条 HTTP 通道，这里看不见，因此分段只能靠时间间隔。
 * 推理 token 连续到达，片间隔为毫秒到几十毫秒；一次工具往返实测 550~680ms。
 * 400ms 落在两者之间，两边都留有一倍以上余量。
 */

/** 一片思考的到达时刻与字数。不留内容。 */
export interface ThoughtTick {
  at: number;
  chars: number;
}

export interface ThinkBurst {
  startedAt: number;
  endedAt: number;
  chunks: number;
  chars: number;
}

/**
 * 分段阈值。见文件头：远大于片间隔（毫秒级），远小于一次工具往返（数百毫秒）。
 */
export const THINK_GAP_MS = 400;

/**
 * 把连续到达的思考片切成若干段。
 *
 * 单片也算一段（`startedAt === endedAt`，时长 0），以区分"只想了一下"与"完全没想"。
 */
export function splitThinkBursts(
  ticks: readonly ThoughtTick[],
  gapMs: number = THINK_GAP_MS,
): ThinkBurst[] {
  if (ticks.length === 0) return [];

  const bursts: ThinkBurst[] = [];
  let cur: ThinkBurst | undefined;

  for (const t of ticks) {
    if (cur && t.at - cur.endedAt <= gapMs) {
      cur.endedAt = t.at;
      cur.chunks += 1;
      cur.chars += t.chars;
      continue;
    }
    cur = { startedAt: t.at, endedAt: t.at, chunks: 1, chars: t.chars };
    bursts.push(cur);
  }

  return bursts;
}
