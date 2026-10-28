/**
 * turn-runner：执行一轮对话并产出事件流。
 *
 * ①Working 硬过期（§7①：会话结束 / 24h）在此实现：
 * 每个 session 映射到一个图 thread；超过 24h 未活动则换新 thread，
 * 旧图状态不再被引用（MemorySaver 生命周期内自然废弃）。
 * 权威对话历史（PG）不受过期影响：过期的是"模型上下文"，不是"可翻阅历史"。
 *
 * 助手回复全文由消费方（gateway）累积 delta 获得，本模块不重复提供。
 */

import { randomUUID } from "node:crypto";

import type { MessageSource, SessionEvent } from "@cabinhug/shared";
import { closePair, countFillerDrop, registerPair, type PairSessionLike } from "./sidecar/pair-session";
import { sweepTurn } from "./branch-submissions";
import { sweepPoiCoords } from "./poi-coords";
import { peekAnswerSources, sweepAnswerSources } from "./answer-sources";
import { sweepEnergyStopCandidates } from "./energy-candidates";
import { sweepEnergyConsumption } from "./energy-consumption";
import { sweepRouteDurations } from "./route-durations";
import type { FillerWriter } from "./sidecar/l1";
import { emitFiller } from "./sidecar/speak";

import { registerTurnSink } from "./interrupt-bus";
import { registerTurnCancel } from "./turn-cancel";
import { PhotoTurnRegistry } from "./photo-turns";
/*
 * 地名解析。
 *
 * 旁路只要用户话里提到的地名，不要原话：模型看见问题原文就会去回答它，禁令挡不住
 * （见 `sidecar/l1.ts`）。所以抽取在这一侧做完，`setPlace` 的签名里没有第二个参数。
 *
 * 地名表在试驾子图里（已处理「想去市」「深圳开到」这类误截），这里复用而不另抄一份。
 * `sidecar/` 不能 import 它（`check:arch` 禁止旁路 import `../graph`）。
 */
import { pickCityDistrict } from "./graph/subgraphs/test-drive";
import type { ChatGraph } from "./graph/supervisor";
import type { LlmUsageSample } from "./llm";
import { CancellationToken, spanData } from "./trace";
import { classifyError } from "./trace/span";
import * as events from "./events";

const WORKING_STATE_TTL_MS = 24 * 60 * 60 * 1000;

interface ThreadInfo {
  threadId: string;
  lastActiveMs: number;
}

export interface TurnInput {
  sessionId: string;
  turnId: string;
  /** 用户输入文本（语音时为 ASR 识别原文）。 */
  content: string;
  source: MessageSource;
  /**
   * 记忆维度。由网关注入，可缺省：缺了双路检索退化为单路（只有 RAG），
   * 但不阻塞对话。有它时必须一路带到 ⑥/Mem0 的读写，防止跨用户混算。
   */
  userId?: string;
  /**
   * 端上的垫场话偏好。
   *
   * 缺省视为开启，但服务端仍受 `SIDECAR_ENABLED` 总开关约束。
   * 为 `false` 时不建 A-pair，而不是建了再由端上丢弃（后者仍在跑判断、写指标、调 L1）。
   */
  fillerEnabled?: boolean;
  /**
   * 本轮绑定的附件（照片与视频）。照片进观察层与直连表述模型；
   * 视频是网关派生好的帧序图 + 转写（没有原件）。见 `graph/media.ts`。
   */
  attachments?: TurnAttachmentInput[];
}

import type { GuardPipeline } from "./guard/pipeline";
import {
  buildContextTrace,
  contextLayerMode,
  contextTraceNotLoaded,
  loadTurnContext,
  observeServed,
  type ActiveTasks,
  type ContextTraceData,
  type ServedBlock,
  type TurnContextDeps,
} from "./context";
import { attachmentNote, isPhotoInput, isVideoInput, type TurnAttachmentInput } from "./graph/media";
import type { ElicitationService } from "./elicitation/service";
import { createStreamRedactor, createModerationSession } from "@cabinhug/guardrails";

/**
 * 撤回时的替换文案。
 *
 * 不能为空：屏幕上什么都不剩时用户会以为应用坏了。
 * 也不带命中的标签：那是审计信息，展示给用户等于提示绕过方法。
 */
const RETRACT_REPLACEMENT = "这条回答我收回了——内容没有通过安全检查。换个说法我们再试试。";
const RETRACT_REASON = "输出内容未通过安全检查";
/** 审核不可用时同样撤回（output fail-closed，§8.2），但原因要说得不一样。 */
const RETRACT_UNAVAILABLE = "内容审核暂时不可用，出于谨慎已收回本次回答";

/**
 * 审核不可用时给用户看的那句话。
 *
 * 不复用 `RETRACT_REPLACEMENT`：那句话说的是"你的内容没通过检查"，
 * 而这里的事实是"检查没跑成"。混用会让用户反复改写说法，而每次仍被收回。
 */
const RETRACT_UNAVAILABLE_REPLACEMENT =
  "这条回答我先收回了——安全检查没能跑完，不是你的问题。稍等一下再问一次吧。";

/**
 * 把审核异常压成一行可读的原因。
 *
 * `AliyunGuardError` 带着 `code`/`retryable`，它们是"该改配置还是该重试"的判据
 * （408 权限/欠费、588 限流、-1 网络或超时），只打 message 时三者无法区分。
 *
 * message 必须截断：`SignatureDoesNotMatch` 的报文里附着服务端算出的待签名串，
 * 其中编码着送审正文与 AccessKeyId，不能写进 `guard_audit_logs.reason`。
 * 120 字足以保留第一句有效信息。
 */
const GUARD_ERROR_MESSAGE_MAX = 120;

function describeGuardError(err: unknown): string {
  const e = err as { name?: string; code?: unknown; retryable?: unknown; message?: string } | null;
  if (!e || typeof e !== "object") return String(err).slice(0, GUARD_ERROR_MESSAGE_MAX);
  const parts = [e.name ?? "Error"];
  if (e.code !== undefined) parts.push(`code=${String(e.code)}`);
  if (e.retryable !== undefined) parts.push(`retryable=${String(e.retryable)}`);
  const raw = e.message ?? String(err);
  const msg =
    raw.length > GUARD_ERROR_MESSAGE_MAX ? `${raw.slice(0, GUARD_ERROR_MESSAGE_MAX)}…（已截断）` : raw;
  return `${parts.join(" ")} — ${msg}`;
}

