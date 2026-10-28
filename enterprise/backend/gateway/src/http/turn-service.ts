/**
 * 轮次编排。
 *
 * 职责（协议转换与治理，§3，不含业务逻辑）：
 *  1. 受理消息（文本 / 音频→ASR）；
 *  2. 用户消息在事件产生时写权威历史（PG，F-03-10，不依赖端上确认）；
 *  3. 调 runtime 内部 turn 接口（NDJSON），事件经 SessionBus 封套下发 SSE；
 *  4. 累积 delta，`turn_end` 时写助手消息。
 *
 * runtime 异常时下发 `update/state: idle` 让端上状态机解卡。
 * TODO(契约变更)：契约暂无结构化错误事件（FL-08 F-08-10），
 * 契约补 `error` 事件类型后替换此兜底。
 */

import { randomUUID } from "node:crypto";

import type { AttachmentRef, ChatMessage, MessageSource, SessionEvent } from "@cabinhug/shared";
import type { ChatRepository } from "@cabinhug/db";
import type { SessionsChangedReason } from "@cabinhug/shared";
import type { SessionBus } from "../stream/session-bus";
import { normalizeImageForModel } from "@cabinhug/tools";
import type { RuntimeVideoAttachment, VideoDeriver } from "../media/derive";
import type { ClientDetectionsPayload, TurnAttachmentPayload } from "./attachments";

/**
 * 必须惰性读，不能写成模块级 `const`。
 *
 * ESM 的 import 是提升的：入口 `index.ts` 里 `loadRootEnv()` 那一行虽然写在最前面，
 * 也要等所有 import 求值完才执行，本模块的模块级代码跑在它之前，
 * 那时 `.env` 还没进 `process.env`。
 *
 * 违反时同一进程里 `createGatewayApp()` 读到的是 `.env` 的值，这里读到的却是默认端口：
 * 大屏显示"ACP 已连接"而每一轮对话都 ECONNREFUSED，端上只看到状态回到 idle，没有报错。
 *
 * 不变量由 `check:arch` 的 `env-timing` 守着。
 */
/** 本轮绑定的附件（图片与视频）：网关取件后的原件，由 `prepareAttachments` 决定怎么转发。 */
export type TurnAttachment = TurnAttachmentPayload;

/** 转发 runtime 的附件形状（与 agent-runtime `server.ts` 的校验一一对应）。 */
export type RuntimeTurnAttachment = { kind: "image"; handle: string; contentType: string; bytesBase64: string; detections?: ClientDetectionsPayload } | RuntimeVideoAttachment;

export function runtimeUrl(): string {
  return process.env.AGENT_RUNTIME_URL ?? "http://localhost:8788";
}

export interface AcceptedTurn {
  turnId: string;
  /**
   * 车主这句话落库后的 messageId。
   *
   * 路由层用它把刚上传的那段录音挂到这条消息上。由这里给出而不是在
   * 路由里按 `msg-${turnId}-u` 拼：id 的构造只存在一处，拼错时音频索引
   * 会指向一条不存在的消息，而外键在 upsert 那一刻才报错。
   */
  userMessageId: string;
}

/** 打断一轮的结果。字段语义与 runtime 端点一一对应。 */
export interface CancelledTurn {
  cancelled: boolean;
  /** 实际被掐掉的轮；此刻没有在跑的轮时为 null（不是错误，见路由处注释）。 */
  turnId: string | null;
  /** 取消落在副作用窗口内 = 动作已经发出去了，收不回来（F-14-05）。 */
  sideEffectInFlight: boolean;
}

