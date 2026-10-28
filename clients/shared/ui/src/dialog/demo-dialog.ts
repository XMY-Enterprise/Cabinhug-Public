/**
 * 对话页的版式截图入口（`?dialog=demo`），与 `?guide=demo` / `?profile=demo` 同一类。
 *
 * 放在共享包而不是某一端：车机与手机共用同一个 `DialogScreen`，演示数据也用同一份，
 * 避免两端内容分叉（与 `DEMO_TRIP_PLAN` 相同）。
 *
 * 会话列表与消息都只在 Tauri 里有（`sessions` 与 `sendText` 仅在 `isTauriEnv()` 时传入），
 * 浏览器里对话页恒为空态；本入口让左栏、气泡、输入条能在浏览器里验证。
 * 数据自带「（演示）」字样，与 `DEMO_TRIP_PLAN` 一致。
 */
import type { ChatMessage } from "@cabinhug/shared";
import type { SessionBrief } from "./SessionList";

export function isDialogDemo(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("dialog") === "demo";
}

const T0 = Date.parse("2026-09-09T11:02:00+08:00");
const sid = "demo-session-1";
const msg = (
  i: number,
  role: "user" | "assistant",
  source: ChatMessage["source"],
  content: string,
): ChatMessage => ({
  messageId: `demo-m${i}`,
  sessionId: sid,
  turnId: `demo-t${Math.ceil(i / 2)}`,
  role,
  source,
  content,
  ts: T0 + i * 20_000,
  cancelled: false,
});

export const DEMO_DIALOG_MESSAGES: ChatMessage[] = [
  msg(1, "user", "voice", "明天去徐州玩三天，帮我安排一下（演示）"),
  {
    ...msg(
      2,
      "assistant",
      "text",
      "已经按 3 天排好了：Day 1 徐州汉文化景区、水下兵马俑博物馆、淮海战役烈士纪念塔；" +
        "Day 2 云龙山索滑道、云龙湖旅游景区；Day 3 户部山古民居、戏马台、回龙窝网红打卡墙。\n" +
        "全程约 36 公里，预计用时 4 h 30 min。第二天午后有小雨，索滑道排在上午。（演示）",
    ),
    // 用到了天气，正文之后单独一行署名（不进口播）。
    sources: [{ name: "示例数据源", url: "https://example.com/source" }],
  },
  msg(3, "user", "voice", "第二天想加个吃饭的地方（演示）"),
];

const brief = (n: number, title: string, minutesAgo: number): SessionBrief => ({
  sessionId: n === 1 ? sid : `demo-session-${n}`,
  title,
  createdAt: new Date(T0 - minutesAgo * 60_000).toISOString(),
  updatedAt: new Date(T0 - minutesAgo * 60_000).toISOString(),
  closedAt: n === 1 ? null : new Date(T0 - minutesAgo * 60_000).toISOString(),
  messageCount: 4,
});

export const DEMO_DIALOG_SESSIONS: SessionBrief[] = [
  brief(1, "明天去徐州玩三天（演示）", 0),
  brief(2, "这车最近有点费电，正常吗（演示）", 900),
  brief(3, "找个能停车的充电站（演示）", 1010),
  brief(4, "导航去公司（演示）", 2880),
  brief(5, "周末带孩子去哪玩（演示）", 4320),
  brief(6, "保养该做了吗（演示）", 5760),
];

/** 流式那一条（半句 + 光标），验的是气泡的流式形态。 */
export const DEMO_DIALOG_STREAMING = {
  turnId: "demo-t2",
  text: "云龙湖边的阿喆米线离索滑道 1.2 公里，中午过去正好——（演示）",
};
