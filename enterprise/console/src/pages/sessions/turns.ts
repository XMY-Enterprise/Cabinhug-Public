/**
 * 会话详情的轮次切分与排序：纯逻辑，不 import 任何组件或样式。
 *
 * 独立于 `index.tsx` 是为了可测：那个文件 `import "./sessions.css"`，
 * 而 web 侧测试用 Node 内置 `node:test` + tsx，tsx 不处理 `.css`，
 * import 时报 `ERR_UNKNOWN_FILE_EXTENSION`。
 *
 * enterprise/console 下的测试只 import 纯逻辑模块
 * （`finance/model`、`workflow/graph-model`、`trace/timeline`、`workflow/projection`…），
 * 页面组件只负责表述。可单测的页面逻辑放在这类模块里，不留在 .tsx 中。
 */

import type { TraceEvent } from "../trace/timeline";

export interface ConsoleMessage {
  messageId: string;
  turnId: string;
  role: "user" | "assistant";
  source: "text" | "voice";
  content: string;
  ts: number;
  redacted?: boolean;
  redactedKinds?: string[];
  /** 这条语音消息由哪个 ASR 档转写。仅 source=voice 的用户消息有值。 */
  asrEngine?: string | null;
  /**
   * 这条助手回复当时下发给端上的 TTS 档位。
   * 不是"实际播了什么"，见界面上的措辞与 schema 注释。
   */
  ttsEngine?: string | null;
  /**
   * 服务端已经存下来的音频种类：`asr` = 车主那段原始录音，
   * `tts` = 助手那句的合成音。
   *
   * `undefined` 与 `[]` 意思不同：前者是"这套功能没接"（对象存储未配置，
   * 接口不带这个字段），界面不出现播放键；后者是"接了，但这条还没有"，
   * 助手消息这时点播放会先补合成一次。
   */
  storedAudio?: string[];
}

export interface TurnView {
  turnId: string;
  messages: ConsoleMessage[];
  /**
   * 真实的时间序号（第 1 轮是最早那轮），不随显示顺序倒过来，
   * 保证同一轮在这里与在轨迹、日志里的编号一致。
   */
  index: number;
}

function groupByTurn(messages: ConsoleMessage[]): Array<[string, ConsoleMessage[]]> {
  const map = new Map<string, ConsoleMessage[]>();
  for (const m of messages) {
    const list = map.get(m.turnId) ?? [];
    list.push(m);
    map.set(m.turnId, list);
  }
  return [...map.entries()];
}

/**
 * 按时间逆序排列轮次（最近一轮在最上面）。
 *
 * 排障与运营查看时通常关注最近一轮。
 * 序号仍取自正序位置，见 `TurnView.index`。
 */
export function turnsNewestFirst(messages: ConsoleMessage[]): TurnView[] {
  const grouped = groupByTurn(messages);
  return grouped
    .map(([turnId, list], i) => ({ turnId, messages: list, index: i + 1 }))
    .reverse();
}

/**
 * 把会话轨迹切到某一轮。
 *
 * `orphan` 是不属于任何轮次的事件数：`acp.connect`（连接建立在任何一轮之外）、
 * 以及轮次关闭后才落的裁决（确认超时那一类）都没有 `turnId`。
 * 按轮过滤时它们不在其中，所以单独计数告知读者；这些事件往往是最慢的。
 */
export function eventsOfTurn(
  timeline: TraceEvent[],
  turnId: string,
): { events: TraceEvent[]; orphan: number } {
  return {
    events: timeline.filter((e) => e.turnId === turnId),
    orphan: timeline.filter((e) => !e.turnId).length,
  };
}
