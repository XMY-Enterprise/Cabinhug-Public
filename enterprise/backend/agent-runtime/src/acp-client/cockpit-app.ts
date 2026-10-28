/**
 * 车主面的 `AcpApp` 描述符（ACR-035）。
 *
 * # `@cabinhug/tools` 只在这里出现
 *
 * 底座（`@cabinhug/acp`）不 import 工具表：否则用研面会间接拿到车主面的
 * 全部工具（订单、日历、车控……），且不报错。
 * 因此工具表、轨迹、节假日都在这里注入，底座只拿到回调。
 *
 * # `piDir` 由描述符给出
 *
 * 底座若按自身 `import.meta.url` 推算 pi 目录，会把车主面的 `.pi/extensions` 与
 * prompts 加载给用研面，且不报错。因此路径由描述符给出，`check:arch` 的
 * `acp-substrate-pure` 禁止底座使用 `import.meta.url`。本文件可以使用它：
 * 车主面就在 pi-agents 旁边。
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listForAgent, type AgentName as ToolAgentName } from "@cabinhug/tools";
import type { AcpApp, AcpTracer, ThinkingLevel } from "@cabinhug/acp";

import { CancelledError } from "../trace";
import { recordPrompt, recordSpan, span } from "../trace/span";
import { canonicalAgent, loadAgentPrompt, thinkingLevelFor } from "./agent-prompt";
import { withDateline } from "./connection";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 车主面的 pi 配置目录。`.pi/extensions` 与 `settings.json` 都在它下面。 */
export const COCKPIT_PI_DIR = resolve(HERE, "../../../pi-agents");
export const COCKPIT_PROMPTS_DIR = resolve(COCKPIT_PI_DIR, "prompts");

/**
 * 车主面的轨迹实现，把四个既有函数装进一个对象。
 *
 * `cancelled` 造的是 `trace` 的 `CancelledError`：调用方按 `err.cancelled`
 * 区分取消与真失败，错误类型不一致时取消会被当成失败上报。
 */
export const cockpitTracer: AcpTracer = {
  span,
  recordSpan,
  recordPrompt,
  cancelled: (message) => new CancelledError(message),
};

/**
 * 车主面的 Agent 清单。与 `connection.ts` 的 `AgentName` 联合类型同源：
 * 那份是类型，这份是运行期的池键清单（`cockpit-app.test.ts` 钉两份逐字对齐）。
 */
export const COCKPIT_AGENTS = [
  "supervisor",
  "buying",
  "ownership",
  "trip",
  "cabin",
  "service",
  "test-drive",
  "drive",
  "hotel",
  "tour",
  "transit",
  "guide-access",
  "guide-spots",
  "guide-comfort",
  "nav",
  // 多天行程 Plan 层的语义裁决会话：池键 tour-plan:high，与 tour:off 各自独立进程。
  "tour-plan",
  // 装配体检修复的裁决会话：池键 trip-review:high，只在 CABINHUG_TRIP_PLAN_LAYER=review 时被发。
  "trip-review",
] as const;

export function createCockpitApp(opts: { toolsEndpoint: string; piDir?: string } = { toolsEndpoint: "" }): AcpApp {
  const piDir = opts.piDir ?? COCKPIT_PI_DIR;
  return {
    id: "cockpit",
    piDir,
    promptsDir: resolve(piDir, "prompts"),
    agents: COCKPIT_AGENTS,
    toolsEndpoint: opts.toolsEndpoint,
    // `loadAgentPrompt` 是同步的；描述符要 Promise 是为了让用研面能去库里取。
    promptFor: async (agent) => loadAgentPrompt(agent),
    thinkingFor: (agent): ThinkingLevel => thinkingLevelFor(agent),
    /*
     * ACL 的单一真相源是 registry 的 `agents` 数组。
     * describe 端裁剪、invoke 端 403、本清单三处必须同源，不另写手工清单。
     */
    toolNamesFor: (agent) => listForAgent(canonicalAgent(agent) as ToolAgentName).map((t) => t.name),
    tracer: cockpitTracer,
    // 车主面要前置"今天几号 + 接下来的节假日"；用研面不传这个（见 `AcpApp.decoratePrompt`）。
    decoratePrompt: withDateline,
  };
}
