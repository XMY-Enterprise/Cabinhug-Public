/**
 * 能力条的调用面。
 *
 * 本文件只出函数与类型，不画界面。
 *
 * # 能力条上出现哪几个按钮，前端不自己判
 *
 * `capabilitiesFor` 是 `@cabinhug/research` 里的纯函数，前后端引同一份：
 * 界面用它决定渲染什么，服务端用它决定是否受理。前端另写一套判断时，
 * 被抑制的格上会出现一个可点击但返回 400 的按钮。
 *
 * # 运行流不新起一套重连
 *
 * `openEventStream` 已处理带 `Authorization` 的重连与退避。这里只包一层：
 * 收到终态事件就主动关闭，否则那一层会把运行正常结束当成断线反复重连。
 */

import { api } from "./index";
import { openEventStream, type StreamHandle, type StreamState } from "./stream";

/*
 * 引子路径，不引包名。
 *
 * `@cabinhug/research` 的桶文件一并导出 `fingerprint.ts`，该文件
 * `import { createHash } from "node:crypto"`，浏览器侧打包会失败
 * （Rollup 报 `"createHash" is not exported by "__vite-browser-external"`，
 * vite 在该错误之前只给一句 externalized 警告）。子路径入口在包的 `exports` 里声明，
 * 纯函数是同一份。
 */
import { capabilitiesFor, type Capability, type SelectionScope } from "@cabinhug/research/capabilities";
import { ASK_MAX_ROUNDS, type AgentNote } from "@cabinhug/research/agent-note";
import type { RedTeamFinding } from "@cabinhug/research/red-team";

export type { AgentNote, Capability, RedTeamFinding, SelectionScope };
export { ASK_MAX_ROUNDS };

/** 能力条上这一刻该出现哪几个按钮。与服务端的闸门是同一个函数。 */
export const railFor = (scope: SelectionScope): readonly Capability[] => capabilitiesFor(scope);

/** `🔍` 层：同步回结果。 */
export interface LookupResult<T = unknown> {
  capability: string;
  tier: "lookup";
  result: T;
}

/** `✎` / `💬` 层：立刻回运行 id，进度经 SSE。 */
export interface RunAccepted {
  capability: string;
  tier: "write" | "dialog";
  runId: string;
  /**
   * `💬` 层的有界轮次：这一次是第几轮、上界是多少（C7、C10–C12）。
   *
   * 可选而不是必填：`✎` 层的能力不带这两个字段，必填会迫使调用处编造数值，
   * 而编造的值在界面上与真实值无法区分。
   */
  round?: number;
  limit?: number;
}

export type CapabilityResponse<T = unknown> = LookupResult<T> | RunAccepted;

export const isLookup = <T>(r: CapabilityResponse<T>): r is LookupResult<T> => r.tier === "lookup";

/**
 * 调一次能力。
 *
 * 不在这里做"这条能力在不在能力条上"的预检：闸门在服务端，
 * 前端再判一次只会多一处可能分叉的判断。前端的职责是不画出不可用的按钮。
 */
export function runCapability<T = unknown>(
  capability: string,
  scope: SelectionScope,
  contractId: string,
  /**
   * 这条能力自己的入参（C7 的 `angle`；C10–C12 的 `question`）。
   *
   * 不铺成具名可选参数：十二条能力各有入参，铺开后签名会变成
   * `limit?, deltas?, angle?, question?, …`，调用处传错位置不报错。
   */
  extra: Record<string, unknown> = {},
): Promise<CapabilityResponse<T>> {
  return api.post<CapabilityResponse<T>>(`/console/research/capabilities/${capability}`, {
    scope,
    contractId,
    ...extra,
  });
}

/**
 * 能力调用会回哪些业务错误码，以及它们在界面上的文案。
 *
 * # 用本地表而不是显示服务端的 `hint`
 *
 * `ApiError` 只带 `code`（`api/index.ts` 从错误体里取 `error` 字段），
 * 拿不到 `hint` / `reason`；取它们需要改动所有页面共用的请求层。
 *
 * # 表外的码原样显示
 *
 * 统一显示"操作失败"会丢掉排查线索。尤其 `capability_not_available`：
 * 它表示服务端认为该格被抑制而界面画出了按钮，是两侧判据分叉的唯一现象。
 */