/**
 * ①Working 的 thread 映射存储。
 *
 * 检查点落 PG 之外还需要这个映射，否则重启后不知道该读哪个 thread 的检查点，
 * 检查点在库里但上下文仍然丢失。
 * 未注入时退回进程内 Map：单测与离线路径不依赖数据库，但重启即丢。
 */
export interface WorkingThreadStore {
  get(sessionId: string): Promise<{ threadId: string; expiresAt: Date } | null>;
  set(sessionId: string, threadId: string, expiresAt: Date): Promise<void>;
}

/** 用量落库的出口：由入口注入 DB 仓储，TurnRunner 只负责补上会话上下文。 */
export type UsageSink = (
  sample: LlmUsageSample & { sessionId: string; turnId: string; agent: string },
) => void;

/**
 * 轨迹出口。
 *
 * 图节点通过 `configurable.onTrace` 上报，由这里接到落库。未接时回放页为空，
 * 而"没采集"与"采集了但读不到"在页面上表现相同。
 */
export type TraceSink = (event: {
  sessionId: string;
  turnId: string;
  kind: string;
  at: number;
  data: Record<string, unknown>;
}) => void;

export class TurnRunner {
  private threads = new Map<string, ThreadInfo>();
  /** 同会话里「带照片的轮还在跑」的登记，纯文字追问先等它，见 `photo-turns.ts` 文件头。 */
  private photoTurns = new PhotoTurnRegistry();

  constructor(
    private graph: ChatGraph,
    private now: () => number = Date.now,
    private onUsage?: UsageSink,
    private threadStore?: WorkingThreadStore,
    /**
     * 内容管线（§8）。挂在这里而不是图节点里：
     * 它要对所有进出的文本生效，放进节点会有路径绕过它。
     */
    private guards?: GuardPipeline,
    /** 轨迹落库的出口。缺省即不采集，回放页为空。 */
    private onTrace?: TraceSink,
    /**
     * L1 导游生成器，在这一层注入：
     * `sidecar/` 不许 import `../llm`（`check:arch` 的 `sidecar-isolation`），
     * 生成器只能由装配层给。缺省即全程 L0：话会少，但不会错。
     */
    private fillerWriter?: FillerWriter,
    /**
     * 事实补录询问（§4.6）。缺省即从不问，离线与单测路径不依赖数据库。
     *
     * 挂在这一层而不是图里：槽位与冷却不进图状态是 AC-53-13 的结构性保证
     * （子图读不到的东西就不会被读错）。
     */
    private elicitation?: ElicitationService,
    /**
     * 裁决审计。内容管线的 onAudit 没有会话归属，而审计按 sessionId
     * 回查，所以落库记录在本层打（这里拿得到 session/turn）。缺省即不记
     * （单测与离线路径），装配层必给。
     */
    private guardAuditor?: {
      record(r: {
        sessionId: string;
        turnId?: string;
        layer: "input_prefilter" | "input_moderation" | "output_moderation" | "output_pii";
        decision: "allow" | "deny";
        rule?: string;
        reason?: string;
        durationMs: number;
      }): void;
    },
    /**
     * 上下文装载层（ACR-036 §4.9）。缺省即不装载：`CABINHUG_CONTEXT_LAYER=off`
     * 时三条链路的 prompt 不含装载内容，离线与单测路径零开销。
     *
     * 挂在这一层而不是图里，与 `elicitation` 同理：取事实是 harness 的职责，
     * 节点只读它拿到的东西，不自己查库。
     *
     * 排在参数列表最后：插在中间会让既有调用点的位置参数整体错位，而 TypeScript
     * 在两个都是可选对象参数时未必拦得住。
     */
    private contextDeps?: TurnContextDeps,
  ) {}

  /**
   * 落一条分跳耗时（F-44-04）。
   *
   * 本类里的两跳（thread 解析、输入侧内容管线）发生在图执行之前，
   * 拿不到 `configurable.onTrace`，也进不了 `trace/span.ts` 的 threadId 换算表
   * （那张表在 `registerTurnSink` 之后才有），所以直接用手上的 `onTrace`。
   */
  private span(
    sessionId: string,
    turnId: string,
    name: string,
    startedAt: number,
    status: "ok" | "failed",
    detail?: string,
  ): void {
    if (!this.onTrace) return;
    const endedAt = this.now();
    try {
      this.onTrace({
        sessionId,
        turnId,
        kind: "span",
        at: endedAt,
        data: spanData(name, startedAt, endedAt, status, detail ? { detail } : undefined),
      });
    } catch {
      /* 吞掉：埋点坏了不该让对话坏 */
    }
  }

  /**
   * 落一条点事件（没有时长）。
   *
   * 目前只有轮次边界用它（`turn_start` / `turn_end`）。缺少轮次事件时，读轨迹的人
   * 判断不出一轮是否结束，大屏实时视图会一直指着最后一个节点。
   */
  private point(sessionId: string, turnId: string, kind: string, data: Record<string, unknown>): void {
    if (!this.onTrace) return;
    try {
      this.onTrace({ sessionId, turnId, kind, at: this.now(), data });
    } catch {
      /* 吞掉：埋点坏了不该让对话坏 */
    }
  }

  /**
   * 取当前会话的图 thread；24h 未活动则轮换（①Working 硬过期，§7①）。
   *
   * 有持久化存储时以它为准：重启后必须取回同一个 thread，否则检查点读不到。
   * 过期的是"模型上下文"，不是"可翻阅历史"（后者在 messages 表，不受影响）。
   */
  private async threadFor(sessionId: string): Promise<string> {
    const nowMs = this.now();

    if (this.threadStore) {
      const stored = await this.threadStore.get(sessionId).catch((err) => {
        console.error("[turn-runner] thread 映射读取失败，退回内存", err);
        return null;
      });
      if (stored && stored.expiresAt.getTime() > nowMs) {
        // 续期：过期是"自最后一次活动起 24h"，不是固定窗口。
        void this.threadStore
          .set(sessionId, stored.threadId, new Date(nowMs + WORKING_STATE_TTL_MS))
          .catch(() => {});
        return stored.threadId;
      }
      const fresh = `${sessionId}#${nowMs}`;
      await this.threadStore
        .set(sessionId, fresh, new Date(nowMs + WORKING_STATE_TTL_MS))
        .catch((err) => console.error("[turn-runner] thread 映射写入失败", err));
      return fresh;
    }

    const existing = this.threads.get(sessionId);
    if (existing && nowMs - existing.lastActiveMs <= WORKING_STATE_TTL_MS) {
      existing.lastActiveMs = nowMs;
      return existing.threadId;
    }
    const fresh: ThreadInfo = { threadId: `${sessionId}#${nowMs}`, lastActiveMs: nowMs };
    this.threads.set(sessionId, fresh);
    return fresh.threadId;
  }

