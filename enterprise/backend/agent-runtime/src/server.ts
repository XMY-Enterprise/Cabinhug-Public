/**
 * 内部 turn 接口。
 *
 * `POST /internal/session/:id/turn`
 *   请求：JSON { turnId, content, source, userId? }（content 为文本或 ASR 原文）
 *
 * `userId` 由网关注入，可缺省：缺了只是拿不到⑥用车数据（双路降级为单路），
 * 而不是整轮失败，记忆是增强不是必需。有它时必须一路带到记忆读写，禁止跨用户混算。
 *   响应：`application/x-ndjson`，逐行 `SessionEvent`，流式。
 *
 * 仅供 gateway 进程内网调用（localhost），不做鉴权；对外协议治理
 * （token、限流、审计、SSE 封套）全部在 gateway（§3 职责边界）。
 * 用 node:http 实现，不为一个内部端点引入 web 框架依赖。
 */

import { ClientDetectionsSchema, type ClientDetections } from "@cabinhug/tools";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  hasHighlights,
  tripDayIndex,
  tripPlanNavTarget,
  type MessageSource,
  type NavPlan,
  type NavPlanOrigin,
  type TripPlanSnapshot,
} from "@cabinhug/shared";
import { TURN_ATTACHMENT_LIMITS } from "@cabinhug/shared";
import type { ConfigStore } from "@cabinhug/db";
import type { VideoInput } from "./graph/media";

import type { TurnRunner } from "./turn-runner";
import { cancelTurn } from "./turn-cancel";
import { handleToolsRequest, getGuardGate } from "./tools-endpoint";
import { knownGaps, riskSummary, type RuntimeHealth } from "./health";
import { HARD_BLOCK_RULES } from "./guard/hard-block-rules";
import { invalidateGuardSettings } from "./guard/settings";
import { liveTrace } from "./trace/live";
import {
  DEFAULT_DISCLAIMER_POLICY,
  DEFAULT_DISCLAIMER_TEXT,
  MAX_DISCLAIMER_CHARS,
  validateDisclaimerPolicy,
  validateDisclaimerText,
} from "./guard/disclaimers";

/**
 * 运行时形态与风险摘要。系统有大量可降级路径，降级时能力变少而表面表现正常，
 * 这里集中暴露这些状态，比逐条读启动日志可靠。
 */
let healthProvider: (() => RuntimeHealth) | undefined;
export function setHealthProvider(fn: () => RuntimeHealth) {
  healthProvider = fn;
}
import { probeLlm } from "./llm/probe";
import { runOwnershipDualPath, runDualPath, stripUsageSection } from "./graph/subgraphs/ownership";

interface TurnRequestBody {
  turnId: string;
  content: string;
  source: MessageSource;
  userId?: string;
  /**
   * 端上的闲聊旁路开关。
   *
   * 显式声明而不是靠 `...body` 带过去：若 `TurnRequestBody` 加了白名单校验，
   * 展开传递的字段会被静默丢掉，表现为关了旁路仍在说垫场话。
   * 缺省 undefined，由 `TurnInput.fillerEnabled ?? true` 定语义。
   */
  fillerEnabled?: boolean;
  /**
   * 本轮绑定的附件（照片与视频）：照片由网关取件后以 base64 带过来
   * （runtime 无对象存储客户端），视频带的是网关派生好的帧序图 + 转写。
   * 照片进观察层，且（与帧序图一起）进直连表述模型（ACR-027）；pi 那条路仍只看文字。
   */
  attachments?: TurnAttachmentBody[];
}

/** 照片：原件 base64。`kind` 缺省 = image（老网关不带这个字段）。`detections` = 端上的框（ACR-045），可选。 */
interface TurnImageAttachmentBody {
  kind?: "image";
  handle: string;
  contentType: string;
  bytesBase64: string;
  detections?: ClientDetections;
}

/** 视频：网关派生好的帧序图与转写，没有原件。与 gateway `media/derive.ts` 的 `RuntimeVideoAttachment` 同形。 */
type TurnVideoAttachmentBody = VideoInput;

const TRANSCRIPT_STATUSES: ReadonlySet<string> = new Set(["ok", "empty", "unavailable", "no_audio", "failed"]);

type TurnAttachmentBody = TurnImageAttachmentBody | TurnVideoAttachmentBody;

function isTurnImageAttachmentBody(v: unknown): v is TurnImageAttachmentBody {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    (o.kind === undefined || o.kind === "image") &&
    typeof o.handle === "string" &&
    typeof o.contentType === "string" &&
    o.contentType.startsWith("image/") &&
    typeof o.bytesBase64 === "string" &&
    o.bytesBase64.length > 0 &&
    o.bytesBase64.length <= 12 * 1024 * 1024 &&
    // 端上的框按 tools 那份 schema 严格校验（网关只做过形状粗筛）；坏了整轮 400，不静默丢
    (o.detections === undefined || ClientDetectionsSchema.safeParse(o.detections).success)
  );
}

const isFiniteNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

function isTurnVideoAttachmentBody(v: unknown): v is TurnVideoAttachmentBody {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.kind !== "video" || typeof o.handle !== "string" || typeof o.contentType !== "string") return false;
  if (!isFiniteNum(o.durationMs) || !isFiniteNum(o.analyzedMs) || typeof o.truncated !== "boolean") return false;
  if (!Array.isArray(o.sheets) || o.sheets.length > 8) return false;
  if (
    !o.sheets.every((sh) => {
      if (typeof sh !== "object" || sh === null) return false;
      const x = sh as Record<string, unknown>;
      return (
        isFiniteNum(x.index) && isFiniteNum(x.fromMs) && isFiniteNum(x.toMs) && isFiniteNum(x.frames) &&
        typeof x.contentType === "string" && x.contentType.startsWith("image/") &&
        typeof x.bytesBase64 === "string" && x.bytesBase64.length > 0 && x.bytesBase64.length <= 6 * 1024 * 1024
      );
    })
  )
    return false;
  if (!Array.isArray(o.transcript) || !o.transcript.every((t) => typeof t === "object" && t !== null && isFiniteNum((t as Record<string, unknown>).fromMs) && isFiniteNum((t as Record<string, unknown>).toMs) && typeof (t as Record<string, unknown>).text === "string")) return false;
  return typeof o.transcriptStatus === "string" && TRANSCRIPT_STATUSES.has(o.transcriptStatus) && Array.isArray(o.notes) && o.notes.every((n) => typeof n === "string");
}