export class TurnService {
  constructor(
    private repo: ChatRepository,
    private bus: SessionBus,
    /**
     * HITL 中转。permission 事件从 runtime 的 turn 流里过来，
     * 在这里登记进 relay；不登记时 resume 会得到 unknown_interrupt，
     * 用户点了确认却没有效果。
     */
    private hitl?: { onInterrupt(n: { sessionId: string; interruptId: string; action: string; title: string; details: Array<{ label: string; value: string }>; scope?: string; disclosure?: Array<{ label: string; value: string }> }): void },
    /**
     * 助手回复落库时当前下发给端上的 TTS 档位（仅控制台展示）。
     *
     * 语义是"下发档位"不是"实际播了什么"：合成在端上发生，服务端不知道
     * 那一句最终有没有出声（用户可能关了播报开关、也可能合成失败降级 say），
     * 而且端上按 refreshMs 缓存配置，最多有一个刷新周期的偏差。界面措辞必须
     * 遵守这个边界。不注入即不记。
     */
    private ttsEngineAtSend?: () => Promise<string | null>,
    /**
     * 视频派生：抽帧成帧序图 + 分段转写，产物随轮转发 runtime。
     * 不注入（ffmpeg 不可用）时视频照收照绑，只转发一份空产物并如实写 note，
     * 车主的视频不因服务端缺少一个二进制而消失。
     */
    private media?: VideoDeriver,
    /**
     * 账号级事件出口（ACR-031）：会话列表变化时发通知，同一个人的其它端据此重拉。
     *
     * 注入的是一个函数而不是 `UserBus`：这里只负责"说变了"，
     * "谁在听、怎么发"归通道。不注入即不发（既有测试构造 TurnService 时不传它）。
     *
     * 三处调用点都不 await、不进 try：这条通知与本轮的成败无关，
     * 不挡在落库与应答之间。
     */
    private onSessionsChanged?: (userId: string, reason: SessionsChangedReason, sessionId: string) => void,
  ) {}

  /**
   * 被打断的轮。
   *
   * 只影响两件事，都在 `handleLine` 的 `turn_end` 分支里：
   *  1. 助手那条消息带上 `cancelled: true`（照常落库，AC-08-6 要求
   *     "已产生内容不丢失"，用户已经听见的那半句不能消失）；
   *  2. 不给这段对话起名字（半句话不作标题，与 `retracted` 同一条理由）。
   *
   * 集合必须有界：`driveTurn` 的 `finally` 会清掉自己那条，但取消一个
   * 已经收口的轮时这里会留下一条永远等不到 `turn_end` 的记录，不清会一直积累。
   */
  private cancelledTurns = new Set<string>();

