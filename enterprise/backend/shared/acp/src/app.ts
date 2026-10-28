/**
 * 一个「应用」在底座眼里的描述（ACR-035）。
 *
 * # 底座不自行推断应用差异
 *
 * 底座同时服务车主面与用研面，两边不同的东西都由外部给出：
 * 加载哪份 `.pi/extensions`、读哪个 prompts 目录、这个会话能用哪些工具、
 * 轨迹往哪写、prompt 前面是否附当天日期。`piDir` 的理由见其注释。
 *
 * # 描述符而非构造参数
 *
 * 这些项合起来定义"这是哪个应用"，总是一起变化。拆成参数时漏传一项不会报错，
 * 例如 `toolNamesFor` 漏传会让模型手里零工具却照常作答。
 */

import type { ThinkingLevel } from "./thinking";

/** 轨迹记录。底座只知道"要记一笔"，不知道记去哪。 */
export interface AcpTracer {
  /** 包一段异步操作，自动记开始/结束/失败。 */
  span<T>(threadId: string | undefined, name: string, fn: () => Promise<T>, opts?: AcpSpanOptions): Promise<T>;
  /** 记一段已经发生过的耗时（思考分段用它——那几段是事后从 tick 切出来的）。 */
  recordSpan(
    threadId: string | undefined,
    name: string,
    startedAt: number,
    endedAt: number,
    status: AcpSpanStatus,
    opts?: AcpSpanOptions,
  ): void;
  /** 记一次发给模型的 prompt。 */
  recordPrompt(threadId: string | undefined, agent: string, text: string): void;
  /**
   * 造一个「本轮已取消」的错误。
   *
   * 由应用提供：调用方按 `err.cancelled` 区分取消与真失败，判据在应用侧
   * （车主面是 `trace` 的 `CancelledError`）。底座自建错误类型会导致
   * `instanceof` 不匹配，取消被当成失败上报。
   */
  cancelled(message: string): Error;
}

export type AcpSpanStatus = "ok" | "failed" | "cancelled";

export interface AcpSpanOptions {
  agent?: string;
  /** 结构性信息，不含用户原文（AC-44-10）。 */
  detail?: string;
}

export interface AcpApp {
  /** 哪个应用。只用于日志与进程池的键前缀，底座不按它分支。 */
  id: "cockpit" | "research";

  /**
   * `session/new` 的 `cwd`，决定 pi 加载哪份 `.pi/extensions` 与 `settings.json`。
   *
   * 本包禁用 `import.meta.url` 的原因：从底座位置推断的 `pi-agents/` 恰好是
   * 车主面的正确目录，第二个应用接入时会静默加载车主面的扩展与提示词，不报错。
   */
  piDir: string;

  /**
   * pi 的二进制所在目录（`node_modules/.bin/pi-acp` 与 `bin/pi-approved.sh`）。
   * 缺省等于 `piDir`，车主面不传。
   *
   * `piDir` 是 pi 的项目（`session/new` 的 `cwd` 决定加载哪份 `.pi/extensions`
   * 与 `settings.json`），`binDir` 只决定从哪里启动进程。
   *
   * 用研面借用车主面的 pi 安装：`piDir = pi-research/`（自己的扩展与提示词），
   * `binDir = pi-agents/`（共用 pi-acp / pi / 模型覆盖 / 凭据），避免两份
   * devDependencies 各自漂移成两个协议版本（ACR-038）。
   */
  binDir?: string;

  /** prompts 目录。同上，不靠 `import.meta.url` 推。 */
  promptsDir: string;

  /** 这个应用有哪些 Agent。底座不认识具体名字，只拿它做进程池的键。 */
  agents: readonly string[];

  /**
   * 工具端点（`.pi/extensions` 里的扩展回调它）。
   *
   * 底座把它按 `CABINHUG_TOOLS_ENDPOINT` 注进子进程环境（`connection.ts` 的
   * `spawnEnvFor`）。扩展若改读 `AGENT_RUNTIME_URL` 会回调到车主面的工具端点，
   * `listForAgent` 对未知 Agent 回空表，模型手里零工具却照常作答（ACR-038）。
   */
  toolsEndpoint: string;

  /** 这个会话的业务 prompt。读盘与缓存都在应用侧。 */
  promptFor(agent: string): Promise<string>;

  /** 这个会话的思考档。默认规则在 `defaultThinkingFor`，应用可以叠自己的例外。 */
  thinkingFor(agent: string): ThinkingLevel;

  /**
   * 这个会话能用哪些工具，拼给 `--tools`。
   *
   * 注入而不是 import：底座引用 `@cabinhug/tools` 会让用研面间接拿到
   * 车主面的全部工具（订单、日历、车控等）且不报错。
   * `check:arch` 的 `acp-substrate-pure` 守着这条。
   *
   * pi 对 `--tools` 里的未知名静默忽略，拼错的工具会无声消失。
   * 因此清单必须与扩展注册的名字同源，不在应用侧另写一份。
   */
  toolNamesFor(agent: string): readonly string[];

  tracer: AcpTracer;

  /**
   * 给一轮 prompt 前置"模型手里没有、又必须准"的事实。
   *
   * 车主面传 `withDateline`（今天日期与接下来的节假日）；用研面不传：
   * 它分析的是已发生的对话窗，附上当天日期会让模型以窗外的今天为分析基准。
   */
  decoratePrompt?(text: string, now: number): string;
}