/**
 * 附件数组：≤ 9 张照片 + ≤ 1 段视频（`TURN_ATTACHMENT_LIMITS`，与网关同一份数字）。
 * 老网关只发照片且 ≤ 3 张、不带 `kind`——照样过。
 */
export function isTurnAttachmentsBody(v: unknown): v is TurnAttachmentBody[] {
  if (!Array.isArray(v) || v.length > TURN_ATTACHMENT_LIMITS.maxTotal) return false;
  let images = 0;
  let videos = 0;
  for (const a of v) {
    if (isTurnVideoAttachmentBody(a)) videos += 1;
    else if (isTurnImageAttachmentBody(a)) images += 1;
    else return false;
  }
  return images <= TURN_ATTACHMENT_LIMITS.maxImages && videos <= TURN_ATTACHMENT_LIMITS.maxVideos;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isTurnRequestBody(v: unknown): v is TurnRequestBody {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.turnId === "string" &&
    typeof o.content === "string" &&
    (o.userId === undefined || typeof o.userId === "string") &&
    (o.fillerEnabled === undefined || typeof o.fillerEnabled === "boolean") &&
    (o.source === "text" || o.source === "voice") &&
    (o.attachments === undefined || isTurnAttachmentsBody(o.attachments))
  );
}

const GUARD_RESUME_PATH = "/internal/guard/resume";
/** 红线只读快照：红线在代码里，后台不另存一份。 */
const GUARD_REDLINES_PATH = "/internal/guard/redlines";
/** 策略改完后让 TTL 缓存立刻失效，否则最多等 30s 才生效。 */
const GUARD_INVALIDATE_PATH = "/internal/guard/invalidate";
/** 话术默认值与校验：业务规则在本进程，后台不另存一份。 */
const GUARD_DISCLAIMER_DEFAULTS_PATH = "/internal/guard/disclaimer/defaults";
const GUARD_DISCLAIMER_VALIDATE_PATH = "/internal/guard/disclaimer/validate";
/** 行前物品与天气的读时重算。 */
const PRETRIP_REFRESH_PATH = "/internal/trip/pretrip-refresh";
/**
 * 目的地推荐的读时补齐。与上面那条同族同形状：
 * 同样的校验顺序、同样的 `skipped` 语义、同样的"失败也回 200"。
 *
 * 单独一条而不是并进 `pretrip-refresh`：两者的耗时差一个量级
 * （天气 6 秒预算 vs 推荐十几秒），网关并发发出，各自超时互不牵连。
 */
const HIGHLIGHTS_REFRESH_PATH = "/internal/trip/highlights-refresh";
/**
 * 出发地 → 今天第一站这一段（屏底状态栏三格）。与 pretrip-refresh 同款：
 * 网关查仓储、这里算；⑤缓存在 `computeTripLeg` 里（地名→坐标 1h、规划 3 分钟）；
 * 三种"这次没算成"都回 200 + skipped，网关据此不带 `leg`，端上显示「暂无」。
 */
const TRIP_LEG_PATH = "/internal/trip/leg";
/** 导览任务状态（ACR-008）：POST 带整份 plan（与 pretrip-refresh 同款：网关查仓储、这里算）。 */
const GUIDE_JOBS_STATUS_PATH = "/internal/guide/jobs-status";
/** 手动「获取」单景点入队（ACR-008）。 */
const GUIDE_ENQUEUE_PATH = "/internal/guide/enqueue";

/**
 * 景区导览采集（点击景点触发，由网关路由打到这里）。
 *
 * pi 的工具调用经 `.pi/extensions` HTTP 回流到本进程的 tools-endpoint，
 * 三分支 fan-out 只能由运行中的 runtime 驱动，所以采集入口是这条端点。
 */
const GUIDE_BRIEF_PATH = "/internal/guide/brief";
/**
 * 出发导航规划（点「开始行程」触发，由网关路由打到这里）。
 * 与 pretrip-refresh 同族：网关按鉴权身份查行程并补起点，这里算；失败一律 200 + `skipped`。
 * 慢是常态（一条 nav-task 分支，预算 55 s），调用方自带超时。
 */
const NAV_PLAN_PATH = "/internal/trip/nav-plan";
const TURN_PATH = /^\/internal\/session\/([\w-]+)\/turn$/;
/**
 * 打断。
 *
 * 与 turn 分开一条路径而不是往 turn 上加参数：取消作用于已在跑的那一轮，
 * 不产生新的一轮，也不产生事件流，形状与 turn 不同。
 */
