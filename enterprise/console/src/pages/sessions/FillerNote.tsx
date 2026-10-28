/**
 * 等待期垫场话在会话页的呈现（US-45）。
 *
 * # 以旁注而非气泡呈现
 *
 * 垫场话按设计不入对话历史（AC-45-7）：不进①图状态、不进记忆、
 * 不进 `Last-Event-ID` 补发窗口，三处都有断言。
 *
 * 渲染成助手气泡会让读者误以为垫场进了历史，因此它是旁注：
 * 只出现在轨迹抽屉里，并注明它不在对话记录中。
 *
 * # 文本来源
 *
 * `sidecar.filler` 这条 span 的 `detail` 形如 `l0 · retrieval`，不含文本：
 * 文本是用户可见内容，轨迹里再存一份会增加一处需脱敏的位置。
 *
 * L0 的文案是代码常量，phase 与句子一一对应，因此由 `phase` 还原，无额外传输。
 *
 * L1（导游式闲聊）无法还原：它是模型即时生成的句子，而轨迹按设计不存文本。
 * 此时只显示发生过与时刻，不推测文本：控制台显示的内容必须与用户实际听到的一致。
 *
 * 已知代价：大多数句子是 L1，回放页因此看不到具体内容。
 * 改变这一点需先决定"用户可见文本是否进入轨迹"这条边界。
 */

import type { JSX } from "react";

import { parseFillerDetail } from "@cabinhug/shared";

import type { TraceEvent } from "../trace/timeline";

export interface FillerNoteItem {
  at: number;
  source?: string;
  phase?: string;
  /** 这是该阶段的第几句（1 起）。 */
  ordinal?: number;
  phrase?: string;
}

/** 从一轮的轨迹事件里挑出垫场话。来源是轨迹，不是对话历史。 */
export function fillersOfTurn(events: TraceEvent[]): FillerNoteItem[] {
  return events
    .filter((e) => (e.data as { name?: string } | undefined)?.name === "sidecar.filler")
    .map((e) => ({
      at: e.at,
      ...parseFillerDetail((e.data as { detail?: string } | undefined)?.detail),
    }));
}

export function FillerNote({ fillers }: { fillers: FillerNoteItem[] }): JSX.Element {
  return (
    <div className="filler-note">
      <h3>
        等待期垫场 <span className="muted tiny">×{fillers.length}</span>
      </h3>
      <p className="muted tiny">
        旁路闲聊 Agent 在等待期播给车主听的话。<strong>不在对话记录里</strong>
        ——它是等待期的瞬时填充，不进历史、不进记忆、不进断线补发。
      </p>
      <ul className="filler-list">
        {fillers.map((f, i) => (
          <li key={`${f.at}-${i}`}>
            <span className="muted tiny mono">{new Date(f.at).toLocaleTimeString()}</span>{" "}
            {f.phrase ? (
              <span className="filler-phrase">「{f.phrase}」</span>
            ) : (
              <span className="muted">
                （L1 是模型现生成的，轨迹里按设计不留文本——只知道它发生过）
              </span>
            )}
            {f.phase ? (
              <span className="muted tiny">
                {" "}
                · {f.phase}
                {f.ordinal && f.ordinal > 1 ? `#${f.ordinal}` : ""}
              </span>
            ) : null}
            {f.source ? <span className="muted tiny"> · {f.source}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
