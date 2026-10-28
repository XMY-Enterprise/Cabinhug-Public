/**
 * 研究工具的回调面（ACR-038）。
 *
 * pi 子进程里的扩展薄代理（`pi-research/.pi/extensions/research-tools.ts`）
 * 调用这两条路径：取工具表、转发一次执行。工具实现留在本进程，与车主面同理：
 * 取数要 `ResearchToolDeps`（仓储、码表版本、镜头与分群），pi 子进程不持有这些。
 *
 * # 计步
 *
 * 直连路径的上界是 AI SDK 的 `maxSteps: CHALLENGE_MAX_STEPS`（8）。
 * pi 没有这个参数：它自己跑工具循环，`--approve` 下每次调用都放行，
 * 上界只能落在这里，按 pi 会话数 invoke 次数。没有上界时一次挑战会查到超时，
 * 表现为这张卡没有挑战记录，与"没找到反例"无法区分。
 *
 * 落地约束：
 *
 * 1. 键是 `piSessionId`，不是 Agent 或进程。同一个 pi 进程会先后跑多张卡的挑战
 *    （池按 Agent × 档位分进程），按进程计步会让第二张卡起手即"步数已用满"。
 * 2. 超限回 HTTP 200 + `{ ok: false, error }`，不回 4xx。4xx 会被 pi 当传输错误重试；
 *    200 + 文本让模型读到并停手（与权限门 deny 的形状一致）。
 * 3. deps 按会话键查表，查不到就回会话已结束，不拿别的挑战的窗去答。
 * 4. 一轮一本账：`register` 归零、`release` 销账。同一个挑战键会被追问反复使用
 *    （C7 走同一个键、同一个 pi 会话），跨轮累加会让第二轮带着上一轮的步数起手。
 *
 * 5. 工具返回过的 id 另记一本。「问它」收口后拿模型写的 `citedUnitIds` /
 *    `citedThemeIds` 与这一本取交集，引用不依赖模型自律。这本账与计步同寿命
 *    （同一行、同一次 `register` 归零、同一次 `release` 销账），上一轮返回过的 id
 *    不为这一轮的引用背书。
 *
 * 一轮 = 一次 `register` 到对应的 `release`。调用序见 `stages/challenge.ts`：
 * `register` → `challenge()`（内部 `exploreAcp` 返回时 `hitLimit` 已读完）→
 * `finally release`。`release` 之后没有读者，所以可以清。
 *
 * # 不接权限门
 *
 * 研究工具全只读、零 sensitive，这里没有门可过。车主面 `tools-endpoint.ts`
 * 的可见域裁剪与 `guardGate` 不适用于这条路：本进程不认识用户（ADR-011）。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  CHALLENGE_MAX_STEPS,
  invokeTool,
  listForAgent,
  describeForPi,
  type ResearchAgentName,
  type ResearchToolDeps,
} from "@cabinhug/research-tools";

/**
 * 两条回调路径。`pi-research/.pi/extensions/research-tools.ts` 按同样的字面量拼 URL，
 * `test/pi-research-dir.test.ts` 拿这两个常量逐字比对。只改一侧时另一侧回 404，
 * 模型手里零工具。
 */
export const RESEARCH_TOOLS_DESCRIBE_PATH = "/internal/research/tools/describe";
export const RESEARCH_TOOLS_INVOKE_PATH = "/internal/research/tools/invoke";

/**
 * 扩展没自报 Agent、也反解不出来时的缺省。
 *
 * 取 `challenger`：它是唯一一条不由研究员发起的路（批量挑战）。缺省落错时
 * ACL 裁到另一个 Agent 的表上，表现为 403。`ResearchAgentName` 有四个取值，缺省只有一个。
 */
const DEFAULT_AGENT: ResearchAgentName = "challenger";

/** 扩展拿不到 pi 会话 id 时发的占位值（与扩展侧逐字一致）。 */
const UNKNOWN_SESSION = "unknown";

/**
 * pi 会话 → 挑战会话与 Agent 的反解。由装配层注入，即
 * `AcpClientPool.resolveSession`，签名逐字相同。
 *
 * `cabinhugSessionId` 在用研面就是挑战键 `challenge:<insightId>:<runId ?? "batch">`，
 * 也就是 `registerChallengeSession` 的 key。名字与底座一致，池的方法可直接注入，无需适配层。
 */
export type ResearchSessionResolver = (
  acpSessionId: string,
) => { cabinhugSessionId: string; agent: string } | undefined;

export interface ResearchToolsEndpointOptions {
  resolveSession?: ResearchSessionResolver;
  /** 一次挑战最多几步工具循环。缺省取工具表里的那个数，本文件不另写。 */
  maxSteps?: number;
}

/** 计步表里一行。`hitLimit` 由收口跳读：超限就把 `holds` 强制成 `inconclusive`。 */
export interface StepState {
  steps: number;
  hitLimit: boolean;
}

