/**
 * 用研面的 `AcpApp` 描述符（ACR-038）。
 *
 * # 目录由描述符给出，不由底座推导
 *
 * `@cabinhug/acp` 里禁用 `import.meta.url`（`check:arch` 的 `acp-substrate-pure` 守着），
 * 理由见底座 `app.ts` 文件头。补充用研面这一侧：车主面与用研面上溯的层数相同，
 * 底座里任何 `resolve(HERE, "../../../pi-agents")` 对两边都能算出结果，
 * 用研面却会拿到车主面的 `.pi/extensions` 与提示词且不报错。
 * 所以路径是描述符的一部分，由应用自己声明。
 *
 * # `piDir` 与 `binDir` 是两件事
 *
 * - `piDir = enterprise/backend/pi-research`：`session/new` 的 `cwd`，决定 pi 加载
 *   哪份 `.pi/settings.json` 与 `.pi/extensions/`，属于用研面自己。
 * - `binDir = enterprise/backend/pi-agents`：借用车主面的 pi 安装（ACR-038）。
 *   借用的是 `node_modules/.bin/pi-acp` 与 `bin/pi-approved.sh`，以及共用的
 *   `.pi/agent/models.json` 与凭据。各装一份时两处 devDependencies 需手工同步，
 *   一旦不一致，同一个底座会面对两个协议版本。
 *
 * 车主面的 `createCockpitApp()` 不传 `binDir`，缺省等于 `piDir`，行为不变。
 *
 * # 描述符与进程池分开
 *
 * `AcpClientPool` 与 Challenger 的 transport 开关在 `src/index.ts` 装配：
 * 这里产出的 `toolsEndpoint` 由底座按 `CABINHUG_TOOLS_ENDPOINT` 注入 pi 子进程，
 * 回调落在 `./tools-endpoint.ts`。
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { canonicalAgent, type AcpApp, type AcpTracer, type ThinkingLevel } from "@cabinhug/acp";
import { listForAgent, type ResearchAgentName } from "@cabinhug/research-tools";

const HERE = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
/** `src/acp/` 上溯两级。`index.ts` 的 `PKG_ROOT` 是同一个目录，只是它在 `src/` 下。 */
const PKG_ROOT = resolve(HERE, "../..");

/** pi 的项目目录：扩展与提示词属于用研面自己。 */
export const RESEARCH_PI_DIR = resolve(PKG_ROOT, "../pi-research");
/** pi 的二进制目录：借用车主面那一份安装（ACR-038）。 */
export const RESEARCH_BIN_DIR = resolve(PKG_ROOT, "../pi-agents");

/**
 * 用研面的 Agent（设计稿 §4 表中全部带工具的角色）。
 *
 * `satisfies` 在编译期保证每个名字都是 `@cabinhug/research-tools` 的
 * `ResearchAgentName`：ACL 的值域与池键清单同源，不另写名单。新增 Agent 需在工具表
 * 加名字，并在 `pi-research/prompts/` 加同名 `.md`，缺后者时 `loadResearchPrompt` 抛错。
 *
 * 顺序不必与 `RESEARCH_AGENT_NAMES` 相同（那边按设计稿表行序），但集合必须相同：
 * 少一个名字时该 Agent 起不来，多一个时它手里零工具。`research-app.test.ts` 按集合对账。
 */
export const RESEARCH_AGENTS = [
  "challenger",
  "analyst",
  "taxonomist",
  "archivist",
] as const satisfies readonly ResearchAgentName[];

/**
 * 用研面的轨迹实现：只打 console。
 *
 * 车主面那份接 OTel 与 `trace/span`；用研进程不引 `@opentelemetry`：
 * 几行日志不值得一条观测链，与 `internal-api` 不引 express 同一取舍。
 *
 * `recordPrompt` 只记结构性信息（长度），不记原文：prompt 由证据单元拼成，
 * 须遵守 `internal-api` 文件头"原文不出研究面"的约束（AC-44-10 同一口径）。
 */
