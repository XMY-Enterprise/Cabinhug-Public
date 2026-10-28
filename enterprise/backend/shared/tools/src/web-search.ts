/**
 * `web_search` —— 通用联网搜索工具 + DeepSeek Anthropic 兼容端点的调用层。
 *
 * # 公共调用层
 *
 * DeepSeek 的 `web_search` 通路（端点、`max_tokens` 截断判定、出处清单的读取）在这里只有一份实现，
 * 导游采集子代理与 `destination_highlights` 共用；后者的 prompt/解析/缓存留在它自己的文件里。
 *
 * # DeepSeek 端点的实测行为（与 Claude 文档不同）
 *
 * 1. `citations` 恒为 `null`：出处的唯一来源是 `web_search_tool_result.content[].url`。
 * 2. 模型写的 URL 会被改写/截断：`results` 清单因此是出处校验的白名单，
 *    消费方必须做字符串全等匹配（`destination-highlights.ts` 的 `verifySource`、
 *    guide merge 的同款校验）。
 * 3. `allowed_domains` 被静默忽略：本文件不声明这个字段，避免读者误以为域收窄生效。
 *    "只看小红书/抖音"只能靠提示词引导 + 出处如实展示。
 *
 * # 搜索结果的去向有两条
 *
 * - 返回给调用方（模型在工具结果里拿到摘要文本 + URL 清单，据此写 `sourceUrl`）；
 * - 经注入的 `SearchResultRecorder` 落进按轮的白名单暂存（agent-runtime 注入，
 *   与 `setBranchSubmissionSink` 同一形态），作为 merge 侧全等校验的依据。
 *   未注入时只是没有旁路记录，工具本身照常工作。
 */

import { defineExternalTool, ToolError, type ExternalTool } from "./external";

// ────────────────────────────── 供应商接线 ──────────────────────────────

export interface WebSearchConfig {
  apiKey: string;
  /** 默认 `https://api.deepseek.com/anthropic`。 */
  baseUrl?: string;
  /**
   * 默认 `deepseek-v4-flash`。
   *
   * 不复用 `DEEPSEEK_MODEL`（那是 OpenAI 兼容路径的模型名，现值 `deepseek-chat`）。
   * DeepSeek 会把不支持的模型名映射到 `deepseek-v4-flash`，行为不变但记录的模型名与实际不符。
   */
  model?: string;
  /** 测试注入。 */
  fetchImpl?: typeof fetch;
}

/**
 * 供应商配置由装配层注入（`agent-runtime/src/index.ts` 经 `setDestinationSearch`
 * 别名，一处注入两个消费方共用），本包不读 `process.env`，
 * 与 `setAmapClient` / `setEnvCache` 一致：`enterprise/backend/shared/tools` 全包零 `process.env`。
 */
let config: WebSearchConfig | undefined;

export function setWebSearch(c: WebSearchConfig | undefined): void {
  config = c;
}

export function getWebSearch(): WebSearchConfig | undefined {
  return config;
}

// ────────────────────────────── 回包读取 ──────────────────────────────

/** 这次回包里出现过的搜索结果——出处白名单的唯一来源。 */
export interface SearchResultRef {
  url: string;
  title?: string;
}

/** 回包里需要的三样。形状在本文件定义，不依赖任何 SDK 的类型。 */
export interface WebSearchTurn {
  text: string;
  results: SearchResultRef[];
  searchCount: number;
  /**
   * `end_turn` / `max_tokens` / …。
   *
   * `max_tokens` 必须单独识别：那种回包里的 JSON 是截断的，截断处可能还留着一个 `}`，
   * 能被解析成一份缺条目的合法数据。
   */
  stopReason?: string;
}