const CANCEL_PATH = /^\/internal\/session\/([\w-]+)\/cancel$/;
/** 会话标题旁路。与 turn 无关的一次性调用，见 `title/index.ts`。 */
const TITLE_PATH = /^\/internal\/session\/([\w-]+)\/title$/;
const PREFERENCES_PATH = /^\/internal\/memory\/preferences\/([^/]+)(?:\/([^/]+))?$/;
const WORKING_MEMORY_PATH = /^\/internal\/memory\/working\/([\w#-]+)$/;
/**
 * ⑤环境缓存的分页浏览。
 *
 * Redis 连接在本进程（`setEnvCache` 在装配层注入），网关读不到，
 * 所以这条由 runtime 出，网关做协议转换。
 */
const ENV_CACHE_PATH = "/internal/memory/cache";
/**
 * ⑤单条详情：`?key=<完整键>`。
 * 键里有冒号与中文（`cabinhug:env:guide-brief:杭州:灵隐寺`），放 query 不放路径：
 * 路径段的百分号编码在代理链上会被反复解码/再编码，query 不会。
 */
const ENV_CACHE_ENTRY_PATH = "/internal/memory/cache/entry";
/** 购车候选与成本的只读快照。与上面同族：只读检查点，不跑图。 */
const BUYING_STATE_PATH = /^\/internal\/buying\/([\w#-]+)$/;
/** 拍照问诊报告只读查询，与 buying 同形。 */
const DIAGNOSIS_STATE_PATH = /^\/internal\/diagnosis\/([\w#-]+)$/;
/** 会话里这份行程（草案或刚确认的）只读查询，与 buying 同形（ACR-062）。 */
const TRIP_DRAFT_STATE_PATH = /^\/internal\/trip-draft\/([\w#-]+)(?:\?.*)?$/;

export function createRuntimeServer(
  runner: TurnRunner,
  config?: ConfigStore,
  /**
   * 会话标题生成器，由装配层注入：本文件不 import `../llm`，
   * 与 narrator / 导游相同（配置热生效与离线路径都在工厂里处置）。
   * 不注入时端点回 503，网关那侧当作"这次没起出名字"，不重试。
   */
  titleWriter?: import("./title").TitleWriter,
  /**
   * 双路对照用的表述生成器。
   *
   * 由装配层注入，与 `titleWriter` / narrator 相同：本文件不 import `../llm`
   * （配置热生效与离线路径都在工厂里处置）。不注入时探针只回检索结果、不回答案，
   * 页面据此隐藏"生成对照答案"按钮。
   */
  answerFor?: (args: { context: string; question: string }) => Promise<string>,
  /**
   * 景区导览简报，由装配层注入：采集要驱动 ACP streamer 的三个
   * `-task` 分支，那是 index.ts 的资产，与 titleWriter / answerFor 相同。
   * 不注入时端点回 503（fake/单挂测试环境没有 pi，注入了也只会空跑）。
   */
  guideBrief?: (input: {
    spotName: string;
    city?: string;
    date?: string;
    selfDrive?: boolean;
    siblingSpots?: string[];
    prevSpot?: string;
    isLastStop?: boolean;
    force?: boolean;
  }) => Promise<{ brief: unknown; cached: boolean }>,
  /**
   * 导览后台任务面（ACR-008）：逐景点状态 + 手动触发。与 guideBrief 同样由装配层注入；
   * `GUIDE_QUEUE` 关着时不注入，两个端点回 503。
   */
  guideJobs?: {
    status: (plan: import("@cabinhug/shared").TripPlanSnapshot) => Promise<unknown>;
    trigger: (input: {
      spotName: string;
      city?: string;
      date?: string;
      selfDrive?: boolean;
      siblingSpots?: string[];
      prevSpot?: string;
      isLastStop?: boolean;
    }) => Promise<unknown>;
  },
  /**
   * 出发导航规划，由装配层注入：要驱动 ACP streamer 的 `nav-task` 分支、
   * 读常用人员与 ③偏好，都是 index.ts 的资产。不注入时端点回 503。
   */
  navPlan?: (input: {
    userId: string;
    origin: NavPlanOrigin;
    destination: { name: string; lat: number; lon: number };
    party?: string;
    vin?: string;
  }) => Promise<NavPlan>,
) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // 工具执行内部端点：pi 侧扩展的回调落点。
    // 工具实现留在本进程的理由见 tools-endpoint.ts 文件头（session_id 带不进 pi 扩展）。
    if (await handleToolsRequest(req, res)) return;

    // HITL 回灌（§3）：网关把用户的确认/拒绝送回来，权限门据此放行或拒绝。
    // 这里不做裁决，裁决在权限门；这里只是 `Command(resume)` 的 HTTP 入口。
    if (req.method === "POST" && req.url === GUARD_RESUME_PATH) {
      const gate = getGuardGate();
      if (!gate) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "guard_gate_unavailable" }));
        return;
      }
      let body: { interruptId?: string; approved?: boolean };
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      if (!body.interruptId || typeof body.approved !== "boolean") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing_interrupt_or_decision" }));
        return;
      }
      // `resumed:false` 不是错：中断点可能已超时收敛，或用户连点重发。
      const resumed = gate.resume(body.interruptId, body.approved);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ resumed }));
      return;
    }

    /*
     * 红线只读快照。
     *
     * 后台要能回答"哪些是永远不可改的"，而红线只存在于代码里
     * （`hard-block-rules.ts` 与 Tauri capability 白名单）。
     * 由本进程回一份快照，网关不另存清单，避免出现会过时的第二份。只读，没有写入路径。
     */
    if (req.method === "GET" && req.url === GUARD_REDLINES_PATH) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          hardBlocks: HARD_BLOCK_RULES.map((r) => `${r.category}：${r.why}`),
          // 端侧能力白名单由 `check:arch` 的 capabilities 不变量守着，
          // 这里给的是"哪些类别的能力被物理排除"的说明，不是文件内容。
          capabilities: [
            "端侧 capability 白名单不含任何车辆控制能力（§8.5）——即使前三层失效也下发不了控制指令",
          ],
          writable: false,
        }),
      );
      return;
    }

    if (req.method === "GET" && req.url === GUARD_DISCLAIMER_DEFAULTS_PATH) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          policy: DEFAULT_DISCLAIMER_POLICY,
          text: DEFAULT_DISCLAIMER_TEXT,
          maxChars: MAX_DISCLAIMER_CHARS,
        }),
      );
      return;
    }

    /*
     * 话术校验。三条红线都在这里，网关不重写，避免两份规则漂移：
     * 售后免责不可关、字段不能空、渲染后不超长。
     */
    if (req.method === "POST" && req.url === GUARD_DISCLAIMER_VALIDATE_PATH) {
      let body: { policy?: unknown; text?: unknown };
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      let error: string | null = null;
      if (body.policy !== undefined) {
        error = validateDisclaimerPolicy(body.policy as never);
      }
      if (!error && body.text !== undefined) {
        error = validateDisclaimerText(body.text as never);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(error ? { error } : { ok: true }));
      return;
    }

    /*
     * 会话标题。旁路，与这一轮的成败无关：网关在首轮 `turn_end`
     * 之后 fire-and-forget 地调一次，拿不到就算了。
     *
     * 由网关来调而不是 runtime 在轮次结束时推送：`TurnRunner.run()` 在 yield 完
     * `turn_end` 就 return（端上按它收口，之后的事件会被丢掉），标题挂不进那条流；
     * 让 turn_end 等标题算完再发又会拖慢收口。
     */
    if (req.method === "POST" && TITLE_PATH.test(req.url ?? "")) {
      const sessionId = TITLE_PATH.exec(req.url ?? "")![1];
      if (!titleWriter) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "title_writer_unavailable" }));
        return;
      }
      let body: { turnId?: string; userText?: string; assistantText?: string };
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      if (typeof body.userText !== "string" || body.userText.trim().length === 0) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing_user_text" }));
        return;
      }
      const title = await titleWriter({
        sessionId,
        turnId: typeof body.turnId === "string" ? body.turnId : "unknown",
        userText: body.userText,
        assistantText: typeof body.assistantText === "string" ? body.assistantText : "",
      });
      // `title: null` 不是错：首句收拾完是空的（纯标点/空白）时就该没有名字。
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ title: title ?? null }));
      return;
    }

    /*
     * 打断这一轮。三条语义：
     *  1. 幂等：同一轮连取消两次都成功；
     *  2. 未命中也返回 200（`turnId: null`）：端上无法知道服务端是否刚好收口，
     *     报 404 会让打断时灵时不灵，而打断必须每次都有反应；
     *  3. 取消不回滚副作用：落在副作用窗口内时如实回 `sideEffectInFlight: true`，
     *     外部 API 一旦发出就收不回来，不能对用户说"已取消"。
     */
    if (req.method === "POST" && CANCEL_PATH.test(req.url ?? "")) {
      const sessionId = CANCEL_PATH.exec(req.url ?? "")![1];
      let body: { turnId?: unknown; reason?: unknown } = {};
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        // 空 body 是合法的："取消这个会话当前在跑的那一轮"。
        body = {};
      }
      const outcome = cancelTurn(
        sessionId,
        typeof body.turnId === "string" && body.turnId.length > 0 ? body.turnId : undefined,
        typeof body.reason === "string" && body.reason.length > 0 ? body.reason : undefined,
      );
      console.info(
        `[runtime] 取消 session=${sessionId} turn=${outcome.turnId ?? "none"} sideEffect=${outcome.sideEffectInFlight}`,
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(outcome));
      return;
    }

    // 策略缓存失效：后台改完策略立刻调，不必等 TTL 自然过期。
    if (req.method === "POST" && req.url === GUARD_INVALIDATE_PATH) {
      invalidateGuardSettings();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    /*
     * 实时轨迹（大屏的"现在流到哪了"）。SSE，不用 WS —— §3 的既有取向。
     *
     * 这里不做鉴权，与本文件其余端点同一条边界：它只对网关开放，
     * 对外的 token / 角色 / 审计全在网关那一侧（`/console/trace/stream`）。
     *
     * 心跳 15s，与网关下行同一个值：防止中间设备掐掉安静的连接，
     * 否则大屏会停在最后一帧，与"系统空闲"无法区分。
     */
    if (req.method === "GET" && req.url === "/internal/trace/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(": connected\n\n");
      const unsubscribe = liveTrace.subscribe((e) => {
        // 写失败（对端已断）不该冒泡：订阅者异常由总线吞掉，但这里更早一步收摊。
        try {
          res.write(`data: ${JSON.stringify(e)}\n\n`);
        } catch {
          unsubscribe();
        }
      });
      const heartbeat = setInterval(() => {
        try {
          res.write(": hb\n\n");
        } catch {
          /* 下一次 close 会收摊 */
        }
      }, 15_000);
      const close = (): void => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      req.on("close", close);
      res.on("close", close);
      return;
    }

    if (req.method === "GET" && req.url === "/internal/health/runtime") {
      if (!healthProvider) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "health_provider_unavailable" }));
        return;
      }
      const health = healthProvider();
      res.writeHead(200, { "content-type": "application/json" });
      // risks 为空数组才是"可以上台"的状态；gaps 是长期存在的已知缺口，
      // 分开给，混进 risks 会让"空了才能上台"的判据失效。
      res.end(JSON.stringify({ health, risks: riskSummary(health), gaps: knownGaps(health) }));
      return;
    }

    /*
     * 行前物品与天气的读时重算。
     *
     * 物品是确认那一刻算的；出发前天气可能已变。
     * 用户打开 App 时由网关带 `refreshPretrip=1` 打到这里，用最新天气重算一遍。
     *
     * 三条取舍：
     *  1. 不落库：库里那份是用户批准过的行程，环境数据不改写它；
     *     重算幂等、随时可再算，读时重算没有信息损失。
     *  2. 重算逻辑在这一侧：网关只做协议转换，
     *     算天气要工具与 registry，那是本进程的事。
     *  3. 失败不是错误：调用方拿不到就用库里那份，所以异常一律回 200 + 原因，
     *     网关原样返回，不把整块 HUD 变成一次报错。
     */
    if (req.method === "POST" && req.url === PRETRIP_REFRESH_PATH) {
      let body: { plan?: TripPlanSnapshot };
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const plan = body.plan;
      if (!plan || typeof plan !== "object" || !Array.isArray(plan.skeleton)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing_plan" }));
        return;
      }
      // 已经结束的行程不调天气接口：它不会上卡（tripPlanToHud 返回 null）。
      const today = new Date().toISOString().slice(0, 10);
      if (tripDayIndex(plan, today) === null) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ skipped: "expired" }));
        return;
      }
      try {
        const { collectPretripItems } = await import("./graph/supervisor");
        const r = await collectPretripItems(plan as never);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            pretripItems: r.items,
            weather: r.weather,
            computedAt: new Date().toISOString(),
          }),
        );
      } catch (err) {
        console.warn("[runtime] pretrip 重算失败（调用方回落库里那份）", err);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ skipped: "failed" }));
      }
      return;
    }

    if (req.method === "POST" && req.url === TRIP_LEG_PATH) {
      let body: { plan?: TripPlanSnapshot; home?: { lat?: number; lon?: number } };
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const plan = body.plan;
      if (!plan || typeof plan !== "object" || !Array.isArray(plan.skeleton)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing_plan" }));
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      if (tripDayIndex(plan, today) === null) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ skipped: "expired" }));
        return;
      }
      try {
        const [{ tripPlanNavTarget }, { computeTripLeg }] = await Promise.all([
          import("@cabinhug/shared"),
          import("@cabinhug/tools"),
        ]);
        const target = tripPlanNavTarget(plan, today);
        // 起点：行程写的出发地优先；没写就用常住地坐标。两者都没有 → 没有这一段，不猜。
        const home = body.home;
        const origin =
          plan.origin?.trim() ||
          (typeof home?.lat === "number" && typeof home?.lon === "number" ? { lat: home.lat, lon: home.lon } : undefined);
        if (!target || !origin) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ skipped: target ? "no_origin" : "no_target" }));
          return;
        }
        const leg = await computeTripLeg({ origin, destination: { lat: target.lat, lon: target.lon } });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(leg ? { leg } : { skipped: "unavailable" }));
      } catch (err) {
        console.warn("[runtime] 出发段规划失败（状态栏显示暂无）", err);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ skipped: "failed" }));
      }
      return;
    }

    /*
     * 目的地推荐（兜底）。推荐在确认/变更后由后台算好并落库
     * （`graph/highlights.ts`），网关只在库里没有时才打这一条，覆盖老行程与
     * 后台没算成的行程。形状与上面那条相同，两处不同：
     *  - 调的是 `collectDestinationHighlights`（不在 supervisor.ts 里，
     *    它不挂在行程确认那一跳上）；
     *  - 三段全空时回 `skipped: "empty"` 而不是一个空对象：
     *    "搜到了但什么都没有"与"没搜成"对端上相同（都不出这张卡），
     *    但排障时需要区分。
     */
    if (req.method === "POST" && req.url === HIGHLIGHTS_REFRESH_PATH) {
      let body: { plan?: TripPlanSnapshot };
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const plan = body.plan;
      if (!plan || typeof plan !== "object" || !Array.isArray(plan.skeleton)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing_plan" }));
        return;
      }
      // 已经结束的行程不做联网搜索：它不会上卡。
      const today = new Date().toISOString().slice(0, 10);
      if (tripDayIndex(plan, today) === null) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ skipped: "expired" }));
        return;
      }
      try {
        const { collectDestinationHighlights } = await import("./graph/highlights");
        const highlights = await collectDestinationHighlights(plan);
        if (!hasHighlights(highlights)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ skipped: "empty" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ destinationHighlights: highlights, computedAt: highlights.computedAt }),
        );
      } catch (err) {
        console.warn("[runtime] 目的地推荐失败（这次就不出这张卡）", err);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ skipped: "failed" }));
      }
      return;
    }

    /*
     * 导览任务状态（ACR-008）。快路径：只查 pg-boss 状态与⑤缓存在场，不触发任何采集：
     * 它供前端轮询，轮询不能产生调用费用。
     */
    if (req.method === "POST" && req.url === GUIDE_JOBS_STATUS_PATH) {
      if (!guideJobs) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "guide_queue_disabled" }));
        return;
      }
      let body: { plan?: unknown };
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const plan = body.plan as import("@cabinhug/shared").TripPlanSnapshot | undefined;
      if (!plan || !Array.isArray(plan.skeleton)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_plan" }));
        return;
      }
      try {
        const jobs = await guideJobs.status(plan);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jobs }));
      } catch (err) {
        console.warn("[runtime] 导览任务状态查询失败", err);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jobs: null }));
      }
      return;
    }

    /* 手动「获取」（ACR-008）：单景点入队，回该点即时状态。 */
    if (req.method === "POST" && req.url === GUIDE_ENQUEUE_PATH) {
      if (!guideJobs) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "guide_queue_disabled" }));
        return;
      }
      let body: { spotName?: unknown; city?: unknown; date?: unknown; selfDrive?: unknown; siblingSpots?: unknown; prevSpot?: unknown; isLastStop?: unknown; force?: unknown };
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const spotName = typeof body.spotName === "string" ? body.spotName.trim() : "";
      if (!spotName) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing_spot_name" }));
        return;
      }
      try {
        const spot = await guideJobs.trigger({
          spotName,
          ...(typeof body.city === "string" && body.city.trim() ? { city: body.city.trim() } : {}),
          ...(typeof body.date === "string" && body.date.trim() ? { date: body.date.trim() } : {}),
          ...(typeof body.selfDrive === "boolean" ? { selfDrive: body.selfDrive } : {}),
          ...(Array.isArray(body.siblingSpots)
            ? { siblingSpots: (body.siblingSpots as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "") }
            : {}),
          ...(typeof body.prevSpot === "string" && body.prevSpot.trim() ? { prevSpot: body.prevSpot.trim() } : {}),
          ...(body.isLastStop === true ? { isLastStop: true } : {}),
          ...(body.force === true ? { force: true } : {}),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ spot }));
      } catch (err) {
        console.warn("[runtime] 导览手动入队失败", err);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ spot: { spotName, state: "failed", note: "这次没排上队，稍后再试" } }));
      }
      return;
    }

    /*
     * 景区导览采集。与两条 refresh 同族：失败不是错误，一律 200 + 原因，
     * 调用方（网关/端上）据此少一页，而不是把导览页变成一次报错。
     * 这是本文件最慢的一条（三分支 fan-out，冷启最坏 90s 量级）：
     * 调用方必须自带超时预算；缓存命中时毫秒级返回（`cached: true`）。
     */
    if (req.method === "POST" && req.url === GUIDE_BRIEF_PATH) {
      let body: { spotName?: unknown; city?: unknown; date?: unknown; selfDrive?: unknown; siblingSpots?: unknown; prevSpot?: unknown; isLastStop?: unknown; force?: unknown };
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const spotName = typeof body.spotName === "string" ? body.spotName.trim() : "";
      if (!spotName) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing_spot_name" }));
        return;
      }
      if (!guideBrief) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "guide_brief_unavailable" }));
        return;
      }
      try {
        const { brief, cached } = await guideBrief({
          spotName,
          ...(typeof body.city === "string" && body.city.trim() ? { city: body.city.trim() } : {}),
          ...(typeof body.date === "string" && body.date.trim() ? { date: body.date.trim() } : {}),
          ...(typeof body.selfDrive === "boolean" ? { selfDrive: body.selfDrive } : {}),
          ...(Array.isArray(body.siblingSpots)
            ? { siblingSpots: (body.siblingSpots as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "") }
            : {}),
          ...(typeof body.prevSpot === "string" && body.prevSpot.trim() ? { prevSpot: body.prevSpot.trim() } : {}),
          ...(body.isLastStop === true ? { isLastStop: true } : {}),
          ...(body.force === true ? { force: true } : {}),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ brief, cached, computedAt: new Date().toISOString() }));
      } catch (err) {
        console.warn("[runtime] 导览采集失败（这次就没有导览页）", err);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ skipped: "failed" }));
      }
      return;
    }

    /*
     * 出发导航规划。校验顺序与 pretrip-refresh 同款；三种"这次没算成"都回 200 + skipped：
     *  - `no_target`：行程里没有带坐标的站（卡上按钮本来就是禁用的，网关不该打到这里，但要防）；
     *  - `no_origin`：网关没给起点（起点回退到常住地是网关的事，这里只认坐标）；
     *  - `failed`：分支/汇聚异常。
     */
    if (req.method === "POST" && req.url === NAV_PLAN_PATH) {
      if (!navPlan) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "nav_plan_unavailable" }));
        return;
      }
      let body: { userId?: unknown; plan?: TripPlanSnapshot; origin?: unknown; vin?: unknown };
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const userId = typeof body.userId === "string" ? body.userId.trim() : "";
      const plan = body.plan;
      if (!userId || !plan || typeof plan !== "object" || !Array.isArray(plan.skeleton)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: userId ? "missing_plan" : "missing_user" }));
        return;
      }
      const o = body.origin as Partial<NavPlanOrigin> | undefined;
      if (!o || typeof o.lat !== "number" || typeof o.lon !== "number" || !Number.isFinite(o.lat) || !Number.isFinite(o.lon)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ skipped: "no_origin" }));
        return;
      }
      const target = tripPlanNavTarget(plan, new Date().toISOString().slice(0, 10));
      if (!target) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ skipped: "no_target" }));
        return;
      }
      const startedAt = Date.now();
      try {
        const result = await navPlan({
          userId,
          origin: {
            lat: o.lat,
            lon: o.lon,
            source: o.source === "home" ? "home" : "fix",
            ...(typeof o.ageMinutes === "number" ? { ageMinutes: o.ageMinutes } : {}),
          },
          destination: target,
          ...(typeof plan.party === "string" && plan.party.trim() ? { party: plan.party.trim() } : {}),
          ...(typeof body.vin === "string" && body.vin.trim() ? { vin: body.vin.trim() } : {}),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ plan: result, elapsedMs: Date.now() - startedAt }));
      } catch (err) {
        console.warn("[runtime] 出发导航规划失败（调用方按起终点直连）", err);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ skipped: "failed", elapsedMs: Date.now() - startedAt }));
      }
      return;
    }

    /*
     * 对照答案：同一段上下文，去掉用车数据那一节。
     *
     * 输入是当时留在轨迹里的那份上下文，不重跑检索：重跑会引入检索结果差异，
     * 而这个对照要证明差异只来自那一路数据。
     *
     * 剥离规则在 `ownership.ts`（与拼装它的代码同住），这里只调用。
     */
    if (req.method === "POST" && req.url === "/internal/dual-path/contrast") {
      let body: { context?: string; question?: string } = {};
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_body" }));
        return;
      }
      const context = typeof body.context === "string" ? body.context : "";
      const question = typeof body.question === "string" ? body.question : "";
      if (!context || !question) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "context_and_question_required" }));
        return;
      }
      if (!answerFor) {
        // 没接生成器就明说，不返回空答案：空答案会被读成"模型没话说"。
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "answer_generator_unavailable" }));
        return;
      }
      try {
        const contrastContext = stripUsageSection(context);
        const answer = await answerFor({ context: contrastContext, question });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ contrastContext, answer }));
      } catch (err) {
        console.error("[runtime] 对照答案生成失败", err);
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "contrast_failed", detail: String(err) }));
      }
      return;
    }

    /*
     * 双路检索探针：向运营控制台展示双路检索的实际结果。
     *
     * # 在 runtime 侧
     *
     * 双路逻辑在 `graph/subgraphs/ownership.ts`，依赖工具注册表（`invokeTool`），
     * 网关没有工具句柄。与 `probe/llm` 同一条理由。
     *
     * # 复用生产的 `runOwnershipDualPath`
     *
     * 探针要证明生产链路在做双路，另写一份可能与真实路径漂开。
     *
     * 默认不跑 LLM：这一层只回答"两路各捞到了什么、够不够格个性化"，
     * `personalized` + `caveats` 已是全部证据，生成答案要多花十几秒与一次调用。
     */
    if (req.method === "POST" && req.url === "/internal/dual-path/probe") {
      let body: {
        query?: string;
        userId?: string;
        vin?: string;
        vehicleModel?: string;
        agent?: string;
        withAnswers?: boolean;
      } = {};
      try {
        body = (await readJson(req)) as typeof body;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_body" }));
        return;
      }
      const query = typeof body.query === "string" ? body.query.trim() : "";
      if (!query) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "query_required" }));
        return;
      }
      try {
        const r = await runOwnershipDualPath({
          query,
          ...(body.userId ? { userId: body.userId } : {}),
          ...(body.vin ? { vin: body.vin } : {}),
          ...(body.vehicleModel ? { vehicleModel: body.vehicleModel } : {}),
          ctx: {
            // 探针的调用也带会话维度，否则工具侧的 ACL 与轨迹换算都无处落。
            sessionId: "__dualprobe__",
            // agent 决定查哪个知识库（ownership=说明书 / service=维修库），
            // 由调用方选，用于展示"同一份双路逻辑、不同的那一路"。
            agent: body.agent === "service" ? "service" : "ownership",
          },
        });
        /*
         * 单路对照：同一段代码、少喂一路。
         *
         * 不另写一个"只查 RAG"的分支，避免差异里混进实现差异，
         * 这一屏要证明差异只来自那一路数据。
         * 复用已经捞到的 chunks，所以不产生第二次检索。
         */
        const single = await runDualPath(
          async () => r.rag.chunks,
          async () => ({ unusableReason: "对照用：本次刻意不接入用车数据" }),
        );

        // 答案是可选的：它要多花两次 LLM 调用与十几秒，只在页面明确要时才跑。
        let answers: { single: string; dual: string } | undefined;
        if (body.withAnswers && answerFor) {
          const [a, b] = await Promise.all([
            answerFor({ context: single.context, question: query }),
            answerFor({ context: r.context, question: query }),
          ]);
          answers = { single: a, dual: b };
        }

        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ...r,
            singleContext: single.context,
            singlePersonalized: single.personalized,
            answerAvailable: answerFor !== undefined,
            ...(answers ? { answers } : {}),
          }),
        );
      } catch (err) {
        console.error("[runtime] 双路探针失败", err);
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "dual_path_failed", detail: String(err) }));
      }
      return;
    }

    // LLM 探活：必须在 runtime 侧，网关不得 import AI SDK（有静态断言守护）。
    if (req.method === "POST" && req.url === "/internal/probe/llm") {
      if (!config) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "config_store_unavailable" }));
        return;
      }
      try {
        const report = await probeLlm(config);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(report));
      } catch (err) {
        console.error("[runtime] llm probe failed", err);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "probe_failed" }));
      }
      return;
    }

    // ③偏好：列出与删除。
    // 系统能自己往③里写，用户就必须能把写错的删掉：③不硬删，
    // 没有删除路径时一条错误偏好会一直影响后续回答。
    const prefMatch = req.url ? PREFERENCES_PATH.exec(req.url) : null;
    if (prefMatch) {
      const userId = decodeURIComponent(prefMatch[1]);
      const memoryId = prefMatch[2] ? decodeURIComponent(prefMatch[2]) : undefined;
      const { getMemoryClient } = await import("@cabinhug/memory");
      const client = getMemoryClient();

      if (req.method === "GET" && !memoryId) {
        try {
          const r = await client.listPreferences(userId);
          res.writeHead(200, { "content-type": "application/json" });
          // `degraded` 一并回传：降级下的空结果不代表"没有偏好"，
          // 页面要能把这两种情况分开说。
          res.end(
            JSON.stringify({
              userId,
              degraded: r.degraded === true,
              preferences: (r.results ?? []).map((m) => ({
                id: m.id,
                content: m.memory,
                domain: (m.metadata as { domain?: string } | undefined)?.domain ?? null,
                confidence: (m.metadata as { confidence?: number } | undefined)?.confidence ?? null,
                evidence: (m.metadata as { evidence?: string } | undefined)?.evidence ?? null,
                provenance: (m.metadata as { provenance?: string } | undefined)?.provenance ?? null,
                supersededContent:
                  (m.metadata as { supersededContent?: string } | undefined)?.supersededContent ?? null,
              })),
            }),
          );
        } catch (err) {
          console.error(`[runtime] 读取 ③偏好失败 user=${userId}`, err);
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "memory_unavailable" }));
        }
        return;
      }

      if (req.method === "DELETE" && memoryId) {
        try {
          await client.delete(memoryId);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ deleted: true }));
        } catch (err) {
          console.error(`[runtime] 删除 ③偏好失败 id=${memoryId}`, err);
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "memory_unavailable" }));
        }
        return;
      }
    }

    /*
     * ⑤环境缓存分页列举。
     *
     * 只读，且不经过 `withEnvCache`：列举不续期任何键的 TTL，
     * 也不因后台翻页去上游取数。
     */
    if (req.method === "GET" && req.url?.split("?")[0] === ENV_CACHE_PATH) {
      const q = new URL(req.url, "http://localhost").searchParams;
      const limit = Math.min(200, Math.max(1, Number(q.get("limit") ?? 20) || 20));
      const offset = Math.max(0, Number(q.get("offset") ?? 0) || 0);
      const namespace = q.get("namespace") || undefined;
      try {
        const { listEnvCache } = await import("@cabinhug/tools");
        const listing = await listEnvCache({ offset, limit, namespace });
        if (!listing) {
          /*
           * 不回空列表：未接入 Redis 与"缓存里没东西"是两回事，
           * 空列表会被读成后者。
           */
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ wired: false }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ wired: true, offset, limit, ...listing }));
      } catch (err) {
        console.error("[runtime] 列举 ⑤环境缓存失败", err);
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "env_cache_unavailable" }));
      }
      return;
    }

    /*
     * ⑤单条详情。同样只读、不经 `withEnvCache`、不续期。
     * 天气预报按 adcode 存、值里没坐标，附带解析到这个 adcode 的逆地理点，
     * 供控制台落针；反查不到就不带，不用城市中心替代。
     */
    if (req.method === "GET" && req.url?.split("?")[0] === ENV_CACHE_ENTRY_PATH) {
      const key = new URL(req.url, "http://localhost").searchParams.get("key") ?? "";
      if (!key) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "key_required" }));
        return;
      }
      try {
        const { getEnvCacheEntry, regeoPointsForAdcode } = await import("@cabinhug/tools");
        const entry = await getEnvCacheEntry(key);
        if (entry === undefined) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ wired: false }));
          return;
        }
        if (entry === null) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ wired: true, found: false }));
          return;
        }
        let related: unknown;
        if (entry.namespace === "amap-forecast") {
          const adcode = (entry.value as { adcode?: unknown } | null)?.adcode;
          if (typeof adcode === "string" && adcode) related = await regeoPointsForAdcode(adcode);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ wired: true, found: true, entry, ...(related ? { regeoPoints: related } : {}) }));
      } catch (err) {
        console.error("[runtime] 读取单条 ⑤环境缓存失败", key, err);
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "env_cache_unavailable" }));
      }
      return;
    }

    // ①Working 只读查询：不触发图执行、不改检查点。
    const memMatch = req.url ? WORKING_MEMORY_PATH.exec(req.url) : null;
    if (req.method === "GET" && memMatch) {
      try {
        const state = await runner.workingState(memMatch[1]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(state));
      } catch (err) {
        console.error(`[runtime] working state failed session=${memMatch[1]}`, err);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "working_state_failed" }));
      }
      return;
    }

    // 拍照问诊报告只读查询：不触发图执行、不改检查点。
    const dxMatch = req.url ? DIAGNOSIS_STATE_PATH.exec(req.url) : null;
    if (req.method === "GET" && dxMatch) {
      try {
        const body = JSON.stringify(await runner.diagnosisState(dxMatch[1]));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      } catch (err) {
        console.error(`[runtime] diagnosis state failed session=${dxMatch[1]}`, err);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "diagnosis_state_failed" }));
      }
      return;
    }

    // 会话行程只读查询（ACR-062）：不触发图执行、不改检查点。
    const tdMatch = req.url ? TRIP_DRAFT_STATE_PATH.exec(req.url) : null;
    if (req.method === "GET" && tdMatch) {
      try {
        // 先取到结果再写头：先写 200 的话，读检查点抛错时 500 写不出去，请求就挂着不回。
        // `userId` 由网关从鉴权结果里填（会话归属已在网关校验过）。
        const userId = new URL(req.url ?? "/", "http://x").searchParams.get("userId") ?? undefined;
        const body = JSON.stringify(await runner.tripDraftState(tdMatch[1], userId));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      } catch (err) {
        console.error(`[runtime] trip draft state failed session=${tdMatch[1]}`, err);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "trip_draft_state_failed" }));
      }
      return;
    }

    // 购车候选与成本只读查询：不触发图执行、不改检查点。
    const buyMatch = req.url ? BUYING_STATE_PATH.exec(req.url) : null;
    if (req.method === "GET" && buyMatch) {
      try {
        const body = JSON.stringify(await runner.buyingState(buyMatch[1]));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      } catch (err) {
        console.error(`[runtime] buying state failed session=${buyMatch[1]}`, err);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "buying_state_failed" }));
      }
      return;
    }

    const match = req.url ? TURN_PATH.exec(req.url) : null;
    if (req.method !== "POST" || !match) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    const sessionId = match[1];

    let body: TurnRequestBody;
    try {
      const raw = await readJson(req);
      if (!isTurnRequestBody(raw)) throw new Error("bad shape");
      body = raw;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_body" }));
      return;
    }

    res.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-cache",
    });

    try {
      for await (const event of runner.run({ sessionId, ...body })) {
        res.write(`${JSON.stringify(event)}\n`);
      }
      res.end();
    } catch (err) {
      // 流已开始：以带 error 标记的终止行结束（内部协议，gateway 转换为错误事件）。
      console.error(`[runtime] turn failed session=${sessionId}`, err);
      res.write(`${JSON.stringify({ internalError: "turn_failed" })}\n`);
      res.end();
    }
  });
}