  /** 只读地解析当前 thread（不续期、不新建），供 workingState 复用。 */
  private async resolveThread(
    sessionId: string,
  ): Promise<{ threadId: string; lastActiveMs: number; expiresAtMs: number } | null> {
    if (this.threadStore) {
      const stored = await this.threadStore.get(sessionId).catch(() => null);
      if (!stored) return null;
      const expiresAtMs = stored.expiresAt.getTime();
      return {
        threadId: stored.threadId,
        lastActiveMs: expiresAtMs - WORKING_STATE_TTL_MS,
        expiresAtMs,
      };
    }
    const info = this.threads.get(sessionId);
    if (!info) return null;
    return {
      threadId: info.threadId,
      lastActiveMs: info.lastActiveMs,
      expiresAtMs: info.lastActiveMs + WORKING_STATE_TTL_MS,
    };
  }

  /**
   * 跑一轮：受理 → thinking → token 流 → 轮次结束。
   * 返回异步事件序列（SessionEvent，未含封套——封套归 gateway）。
   * 图执行失败时事件流以异常终止，由调用方转换为错误响应。
   */
  async *run(input: TurnInput): AsyncGenerator<SessionEvent> {
    /*
     * 轮次开始，发在最前面：thread 解析与输入侧内容管线也属于这一轮，
     * 且 `guard.input` 常是最大的一跳。
     */
    this.point(input.sessionId, input.turnId, "turn_start", { source: input.source });

    // ①thread 解析：有持久化存储时这里是一次真实的 PG 往返。
    const threadStartedAt = this.now();
    const threadId = await this.threadFor(input.sessionId);
    this.span(
      input.sessionId,
      input.turnId,
      "thread.resolve",
      threadStartedAt,
      "ok",
      this.threadStore ? "pg" : "memory",
    );

    /*
     * ①.5 上下文装载（ACR-036 §4.9）。
     *
     * 位于 thread 解析之后、内容管线与图执行之前：要 threadId 才能钉锚定块；
     * 节点拿到的必须是装好的事实。
     *
     * 整跳受 `assembleUserContext` 的 300 ms 预算约束，任一段失败只让那一段标"读不到"。
     * 装载本身失败也不阻塞：退回 undefined，各节点走不带上下文的路径。
     * 上下文是增强不是必需，与 ②③记忆同一约束。
     */
    const ctxStartedAt = this.now();
    let turnContext: Awaited<ReturnType<typeof loadTurnContext>>;
    /*
     * 上下文的轨迹落点（会话页「查看上下文」）。三样东西在这里备好、轮末一并落：
     * 装载完成时的任务快照（写穿会就地改 `turnContext.tasks`）、各 Agent 实际取走的块
     * （经 `observeServed` 包一层记下来）、以及"没装载"的两种原因（关着 / 抛错）。
     */
    let contextTrace: ContextTraceData | undefined;
    let tasksBefore: ActiveTasks = {};
    let servedBlocks: () => ServedBlock[] = () => [];
    if (this.contextDeps) {
      try {
        const loaded = await loadTurnContext(this.contextDeps, {
          ...(input.userId !== undefined ? { userId: input.userId } : {}),
          threadId,
          now: this.now(),
        });
        if (loaded) {
          this.span(input.sessionId, input.turnId, "context.load", ctxStartedAt, "ok", loaded.mode);
          // 草案是可序列化的（契约要求），structuredClone 拿到的就是"模型看到的那份"。
          tasksBefore = structuredClone(loaded.tasks);
          const observed = observeServed(loaded);
          turnContext = observed.ctx;
          servedBlocks = observed.served;
        } else {
          contextTrace = contextTraceNotLoaded("off", threadId);
        }
      } catch (err) {
        console.error("[turn-runner] 上下文装载失败，本轮走老路径", err);
        this.span(input.sessionId, input.turnId, "context.load", ctxStartedAt, "failed");
        contextTrace = contextTraceNotLoaded(contextLayerMode(), threadId, this.now() - ctxStartedAt);
      }
    }
    const ctxLoadMs = this.now() - ctxStartedAt;
    /*
     * 上下文落点：紧挨着 `turn_end` 之前发，两条出口（输入被拦的提前 return、finally）各调一次。
     * 轮末才知道各 Agent 取走了什么、任务状态被写成了什么；失败与取消的轮同样要落。
     * 装载层没配（`contextDeps` 缺席，离线测试路径）时一条都不落，以区分"没配"与"关着"。
     */
    const pointContext = (): void => {
      if (!this.contextDeps) return;
      const data =
        turnContext !== undefined
          ? buildContextTrace({ ctx: turnContext, tasksBefore, served: servedBlocks(), loadMs: ctxLoadMs })
          : (contextTrace ?? contextTraceNotLoaded("off", threadId));
      this.point(input.sessionId, input.turnId, "context", data);
    };

    const assistantMessageId = `msg-${input.turnId}-${randomUUID().slice(0, 8)}`;

    // 输入侧内容管线（§8.1/§8.2），在图执行之前：被拦下的输入不消耗任何 LLM 调用。
    //
    // 这一跳是全链路的固定成本：规则筛是零延迟的，但内容审核是一次外部 HTTP
    // （阿里云，超时上限 5s），因此单独计 span（F-44-04）。
    if (this.guards) {
      const guardStartedAt = this.now();
      let verdict: Awaited<ReturnType<GuardPipeline["checkInput"]>>;
      try {
        verdict = await this.guards.checkInput(input.content);
      } catch (err) {
        this.span(
          input.sessionId,
          input.turnId,
          "guard.input",
          guardStartedAt,
          "failed",
          classifyError(err),
        );
        throw err;
      }
      // 拦没拦下是结构性信息，不含原文，可以进 detail（AC-44-10）。
      this.span(
        input.sessionId,
        input.turnId,
        "guard.input",
        guardStartedAt,
        "ok",
        verdict.allowed ? "allow" : "deny",
      );
      // 保留用审计：拦下记在拦下它的那一层；放行记 moderation 层
      // （规则筛放行不是终局，整条输入管线的结论才是）。不含用户原文。
      this.guardAuditor?.record({
        sessionId: input.sessionId,
        turnId: input.turnId,
        layer: verdict.stage === "prefilter" ? "input_prefilter" : "input_moderation",
        decision: verdict.allowed ? "allow" : "deny",
        rule: verdict.ruleId,
        reason: verdict.reason,
        durationMs: this.now() - guardStartedAt,
      });
      if (!verdict.allowed) {
        yield events.promptAccepted(input.turnId, input.source, input.content);
        yield events.delta(input.turnId, verdict.reason ?? "这条消息我没法处理。");
        yield events.turnEnd(input.turnId, assistantMessageId);
        // 提前 return 也要收口，否则被输入管线拦下的那一轮在轨迹上一直显示"还在跑"。
        pointContext();
        this.point(input.sessionId, input.turnId, "turn_end", { outcome: "input_denied" });
        return;
      }
    }

    /*
     * prompt 事件不分来源都带原文。
     *
     * 端上不做乐观插入，用户消息由 SSE 回流（cockpit/mobile 的 `sendText`），
     * Rust 投影 `fanout.rs` 只在有 transcript 时追加用户气泡。这里带上原文，
     * 端上的编号（`msg-{turnId}-u`）、缓存、去重、补发才对文字输入同样生效。
     */
    yield events.promptAccepted(input.turnId, input.source, input.content);
    yield events.stateThinking();

    // 节点内的 emit 回调 → 队列 → 本生成器实时转发（流式，不等全量）。
    /**
     * 本轮的流式脱敏器。一轮一个：跨轮复用会把上一轮的尾巴接到这一轮开头。
     */
    const redactor = createStreamRedactor();
    /** 本轮 PII 脱敏命中累计（审计用）：只记类别与次数，不记原值。 */
    const piiHits: Record<string, number> = {};
    const tallyPii = (r: { hits: Record<string, number> }): void => {
      for (const [kind, n] of Object.entries(r.hits)) {
        if (n > 0) piiHits[kind] = (piiHits[kind] ?? 0) + n;
      }
    };
    const turnStartedAt = this.now();

    /**
     * 本轮输出侧审核会话（F-26-06）。
     *
     * 边流边审而不是等 turn_end：判"拦"时前面的 token 已经推出去，只能撤回，
     * 而用户已经读到了。越早判，读到的越少。
     *
     * `sessionKey` 用 turnId：同一轮的切片在阿里云侧被拼起来判，
     * 第 3 片的判定包含前两片的内容，跨片的表述照样认得出。
     */
    const moderation = this.guards
      ? createModerationSession(this.guards.outputGuard(), input.turnId)
      : undefined;
    /** 已撤回：撤回后本轮不再发任何 delta，也不再送审。 */
    let retracted = false;
    /**
     * 在途的裁决处理链。
     *
     * `moderation.finish()` 只等到送审返回，拿到裁决后还要
     * `await judgeOutput()`（读策略，异步）才知道撤不撤。不等这一段的话，
     * 撤回会发在 `turn_end` 之后，端上已收口会直接丢掉。测试 `judgeOutput` 那条覆盖它。
     */
    const pendingChecks: Promise<void>[] = [];

    const queue: SessionEvent[] = [];
    let wake: (() => void) | undefined;
    let done = false;
    let failure: unknown;
    /** 本轮是被打断的。与 `failure` 互斥，见下面 `.catch` 里的理由。 */
    let cancelled = false;
    /** 带照片的轮在这里登记的收口函数；finally 里调（`photo-turns.ts`）。 */
    let endPhotoTurn: (() => void) | undefined;
    /**
     * 本轮真正推向用户的文字量（应答 delta + 垫场话），turn_end 落轨迹。
     * 它是 TTS 成本估算的计费量：端上合成的就是这些字。数在 `push` 漏斗上
     * 而不是各产生点——直连叙述与 ACP 转发两条路都汇到这里。
     */
    let answerChars = 0;
    /** 其中垫场话的字数。分开数是因为它们各自对应一次独立合成（见下）。 */
    let fillerChars = 0;
    /**
     * 端上会发起几次合成。
     *
     * 端的粒度是"一段一次"（`tts::speak_filler` 每句垫场一次、`tts::speak`
     * 在轮次收口时把整段正文一次合成），所以这里 = 垫场话条数 + 有正文则 1。
     * 它是下发口径：端上静音、抢占丢弃时实际合成会更少
     * （`filler_slot` 的 Drop 分支）。计费仍以字数为准，这个数是它的补充。
     */
    let fillerSegments = 0;

    /*
     * 旁路 A-pair（F-45-01/02）。
     *
     * 注册点在 `stateThinking()` 之后：静默计时的基准是"受理了但还没出声"的那一刻。
     *
     * 销毁挂在下面的 `finally`（与 `unregisterSink()` 并列）：提前 return（`turn_end`）
     * 与异常都会走到那里。遗漏时下一轮的静默计时器会带着上一轮的状态，
     * 上一轮的垫场话会在这一轮开头出现。
     */
    /*
     * `pair` 与 `push` 互相引用：push 里要 markUserFacing / mute，
     * pair 的 emit 出口又是 push。先声明后赋值，`push` 内用可选链：
     * 注册之前不会有任何事件经过 push（注册紧跟在 `stateThinking` 之后）。
     */
    let pair: PairSessionLike | undefined;

    const push = (e: SessionEvent) => {
      /*
       * 只有 `delta` 与 `retract` 重置静默基准。
       *
       * `state` / `branch` / `tool_call` 不是面向用户的内容；用它们重置的话，
       * 事件多但不出声的链路永远触发不了静默判定，而那正是最需要垫场的场景。
       *
       * `filler` 自己也不算：否则说了一句就把计时器归零，永远说不出第二句，
       * `maxPerTurn` 也就失效。
       */
      if (e.type === "update" && (e.kind === "delta" || e.kind === "retract")) {
        pair?.markUserFacing(this.now());
        // 正文一到就解除静音：HITL 走完 resume 之后，恢复的信号就是它。
        pair?.unmute("hitl");
      }
      // TTS 计费量：撤回不回退，流式合成下发出去的片段已经被念了。
      if (e.type === "update" && (e.kind === "delta" || e.kind === "filler")) {
        const t = (e as { text?: unknown }).text;
        if (typeof t === "string") {
          answerChars += t.length;
          if (e.kind === "filler") {
            fillerChars += t.length;
            fillerSegments += 1;
          }
        }
      }
      /*
       * HITL 静音（F-45-12）。
       *
       * 信号取自真实的 `permission` 事件（`interrupt-bus` 经同一个 sink 推过来），
       * 不靠"没有 delta 就是在等确认"去猜：猜错会往确认问句上插话，
       * 盖掉有后果动作的最后一道用户侧闸门。
       */
      if (e.type === "permission") pair?.mute("hitl");
      queue.push(e);
      wake?.();
    };

    pair = registerPair(input.sessionId, input.turnId, this.now(), input.fillerEnabled ?? true, {
      now: this.now,
      ...(this.fillerWriter ? { writer: this.fillerWriter } : {}),
      /*
       * 垫场话的出口。
       *
       * 过 `checkOutput` 但不进 `redactor`：
       *  - 过管线：能出声的通道都必须经过 §8.3 这一层（F-45-10）。
       *  - 不进 `redactor`：`createStreamRedactor()` 是一轮一个且有跨片状态
       *    （扣住"还可能长成模式"的尾巴）。把垫场话推进去会往主回答的脱敏缓冲里
       *    插入不属于它的文本，在跨片时让主回答多出或少掉一小段。
       *    整句一次性产出用 `checkOutput` 即可。
       *
       * `emitFiller` 同步返回，管线在 fire-and-forget 的 promise 里跑。
       */
      emit: (draft) =>
        emitFiller(
          {
            guard: this.guards,
            push: (text) => {
              const at = this.now();
              push(events.filler(input.turnId, text, draft.source, true));
              /*
               * 垫场 span（F-45-15）。
               *
               * `detail` 只放 `phase` 与档位，不放文本：它是用户可见内容，
               * 轨迹里再存一份会多一处要脱敏的地方（§4.1 X2 对 span detail 的约束：
               * 只放结构性信息）。
               */
              this.span(input.sessionId, input.turnId, "sidecar.filler", at, "ok", `${draft.source} · ${draft.phase}#${draft.ordinal}`);
            },
            onDropped: countFillerDrop,
          },
          draft,
        ),
    });

    /*
     * 把地名递给旁路。只有地名，见文件头 `pickCityDistrict` 的注释。
     *
     * 认不出就不传：导游会说一句不带地点的闲话，而不是编一个地方出来。
     */
    const { city, district } = pickCityDistrict(input.content);
    const place = city && district ? `${city}${district}` : (city ?? district);
    pair.setPlace(place);

    // 权限门的挂起要能走出图、进到本轮的流里（§3 HITL 中转，见 interrupt-bus.ts）。
    // 注销放在下面的 finally，否则下一轮的 permission 事件会推给上一轮的队列。
    // 真会话 id 一并登记：权限门与工具观察者手上只有 threadId，
    // 而轨迹必须按真会话 id 落库，否则回放页查不到（见 interrupt-bus 的 currentTurnOf）。
    const unregisterSink = registerTurnSink(threadId, input.turnId, push, input.sessionId);

    /*
     * 取消把手（F-08-08 / F-14-04）。
     *
     * `signal` 有两个去处，缺一不可：
     *  - `graph.invoke` 的第二参：让 LangGraph 自己停止推进，abort 之后
     *    下一个节点不会执行（v1 的 `RunnableConfig.signal`，`test/graph-abort.test.ts` 覆盖）。
     *  - `configurable.signal`：图节点里的 streamer 要往下透传给 ACP，
     *    否则编排层不再等了而底层调用仍在运行。
     *
     * `token` 管副作用窗口：工具在 `withSideEffect` 里发出去的外部调用收不回来，
     * 取消落在那一段时 `cancel()` 返回 false，端点据此如实回 `sideEffectInFlight: true`。
     *
     * 注销与 `unregisterSink` 并列放在下面的 `finally`，否则
     * "取消当前轮"会命中一个已结束的 controller。
     */
    const abort = new AbortController();
    const cancelToken = new CancellationToken();
    const unregisterCancel = registerTurnCancel(
      input.sessionId,
      input.turnId,
      abort,
      cancelToken,
      this.now(),
    );

    /*
     * 结算上一轮的补录提问（§4.6）。
     *
     * # await 的是"抽取 + 把弹窗发出去"，不是"等用户点"
     *
     * 不 await 时，抽取那次 LLM 调用可能比回答慢，发出 permission 事件时流已关闭，
     * 用户看不到确认弹窗。
     *
     * 因此 await 到"弹窗已发出"为止（此时 `registerTurnSink` 已登记，
     * 事件走这一轮的流），等用户点的那一段不等待：权限门的确认超时是 10 分钟，
     * 补录不应卡住车主这一轮的回答。
     *
     * 代价：这一轮的回答看不到刚写进去的值，下一轮才看得到；多一次小抽取调用的延迟，
     * 只发生在上一轮问过的那一轮。
     */
    let elicitationContext: string | undefined;
    if (this.elicitation && input.userId) {
      try {
        elicitationContext = await this.elicitation.settle(
          input.sessionId,
          threadId,
          input.userId,
          input.content,
        );
      } catch (err) {
        // fail-open：补录挂了不该让这一轮问答失败。
        console.error(
          `[elicitation] 结算失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 照片与视频各走各的通道：照片进观察层，视频进【视频】段；
    // 字节不进 `messages`（那是跨轮检查点），当前轮的用户消息只留一句附件备注。
    const photos = (input.attachments ?? []).filter(isPhotoInput);
    const video = (input.attachments ?? []).find(isVideoInput);
    const note = attachmentNote(photos.length, video);
    /*
     * 同会话里带照片的那一轮还在跑时，紧跟着的纯文字追问先等它收口。
     * 等完再 invoke，读到的检查点里才有那一轮的消息与照片观察；观察节点随后把它沿用下来
     * （`graph/vision.ts`）。只等带照片的轮、且封顶，理由在 `photo-turns.ts` 文件头。
     */
    if (photos.length > 0) {
      endPhotoTurn = this.photoTurns.begin(input.sessionId, input.turnId);
    } else {
      const waitStartedAt = this.now();
      const w = await this.photoTurns.waitFor(input.sessionId);
      if (w.waited) {
        this.span(input.sessionId, input.turnId, "turn.wait_photo_turn", waitStartedAt, w.timedOut ? "failed" : "ok", `等 ${w.turnId} · ${w.ms} ms${w.timedOut ? " · 到上限未收口，照常开跑" : ""}`);
      }
    }
    void this.graph
      .invoke(
        {
          photoInput: photos.length ? photos : undefined,
          videoInput: video,
          messages: [
            { role: "user" as const, content: input.content, ...(note ? { attachmentNote: note } : {}) },
            /*
             * 能源缺口的测算结果。与"编排层已完成的求解结果"同一条路：
             * 求解在代码里做完，模型只表述（F-13-02）。
             * 缺口算不出来时这里什么都不追加，模型看不到它就编不出来。
             */
            ...(elicitationContext
              ? [{ role: "user" as const, content: elicitationContext }]
              : []),
          ],
        },
        {
          /*
           * 取消。`test/graph-abort.test.ts` 断言 abort 之后下一个节点不执行。
           * 放在 config 顶层而不是 configurable：`RunnableConfig.signal` 是框架识别的字段，
           * configurable 里的那份是给节点代码读的（见下）。
           */
          signal: abort.signal,
          configurable: {
            thread_id: threadId,
            userId: input.userId,
            // 这一轮的上下文。undefined = 装载层关着，各节点走不带上下文的路径。
            ...(turnContext ? { turnContext } : {}),
            /*
             * 同一个 signal 的第二个去处：图节点调 streamer 时往下透传给 ACP，
             * 否则上层取消后底层调用仍在运行。
             */
            signal: abort.signal,
            // 图里的意图/路由/分支/汇聚事件在此落库。fire-and-forget：
            // 轨迹是旁路，它坏了不该让对话坏（F-10-12 同源）。
            onTrace: (e: { kind: string; data: Record<string, unknown> }) => {
              try {
                this.onTrace?.({
                  sessionId: input.sessionId,
                  turnId: input.turnId,
                  kind: e.kind,
                  at: this.now(),
                  data: e.data,
                });
              } catch {
                /* 吞掉 */
              }
            },
            /*
             * 业务话术解析器。
             *
             * 图这一层需要在第一个 token 之前发出免责，而开关、DB 文案与
             * 长度校验都在 `GuardPipeline` 里，所以注入的是它的方法而不是一句文案。
             * 未装配 guards 时不挂话术（离线路径），不退化成硬编码文案，
             * 否则运营在控制台上关掉它不会生效。
             */
            resolveDisclaimer: this.guards
              ? (scenario: Parameters<GuardPipeline["resolveDisclaimer"]>[0]) =>
                  this.guards!.resolveDisclaimer(scenario)
              : undefined,
            /*
             * 事实补录询问（§4.6）。与上面同一形态：注入方法不是文案。
             *
             * 传的是闭包而不是槽位对象：槽位与冷却不进图状态
             * （§4.6 约束 4：拒答不构成新的信息，见 ChatGraphConfigurable 的说明）。
             * 未注入 ⇒ 不问，不是退化成硬编码提问。
             */
            resolveElicitation:
              this.elicitation && input.userId
                ? async (ctx: { agent?: string; answered: boolean; questionBudgetLeft?: number }) => {
                    /*
                     * 本轮的问题位已经被问诊追问用完：在 `pretripOf` 之前返回。
                     * `pretripOf` 会把这次行程记成「已经问过一次」（AC-54-1 的一次性），
                     * 位数为 0 时调用它会让出发前那一问静默丢失。
                     */
                    if (ctx.questionBudgetLeft !== undefined && ctx.questionBudgetLeft <= 0) return undefined;
                    // 没有 userId 就不问：体检必须带用户维度，防止跨用户混算。
                    return this.elicitation!.next({
                      sessionKey: input.sessionId,
                      userId: input.userId!,
                      vin: undefined,
                      agent: ctx.agent,
                      answered: ctx.answered,
                      /*
                       * 出发前上下文。用户这一轮的原话是判据之一：
                       * 他比日历更知道自己什么时候上路。里程也从这句话里取
                       * （"这趟 500 公里"），行程快照里没有里程字段。
                       */
                      pretrip: this.elicitation!.pretripOf
                        ? await this.elicitation!.pretripOf(input.userId!, input.content)
                        : undefined,
                      ...(ctx.questionBudgetLeft !== undefined ? { questionBudgetLeft: ctx.questionBudgetLeft } : {}),
                    });
                  }
                : undefined,
            emit: {
              /*
               * 输出侧脱敏在这里做，而不是等 turn_end（F-26-05）。
               *
               * §8.3 第 4 条"脱敏永远跑"在流式路径上也要成立：delta 是逐片推的，
               * 而 PII 可能横跨两片，逐片脱敏会漏，攒整段又没有流式。
               * `createStreamRedactor` 扣住"还可能长成模式"的尾巴，
               * 中文立刻发、只短暂扣住结尾正在输出的数字/字母串。
               *
               * 返回空串表示这一片全被扣住了，不发空 delta。
               */
              onDelta: (text: string) => {
                if (retracted) return; // 撤回后本轮闭嘴
                const out = redactor.push(text);
                tallyPii(out.redaction);
                if (out.text) push(events.delta(input.turnId, out.text));
                // 送审用脱敏后的文本：脱敏已经把号码变成掩码，
                // 送原文会在审核链路上多留一份明文
                const check = moderation
                  ?.push(out.text)
                  .then(async (verdict) => {
                    if (!verdict || retracted) return;
                    // 过一遍运营策略，保证关掉某维度在输入侧与输出侧同样生效
                    if (await this.guards!.judgeOutput(verdict)) return;
                    retracted = true;
                    push(events.retract(input.turnId, RETRACT_REPLACEMENT, RETRACT_REASON));
                    // 高风险语境保留：流中判拦即撤回，必落审计。
                    this.guardAuditor?.record({
                      sessionId: input.sessionId,
                      turnId: input.turnId,
                      layer: "output_moderation",
                      decision: "deny",
                      reason: "流式审核判拦，已撤回",
                      durationMs: this.now() - turnStartedAt,
                    });
                  })
                  .catch((err: unknown) => {
                    /*
                     * 撤回由 finish() 统一按 fail 模式处置，这里不重复撤回，
                     * 但要打日志带上原因：finish() 那句"审核不可用"不区分超时、限流
                     * 还是账号问题，也不说明失败了几片。
                     */
                    console.warn(
                      `[guardrails] output:stream 送审失败（turn=${input.turnId}）：${describeGuardError(err)}`,
                    );
                  });
                if (check) pendingChecks.push(check);
              },
              // 分支起止实时下发（F-13-07）：并行的那一分钟里端上要看得到进展。
              onBranch: (e: Parameters<typeof events.branch>[1]) =>
                push(events.branch(input.turnId, e)),
            },
            /*
             * 埋点补上会话上下文：session_id + turn_id + agent 一路传到 LLM 调用层
             * （F-36-07）。
             *
             * agent 取样本自报的那个，用量页才能按子 Agent 分账。
             * 样本给不出时回落 supervisor：主链路那一跳就是它。
             */
            onUsage: (sample: LlmUsageSample) =>
              this.onUsage?.({
                ...sample,
                sessionId: input.sessionId,
                turnId: input.turnId,
                agent: sample.agent ?? "supervisor",
              }),
          },
        },
      )
      .then(async () => {
        // 先等齐在途裁决链：它们里可能有一个刚判了"拦"
        await Promise.allSettled(pendingChecks);
        if (!retracted) {
          // 收尾必须 flush：扣在缓冲里的尾巴不吐出来，回答就缺最后一小段。
          const tail = redactor.flush();
          tallyPii(tail.redaction);
          if (tail.text) push(events.delta(input.turnId, tail.text));

          /*
           * 最后一片也要审。
           *
           * 前面按 120 字节奏送审，结尾那不足一片的残余只有 finish() 会送；
           * 不送则回答的最后一句不经审核，而结论往往在最后一句。
           * 审核不可用时按 output fail-closed 撤回（§8.2）：宁可不回复，
           * 也不放行未审核的输出。
           */
          try {
            const last = await moderation?.finish();
            if (last && !(await this.guards!.judgeOutput(last))) {
              retracted = true;
              push(events.retract(input.turnId, RETRACT_REPLACEMENT, RETRACT_REASON));
              this.guardAuditor?.record({
                sessionId: input.sessionId,
                turnId: input.turnId,
                layer: "output_moderation",
                decision: "deny",
                reason: "收尾审核判拦，已撤回",
                durationMs: this.now() - turnStartedAt,
              });
            }
          } catch (err: unknown) {
            retracted = true;
            const why = describeGuardError(err);
            /*
             * 撤回文案走"审核没跑成"那一句，不是 RETRACT_REPLACEMENT：
             * 一句让用户改说法，另一句让用户等一下。
             */
            push(events.retract(input.turnId, RETRACT_UNAVAILABLE_REPLACEMENT, RETRACT_UNAVAILABLE));
            console.warn(
              `[guardrails] output fail-closed 撤回（turn=${input.turnId}）：${why}`,
            );
            this.guardAuditor?.record({
              sessionId: input.sessionId,
              turnId: input.turnId,
              layer: "output_moderation",
              decision: "deny",
              // 原因带上真实异常，审计记录才能回答"为什么不可用"。
              reason: `审核不可用，按 fail-closed 撤回：${why}`,
              durationMs: this.now() - turnStartedAt,
            });
          }
        }
        // PII 命中：脱敏是放行 + 修改，不是拦截，decision 记 allow，
        // rule 记类别×次数（如 "phone×2,email×1"），不记原值。零命中不落。
        if (Object.keys(piiHits).length > 0) {
          this.guardAuditor?.record({
            sessionId: input.sessionId,
            turnId: input.turnId,
            layer: "output_pii",
            decision: "allow",
            rule: Object.entries(piiHits)
              .map(([k, n]) => `${k}×${n}`)
              .join(","),
            reason: "输出含个人信息，已脱敏后放行",
            durationMs: this.now() - turnStartedAt,
          });
        }
        // turn_end 永远在最后：端上按它收口，之后来的事件会被丢掉。
        // 本轮用到的数据来源随它下发，端上展示在正文之后、不进口播。
        push(events.turnEnd(input.turnId, assistantMessageId, peekAnswerSources(input.sessionId, input.turnId)));
      })
      .catch((err: unknown) => {
        /*
         * 被取消与真的跑挂了在这里都是 invoke reject，必须分开处理：取消是用户要的结果，
         * 当失败抛出去会让网关下发 `state: idle` 的错误兜底、大屏失败率把打断算成故障。
         *
         * 取消路径不 flush 脱敏器的尾巴：那段文字从没送到用户面前，也没过最后一片的审核。
         * AC-08-6 的"已产生内容不丢失"指的是已经推给用户的内容；补发未审核的尾巴
         * 违反 §8.2 的 output fail-closed。
         */
        if (cancelToken.isCancelled()) {
          cancelled = true;
          // turn_end 照发：网关按它落库（带 cancelled 标记）、端上按它收口。
          // 已说出的半句可能已经用到了天气，来源照带。
          push(events.turnEnd(input.turnId, assistantMessageId, peekAnswerSources(input.sessionId, input.turnId)));
          return;
        }
        failure = err ?? new Error("graph invoke failed");
      })
      .finally(() => {
        done = true;
        wake?.();
      });

    try {
      for (;;) {
        while (queue.length > 0) {
          const e = queue.shift()!;
          yield e;
          if (e.type === "update" && e.kind === "turn_end") return;
        }
        if (done) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }

      if (failure) throw failure;
    } finally {
      // 提前 return（turn_end）与异常都要走到这里，否则表会漏，
      // 下一轮的 permission 事件会被推给上一轮已经关掉的队列。
      unregisterSink();
      // 取消把手同理：否则"取消当前轮"会命中一个已结束的 controller。
      unregisterCancel();
      // 旁路同理：泄漏时上一轮的垫场话会在这一轮开头出现。
      closePair(input.turnId);
      // 分支提交暂存区同理：轮已结束，这一轮的提交与完成信号已无消费者。
      sweepTurn(input.sessionId, input.turnId);
      // poi_search 坐标登记簿同理：只服务本轮的片区缺口判定。
      sweepPoiCoords(input.sessionId, input.turnId);
      // 回复引用来源登记簿同理：turn_end 已带走，轮结束即弃。
      sweepAnswerSources(input.sessionId, input.turnId);
      // charging / refuel 候选站登记簿同理：只服务本轮 energyStops 的来源核对。
      sweepEnergyStopCandidates(input.sessionId, input.turnId);
      sweepEnergyConsumption(input.sessionId, input.turnId);
      // map_route 实算时长登记簿同理：只服务本轮各段之和的核对（ACR-047）。
      sweepRouteDurations(input.sessionId, input.turnId);
      /*
       * 轮次收口必须在 finally 里：提前 return（turn_end 事件）、图执行抛错、
       * 上游取消三条路都要走到，否则失败的那一轮在轨迹上一直显示"还在跑"。
       */
      // 带照片的轮收口：放行在等它的纯文字追问。必须在 finally，跑挂了、被打断了也要放行。
      endPhotoTurn?.();
      pointContext();
      this.point(input.sessionId, input.turnId, "turn_end", {
        // 三态而不是两态："被打断"和"跑挂了"在轨迹上分开，
        // 否则大屏的失败率会把每一次用户打断算成一次故障。
        outcome: cancelled ? "cancelled" : failure ? "failed" : "ok",
        // TTS 成本估算的计费量（配置 TTS_PRICE_PER_10K_CHARS）。
        answerChars,
        fillerChars,
        // 正文有字就是一次整段合成；垫场话每句各一次。
        ttsRequests: fillerSegments + (answerChars - fillerChars > 0 ? 1 : 0),
      });
    }
  }

  /**
   * ①Working 只读查询。
   *
   * 三条硬约束：不触发图执行、不修改检查点、不延长生命周期，
   * 否则会改变硬过期语义。这里只读 thread 映射与检查点快照，
   * 不调用 `invoke`，也不刷新 `lastActiveMs`。
   *
   * `empty` 的两种成因（新会话 / 进程重启后丢失）在本进程内无法区分，
   * 由 gateway 结合 PG 的消息数补全。
   */
  /**
   * 购车候选与成本的只读快照（F-15-14）。
   *
   * 与 `workingState` 同一条路径：解析 thread → 读检查点 → 原样返回。
   * 不触发图执行、不改检查点：页面刷新不产生一轮对话。
   *
   * 没有 thread / 已过期 / 从没比过车，一律返回 `plan: null` 而不是报错：
   * "还没比过车"是常态不是异常，轮询端把它当异常会反复告警。
   */
  async buyingState(sessionId: string): Promise<{
    plan: unknown;
    cost: unknown;
    trim: unknown;
    loan: unknown;
    insurance: unknown;
  }> {
    const empty = { plan: null, cost: null, trim: null, loan: null, insurance: null };
    const info = await this.resolveThread(sessionId);
    if (!info || info.expiresAtMs <= this.now()) return empty;

    const snapshot = await this.graph.getState({
      configurable: { thread_id: info.threadId },
    });
    return {
      plan: snapshot.values?.buyingPlan ?? null,
      cost: snapshot.values?.costPlan ?? null,
      // 配置比较与金融两段也进页面，各自独立为 null：
      // 只比过配置没算过钱时，金融分区显示"还没算"，而不是整页变空。
      trim: snapshot.values?.trimPlan ?? null,
      loan: snapshot.values?.loanPlan ?? null,
      insurance: snapshot.values?.insurancePlan ?? null,
    };
  }

  /**
   * 拍照问诊报告只读查询：不触发图执行、不改检查点。
   * 「还没问过诊」是常态：`report: null`。线程过期也是 null（报告随线程 24h 轮换）。
   */
  async diagnosisState(sessionId: string): Promise<{ report: unknown }> {
    const info = await this.resolveThread(sessionId);
    if (!info || info.expiresAtMs <= this.now()) return { report: null };
    const snapshot = await this.graph.getState({ configurable: { thread_id: info.threadId } });
    return { report: snapshot.values?.diagnosis ?? null };
  }

  /**
   * 会话里这份行程（草案或刚确认的）只读查询（ACR-062）：不触发图执行、不改检查点。
   *
   * 已确认行程另有 `GET /v1/trip-plan/current`（读库）；草案只在图状态 `tripPlan` 通道里，
   * 单机版桌面界面的行程面板要在「定下来」之前就能画出逐天安排与地图。形状就是 `TripPlanSnapshot`
   * （加 `committedPlanId` 等会话内字段），不另起一份。还没排过行程或线程过期：`plan: null`。
   */
  async tripDraftState(sessionId: string, userId?: string): Promise<{ plan: unknown }> {
    // 缺省的 `tasks` 档（ACR-036 §4.9）下行程不再写进图状态，而在 `working_tasks` 里按 人 × 种类 存一份：
    // 同一个人各会话共用当前这件行程。`off` / `inject` 两档照旧读图状态。
    if (contextLayerMode() === "tasks") {
      const reader = this.contextDeps?.taskReader;
      if (!userId || !reader) return { plan: null };
      const tasks = await reader.loadActive(userId, this.now());
      return { plan: tasks.find((t) => t.kind === "trip")?.draft ?? null };
    }
    const info = await this.resolveThread(sessionId);
    if (!info || info.expiresAtMs <= this.now()) return { plan: null };
    const snapshot = await this.graph.getState({ configurable: { thread_id: info.threadId } });
    return { plan: snapshot.values?.tripPlan ?? null };
  }

  async workingState(sessionId: string): Promise<{
    status: "active" | "expired" | "empty";
    threadId: string | null;
    lastActiveMs: number | null;
    turnCount: number;
    messages: Array<{ role: string; content: string }>;
  }> {
    // 与 threadFor 走同一条解析路径：有持久化存储时以它为准。
    // 两处各自解析时，写入侧改动未同步到读取侧会静默退化成 empty。
    const info = await this.resolveThread(sessionId);
    if (!info) {
      return { status: "empty", threadId: null, lastActiveMs: null, turnCount: 0, messages: [] };
    }
    if (info.expiresAtMs <= this.now()) {
      return {
        status: "expired",
        threadId: info.threadId,
        lastActiveMs: info.lastActiveMs,
        turnCount: 0,
        messages: [],
      };
    }

    const snapshot = await this.graph.getState({
      configurable: { thread_id: info.threadId },
    });
    const messages = (snapshot.values?.messages ?? []) as Array<{
      role: string;
      content: string;
    }>;

    return {
      status: "active",
      threadId: info.threadId,
      lastActiveMs: info.lastActiveMs,
      turnCount: messages.filter((m) => m.role === "user").length,
      messages,
    };
  }
}
