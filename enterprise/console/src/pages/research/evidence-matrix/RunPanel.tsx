/**
 * 运行态面板。
 *
 * # 「停止查看」不是「取消」
 *
 * 这个按钮只断开 SSE 订阅，服务端那次运行继续执行并消耗 token，
 * 因此文案是「停止查看」而非「取消」。服务端取消尚未实现。
 */

import { useEffect, useRef, useState } from "react";

import { openRunStream, type RunStreamEvent } from "../../../api/research-capability";
import type { StreamState } from "../../../api/stream";
import { costLine, initialRunState, reduceRun, STEP_GLYPH, type RunPanelState } from "./run-model";

export function RunPanel({
  runId,
  title,
  onDone,
  onSettled,
}: {
  runId: string;
  title: string;
  /**
   * 运行成功结束时回调一次。C1 用它让页面重取洞察卡。
   *
   * 只在 `done` 上回调、不在 `failed` 上回调：失败时没有新卡，重取会被误读为"跑成了"。
   *
   * 参数是归约后的 `state.result`：`done` 帧的产物形状因能力而异
   * （C10–C12 是 `{ note: AgentNote, … }`）。公共组件只交出值、由上层收窄，
   * 新增能力时无需修改本组件。
   */
  onDone?: (result: unknown) => void;
  /**
   * 成功或失败都回调一次，用于解除"这张卡正在跑"的锁。
   *
   * 与 `onDone` 分开：`onDone` 表示有新结果可取，而锁在失败时也必须解开，
   * 否则一次失败的挑战会让那张卡上的按钮保持禁用。
   */
  onSettled?: (ok: boolean) => void;
}): JSX.Element {
  const [state, setState] = useState<RunPanelState>(() => initialRunState(runId));
  /*
   * 归约结果的同步镜像。
   *
   * `setState(prev => …)` 的 updater 在渲染期执行，同一个事件处理器里拿不到新状态，
   * 而终态回调需要新状态里的 `result`。不直接读帧上的 `e.result`，
   * 保证回调与界面都只经过同一张归约表。
   */
  const latest = useRef<RunPanelState>(state);
  const [conn, setConn] = useState<StreamState>("connecting");
  const handleRef = useRef<{ close(): void } | null>(null);
  /** 回调只发一次。重连会重放终态帧，此标记防止页面重复重取。 */
  const notified = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  useEffect(() => {
    latest.current = initialRunState(runId);
    setState(latest.current);
    notified.current = false;
    const handle = openRunStream(runId, {
      onEvent: (e: RunStreamEvent) => {
        latest.current = reduceRun(latest.current, e);
        setState(latest.current);
        if ((e.event === "done" || e.event === "failed") && !notified.current) {
          notified.current = true;
          if (e.event === "done") onDoneRef.current?.(latest.current.result);
          onSettledRef.current?.(e.event === "done");
        }
      },
      onState: (s) => setConn(s),
    });
    handleRef.current = handle;
    return () => handle.close();
  }, [runId]);

  const stop = (): void => {
    handleRef.current?.close();
    latest.current = { ...latest.current, watching: false };
    setState(latest.current);
  };

  return (
    <div className="rm-run">
      <div className="rm-run-head">
        <strong>{title}</strong>
        <span className="rm-dim rm-run-stage">{state.stage ? `阶段 ${state.stage}` : "等待第一帧"}</span>
      </div>

      {state.steps.length === 0 ? (
        <p className="rm-dim">还没有进度——图刚起来时第一句话要几秒才到。</p>
      ) : (
        <ul className="rm-run-steps">
          {state.steps.map((s, i) => (
            <li key={`${i}-${s.text}`} className={`is-${s.status}`}>
              <span className="rm-run-glyph">{STEP_GLYPH[s.status]}</span>
              {s.text}
            </li>
          ))}
        </ul>
      )}

      {state.phase === "failed" ? (
        // 原样显示服务端给的原因，保留排查线索。
        <p className="rm-run-err">跑失败了：{state.error}</p>
      ) : null}

      <div className="rm-run-foot">
        <span className="rm-dim">{costLine(state.usage)}</span>
        {state.phase === "running" && state.watching ? (
          <button type="button" className="btn-secondary" onClick={stop} title="只断开这条进度流，服务端那次运行照跑">
            停止查看
          </button>
        ) : (
          <span className="rm-dim">
            {state.phase === "done" ? "跑完了" : state.watching ? "" : "已停止查看（运行仍在服务端继续）"}
            {state.phase === "running" && conn === "closed" ? "（连接断了，正在重连）" : ""}
          </span>
        )}
      </div>
    </div>
  );
}
