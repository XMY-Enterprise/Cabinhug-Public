/**
 * 车主面对 `@cabinhug/acp` 的垫片，以及车主面专属的定义（ACR-035）。
 *
 * # 文件分两部分
 *
 * 上半是 re-export：`AcpClient` / `createAcpStreamer` / 连接与会话管理在
 * `@cabinhug/acp`。用研面跑在同一套 ACP 上，而 ADR-011 禁止它 import 车主面。
 *
 * 下半是车主面专属、不属于底座的部分：
 *  - `AgentName`：车主面 Agent 的名字。底座只认 `string`，
 *    不感知 `hotel`、`nav` 等具体 Agent。
 *  - `toolListFor`：依赖 `@cabinhug/tools`。底座若引用工具表，
 *    用研面会间接拿到车主面的全部工具，且不报错。
 *  - `withDateline` / `dateline`：依赖 `../holidays`，语义也属于车主面
 *    （用研面分析的是已经发生过的时间窗，"今天"对它没有意义）。
 *    它经 `AcpApp.decoratePrompt` 注入给底座。
 *
 * # 调用点保持原写法
 *
 * `AcpClient` 在这里包了一层：构造时自动带上车主面的描述符，
 * 调用点仍写 `new AcpClient({...})` 与 `new AcpClientPool()`。
 */

import {
  AcpClient as AcpClientBase,
  createAcpStreamer as createAcpStreamerBase,
  type AcpClientOptions as AcpClientOptionsBase,
  type AcpHealth,
  type AcpPrompter,
  type ChatStreamHooks,
  type ChatStreamer,
} from "@cabinhug/acp";
import { canonicalAgent } from "@cabinhug/acp";
import { listForAgent, type AgentName as ToolAgentName } from "@cabinhug/tools";

import { holidayLine } from "../holidays";
import { createCockpitApp, COCKPIT_PI_DIR } from "./cockpit-app";

/*
 * 原样 re-export 的纯函数。导出面必须与调用方逐字对得上：少一个不会编译红，
 * 而是在运行时报 `does not provide an export named`。
 */
export { modelSpecFor, trailingUserRunStart } from "@cabinhug/acp";
export type { AcpHealth, AcpPrompter } from "@cabinhug/acp";

/** 车主面的构造参数：`app` 由这里补上，调用点不用知道有这回事。 */
export type AcpClientOptions = Omit<AcpClientOptionsBase, "app"> & { app?: AcpClientOptionsBase["app"] };

/**
 * 车主面的 `AcpClient`。
 *
 * 没传 `app` 时补上车主面的描述符。
 * 底座那一侧 `app` 是必填的（漏传时 tsc 报错）；默认值只出现在车主面这一层，
 * 不出现在底座里。
 */
export class AcpClient extends AcpClientBase {
  constructor(opts: AcpClientOptions = {}) {
    super({ ...opts, app: opts.app ?? createCockpitApp() });
  }
}

/** 同上：`piDir` 由车主面补。 */
export function createAcpStreamer(
  client: AcpPrompter,
  resolve: (hooks?: ChatStreamHooks) => { cabinhugSessionId: string; agent: string },
): ChatStreamer {
  return createAcpStreamerBase(client, resolve, COCKPIT_PI_DIR);
}

// ── 下半：车主面专属 ───────────────────────────────────────

export type AgentName =
  | "supervisor"
  | "buying"
  | "ownership"
  | "trip"
  | "cabin"
  | "service"
  // 试驾预约。名字不能以 `-task`/`-intent`/`-voice` 结尾：
  // `canonicalAgent` 会剥掉这些后缀，`loadAgentPrompt` 会去找错文件，
  // 外部症状只是"分支失败"。`test-drive` 不受影响。
  | "test-drive"
  // 多天行程 fan-out 的四个专家：只以 `-task` 会话被编排层驱动（思考档
  // 随后缀落 off），没有直达路由：route.ts 的目标里没有它们，answer 也不发给它们。
  | "drive"
  | "hotel"
  | "tour"
  | "transit"
  // 景区导游采集三分支：同上，仅以 `-task` 会话被 runGuideFanout 驱动，
  // 触发方式是点击景点（HTTP），不经聊天路由。与 registry.ts 的第二份必须同步。
  | "guide-access"
  | "guide-spots"
  | "guide-comfort"
  // 出发导航规划：仅以 `nav-task` 会话被 runNavPlanFanout 驱动，触发方式是点「开始行程」（HTTP），
  // 不经聊天路由。与 registry.ts 的第二份必须同步。
  | "nav"
  // 多天行程 Plan 层的语义裁决（ACR-037）：只以 `tour-plan-task` 会话被 runTripPlanLayer 驱动，
  // 不进路由、不应答。与 registry.ts 的第一份必须同步。
  | "tour-plan"
  // 装配体检修复的裁决会话（ACR-037）：只以 `trip-review-task` 会话被 reviewLoop 驱动，
  // 不进路由、不应答；思考档由 PI_OVERRIDES 钉 high。与 registry.ts 的第一份必须同步。
  | "trip-review";

/**
 * 该 Agent 的工具允许清单，拼给 `--tools`。
 *
 * # 从 `listForAgent` 派生
 *
 * ACL 的单一真相源是 registry 的 `agents` 数组。describe 端裁剪、
 * invoke 端 403、本清单三处必须同源，不另写手工清单。
 * 名字与扩展注册的一致性也由同源保证：pi 对 `--tools` 里的未知名静默忽略，
 * 拼错不报错，只会让那个工具消失。
 *
 * # 在 spawn 时计算，不缓存
 *
 * 注册表是静态模块，`listForAgent` 是一次数组 filter；连接重建是罕见路径，
 * 缓存会引入"注册表变了但清单没变"的状态。
 */
export function toolListFor(agent: AgentName | string): string {
  return listForAgent(canonicalAgent(agent) as ToolAgentName)
    .map((t) => t.name)
    .join(",");
}

/**
 * 每次 `session/prompt` 前置一行「今天是几号」。
 *
 * 模型不知道今天的日期，而车主的话里多是相对日期（「下周末」「后天」「十七号」），
 * 缺少当天日期时模型会给出错误的绝对日期，下游的日期窗口判定随之失败。
 *
 * 放在这里而不放系统提示词：系统提示词在 pi 进程启动时一次拼定（`--append-system-prompt`），
 * 进程跨过零点后日期会错；这一行按轮拼接，跨零点仍正确。
 * 时区取北京时间，与天气/门店时段的口径一致（见 `weather.ts` 的 `today()`），
 * 否则跨零点前后会差一天。
 */
export function dateline(now: number = Date.now()): string {
  const bj = new Date(now + 8 * 3_600_000);
  const ymd = bj.toISOString().slice(0, 10);
  const weekday = "日一二三四五六"[bj.getUTCDay()];
  return `【今天是 ${ymd}（周${weekday}），北京时间】`;
}

/**
 * 给一轮 prompt 前置"模型手里没有、又必须准"的事实：今天几号，以及接下来的节假日。
 *
 * `dateline` 只解决相对日期（「下周二」「后天」），解决不了「中秋是几号」。
 * 农历换算不交给模型：模型会串错农历年份，而错误日期看上去与正常日期无异。
 *
 * 表覆盖不到时 `holidayLine` 回空串，这里只前置日期行：宁可不给，也不给错的。
 */
export function withDateline(text: string, now: number = Date.now()): string {
  const holidays = holidayLine(now);
  return [dateline(now), holidays, text].filter(Boolean).join("\n");
}
