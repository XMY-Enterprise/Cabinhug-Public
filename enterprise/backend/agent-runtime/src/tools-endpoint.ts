/**
 * 工具执行内部端点：pi 扩展的回调落点。
 *
 * 【工具在 agent-runtime 内执行】
 * 工具调用日志与 `/internal/guard/check` 都必须带 Cabinhug 的 `session_id`（F-07-07），
 * 而 pi 侧拿不到它：
 *   - pi 扩展的 `ctx.sessionManager.getSessionId()` 是 pi 自己的会话 id，与 Cabinhug 的
 *     `session_id` 是两套标识；
 *   - pi 不支持 mcpServers，也没有"给扩展注入外部上下文"的入口。
 * 因此工具实现留在本进程，pi 侧的扩展只做一层薄代理：pi 在自己的工具表里看到这些工具，
 * 真正的 `execute()` 跑在 agent-runtime。§8.4 的权限门也在本进程内，权限检查是进程内调用。
 *
 * 【会话相关性】
 * 代理请求带的是 pi 侧的会话标识。`AcpClient` 建会话时记下
 * ACP 会话 id → (Cabinhug 会话, Agent) 的反向索引，这里据此反解。
 * `sessionId` 决定权限门 `interrupt` 挂到哪一路 SSE，反解不出时 HITL 无法工作；
 * `agent` 决定 §4.3 的工具 ACL 按谁裁剪。
 *
 * 解析失败记 `unresolved:<piSessionId>` 并计数上报，不填假的会话 id。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  capabilityOffFor,
  invokeTool,
  listForAgent,
  describeForPi,
  describePreference,
  getTool,
  describeDisclosure,
  resolveContactSecret,
  type AgentName,
  type AppointmentContact,
} from "@cabinhug/tools";

import {
  validateCabinPreference,
  OWNER_ONLY_TOOLS,
  PRIVATE_DOMAIN_TOOLS,
  type GrantRole,
} from "@cabinhug/shared";

import type { GuardGate } from "./guard/http-endpoint";
import { canonicalAgent } from "./acp-client/agent-prompt";
import { currentTurnId } from "./interrupt-bus";

export const TOOLS_INVOKE_PATH = "/internal/tools/invoke";
export const TOOLS_DESCRIBE_PATH = "/internal/tools/describe";
export const TOOLS_STATS_PATH = "/internal/tools/stats";

/**
 * 调用计数：`invocations` 是工具确实被执行过的证据（区别于模型编造答案），
 * `unresolvedSessionCalls` 暴露会话反解失败的调用。
 */
const stats = {
  invocations: 0,
  failures: 0,
  unresolvedSessionCalls: 0,
  byTool: {} as Record<string, number>,
  /** 被权限门拒绝的次数（含硬禁与用户拒绝）。 */
  denied: 0,
  /**
   * pi 扩展加载时会拉一次工具表，这是扩展确实被 pi 加载的唯一证据：
   * pi 在 `--mode rpc` 下对未信任项目静默忽略 `.pi/extensions/`，不报错，只是没有工具。
   */
  describeCalls: 0,
};
export function getToolEndpointStats() {
  return { ...stats, byTool: { ...stats.byTool } };
}

/**
 * 权限门，由装配层注入。未注入时敏感工具一律拒绝，不默认放行。
 */
let guardGate: GuardGate | undefined;
export function setGuardGate(gate: GuardGate) {
  guardGate = gate;
}

/** 供 HITL 回灌入口取用（`server.ts` 的 /internal/guard/resume）。 */
export function getGuardGate(): GuardGate | undefined {
  return guardGate;
}

/**
 * pi 会话 → Cabinhug 会话与 Agent 的反解。由装配层注入（ACP 池持有那张表）。
 *
 * 未注入时不猜：退回 `unresolved:` 并计数，让缺口在健康页上看得见。
 */