  /**
   * 打断这一轮。不裁决、不落库：网关只做协议转换（§3），
   * 真正掐掉执行的是 runtime 的取消令牌与 AbortController。
   */
  async cancel(sessionId: string, turnId?: string): Promise<CancelledTurn> {
    const res = await fetch(`${runtimeUrl()}/internal/session/${sessionId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnId }),
    });
    if (!res.ok) {
      /*
       * runtime 不可达也要给端上一个能用的答复。
       *
       * 端上此刻已经停了声音（那一步是同步的、本地的），
       * 这里再报错只会让界面弹一个用户无法处置的框，而他要的操作已经完成。
       * 服务端那一轮会自己按超时收敛。
       */
      console.error(`[gateway] cancel failed session=${sessionId} status=${res.status}`);
      return { cancelled: true, turnId: null, sideEffectInFlight: false };
    }
    const outcome = (await res.json()) as CancelledTurn;
    if (outcome.turnId) {
      this.cancelledTurns.add(outcome.turnId);
      // 上限兜底：取消一个已收口的轮会留下永远等不到 turn_end 的记录。
      if (this.cancelledTurns.size > 64) {
        const oldest = this.cancelledTurns.values().next().value;
        if (oldest) this.cancelledTurns.delete(oldest);
      }
    }
    return outcome;
  }

  /** 受理一轮：落用户消息、异步驱动 runtime。立即返回 turnId（202 语义）。 */
  async accept(
    sessionId: string,
    content: string,
    source: MessageSource,
    userId?: string,
    /**
     * 端上的闲聊旁路开关。缺省不传给 runtime，而不是传 `true`：
     * `TurnInput.fillerEnabled ?? true` 已经定了缺省语义，默认值只保留一处。
     */
    fillerEnabled?: boolean,
    /**
     * 这条语音消息由哪个 ASR 档转写（仅运营控制台展示）。
     * 由路由层从闸门实际给的 provider 上取，不在这里问配置：
     * 闸门超限降级时两者不同。
     */
    asrEngine?: string | null,
    /** 本轮绑定的图片：随消息转发 runtime，不落 messages 表。 */
    attachments?: TurnAttachment[],
  ): Promise<AcceptedTurn> {
    const turnId = `turn-${randomUUID().slice(0, 8)}`;

    const userMessage: ChatMessage = {
      messageId: `msg-${turnId}-u`,
      sessionId,
      turnId,
      role: "user",
      source,
      content,
      ts: Date.now(),
    };
    await this.repo.appendMessage(userMessage, { asrEngine: asrEngine ?? null });
    // 列表的排序键是 updatedAt，一条消息落库就变了（ACR-031）。
    if (userId) this.onSessionsChanged?.(userId, "message", sessionId);

    // 不阻塞受理响应；事件经 SSE 下行。
    void this.driveTurn(sessionId, turnId, content, source, userId, fillerEnabled, attachments).catch((err) => {
      console.error(`[gateway] turn drive failed session=${sessionId} turn=${turnId}`, err);
      this.bus.append(sessionId, { type: "update", kind: "state", state: "idle" });
    });

    return { turnId, userMessageId: userMessage.messageId };
  }

  /**
   * 给这段对话起个名字。
   *
   * # 三条边界
   *
   * 1. 网关不调 LLM（§3 红线）。生成在 runtime 的旁路端点里，这里只发一次内部
   *    HTTP、把结果落库、再推一条 SSE。提示词不在网关另存一份。
   * 2. 一个会话只起一次。先问库里有没有，`sessionTitle` 返回非 null 就直接返回，
   *    不发 LLM 调用；真正的幂等仍由 `setSessionTitle` 的条件更新兜底
   *    （两轮挨得近时两次判定会并发跨过同一次调用）。
   * 3. 全程静默失败。标题起不出来不影响车主收到的内容；
   *    列表里那条会话继续显示时间，下次进页面还有机会补上。
   *
   * 先查再调、而不是直接调完让 DB 去挡：LLM 调用计费，
   * 只靠条件更新兜底时每一轮都会多一次调用。
   */
  private async maybeTitle(
    sessionId: string,
    turnId: string,
    userText: string,
    assistantText: string,
    /** 只为 ACR-031 那条通知；起名字本身不需要知道是谁。 */
    userId?: string,
  ): Promise<void> {
    try {
      const existing = await this.repo.sessionTitle(sessionId);
      // undefined = 会话不存在（自检/竞态）；非 null = 已经有名字了。
      if (existing !== null) return;

      const r = await fetch(`${runtimeUrl()}/internal/session/${sessionId}/title`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ turnId, userText, assistantText }),
      });
      if (!r.ok) return;
      const title = ((await r.json()) as { title?: string | null }).title;
      if (typeof title !== "string" || title.trim().length === 0) return;

      // 写进去了才推事件。没写进去说明别处先写了，再推一条会让端上
      // 刚显示的名字被覆盖，表现为标题自己在变。
      if (await this.repo.setSessionTitle(sessionId, title)) {
        this.bus.append(sessionId, { type: "update", kind: "title", title });
        // 列表上显示的就是这个名字，别处的端要跟着换（ACR-031）。
        if (userId) this.onSessionsChanged?.(userId, "title", sessionId);
      }
    } catch (err) {
      // 起名字失败不进错误告警，但留一行日志，
      // 否则"列表里全是没名字的会话"无从排查。
      console.warn(`[gateway] 会话标题生成失败 session=${sessionId}`, err);
    }
  }

  private async driveTurn(
    sessionId: string,
    turnId: string,
    content: string,
    source: MessageSource,
    userId?: string,
    fillerEnabled?: boolean,
    attachments?: TurnAttachment[],
  ): Promise<void> {
    /*
     * 带附件的轮：受理回执由网关先发，不等 runtime。
     *
     * 视频派生要几秒（抽帧 + 六段转写），车主的气泡与缩略图要当场出现
     * （`attachments` 引用此刻已齐，不依赖派生结果）。
     * runtime 稍后发来的同一轮 `prompt` 事件在 `handleLine` 里丢弃，避免端上收到两条。
     */
    const refs = attachmentRefs(attachments ?? []);
    if (refs.length > 0) {
      this.bus.append(sessionId, { type: "prompt", turnId, source, transcript: content, attachments: refs });
    }
    const runtimeAttachments = await this.prepareAttachments(sessionId, turnId, attachments ?? []);

    const res = await fetch(`${runtimeUrl()}/internal/session/${sessionId}/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // userId 一路带下去：⑥用车数据与 Mem0 的读写都必须带用户维度。
      // fillerEnabled 只在端上明确表过态时才带上去（见 accept 的参数注释）。
      body: JSON.stringify({
        turnId,
        content,
        source,
        userId,
        ...(fillerEnabled === undefined ? {} : { fillerEnabled }),
        // 照片原样转发（进观察层与表述模型，ACR-027）；视频转发的是派生产物，不是原件。
        ...(runtimeAttachments.length ? { attachments: runtimeAttachments } : {}),
      }),
    });
    if (!res.ok || res.body === null) {
      throw new Error(`runtime_unavailable status=${res.status}`);
    }