interface AnthropicBlock {
  type?: string;
  text?: string;
  content?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * 把回包的 `content` 数组拆成 `{ text, results, searchCount }`。
 *
 * 搜索结果从所有 `web_search_tool_result` 块里收集（一次调用会搜多轮）；
 * `searchCount` 优先取 `usage.server_tool_use.web_search_requests`（DeepSeek 自己的计数），
 * 取不到就数 `server_tool_use` 块，两者实测一致。
 */
export function readWebSearchTurn(body: unknown): WebSearchTurn {
  const b = body as {
    content?: AnthropicBlock[];
    stop_reason?: string;
    usage?: { server_tool_use?: { web_search_requests?: number } };
  };
  const blocks = Array.isArray(b?.content) ? b.content : [];
  let text = "";
  const results: SearchResultRef[] = [];
  let toolUseBlocks = 0;

  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string") {
      text += block.text;
    } else if (block?.type === "server_tool_use") {
      toolUseBlocks += 1;
    } else if (block?.type === "web_search_tool_result") {
      // 出错时 `content` 是单个错误对象而不是数组（`web_search_tool_result_error`）。
      // 那种情况下这一轮没有结果，但不致命，别的轮可能搜到了。
      if (!Array.isArray(block.content)) continue;
      for (const r of block.content as Array<{ url?: unknown; title?: unknown }>) {
        const url = str(r?.url);
        if (url) results.push({ url, ...(str(r?.title) ? { title: str(r?.title) } : {}) });
      }
    }
  }

  const reported = b?.usage?.server_tool_use?.web_search_requests;
  return {
    text,
    results,
    searchCount: typeof reported === "number" ? reported : toolUseBlocks,
    ...(typeof b?.stop_reason === "string" ? { stopReason: b.stop_reason } : {}),
  };
}

// ────────────────────────────── 网络：一次 messages 调用 ──────────────────────────────

export interface CallWebSearchOptions {
  /** DeepSeek 侧一次调用最多搜几次。实测 3 次约 8 秒，再多更慢更贵。 */
  maxUses?: number;
  /**
   * 默认 4000 而不是 1600。thinking 与正文共用这一份预算，实测 1600 时
   * 思考占掉 1700 output tokens，`stop_reason` 直接是 `max_tokens`、JSON 只剩半截。
   */
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * 一次带 `web_search` 服务端工具的 messages 调用。
 *
 * `toolName` 只用于报错归属（ToolError 的第一个参数）：同一条通路服务多个工具，
 * 错误落在真正发起调用的那个工具名下。
 */
export async function callAnthropicWebSearch(
  toolName: string,
  prompt: string,
  opts: CallWebSearchOptions = {},
): Promise<WebSearchTurn> {
  const cfg = config;
  if (!cfg?.apiKey) {
    throw new ToolError(
      toolName,
      "unconfigured",
      "联网搜索未接入（缺 DeepSeek 密钥），本次不提供联网结果",
      false,
    );
  }
  const baseUrl = (cfg.baseUrl ?? "https://api.deepseek.com/anthropic").replace(/\/+$/, "");
  const doFetch = cfg.fetchImpl ?? fetch;

  const res = await doFetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": cfg.apiKey },
    body: JSON.stringify({
      model: cfg.model ?? "deepseek-v4-flash",
      max_tokens: opts.maxTokens ?? 4000,
      /*
       * 显式关思考：这个端点不带字段时默认思考（返回块 `thinking, text`），
       * 而这里的输出是给代码解析的。关掉后 `server_tool_use → web_search_tool_result → text` 照常。
       * 用字面量而不 import agent-runtime 的策略表：依赖方向是 runtime → tools，
       * runtime 的 `thinking-policy.test.ts` 会扫本文件核对这一行存在。
       */
      thinking: { type: "disabled" },
      messages: [{ role: "user", content: prompt }],
      // 不带 `allowed_domains`：DeepSeek 侧静默忽略它（见文件头第 3 条）。
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: opts.maxUses ?? 3 }],
    }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  if (!res.ok) {
    throw new ToolError(
      toolName,
      "upstream",
      `联网搜索返回 ${res.status}`,
      res.status >= 500 || res.status === 429,
    );
  }
  const turn = readWebSearchTurn(await res.json());
  if (turn.stopReason === "max_tokens") {
    // 截断的 JSON 有时仍能解析出一份缺条目的结果，必须按失败处理。
    throw new ToolError(
      toolName,
      "upstream",
      "联网搜索的回答被输出上限截断，本次结果不完整",
      true,
    );
  }
  return turn;
}

// ────────────────────────────── 按轮白名单旁路 ──────────────────────────────