export const researchTracer: AcpTracer = {
  async span(threadId, name, fn, opts) {
    const startedAt = Date.now();
    try {
      const out = await fn();
      console.log(`[research-acp] ${name} ok ${Date.now() - startedAt}ms${suffix(threadId, opts?.agent)}`);
      return out;
    } catch (err) {
      console.warn(
        `[research-acp] ${name} failed ${Date.now() - startedAt}ms${suffix(threadId, opts?.agent)}：` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  },
  recordSpan(threadId, name, startedAt, endedAt, status, opts) {
    console.log(`[research-acp] ${name} ${status} ${endedAt - startedAt}ms${suffix(threadId, opts?.agent)}`);
  },
  recordPrompt(threadId, agent, text) {
    // 只记长度：prompt 是证据单元拼出的正文，写进日志会成为原文的第二个出口。
    console.log(`[research-acp] prompt agent=${agent} ${text.length} 字${suffix(threadId)}`);
  },
  /**
   * 取消错误带 `cancelled = true`。
   *
   * 形状必须与调用方的判据一致（见底座 `app.ts`：两边 `instanceof` 对不上时，
   * 取消会被当成失败上报）。用研面没有自己的 `CancelledError` 类，按这个字段分流取消。
   */
  cancelled: (message) => Object.assign(new Error(message), { cancelled: true as const }),
};

const suffix = (threadId?: string, agent?: string): string =>
  `${agent ? ` agent=${agent}` : ""}${threadId ? ` thread=${threadId}` : ""}`;

export interface ResearchAppOptions {
  /** 扩展回调地址。装配层给 `http://127.0.0.1:<RESEARCH_RUNTIME_PORT>`（本进程只绑回环）。 */
  toolsEndpoint: string;
  /** 覆盖 pi 项目目录。只有测试会传。 */
  piDir?: string;
  /** 覆盖 pi 二进制目录。只有测试会传。 */
  binDir?: string;
}

export function createResearchApp(opts: ResearchAppOptions): AcpApp {
  const piDir = opts.piDir ?? RESEARCH_PI_DIR;
  const promptsDir = join(piDir, "prompts");
  return {
    id: "research",
    piDir,
    binDir: opts.binDir ?? RESEARCH_BIN_DIR,
    promptsDir,
    agents: RESEARCH_AGENTS,
    toolsEndpoint: opts.toolsEndpoint,
    promptFor: async (agent) => loadResearchPrompt(promptsDir, agent),
    /*
     * 恒 `off`，不走 `defaultThinkingFor`。
     *
     * 那个默认只对 `-task` / `-intent` 后缀关思考，研究面的 Agent 名没有后缀，
     * 会得到 `high`。Challenger 的产出是给代码解析的判决（收口跳是
     * `generateObject` + `challengeSchema`），思考只会消耗预算而无人阅读
     * （见 内部开发指引 的命名规则中 `-task` 自动关思考一条）。
     */
    thinkingFor: (): ThinkingLevel => "off",
    /*
     * ACL 的单一真相源是注册表的 `agents` 数组：describe 端裁剪、invoke 端 403、
     * 本清单三处同源，不另写清单。
     * 归一后缀与 `promptFor` 同口径：会话隔离靠会话键，不靠后缀。
     */
    toolNamesFor: (agent) =>
      listForAgent(canonicalAgent(agent) as ResearchAgentName).map((t) => t.name),
    tracer: researchTracer,
    /*
     * 不实现 `decoratePrompt`。车主面前置"今天几号 + 接下来的节假日"；用研面分析的
     * 是已经发生过的对话窗，贴上今天会让模型把窗外的今天当成分析基准
     * （见底座 `app.ts` 的 `decoratePrompt` 注释）。追问角度也不走这里，
     * 它进本轮 user 消息（见 `challenge/acp-transport.ts`）。
     */
  };
}

/**
 * 读这个 Agent 的业务提示词，读不到就抛。
 *
 * 与车主面 `loadAgentPrompt` 一致：缺文件即抛错。回空字符串时 pi 照常启动、
 * 模型照常作答，但没有判定口径，产出的挑战记录与正常记录无法区分。
 */
export async function loadResearchPrompt(promptsDir: string, agent: string): Promise<string> {
  const file = join(promptsDir, `${canonicalAgent(agent)}.md`);
  if (!existsSync(file)) {
    throw new Error(`[research-acp] Agent ${agent} 的提示词不存在：${file}`);
  }
  return readFileSync(file, "utf8");
}
