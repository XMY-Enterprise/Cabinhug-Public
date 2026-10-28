/**
 * 运行流 `GET /internal/research/runs/:id/stream`。
 *
 * # 进度文案取自图的 `notes[]`
 *
 * 研究图每个节点都往 `notes[]` 里推一句人话（`1482 轮 / 36 主题`、`21 张洞察卡`）。
 * 这条流只把 `notes[]` 新增的条目发出去，不另写一套进度文案，
 * 避免同一次运行有两份会分叉的描述。
 *
 * # 轮询而不是订阅
 *
 * 图的状态存于 PG 的检查点表，LangGraph 不提供状态变更钩子。
 * 进程内事件总线在重启后为空而检查点仍在，会与 `GET runs/:id` 不一致。
 * 因此按同一个 `runState` 轮询，只保留一个信息源。
 *
 * # 连上先发完整状态
 *
 * 第一帧是完整状态，之后才是增量，晚连上的客户端也能画全面板。
 */

import type { ServerResponse } from "node:http";

/** 与 `trace-stream.ts`、端上下行取同一个值；三处不一致时实际生效的是最短的那个。 */
const HEARTBEAT_MS = 15_000;

/** 轮询间隔。图的一个节点动辄几十秒，1 秒够细了；再密只是空转查库。 */
export const POLL_MS = 1_000;

export interface RunState {
  stage: string;
  notes: string[];
  pending: unknown[];
  /**
   * 这次运行自己报的失败。
   *
   * 图的运行失败时 `getState` 会抛错；能力运行是本进程里的一段异步，
   * 失败时状态仍在，只在这里记一句原因。缺少该字段时，
   * 这类失败会走到 `stage === "done"` 并发出 `done` 帧，被界面显示为成功。
   */
  error?: string;
  /** 终态产出。`done` 帧原样带出去，界面拿它渲染结果。 */
  result?: unknown;
}

/** 一次运行消耗的 token。取不到时为 `null` 而不是 0，0 会被读成"没花钱"。 */
export interface RunUsage {
  totalTokens: number;
  models: string[];
}

export interface RunStreamDeps {
  runState(runId: string): Promise<RunState | null>;
  /**
   * 这次运行的用量（G7：界面显示花费）。
   *
   * 已知口径限制：`llm_usage` 没有 run 列，只能按"这次运行开始之后、
   * `sessionId = research` 的行"求和。并发两次 run 时，两条流都会报出两次运行的合计。
   * POC 下一次只跑一个窗（`thread_id` 由合同 + 窗口定）；要分开统计需给 `llm_usage` 加列。
   */
  runUsage?(runId: string): Promise<RunUsage | null>;
  /** 轮询间隔。仅测试传入；生产固定用 `POLL_MS`，不开配置项。 */
  pollMs?: number;
}

/** 终态阶段：到达后关流，不再轮询。 */
const isTerminalStage = (stage: string): boolean => stage === "done";

/** 这一帧是否已收敛：跑完、停在人工确认上、或自报失败，三者都结束流。 */
const isSettled = (st: RunState): boolean =>
  isTerminalStage(st.stage) || st.pending.length > 0 || st.error !== undefined;

type EventName = "state" | "progress" | "stage" | "done" | "failed";

interface Frame {
  event: EventName;
  data: Record<string, unknown>;
}

/**
 * 事件类型同时写在 `event:` 行和载荷里。
 *
 * 控制台共用的 `openEventStream`（`console/src/api/stream.ts`）只解析 `data:` 行，
 * 前端靠载荷里的 `event` 区分 `progress` 与 `done`，不必改动所有页面共用的解析层。
 * `event:` 行保留给 curl 与浏览器 DevTools 显示。
 */
const writeFrame = (res: ServerResponse, f: Frame): void => {
  res.write(`event: ${f.event}\ndata: ${JSON.stringify({ event: f.event, ...f.data })}\n\n`);
};

/**
 * 开一条运行流。返回一个 promise，连接关闭时 resolve。
 *
 * 运行不存在时不开流，回 404 JSON，与 `GET runs/:id` 的 `run_not_found` 同一个码，
 * 以区分"run 不存在"与"run 尚无进展"。
 */
export async function handleRunStream(
  res: ServerResponse,
  runId: string,
  deps: RunStreamDeps,
  onClose: (fn: () => void) => void,
): Promise<void> {
  const first = await deps.runState(runId);
  if (!first) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "run_not_found" }));
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");

  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
  };
  onClose(close);

  const pollMs = deps.pollMs ?? POLL_MS;
  const usageOf = async (): Promise<RunUsage | null> => (deps.runUsage ? deps.runUsage(runId).catch(() => null) : null);

  // 第一帧：完整状态。晚连上的客户端从这里就能把面板画全。
  writeFrame(res, { event: "state", data: { runId, ...first, usage: await usageOf() } });
  let sentNotes = first.notes.length;
  let stage = first.stage;

  /**
   * 收尾：先看 `error`，再看阶段。
   *
   * 失败的运行同样会走到终态阶段，先判阶段会把它发成 `done` 帧。
   */
  const settle = async (st: RunState): Promise<void> => {
    if (st.error !== undefined) {
      writeFrame(res, { event: "failed", data: { runId, stage: st.stage, error: st.error, usage: await usageOf() } });
    } else {
      writeFrame(res, {
        event: "done",
        data: { runId, stage: st.stage, pending: st.pending, result: st.result, usage: await usageOf() },
      });
    }
    close();
    res.end();
  };

  if (isSettled(first)) {
    await settle(first);
    return;
  }

  heartbeat = setInterval(() => res.write(": hb\n\n"), HEARTBEAT_MS);

  await new Promise<void>((resolve) => {
    const tick = async (): Promise<void> => {
      if (closed) {
        resolve();
        return;
      }
      let st: RunState | null;
      try {
        st = await deps.runState(runId);
      } catch (err) {
        // 查库失败时发 failed 帧再关流；静默断开会被读成"跑完了"。
        writeFrame(res, { event: "failed", data: { runId, error: err instanceof Error ? err.message : String(err) } });
        close();
        res.end();
        resolve();
        return;
      }
      if (!st) {
        // 运行中状态消失（检查点被清）按失败处理。
        writeFrame(res, { event: "failed", data: { runId, error: "run_state_vanished" } });
        close();
        res.end();
        resolve();
        return;
      }

      for (const note of st.notes.slice(sentNotes)) {
        writeFrame(res, { event: "progress", data: { runId, stage: st.stage, note } });
      }
      sentNotes = st.notes.length;
      if (st.stage !== stage) {
        stage = st.stage;
        writeFrame(res, { event: "stage", data: { runId, stage, usage: await usageOf() } });
      }

      if (isSettled(st)) {
        await settle(st);
        resolve();
        return;
      }
      setTimeout(() => void tick(), pollMs);
    };
    setTimeout(() => void tick(), pollMs);
  });
}