/**
 * 搜索结果的按轮记录器。出处全等校验的白名单要在 merge 侧可读，
 * 而工具执行在 tools-endpoint，这条旁路由 agent-runtime 注入落进它的按轮暂存
 * （与 `setBranchSubmissionSink` 同一形态）。
 */
export interface SearchResultRecorder {
  record(
    ctx: { sessionId?: string; turnId?: string; agent?: string },
    results: readonly SearchResultRef[],
  ): void;
}

let recorder: SearchResultRecorder | undefined;

export function setSearchResultRecorder(r: SearchResultRecorder | undefined): void {
  recorder = r;
}

// ────────────────────────────── 工具壳 ──────────────────────────────

export interface WebSearchArgs {
  /** 要搜什么，如「普陀山 停车场 攻略」。空串直接抛 invalid，不发请求。 */
  query: string;
}

export interface WebSearchData {
  /** 模型对搜索结果的整理文本（含要点与它自己的措辞）。 */
  text: string;
  /**
   * 这次真实出现过的搜索结果链接。引用出处时 `sourceUrl` 必须逐字复制自这份清单，
   * 改写/截断的链接在 merge 侧会被全等校验丢弃。
   */
  results: SearchResultRef[];
  /** 这次实际搜了几次。0 = 模型凭记忆答，工具壳当失败处理，不把结果发出去。 */
  searchCount: number;
}

export const webSearchTool: ExternalTool<WebSearchArgs, WebSearchData> = defineExternalTool<
  WebSearchArgs,
  WebSearchData
>({
  name: "web_search",
  provider: "deepseek-web-search",
  sensitive: false,
  /*
   * 不自动重试（与 destination_highlights 的 retries:1 不同）：
   * 本工具运行在 90s 分支预算里，一次超时加自动重试会耗尽预算（30s 超时加一次重试实测 60.2s），
   * 第二次搜索成功时分支已来不及提交。重试交给模型：它看得到失败结果，
   * 可以换个更短的检索词再试。
   */
  retries: 0,
  /*
   * 45 秒：DeepSeek 侧耗时常态 11~24s、偶发 >30s，30s 会把慢但能成功的调用判为失败。
   * 本工具不带缓存：query 由模型自由拼写，命中率低；导游数据的复用由上层按景区键缓存
   * （ENV_TTL.guideBrief）。
   */
  timeoutMs: 45_000,

  real: async (args, ctx) => {
    const query = args.query?.trim();
    if (!query) {
      throw new ToolError("web_search", "invalid", "query 不能为空", false);
    }
    const prompt = [
      `请联网搜索：${query}`,
      // 输出必须收紧：约束松时单次可达 45s 以上并被 max_tokens 截断，
      // 而截断在本工具是硬失败（见下）。
      "把搜到的要点整理成**至多 8 条**中文条目，每条不超过 40 字（保留关键事实与数字），",
      "每条末尾附它来自的结果链接（逐字复制，不要改写、不要截断）。不要写开头结尾的客套。",
    ].join("\n");
    const turn = await callAnthropicWebSearch("web_search", prompt, {
      signal: ctx.signal,
      // 6000 而不是默认 4000：thinking 与正文共用预算，4000 时出现过截断。
      maxTokens: 6000,
    });
    if (turn.searchCount === 0) {
      // 模型没搜就是在凭记忆答，当失败处理，不把结果发出去。
      throw new ToolError(
        "web_search",
        "upstream",
        "模型没有联网搜索（凭记忆的回答不可信），本次不提供结果",
        true,
      );
    }
    recorder?.record(
      { sessionId: ctx.sessionId, turnId: ctx.turnId, agent: ctx.agent },
      turn.results,
    );
    return { text: turn.text, results: turn.results, searchCount: turn.searchCount };
  },

  /*
   * Mock 三态：固定两条结果，出处用明显的示例域名，
   * 模拟数据不带看起来像真实的链接（与 destination-highlights 一致）。
   */
  mock: (args) => ({
    text: `（模拟搜索）关于「${args.query}」的两条要点：示例要点一；示例要点二。`,
    results: [
      { url: "https://example.com/mock-1", title: "模拟结果一" },
      { url: "https://example.com/mock-2", title: "模拟结果二" },
    ],
    searchCount: 1,
  }),
});