export type SessionResolver = (acpSessionId: string) => { cabinhugSessionId: string; agent: AgentName } | undefined;
let resolveSession: SessionResolver | undefined;
export function setSessionResolver(r: SessionResolver): void {
  resolveSession = r;
}

/**
 * Cabinhug 会话 → 用户 id。
 *
 * 用户维度的工具（`contact_lookup` / `usage_profile` / `vehicle_member` …）都要 `userId`，
 * 而模型不知道这个值，schema 要求必填时它会编一个。因此由会话反查注入（见 `withUserId`）。
 *
 * 不做成 ACP 会话表的一列：`sessionFor(cabinhugSessionId, agent)` 建会话时手上没有 userId，
 * 而 `sessions` 表本来就有 `user_id`，查一次即可。
 */
export type SessionUserResolver = (cabinhugSessionId: string) => Promise<string | undefined>;

/**
 * 会话的可见域上下文（F-57-03）。
 *
 *  - `userId: null` = 访客会话（车机上车声明选了访客）；
 *  - `userId: string` = 那个人（人的会话是登录者，车机会话是声明的那位）；
 *  - 整体 `undefined` = 会话查不到（不是访客，是不知道）。
 *
 * 三态而不是 `string | undefined`：访客与查不到必须分开，否则一次查库抖动
 * 会把真实用户的会话静默降级为访客。
 */
export type SessionAccessResolver = (
  cabinhugSessionId: string,
) => Promise<{ userId: string | null; role: GrantRole | null } | undefined>;
let resolveSessionAccess: SessionAccessResolver | undefined;
export function setSessionAccessResolver(r: SessionAccessResolver | undefined): void {
  resolveSessionAccess = r;
}
let resolveSessionUser: SessionUserResolver | undefined;
export function setSessionUserResolver(r: SessionUserResolver | undefined): void {
  resolveSessionUser = r;
}

/**
 * 会话身份覆盖入参里的 userId；查不到才退回入参，也不编造。
 *
 * 覆盖而非缺了才补：这条路径的调用方只有模型（子图直调走进程内的 `invokeTool`，
 * 不经过这里），而模型不知道 userId，会从上下文里抓一个像 id 的串（例如功能点编号）。
 * 编中别人的 id 就是跨用户读写，因此模型填的值一律不作数。
 */
async function withUserId(args: unknown, sessionId: string): Promise<unknown> {
  if (typeof args !== "object" || args === null) return args;
  const bag = args as Record<string, unknown>;
  const userId = await resolveSessionUser?.(sessionId);
  // 查不到就不改：让工具按"缺 userId"报错，比塞空串到 where 里安全。
  if (!userId) return args;
  if (typeof bag.userId === "string" && bag.userId.trim() && bag.userId !== userId) {
    // 模型编 id 是无症状故障，现象只是动作没生效，因此打告警。
    console.warn(
      `[tools] 模型给的 userId=${JSON.stringify(bag.userId)} 已被会话身份覆盖` +
        `（session=${sessionId}）——它不知道这个值，填的是从上下文里抓的串`,
    );
  }
  return { ...bag, userId };
}