export const CAPABILITY_ERROR_TEXT: Readonly<Record<string, string>> = {
  /* 前两条是 400，最后一条是 503。 */
  question_rejected: "这个问题没能通过输入规则筛，服务端没让它进模型。换个问法再试",
  ask_limit_reached: `已问满 ${ASK_MAX_ROUNDS} 轮，换个范围再问`,
  agents_not_available: "研究 Agent 未启用（RESEARCH_CHALLENGER_TRANSPORT=direct 或缺 DEEPSEEK_API_KEY）",
};

/** 认识的码翻成人话，不认识的原样带出来（同 `identity/model.ts` 的 `errorText`）。 */
export const capabilityErrorText = (code: string): string => CAPABILITY_ERROR_TEXT[code] ?? code;

/*
 * ── 四条 `🔍` 查类能力的返回形状 ──
 *
 * 这是后端 `research-runtime/src/capabilities/lookup.ts` 的第二份类型声明。
 *
 * 不直接引用后端：控制台是浏览器包，`check:arch` 的 `research-isolation` 不允许它
 * 依赖 research-runtime。也不放进 `@cabinhug/research`：那个包是纯函数，
 * 这四个形状是服务端端点的响应体，不是共享领域模型。
 *
 * `console/test/lookup-result.test.ts` 读后端源码逐字段对账；
 * 字段名不一致时界面上那一栏会静默变空。
 */

export interface CounterEvidenceList {
  themes: Array<{ id: string; name: string }>;
  themeTotal: number;
  truncated: boolean;
  count: number;
  units: Array<{ unitId: string; text: string; themeId: string; themeName: string }>;
  perTheme: Array<{ themeId: string; themeName: string; count: number }>;
}

export interface SystemEventOverlap {
  window: { from: number; to: number };
  count: number;
  events: Array<{ at: number; kind: string; summary: string; inRecentHalf: boolean }>;
}

export interface SegmentSlice {
  themes: Array<{ id: string; name: string }>;
  themeTotal: number;
  truncated: boolean;
  perTheme: Array<{
    themeId: string;
    themeName: string;
    slices: Array<{ segment: string; n: number; share: number }>;
    topShare: number;
    topSegment: string | null;
  }>;
}

export interface ThresholdSensitivity {
  code: string;
  probes: Array<{ delta: number; flips: boolean; detail: string }>;
  anyFlips: boolean;
  minFlipDelta: number | null;
}

/** C9 的返回就是 findings 数组，单独给一个有类型的入口。 */
export async function fetchRedTeam(contractId: string): Promise<RedTeamFinding[]> {
  const res = await runCapability<RedTeamFinding[]>("red-team", { kind: "page" }, contractId);
  return isLookup(res) ? res.result : [];
}

export interface RunStreamEvent {
  event: "state" | "progress" | "stage" | "done" | "failed";
  runId: string;
  stage?: string;
  note?: string;
  notes?: string[];
  pending?: unknown[];
  usage?: { totalTokens: number; models: string[] } | null;
  error?: string;
  /**
   * 终态载荷。`done` 帧带，别的帧不带。
   *
   * 形状由能力决定（C10–C12 是 `{ note: AgentNote, agent, round, steps, … }`），
   * 所以这里是 `unknown`，由各自的面板在使用处收窄；联合类型会要求每加一条能力都改这个公共文件。
   */
  result?: unknown;
}

/**
 * 订阅一次运行的进度。
 *
 * `openEventStream` 只认 `data:` 行，不认 `event:` 行，所以事件类型
 * 由载荷自己带（上游两处都发）。解析 `event:` 行需要改动所有页面共用的那一层。
 */
export function openRunStream(
  runId: string,
  handlers: {
    onEvent: (e: RunStreamEvent) => void;
    onState?: (s: StreamState, detail?: string) => void;
  },
): StreamHandle {
  let handle: StreamHandle | undefined;
  let done = false;

  handle = openEventStream<RunStreamEvent>(`/console/research/runs/${encodeURIComponent(runId)}/stream`, {
    onState: handlers.onState,
    onEvent: (e) => {
      handlers.onEvent(e);
      // 终态：主动收线。不收的话重连层会把正常结束当断线，一直重连。
      if (!done && (e.event === "done" || e.event === "failed")) {
        done = true;
        handle?.close();
      }
    },
  });

  return {
    close() {
      done = true;
      handle?.close();
    },
  };
}