/**
 * 表里实际存的一行：计步 + 本轮工具返回过的 id。
 *
 * 对外只投影 `StepState`（`stepsOf` / `stepsForKey` 回 `{ steps, hitLimit }`）。
 * id 那一本走 `seenIdsOf` / `seenIdsForKey` 单独读：两笔账各有读者，
 * 不让"探查跳有没有撞上界"的判据带上一个几十项的集合。
 */
interface StepRow extends StepState {
  seenIds: Set<string>;
}

/** 从返回 JSON 里收 id 的键名。只认这三个，别的键上的字符串不是研究实体 id。 */
const ID_KEYS = new Set(["unitId", "themeId", "id"]);

/** 遍历深度上界。工具返回是几层的普通对象，给足余量即可，防的是环与畸形数据。 */
const ID_SCAN_MAX_DEPTH = 8;

/**
 * 把一份工具返回里出现过的研究实体 id 收进集合。
 *
 * 宁可多收：这本账是引用核对的白名单，多收只会留下一条在返回里出现过的引用，
 * 少收会剥掉模型如实引用的那一条。所以宽键 `id` 也收（`themeMembers` 回的主题、
 * `codebookLookup` 回的码都用它）。
 */
function collectIds(value: unknown, into: Set<string>, depth = 0): void {
  if (depth > ID_SCAN_MAX_DEPTH || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) collectIds(v, into, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") {
      if (ID_KEYS.has(k) && v) into.add(v);
    } else {
      collectIds(v, into, depth + 1);
    }
  }
}

export interface ResearchToolsEndpointStats {
  /** 扩展加载时会拉一次工具表，这是扩展确实被 pi 加载的唯一证据。 */
  describeCalls: number;
  /** 过了 ACL 与步数上界、进到执行这一步的调用次数。 */
  invokeCalls: number;
  /** 被 ACL 拒掉的次数。 */
  denied: number;
  /** 回过"步数已用满"的次数。 */
  limitHits: number;
  /** 当前挂着的挑战会话数。挑战结束没 release 时它只增不减。 */
  activeSessions: number;
  /**
   * 当前留着计步行的 pi 会话数。
   *
   * 与 `activeSessions` 是两笔账：会话表按挑战键、计步表按 pi 会话。
   * 两个数都应随 `release` 回落，`trackedSteps` 只增不减说明漏了销账（内存泄漏）。
   */
  trackedSteps: number;
}

export interface ResearchToolsEndpoint {
  /** 返回 true 表示本请求已被处理（形状照车主面的 `handleToolsRequest`）。 */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** 一次挑战开始前登记它的取数；key = 挑战键。 */
  registerChallengeSession(key: string, deps: ResearchToolDeps): void;
  /** 挑战结束后摘掉。摘掉之后再来的 invoke 一律回"挑战会话已结束"。 */
  release(key: string): void;
  /** 这个 pi 会话走了几步、有没有撞上界。没来过就是 `undefined`。 */
  stepsOf(piSessionId: string): StepState | undefined;
  /**
   * 同上，但按挑战键问。
   *
   * 探查跳结束后要读 `hitLimit`，手里只有会话键：pi 会话 id 由 pi 侧生成，调用方拿不到。
   * 底座的反解表（`AcpClientPool.resolveSession`）是单向的，这一层在第一次 invoke 时
   * 记下反方向。一个挑战键对一个 pi 会话：会话键含 insightId（+ runId）。
   */
  stepsForKey(key: string): StepState | undefined;
  /**
   * 这个 pi 会话本轮的工具返回里出现过哪些研究实体 id。
   *
   * 「问它」的收口跳拿它与模型写的引用取交集。没来过（或已 release）时为 `undefined`，
   * 调用方必须读成"这一轮工具没返回过任何 id"并剥掉所有引用，不能读成"不核对"。
   */
  seenIdsOf(piSessionId: string): ReadonlySet<string> | undefined;
  /** 同上，但按会话键问（探查跳手里只有键，见 `stepsForKey`）。 */
  seenIdsForKey(key: string): ReadonlySet<string> | undefined;
  stats(): ResearchToolsEndpointStats;
}