interface InvokeBody {
  name?: string;
  args?: unknown;
  /** pi 侧的会话标识（`ctx.sessionManager.getSessionId()`）。 */
  piSessionId?: string;
  /** 调用方 Agent；pi 扩展按其加载的工具表传入。 */
  agent?: AgentName;
  /** Mock 三态（FL-39 F-39-02）；由装配层决定，pi 侧不自己选。 */
  mode?: "real" | "mock" | "off";
  /** 幂等键：重试/重发不产生第二次敏感动作（F-27-10）。 */
  idempotencyKey?: string;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

/**
 * 动作指纹：会话 + 工具 + 入参。
 *
 * 入参须稳定序列化（键按字典序）：`JSON.stringify` 保留插入顺序，而模型两次生成的
 * 字段顺序常不同，直接 stringify 会把同一件事算成两件，拒绝记忆失效。
 */
export function actionFingerprint(sessionId: string, tool: string, args: unknown): string {
  return `${sessionId}::${tool}::${stableStringify(args)}`;
}

/**
 * 拒绝记忆的键。优先按轮次，退化到入参指纹。
 *
 * 语义是"这一轮里这个工具已经被否过"，不是"这一组入参被否过"：
 * 用户拒绝的是"别替我去预约"，不是某个特定门店。按指纹时模型换参数重试会反复弹窗；
 * 按会话又太宽，用户稍后重新要求预约不应被自动否掉。一次提问对应一次表态。
 */
export function refusalKey(sessionId: string, tool: string, args: unknown): string {
  const turnId = currentTurnId(sessionId);
  return turnId ? `turn:${sessionId}#${turnId}::${tool}` : actionFingerprint(sessionId, tool, args);
}

/**
 * 「将提供给第三方的个人信息」，按工具查表（F-26-09 / AC-15-7）。
 *
 * 只登记向第三方外发个人信息的工具。`trip_plan_commit` / `vehicle_profile_write`
 * 也是敏感工具，但写的是自有库，不属于外发；混入会让这个字段失去含义。
 *
 * 查不到就不传：未登记的工具本来也没有外发。
 */
const DISCLOSURE_BUILDERS: Record<
  string,
  (args: unknown) => string[] | undefined | Promise<string[] | undefined>
> = {
  // 试驾下单。与 appointment 用同一份掩码规则，保证用户看到的与实际发出的一致。
  test_drive_book: async (args) => {
    const a = args as { contact?: AppointmentContact; memberId?: string; userId?: string } | undefined;
    /*
     * 走档案时入参里没有 `contact`：真号在库里，模型手上只有 memberId。
     * 外发块不能因此为空，否则用户会以为没有个人信息发出（AC-15-7）。
     *
     * 在这里读真号是安全的：读完立刻过 `describeDisclosure` 掩码，
     * 明文不出这个函数、不进 verdict、不进 SSE。
     */
    const contact =
      a?.contact ??
      (a?.memberId && a?.userId ? await resolveContactSecret(a.userId, a.memberId) : undefined);
    if (!contact?.name || !contact?.phone) return undefined;
    return describeDisclosure(contact).map((d) => `${d.field}：${d.value}`);
  },
  appointment: async (args) => {
    const a = args as { contact?: AppointmentContact; memberId?: string; userId?: string } | undefined;
    /*
     * 档案路时入参里没有 `contact`：真号在库里，模型手上只有 memberId。
     * 外发块不能因此为空（与 test_drive_book 同一约束）。
     * 在这里读真号是安全的：读完立刻过 `describeDisclosure` 掩码，明文不出函数。
     */
    const contact =
      a?.contact ??
      (a?.memberId && a?.userId ? await resolveContactSecret(a.userId, a.memberId) : undefined);
    if (!contact?.name || !contact?.phone) return undefined;
    // 值来自 `describeDisclosure()`，不在这里拼：手机号的掩码规则只有那一份。
    return describeDisclosure(contact).map((d) => `${d.field}：${d.value}`);
  },
};

/**
 * 弹窗上那一行「动作」。
 *
 * 不能直接 `JSON.stringify(args)`：`appointment` 的入参带完整手机号，而确认弹窗
 * 可能出现在车机大屏上，外发项里掩码了、动作摘要里却是明文。
 */
/*
 * ── 最近的工具调用 ─────────────────────────────────
 *
 * 用来核对模型说的和做的是否一致。A 型把动作交给模型后，模型可能只查了状态、
 * 没做任何设置动作，却回答"已经调好了"。仅靠 prompt 拦不住这类错，需要编排层
 * 事后按实际调用对账；这不是替模型判断意图。
 *
 * 环形缓冲，只留最近若干条：它服务的是"刚刚这一跳"，不是历史查询。
 */
interface RecentCall {
  sessionId: string;
  name: string;
  at: number;
  ok: boolean;
}
const RECENT_LIMIT = 200;
const recentCalls: RecentCall[] = [];

function recordCall(c: RecentCall): void {
  recentCalls.push(c);
  if (recentCalls.length > RECENT_LIMIT) recentCalls.splice(0, recentCalls.length - RECENT_LIMIT);
}

/** 某会话在某时刻之后成功调过的工具名（去重）。 */
export function successfulToolsSince(sessionId: string, sinceMs: number): string[] {
  return [
    ...new Set(recentCalls.filter((c) => c.sessionId === sessionId && c.at >= sinceMs && c.ok).map((c) => c.name)),
  ];
}

/**
 * 确认弹窗上显示的那句话（F-04-02：不只显示动作名）。
 *
 * 导出供单测直接断言：它的失效形态是弹窗上出现写给模型的工具描述加原始 JSON，
 * 只有对着输出才能发现。
 */
export function summarizeAction(tool: string, args: unknown, fallback: string): string {
  if (tool === "test_drive_book") {
    // 摘要面向用户，id 对用户没有意义。门店名与时间由子图在 summary 里给，
    // 这里是模型直调时的兜底。
    const a = args as { model?: string; trim?: string; storeId?: string; slotId?: string } | undefined;
    return ["预约试驾", a?.model, a?.trim, a?.storeId, a?.slotId].filter(Boolean).join(" · ");
  }
  if (tool === "appointment") {
    const a = args as
      | { kind?: string; storeName?: string; at?: string; subject?: string }
      | undefined;
    const what = a?.kind === "service" ? "预约维修" : "预约试驾";
    return [what, a?.storeName, a?.at, a?.subject].filter(Boolean).join(" · ");
  }
  if (tool === "member_preference_set") {
    /*
     * 这句就是复述，由代码从入参生成：模型口述的值可能与实际参数不一致
     * （说 24 度而参数是 26），弹窗照着入参念才对得上。
     */
    const a = args as { memberName?: string; memberId?: string; preference?: Record<string, unknown> } | undefined;
    const who = a?.memberName?.trim() || a?.memberId || "这位家人";
    let items: string[];
    try {
      items = describePreference(validateCabinPreference(a?.preference ?? {}));
    } catch {
      items = ["（偏好内容不合法，将被拒绝）"];
    }
    return `把「${who}」的座舱偏好记为：${items.join("、")}`;
  }
  if (tool === "vehicle_profile_write") {
    /*
     * 这句就是复述（AC-53-5）。
     *
     * §4.6 要求"复述 + 一次确认"，而不是"先复述、用户说对、再弹一次窗"（FL-27 裁定的
     * 确认疲劳）。因此复述放在确认弹窗上：车主看到的就是要落进档案的那几个数。
     * 与 `member_preference_set` 同理，照着入参生成才不会与实际参数脱节。
     */
    const a = args as
      | { op?: string; odometerKm?: number; at?: number; items?: string; symptom?: string }
      | undefined;
    const when = a?.at ? new Date(a.at).toLocaleDateString("zh-CN") : undefined;
    const km = typeof a?.odometerKm === "number" ? `${a.odometerKm} 公里` : undefined;
    if (a?.op === "maintenance") {
      // 日期与里程都回显：车主要能一眼看出哪个数记错了。
      return ["记一次保养", when, a?.items, km].filter(Boolean).join(" · ");
    }
    if (a?.op === "repair") {
      return ["记一次维修", when, a?.symptom, km].filter(Boolean).join(" · ");
    }
    return km ? `把当前里程更新为 ${km}` : "更新车辆档案";
  }
  if (tool === "trip_plan_cancel") {
    // 取消时入参里只有 planId（要取消哪份由服务端定），不编目的地。
    return "取消已确认的行程";
  }
  if (tool === "trip_plan_update") {
    const a = args as { plan?: { destination?: string; days?: number } } | undefined;
    const obj = [a?.plan?.destination, a?.plan?.days ? `${a.plan.days}天` : ""]
      .filter(Boolean)
      .join(" ");
    return obj ? `变更已确认的行程：${obj}` : "变更已确认的行程";
  }
  if (tool === "trip_plan_commit") {
    /*
     * 与 `supervisor` 那条路径给出同一句话（`commitDisclosures` 旁边的摘要）。
     * 用户在这一屏要回答的是"我批的是什么"，写给模型的工具描述不能作为弹窗标题。
     */
    const a = args as { plan?: { destination?: string; days?: number } } | undefined;
    const what = "确认多天行程并保存";
    const obj = [a?.plan?.destination, a?.plan?.days ? `${a.plan.days}天` : ""]
      .filter(Boolean)
      .join(" ");
    // 取消时入参里没有 plan（要取消哪份由服务端定），此时只说动作，不编目的地。
    return obj ? `${what}：${obj}` : what;
  }
  /*
   * 兜底：只给动作名，不输出 JSON。
   *
   * 入参里可能有手机号、地址这类不该出现在标题上的内容。
   * 新增敏感工具时应在上面补一条专门的摘要，而不是依赖这里。
   */
  return fallback.split(/[。（(]/)[0] || tool;
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(",")}}`;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** 返回 true 表示本请求已被处理。 */
export async function handleToolsRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method === "GET" && req.url?.startsWith(TOOLS_STATS_PATH)) {
    json(res, 200, getToolEndpointStats());
    return true;
  }

  if (req.method === "GET" && req.url?.startsWith(TOOLS_DESCRIBE_PATH)) {
    const agent = (new URL(req.url, "http://x").searchParams.get("agent") ?? "supervisor") as AgentName;
    stats.describeCalls += 1;
    json(res, 200, { agent, tools: describeForPi(agent) });
    return true;
  }

  if (req.method !== "POST" || req.url !== TOOLS_INVOKE_PATH) return false;

  let body: InvokeBody;
  try {
    body = (await readJson(req)) as InvokeBody;
  } catch {
    json(res, 400, { error: "invalid_json" });
    return true;
  }

  if (!body.name) {
    json(res, 400, { error: "missing_tool_name" });
    return true;
  }

  // 反解优先于 pi 进程自报的身份：进程只知道自己是哪个 Agent 的，
  // 而 fan-out 的 `trip-task` 与直达的 `trip` 跑在同一进程里、是两个会话。
  const piSessionId = body.piSessionId ?? "unknown";
  const resolved = resolveSession?.(piSessionId);
  // 会话身份带后缀（`trip-task` / `supervisor-intent`），而工具 ACL 按规范 Agent 裁剪。
  // 不归一时 `listForAgent("trip-task")` 返回空表，出行分支的工具调用会被 403。
  const agent = canonicalAgent(resolved?.agent ?? body.agent ?? "supervisor") as AgentName;

  // 能力关闭（ACR-059）排在 ACL 前面：`listForAgent` 已经把这类工具剔除，不先判就只会报
  // 「不属于这个 Agent」，模型会换个说法重试。说清是这一版没开放，它才会停手、如实告诉车主。
  const registered = getTool(body.name);
  const closedBy = registered ? capabilityOffFor(registered) : undefined;
  if (closedBy) {
    json(res, 403, {
      error: "capability_off",
      capability: closedBy,
      tool: body.name,
      reason: "这一版没有开放这项能力，这个工具用不了。如实告诉车主这件事这一版做不了，不要换别的工具或说法重试。",
    });
    return true;
  }

  // 工具表按 Agent 裁剪（§4.3）——pi 侧即使发来不属于它的工具名也要拒。
  if (!listForAgent(agent).some((t) => t.name === body.name)) {
    json(res, 403, { error: "tool_not_allowed_for_agent", agent, tool: body.name });
    return true;
  }

  const sessionId = resolved?.cabinhugSessionId ?? `unresolved:${piSessionId}`;

  /*
   * 可见域裁剪（F-57-03）。执行点在这里，不在提示词里。
   *
   * spawn 时的 `--tools` 清单按 Agent 计算、整个 pi 进程共用一份，
   * 而"谁在用"是每个会话各自的，所以裁剪落在每次调用上。
   *
   * 两类裁剪：
   *  - 访客（无账号）调个人域工具：它没有自己的偏好/行程/日历，调用的只可能是别人的；
   *  - 非车主调只有车主能用的写类工具（设计裁决 R7）。
   *
   * 拒绝时说清这一步做不了以及原因，否则模型会换个说法重试并再次被拒。
   */
  const access = resolveSessionAccess ? await resolveSessionAccess(sessionId) : undefined;
  if (access) {
    const guest = access.userId === null;
    if (guest && (PRIVATE_DOMAIN_TOOLS as readonly string[]).includes(body.name)) {
      stats.denied += 1;
      json(res, 200, {
        ok: false,
        error:
          "当前是访客模式，读不到个人偏好、日历与行程安排。要用这些，请在车机上选择你的账号。",
        decision: "deny",
      });
      return true;
    }
    if (
      (OWNER_ONLY_TOOLS as readonly string[]).includes(body.name) &&
      access.role !== "owner"
    ) {
      stats.denied += 1;
      json(res, 200, {
        ok: false,
        error: "只有车主可以修改这辆车的档案与人员名单。",
        decision: "deny",
      });
      return true;
    }
  }
  stats.invocations += 1;
  if (!resolved) stats.unresolvedSessionCalls += 1;
  stats.byTool[body.name] = (stats.byTool[body.name] ?? 0) + 1;

  /*
   * 用户维度补在权限门之前。
   *
   * 走 `memberId` 下单时，外发块只能按 userId + memberId 去库里取，补晚了外发块为空
   * （AC-15-7）。代价是每次敏感调用多一次库查。
   */
  const args = await withUserId(body.args, sessionId);

  // 敏感工具过权限门；只读工具不调，零额外往返（§8.4 表第三行 / F-27-09）。
  const reg = getTool(body.name);
  if (reg?.sensitive) {
    if (!guardGate) {
      json(res, 200, { ok: false, error: "权限门未装配，敏感动作一律拒绝" });
      return true;
    }
    const verdict = await guardGate.check({
      sessionId,
      agent,
      tool: body.name,
      summary: summarizeAction(body.name, args, reg.description),
      disclosures: await DISCLOSURE_BUILDERS[body.name]?.(args),
      idempotencyKey: body.idempotencyKey,
      // 动作指纹：模型重试时不会重发同一个 idempotencyKey（pi 扩展不发它），
      // 但重试的是同一件事。权限门据此不再重复打扰用户。
      actionKey: refusalKey(sessionId, body.name, args),
    });
    if (verdict.decision !== "allow") {
      stats.denied += 1;
      json(res, 200, { ok: false, error: verdict.reason, decision: verdict.decision });
      return true;
    }
  }

  const startedAt = Date.now();
  try {
    const result = await invokeTool(body.name, args, {
      sessionId,
      // 轮次维度：与权限门指纹用同一来源。缺失时 submit_hotels 的提交归不了轮而被拒，
      // cabin deriveRequestId 的幂等退回随机。
      turnId: currentTurnId(sessionId),
      agent,
      mode: body.mode,
    });
    console.log(
      `[tools] ${body.name} agent=${agent} session=${sessionId} ok ${Date.now() - startedAt}ms`,
    );
    recordCall({ sessionId, name: body.name, at: startedAt, ok: true });
    json(res, 200, { ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[tools] ${body.name} agent=${agent} session=${sessionId} failed ${Date.now() - startedAt}ms: ${message}`,
    );
    // 结构化失败：由调用方决定降级，底层不自动降级（FL-33 F-33-07 同一原则）。
    stats.failures += 1;
    recordCall({ sessionId, name: body.name, at: startedAt, ok: false });
    json(res, 200, { ok: false, error: message });
  }
  return true;
}