    let assistantText = "";
    let buffered = "";
    let retracted = false;

    const handleLine = async (line: string): Promise<void> => {
      if (line.trim().length === 0) return;
      const parsed = JSON.parse(line) as SessionEvent | { internalError: string };
      if ("internalError" in parsed) {
        throw new Error(parsed.internalError);
      }
      const event = parsed;

      if (event.type === "update" && event.kind === "delta") {
        assistantText += event.text;
      }

      // 权限确认由 relay 独占下发（`HitlRelay.onInterrupt` 内部会 emit）：
      // 这里不能再 append 一次，否则端上收到两条相同的 permission、弹两次确认框。
      // 登记与下发必须是同一个动作。
      if (event.type === "permission") {
        const p = event as unknown as {
          interruptId: string;
          action: string;
          title: string;
          details: Array<{ label: string; value: string }>;
          scope?: string | null;
          disclosure?: Array<{ label: string; value: string }>;
        };
        this.hitl?.onInterrupt({
          sessionId,
          interruptId: p.interruptId,
          action: p.action,
          title: p.title,
          details: p.details,
          scope: p.scope ?? undefined,
          // 外发个人信息原样透传：网关只做协议转换，任何加工都会让
          // "弹窗上显示的"与"实际发出去的"不一致。
          disclosure: p.disclosure,
        });
        return;
      }

      // 带附件的轮已在派生前发过受理回执（见 driveTurn 开头），runtime 这条不再下发。
      if (event.type === "prompt" && refs.length > 0) return;

      this.bus.append(sessionId, event);

      if (event.type === "update" && event.kind === "retract") {
        // 标题只看真正说出口的话。撤回意味着这一轮的输出被内容审核拦下，
        // 拿它起名字等于把被拦的内容搬到列表上。
        // 这里只影响标题判定，不改历史落库的既有行为。
        retracted = true;
      }

      if (event.type === "update" && event.kind === "turn_end") {
        const cancelled = this.cancelledTurns.has(turnId);
        /*
         * 被打断的一轮：照常落库，只是标出来。
         *
         * AC-08-6 要求"已产生内容不丢失"。删掉它会让用户刚听见的半句在刷新之后消失，
         * 比保留一条标了"已中断"的半句更难解释。
         *
         * 一个字都没吐就被取消时不落库：空消息只是噪声
         * （与 `fanout.rs` 里"累积为空就只回 Idle"同一条判据）。
         */
        if (!cancelled || assistantText.length > 0) {
          // 档位查询失败不挡消息落库，它只是个标注。
          const ttsEngine = await this.ttsEngineAtSend?.().catch(() => null);
          await this.repo.appendMessage(
            {
              messageId: event.messageId,
              sessionId,
              turnId,
              role: "assistant",
              source: "text",
              content: assistantText,
              ts: Date.now(),
              ...(cancelled ? { cancelled: true } : {}),
              // 引用来源随消息落库，回源读历史时署名还在。被撤回的回复不再展示原数据，来源不落。
              ...(!retracted && event.sources?.length ? { sources: event.sources } : {}),
            },
            { ttsEngine: ttsEngine ?? null },
          );
          // 助手那条也变了列表的 updatedAt（ACR-031）。
          if (userId) this.onSessionsChanged?.(userId, "message", sessionId);
        }
        // 标题旁路。放在最后且不 await：它与这一轮的成败无关，
        // 否则每一轮都要多等一次 LLM 调用才收口。
        // 被打断的一轮同样跳过：半句话不作标题（同 `retracted`）。
        if (!retracted && !cancelled && assistantText.trim().length > 0) {
          void this.maybeTitle(sessionId, turnId, content, assistantText, userId);
        }
      }
    };

    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffered += Buffer.from(chunk).toString("utf8");
        let newlineAt: number;
        while ((newlineAt = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, newlineAt);
          buffered = buffered.slice(newlineAt + 1);
          await handleLine(line);
        }
      }
      if (buffered.trim().length > 0) await handleLine(buffered);
    } finally {
      // 这一轮的取消记录用完就丢，避免集合无限增长。
      this.cancelledTurns.delete(turnId);
    }
  }

  /**
   * 把本轮附件变成 runtime 能处理的形状：照片原样；视频派生成帧序图 + 转写。
   *
   * 派生期间给端上发一条 `tool_call`（F-08-05 的人话进展），避免几秒的空白被当成没反应。
   * 派生失败不抛：转发一份空产物并写 note，让模型如实说"这次没看成视频"。
   */
  private async prepareAttachments(sessionId: string, turnId: string, attachments: TurnAttachment[]): Promise<RuntimeTurnAttachment[]> {
    const out: RuntimeTurnAttachment[] = [];
    for (const a of attachments) {
      if (a.kind === "image") {
        /*
         * 照片先归一化：HEIC / BMP / TIFF 这些视觉模型读不了的格式转成 JPEG，
         * 单边超 4096 的缩一下，EXIF 里躺倒的摆正。只在必须时才动字节：
         * 观察层对小图标的分辨率是调过的，无谓重编码会降低认灯效果。
         * 转不动不抛：原样转发，由运行时那道过滤把模型读不了的挡在模型之外。
         */
        const norm = await normalizeImageForModel(Buffer.from(a.bytesBase64, "base64"), a.contentType);
        if (norm.note) console.log(`[gateway] 照片归一化 handle=${a.handle} ${norm.note}`);
        out.push({
          kind: "image",
          handle: a.handle,
          contentType: norm.contentType,
          bytesBase64: norm.changed ? norm.bytes.toString("base64") : a.bytesBase64,
          // 端上的框（ACR-045）原样透传：它已经是转正后的归一化坐标，归一化照片（摆正 / 缩边）不改变归一化框
          ...(a.detections ? { detections: a.detections } : {}),
        });
        continue;
      }
      const toolCallId = `video-${turnId}-${a.handle.slice(0, 8)}`;
      this.bus.append(sessionId, { type: "tool_call", toolCallId, toolName: "video_derive", displayName: "正在看视频（抽帧、听声音）", status: "started" });
      let derived: RuntimeVideoAttachment;
      if (!this.media) {
        derived = emptyVideo(a, "服务端没接视频解析（ffmpeg 不可用），本次没有看视频");
      } else {
        try {
          derived = await this.media(a, { sessionId, turnId });
        } catch (err) {
          console.error(`[gateway] 视频派生失败 session=${sessionId} turn=${turnId} handle=${a.handle}`, err);
          derived = emptyVideo(a, `视频解析失败（${err instanceof Error ? err.message : String(err)}），本次没有看视频`);
        }
      }
      const ok = derived.sheets.length > 0 || derived.transcript.length > 0;
      this.bus.append(sessionId, {
        type: "tool_call",
        toolCallId,
        toolName: "video_derive",
        displayName: ok
          ? `看完了视频（${derived.sheets.length} 张帧序图${derived.transcript.length ? `、${derived.transcript.length} 段声音转写` : ""}${derived.truncated ? "，只看了前 1 分钟" : ""}）`
          : "视频没能解析",
        status: ok ? "succeeded" : "failed",
      });
      out.push(derived);
    }
    return out;
  }
}

/** 受理回执与历史里的附件引用：只有元数据，没有字节。 */
export function attachmentRefs(attachments: readonly TurnAttachment[]): AttachmentRef[] {
  return attachments.map((a) => ({
    attachmentId: a.handle,
    kind: a.kind,
    handle: a.handle,
    contentType: a.contentType,
    bytes: a.bytes,
    ...(a.filename ? { filename: a.filename } : {}),
  }));
}

function emptyVideo(a: TurnAttachment, note: string): RuntimeVideoAttachment {
  return {
    kind: "video",
    handle: a.handle,
    contentType: a.contentType,
    durationMs: 0,
    analyzedMs: 0,
    truncated: false,
    sheets: [],
    transcript: [],
    transcriptStatus: "unavailable",
    notes: [note],
    timings: { probeMs: 0, framesMs: 0, sheetsMs: 0, audioMs: 0, asrMs: 0, totalMs: 0 },
  };
}