export function createResearchToolsEndpoint(
  opts: ResearchToolsEndpointOptions = {},
): ResearchToolsEndpoint {
  const maxSteps = opts.maxSteps ?? CHALLENGE_MAX_STEPS;
  /** 挑战键 → 这一次挑战的取数。一次挑战一份，不是进程级一份。 */
  const sessions = new Map<string, ResearchToolDeps>();
  /**
   * pi 会话 id → 计步。一行只记当前这一轮。
   *
   * 上界是"一轮最多查几步"，不是"这个 pi 会话总共最多查几步"：
   * 池按 `cabinhugSessionId` 复用会话，追问与批量挑战都落回同一个 pi 会话。
   * 所以 `register` 归零、`release` 销账。
   *
   * 可以销账的前提是没有跨过 release 的读者：`hitLimit` 由 `exploreAcp` 在
   * `challenge()` 内部读完（调用序见 `stages/challenge.ts`），`release` 在其后的
   * `finally` 里（文件头第 4 条）。
   *
   * 行里还带本轮工具返回过的 id（文件头第 5 条）：同寿命、同一次归零。
   */
  const steps = new Map<string, StepRow>();
  /**
   * 挑战键 → pi 会话 id。
   *
   * 与 `steps` 相反，它不随 release 清：下一轮同一个键要靠它找到同一个 pi 会话来归零，
   * 而归零发生在本轮第一次 invoke 之前。缺了它，第二轮的 `register` 找不到该清的行，
   * 退化为跨轮累加。一个挑战键对一个 pi 会话：会话复用时覆盖是幂等的。
   */
  const piSessionOfKey = new Map<string, string>();
  const stats: ResearchToolsEndpointStats = {
    describeCalls: 0,
    invokeCalls: 0,
    denied: 0,
    limitHits: 0,
    activeSessions: 0,
    trackedSteps: 0,
  };

  /**
   * 挑战键 → 取数。
   *
   * 注入了反解就只信反解：反解不出来说明这个 pi 会话不属于任何一次挑战，
   * 此时回落到"库里唯一那个会话"等于拿别人的窗去答。
   *
   * 没注入反解时允许一条确定性回落：当且仅当此刻恰好挂着一个挑战会话，就是它。
   * 0 个或 ≥2 个一律按结束处理，避免并发两张卡时串台。
   */
  const keyFor = (piSessionId: string): string | undefined => {
    if (opts.resolveSession) return opts.resolveSession(piSessionId)?.cabinhugSessionId;
    if (sessions.size !== 1) return undefined;
    return [...sessions.keys()][0];
  };

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  const readJson = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  };

  return {
    async handle(req, res) {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;

      if (req.method === "GET" && path === RESEARCH_TOOLS_DESCRIBE_PATH) {
        const agent = (url.searchParams.get("agent") ?? DEFAULT_AGENT) as ResearchAgentName;
        stats.describeCalls += 1;
        // 未知 Agent 回空表（ACL 语义即"这个 Agent 什么都拿不到"），不 404：
        // 扩展遇到非 2xx 会直接抛，名字写错应表现为工具数 0 而不是起不来。
        json(res, 200, { agent, tools: describeForPi(agent) });
        return true;
      }

      if (req.method !== "POST" || path !== RESEARCH_TOOLS_INVOKE_PATH) return false;

      let body: { name?: string; args?: unknown; agent?: string; piSessionId?: string };
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        json(res, 400, { error: "invalid_json" });
        return true;
      }
      if (!body.name) {
        json(res, 400, { error: "missing_tool_name" });
        return true;
      }

      const rawSessionId = body.piSessionId ?? UNKNOWN_SESSION;
      // 反解优先于 pi 进程自报的身份：进程只知道自己是哪个 Agent 的，
      // 而一个进程里会先后跑多个会话。
      const resolved = opts.resolveSession?.(rawSessionId);
      const agent = (resolved?.agent ?? body.agent ?? DEFAULT_AGENT) as ResearchAgentName;

      // ACL（唯一读法是 `listForAgent`）：pi 侧发来不属于它的工具名也要拒。
      if (!listForAgent(agent).some((t) => t.name === body.name)) {
        stats.denied += 1;
        json(res, 403, { error: "tool_not_allowed_for_agent", agent, tool: body.name });
        return true;
      }

      /*
       * 计步。拿不到会话 id 时不计步但打警告：既不静默放行（挑战没有上界），
       * 也不静默拒绝（工具失灵），警告让冒烟可见。
       */
      if (rawSessionId === UNKNOWN_SESSION) {
        console.warn(
          `[research-tools] invoke ${body.name} 没带 piSessionId——本次不计步，` +
            `这次挑战的 ${maxSteps} 步上界在这条路上不生效`,
        );
      } else {
        const st = steps.get(rawSessionId) ?? { steps: 0, hitLimit: false, seenIds: new Set<string>() };
        if (st.steps >= maxSteps) {
          st.hitLimit = true;
          steps.set(rawSessionId, st);
          stats.trackedSteps = steps.size;
          stats.limitHits += 1;
          // HTTP 200 + 文本：模型读得到并停手；回 4xx 的话 pi 当传输错误重试。
          json(res, 200, { ok: false, error: limitMessage(maxSteps) });
          return true;
        }
        st.steps += 1;
        steps.set(rawSessionId, st);
        stats.trackedSteps = steps.size;
      }

      stats.invokeCalls += 1;

      const sessionKey = keyFor(rawSessionId);
      // 反方向映射：探查跳结束后按挑战键读 `hitLimit`，它拿不到 pi 会话 id。
      if (sessionKey !== undefined && rawSessionId !== UNKNOWN_SESSION) {
        piSessionOfKey.set(sessionKey, rawSessionId);
      }
      const deps = sessionKey === undefined ? undefined : sessions.get(sessionKey);
      if (!deps) {
        // 不拿别的挑战的窗去答。
        json(res, 200, { ok: false, error: "挑战会话已结束" });
        return true;
      }

      const startedAt = Date.now();
      try {
        const out = await invokeTool(body.name, body.args, deps);
        /*
         * 引用核对的那本账，只在成功时收：`ok: false` 的返回里只有错误文本、没有数据。
         * 拿不到 piSessionId 时这一轮没有行可记，与计步同一口径。
         */
        if (out.ok) {
          const row = steps.get(rawSessionId);
          if (row) collectIds(out.data, row.seenIds);
        }
        console.log(
          `[research-tools] ${body.name} agent=${agent} session=${rawSessionId} ` +
            `${out.ok ? "ok" : "rejected"} ${Date.now() - startedAt}ms`,
        );
        /*
         * 成功回 `{ ok: true, result }`，扩展读 `body.result`；注册表的字段名是 `data`，
         * 在这一跳转换。对不上时模型每次都收到 `undefined`。
         */
        json(res, 200, out.ok ? { ok: true, result: out.data } : { ok: false, error: out.error });
      } catch (err) {
        // 取数抛错也回 200 + 文本：让模型看见工具出错并改道，而不是当传输错误重试。
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `[research-tools] ${body.name} agent=${agent} session=${rawSessionId} failed ` +
            `${Date.now() - startedAt}ms：${message}`,
        );
        json(res, 200, { ok: false, error: message });
      }
      return true;
    },

    /**
     * 一轮开始：登记取数，并把这个键上一轮留下的步数归零。
     *
     * 第一轮时 `piSessionOfKey` 里还没有这个键（第一次 invoke 才记下），无需归零。
     * 第二轮起池复用同一个 pi 会话，`piSessionOfKey` 指向那一行，清它。
     */
    registerChallengeSession(key, deps) {
      sessions.set(key, deps);
      stats.activeSessions = sessions.size;

      const piSessionId = piSessionOfKey.get(key);
      if (piSessionId !== undefined) {
        // id 那本账一起归零：上一轮返回过的 id 不为这一轮的引用背书。
        steps.set(piSessionId, { steps: 0, hitLimit: false, seenIds: new Set<string>() });
        stats.trackedSteps = steps.size;
      }
    },

    /**
     * 一轮结束：摘掉取数，并把计步行销账。
     *
     * `piSessionOfKey` 保留：下一轮同一个键要靠它找到该归零的那一行。
     * 此时销账安全：`hitLimit` 的唯一读者（收口跳）在 `release` 之前已读完
     * （调用序见文件头第 4 条）。
     */
    release(key) {
      sessions.delete(key);
      stats.activeSessions = sessions.size;

      const piSessionId = piSessionOfKey.get(key);
      if (piSessionId !== undefined) {
        steps.delete(piSessionId);
        stats.trackedSteps = steps.size;
      }
    },

    /*
     * 对外只投影 `{ steps, hitLimit }`，不把另一笔账的 `seenIds` 带给读计步的调用方。
     */
    stepsOf: (piSessionId) => projectSteps(steps.get(piSessionId)),

    stepsForKey(key) {
      const piSessionId = piSessionOfKey.get(key);
      return piSessionId === undefined ? undefined : projectSteps(steps.get(piSessionId));
    },

    seenIdsOf: (piSessionId) => steps.get(piSessionId)?.seenIds,

    seenIdsForKey(key) {
      const piSessionId = piSessionOfKey.get(key);
      return piSessionId === undefined ? undefined : steps.get(piSessionId)?.seenIds;
    },

    stats: () => ({ ...stats }),
  };
}

/** 内部那一行 → 对外的 `StepState`。没有行就是 `undefined`（"这个会话没来过"）。 */
function projectSteps(row: StepRow | undefined): StepState | undefined {
  return row === undefined ? undefined : { steps: row.steps, hitLimit: row.hitLimit };
}

/**
 * 步数用满时给模型的那句话。
 *
 * 同时说明该判什么：只说"用满了"时，模型会把没查清楚的条目判成 `holds`，
 * 这正是 Challenger 提示词要防的误判。步数从参数来，真相源是 `CHALLENGE_MAX_STEPS`。
 */
function limitMessage(maxSteps: number): string {
  return `工具步数已用满（${maxSteps} 步）——没查清楚的条目请判 inconclusive，不要判 holds`;
}
