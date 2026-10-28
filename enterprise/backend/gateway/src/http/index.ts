/**
 * http：REST 路由。
 *
 * POST /v1/session                → 建会话（session 事件入总线）
 * POST /v1/session/:id/messages   → 受理消息：
 *      application/json {content}                     → 文本
 *      audio/*（raw body）+ X-Audio-Meta（AudioMeta JSON）→ 转存 → ASR → 文本
 * GET  /v1/session/:id/messages   → 权威历史分页（F-03-10）
 *
 * 音频上行采用 raw body + `X-Audio-Meta` 头而非 multipart，免去 Rust 侧与网关
 * 双方的 multipart 编解码，语义等价。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { Router, json, raw } from "express";
import type { Response } from "express";

import type { AudioMeta, MessageSource, SessionsChangedReason } from "@cabinhug/shared";
import { MAX_CAPTURE_DURATION_MS, SESSION_EXPIRED, DEFAULT_SESSION_IDLE_MIN } from "@cabinhug/shared";
import type { ChatRepository } from "@cabinhug/db";

import type { AuthedRequest } from "../auth";
import { wrapPcmAsWav, type AsrProvider, type AsrUsage } from "../asr";
import type { SessionBus } from "../stream/session-bus";
import { HitlRelay } from "../hitl";
import { runtimeUrl } from "./turn-service";
import type { AttachmentRepository } from "@cabinhug/db";
import type { ObjectStore } from "../upload/storage";
import { type ClientDetectionsPayload, parseAttachmentRefs, resolveTurnAttachments, type TurnAttachmentPayload } from "./attachments";
import { photoOffBody, voiceOffBody } from "./capabilities";
import { accountEventsEnabled } from "../stream";
import type { UserBus } from "../stream/user-bus";
import { TurnService } from "./turn-service";
import { createVideoDeriver } from "../media/derive";
import type { FfmpegPaths } from "@cabinhug/tools";

const AUDIO_DIR = join(tmpdir(), "cabinhug-uploads");

/**
 * 自检会话的前缀（F-43-10：自检数据可识别、可清理）。
 *
 * 与 `scripts/dev/check/selfcheck.ts` 的 `SELFCHECK_PREFIX` 必须一致。
 * 不从那边 import：网关不该依赖运维脚本，那是反向依赖。
 */
const SELFCHECK_PREFIX = "selfcheck-";
const SELFCHECK_HEADER = "x-cabinhug-selfcheck";

/**
 * 会话 id 前缀。
 *
 * 分层自检每跑一次就在 `sessions` 里留一条与真实会话形态相同的记录，
 * 前缀使它在清场时可识别。
 *
 * 只认这一个头，且只加前缀、不改其它任何行为：它不是权限开关。
 * 冒用它的代价仅仅是自己的会话被标成自检数据（在清理时会被一起删掉），
 * 拿不到任何额外能力，所以不需要额外鉴权（这条路本来就在 demoAuth 后面）。
 */
function sessionPrefix(req: AuthedRequest): string {
  return req.header(SELFCHECK_HEADER) === "1" ? `${SELFCHECK_PREFIX}sess-` : "sess-";
}

function parseAudioMeta(header: string | undefined): AudioMeta | null {
  if (!header) return null;
  try {
    const meta = JSON.parse(header) as AudioMeta;
    if (
      typeof meta.durationMs !== "number" ||
      typeof meta.format !== "string" ||
      typeof meta.sampleRateHz !== "number" ||
      typeof meta.channels !== "number"
    ) {
      return null;
    }
    return meta;
  } catch {
    return null;
  }
}

/**
 * 会话空闲多久算结束。
 *
 * 在调用时读 `process.env`，不在模块级：`check:arch` 的 env-timing 不变量
 * 禁止服务的非入口模块在模块级读环境变量（与 `runtimeUrl()` 同形）。
 *
 * 非法值（负数 / 非数字）回落默认值：阈值为 0 会让每一条消息都被判过期，
 * 整个对话功能停摆。
 */
export function sessionIdleMs(): number {
  const raw = Number(process.env.CABINHUG_SESSION_IDLE_MIN);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SESSION_IDLE_MIN;
  return minutes * 60 * 1000;
}

/**
 * 这个会话还能不能接着说。
 *
 * 三种回答：`ok` / `not_found` / `expired`。判定与关闭放在一起：
 * 判出过期就标记关闭（懒关闭：没有 cron，过期在下一次访问时落定）。
 * 分开写会出现"被判过期但库里仍是 null"的中间态，运营页上看不出这个会话已经结束。
 */
async function checkSessionUsable(
  repo: ChatRepository,
  sessionId: string,
  now: number,
): Promise<"ok" | "not_found" | "expired"> {
  const state = await repo.sessionState(sessionId);
  if (!state.exists) return "not_found";
  if (state.closedAt) return "expired";
  const last = state.lastActiveAt?.getTime() ?? now;
  // 严格大于：正好卡在阈值上算没过期。
  if (now - last > sessionIdleMs()) {
    await repo.closeSession(sessionId, new Date(now));
    return "expired";
  }
  return "ok";
}

/**
 * 转写前的日用量闸门（ACR-016）。
 *
 * 返回本次该用的 provider 与它的档位名：没超限给云端那个，超限了装配层会
 * 给一个免费的本地 provider；返回 `null` 表示超限且连免费兜底都没有，调用方明确失败。
 *
 * `engine` 必须跟着 provider 一起回，不能让调用方另去问配置：闸门超限降级时
 * 实际用的是 mock，而配置里写的还是 aliyun，只问配置会让会话详情里的标签
 * 错报成一笔没花的钱。
 *
 * 闸门返回 provider 而不是布尔：降级目标是装配层的知识（它知道
 * 本地档配没配、URL 是什么），路由层只负责"拿谁转写"。返回布尔时，
 * "超限了该用谁"会散进两个路由各写一遍。
 *
 * 不注入 = 不设闸。
 */
export type AsrGate = () => Promise<{ provider: AsrProvider; engine: string } | null>;

/** 上车声明校验所需的最小依赖。 */
export interface BoardingDeps {
  /** 这辆车的车主 id；没有这辆车时 null。 */
  ownerOf(vin: string): Promise<string | null>;
  /** 这辆车当前生效的授权成员 id。 */
  activeMemberIds(vin: string): Promise<string[]>;
}

export function createHttpRouter(
  repo: ChatRepository,
  bus: SessionBus,
  asr: AsrProvider,
  /**
   * ASR 用量出口（成本口径）：云 ASR 按 token/时长计费，识别也是钱。
   * 计价在装配层（它有配置与用量仓储），这里只如实转交。缺省不记。
   *
   * `source` 区分两个入口，是成本归因的唯一依据（§13 待确认 22 要求
   * "用量按端可拆解"）：哨兵段与对话轮次的量级差一个数量级，混在一起记
   * 无法区分成本去向。哨兵段不建轮（AC-52-5），所以那一路没有
   * sessionId/turnId，由装配层填常量占位，不编 id。
   */
  onAsrUsage?: (sample: {
    source: "turn" | "sentinel";
    sessionId?: string;
    turnId?: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
  }) => void,
  /**
   * 上车声明的成员集合校验（F-56-05）。
   *
   * 可选注入：不注入时车辆级 token 建不了会话。
   * 注入了才打开"车机声明 activeUserId"这条路；注入与否都不会让某个人
   * 被默认成"正在用车的人"。
   */
  boarding?: BoardingDeps,
  /** 日用量闸门（ACR-016）。不注入即不设闸。 */
  asrGate?: AsrGate,
  /**
   * 助手回复落库时当前下发的 TTS 档位（仅控制台展示）。
   * 语义边界见 `TurnService` 构造参数上的注释：是"下发档位"不是"实际播了什么"。
   */
  ttsEngineAtSend?: () => Promise<string | null>,
  /**
   * 车主录音的转存（可选注入）。只在建轮那条路上调：
   * 哨兵段不建轮也就没有 messageId 可挂，这条边界由结构保证（AC-52-5）。
   *
   * 不注入（对象存储未接）时回落到本地落盘，见调用处。
   */
  saveVoiceAudio?: (a: {
    sessionId: string;
    messageId: string;
    engine: string;
    bytes: Buffer;
    mime: string;
  }) => Promise<void>,
  /**
   * 附件绑定（F-09-06）：`/messages` 请求体里的句柄要校验归属、取件、绑到本轮。
   * 未接对象存储时不传：带句柄的消息会得到 404 `attachments_unavailable`，不是静默丢弃。
   */
  attachments?: {
    repo: AttachmentRepository;
    store: ObjectStore;
    /** 拍照问诊是否关闭（ACR-056）。关闭时带附件的消息整条 403，不静默丢掉照片后照常作答。 */
    photoOff?: () => Promise<boolean>;
  },
  /**
   * 视频派生（ACR-027）：ffmpeg 可用时注入路径；不注入则视频照收照绑、只是不解析。
   * 转写走与语音分支同一个 ASR provider 与同一道日用量闸门（视频的声音同样计费）。
   */
  media?: { ffmpeg: FfmpegPaths },
  /**
   * 账号级事件通道（ACR-031）。不注入即不发，既有测试构造这个路由时不传它。
   */
  userBus?: UserBus,
  /** 语音是否关闭（ACR-059）。关闭时语音消息与 `/v1/asr/transcribe` 回 403，不转写、不转存。不注入 = 不关。 */
  voiceOff?: () => Promise<boolean>,
): Router {
  const router = Router();
  // HITL 中转。不接入时权限门挂起后用户收不到确认弹窗，表现为助手不再回复。
  const hitl = new HitlRelay({
    emit: (sessionId, event) => bus.append(sessionId, event),
    forwardResume: async ({ interruptId, approved }) => {
      const r = await fetch(`${runtimeUrl()}/internal/guard/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ interruptId, approved }),
      });
      if (!r.ok) return false;
      return ((await r.json()) as { resumed?: boolean }).resumed === true;
    },
  });
  /**
   * 会话列表变化时发通知（ACR-031）。
   *
   * 开关在每次调用时判断而不是构造时：置 `false` 后无需重建路由即停止发送，
   * 可作为不发版的回滚手段。
   */
  const notifySessionsChanged = userBus
    ? (userId: string, reason: SessionsChangedReason, sessionId: string): void => {
        if (!accountEventsEnabled()) return;
        userBus.publish(userId, { kind: "sessions_changed", reason, sessionId });
      }
    : undefined;
  const turns = new TurnService(
    repo,
    bus,
    hitl,
    ttsEngineAtSend,
    media ? createVideoDeriver({ paths: media.ffmpeg, asr, asrGate, onAsrUsage: (u) => onAsrUsage?.(u) }) : undefined,
    notifySessionsChanged,
  );
  mkdirSync(AUDIO_DIR, { recursive: true });

  router.post("/v1/session", json(), async (req: AuthedRequest, res: Response) => {
    /*
     * 谁在用这个会话（F-56-05）。
     *
     * 人的 token：恒是本人。请求体里的 activeUserId 一律忽略，
     * 允许一个已登录的人声明成另一个人就等于把整套隔离作废。
     *
     * 车辆级 token（车机）：必须显式声明，且只能声明成
     * 这辆车的生效成员，或 `null`（访客模式）。车机 token 不代表任何人
     * （设计裁决 R4），服务端也不替它猜，没声明就是 400。
     */
    let activeUserId: string | null;
    if (req.userId) {
      activeUserId = req.userId;
    } else if (req.vehicleVin && boarding) {
      const declared = (req.body ?? {}) as { activeUserId?: unknown };
      if (!("activeUserId" in declared)) {
        // 没带这个字段 ≠ 访客。访客要显式传 null，否则"忘了传"会被
        // 静默当成访客，而访客模式是要播报出来的降级。
        res.status(400).json({ error: "active_user_required" });
        return;
      }
      const claimed = declared.activeUserId;
      if (claimed === null) {
        activeUserId = null; // 访客模式
      } else if (typeof claimed !== "string" || !claimed) {
        res.status(400).json({ error: "invalid_active_user" });
        return;
      } else {
        const [owner, members] = await Promise.all([
          boarding.ownerOf(req.vehicleVin),
          boarding.activeMemberIds(req.vehicleVin),
        ]);
        const allowed = new Set([...(owner ? [owner] : []), ...members]);
        if (!allowed.has(claimed)) {
          // 400 而不是 403：这是参数非法（声明了一个不在名单里的人），
          // 不是权限不足：车机本身是合法的，只是这次声明不成立。
          res.status(400).json({ error: "invalid_active_user" });
          return;
        }
        activeUserId = claimed;
      }
    } else {
      res.status(400).json({ error: "active_user_required" });
      return;
    }

    const sessionId = `${sessionPrefix(req)}${randomUUID().slice(0, 12)}`;
    await repo.createSession(sessionId, activeUserId, req.deviceId ?? null);
    bus.append(sessionId, { type: "session", status: "created" });
    res.status(201).json({
      sessionId,
      /**
       * 访客模式回给端上，让它播报降级话术（AC-56-7），
       * 避免用户以为助手忘了他的偏好。
       */
      guest: activeUserId === null,
    });
  });

  router.post(
    "/v1/session/:id/messages",
    json({ type: "application/json" }),
    raw({ type: "audio/*", limit: "10mb" }),
    async (req: AuthedRequest, res: Response) => {
      const sessionId = String(req.params.id);
      /*
       * 会话有终点，服务端是权威。端上也有一份空闲计时器，
       * 但只驱动形象状态；正确性以这里为准，端上的缺陷不会让会话无限延长。
       */
      const usable = await checkSessionUsable(repo, sessionId, Date.now());
      if (usable === "not_found") {
        res.status(404).json({ error: "session_not_found" });
        return;
      }
      if (usable === "expired") {
        // 409 不是 404：端上两种都会去建新会话，
        // 但排障时能区分"过期了"与"id 传错了"。
        res.status(409).json({ error: SESSION_EXPIRED, sessionId });
        return;
      }

      let content: string;
      let source: MessageSource;
      let asrUsage: AsrUsage | undefined;
      /** 这条语音消息实际由哪个档转写（null = 文字消息或未过闸门）。 */
      let asrEngine: string | null = null;
      /** 待转存的原始录音。文字消息恒为 null。 */
      let pendingVoice: { bytes: Buffer; meta: AudioMeta } | null = null;
      /*
       * 闲聊旁路开关（F-45-08）。两条分支各取各的：
       * JSON 体读 `fillerEnabled`，音频体的 body 是 raw PCM，
       * 所以读 `X-Filler-Enabled` 头。
       *
       * `undefined` = 端上没表态 ⇒ 不传给 runtime，让它的 `?? true` 生效，
       * 不带这个字段的老版本端行为不变。
       */
      let fillerEnabled: boolean | undefined;
      let attachmentHandles: string[] = [];
      let attachmentDetections: Record<string, ClientDetectionsPayload> | undefined;

      if (Buffer.isBuffer(req.body)) {
        // 语音关闭（ACR-059）：在解析与转写之前拒，不花 ASR 的钱，也不留录音。
        if ((await voiceOff?.()) === true) {
          res.status(403).json(voiceOffBody);
          return;
        }
        // 音频路径：raw body + X-Audio-Meta
        const meta = parseAudioMeta(req.header("x-audio-meta"));
        if (!meta) {
          res.status(400).json({ error: "invalid_audio_meta" });
          return;
        }
        if (meta.durationMs > MAX_CAPTURE_DURATION_MS) {
          res.status(400).json({ error: "audio_too_long" });
          return;
        }
        /*
         * 转存推迟到建轮之后。
         *
         * 控制台要按消息回听，录音需挂在 messageId 上，
         * 而 messageId 要等 `turns.accept` 才有。
         */
        pendingVoice = { bytes: req.body, meta };

        // 日用量闸门（ACR-016）。超限时装配层给免费的本地 provider；
        // 连它都没有才 null，此时明确失败，不返回假文本：
        // 用户确实说了一句话，用编造的文字建轮比报错更糟。
        const gated = asrGate ? await asrGate() : null;
        if (asrGate && !gated) {
          res.status(503).json({ error: "asr_quota_exceeded" });
          return;
        }
        const provider = gated?.provider ?? asr;
        // 会话详情显示"这句由哪个档转写"：取闸门实际给的档位，见 AsrGate。
        asrEngine = gated?.engine ?? null;
        try {
          content = await provider.transcribe(req.body, meta, (u) => {
            asrUsage = u;
          });
        } catch (err) {
          console.error(`[gateway] asr failed session=${sessionId}`, err);
          res.status(502).json({ error: "asr_failed" });
          return;
        }
        source = "voice";
        /*
         * 头只认 "0" 与 "1"，其他值一律当没传，不 400：
         * 这是一条可选的元信息，不为它挡掉一条真实的语音消息
         * （对比 `source`：那个挡是因为静默回落会造成用户可见的错误，见下）。
         */
        const raw = req.header("x-filler-enabled");
        if (raw === "0") fillerEnabled = false;
        else if (raw === "1") fillerEnabled = true;
      } else if (typeof (req.body as { content?: unknown })?.content === "string") {
        const body = req.body as { content: string; source?: unknown };
        content = body.content;
        /*
         * 来源由调用方声明，默认 text。
         *
         * 端上唤醒词那条链是"本地转写完再发文本"，语音指令也走这一支。
         * source 错记成 "text" 时有两处后果：
         *  ① `turn-runner` 只在 source==="voice" 时给 prompt 事件带 transcript，
         *    而端上 `fanout.rs` 只在有 transcript 时才追加用户气泡，
         *    车主自己说的那句话不会显示在车机对话界面上；
         *  ② 控制台会话详情按这个字段标「🎙 语音 / ⌨ 文字」，会标错。
         * 只认这两个值，其他一律 400，不静默回落 text。
         */
        if (body.source === undefined) {
          source = "text";
        } else if (body.source === "voice" || body.source === "text") {
          source = body.source;
        } else {
          res.status(400).json({ error: "invalid_source" });
          return;
        }
      } else {
        res.status(400).json({ error: "invalid_body" });
        return;
      }

      if (!Buffer.isBuffer(req.body)) {
        // JSON 分支。非 boolean 一律当没传，理由同音频分支那段注释。
        const raw = (req.body as { fillerEnabled?: unknown }).fillerEnabled;
        if (typeof raw === "boolean") fillerEnabled = raw;
        // 附件句柄：形状不对或超量直接 400，不静默丢弃，用户拍的照片不能悄悄消失。
        const refs = parseAttachmentRefs(req.body);
        if ("error" in refs) {
          res.status(400).json({ error: refs.error });
          return;
        }
        attachmentHandles = refs.handles;
        attachmentDetections = refs.detections;
      }

      /*
       * 归属取会话的而不是请求的。车机是车辆级凭证，
       * 请求上下文里没有人；谁在用由建会话时的上车声明决定，存在会话行里。
       * 用 req.userId 时，车机上每一轮都会落进无归属分支（记忆读写会拒绝），
       * 表现为助手什么都不记得。
       */
      const sessionOwner = await repo.sessionUserId(sessionId);
      let turnAttachments: TurnAttachmentPayload[] = [];
      if (attachmentHandles.length > 0) {
        if (!attachments) {
          res.status(404).json({ error: "attachments_unavailable" });
          return;
        }
        // 上传那道已经拦过；开关在上传与发送之间被关上时，这里是最后一道。
        if ((await attachments.photoOff?.()) === true) {
          res.status(403).json(photoOffBody);
          return;
        }
        const resolved = await resolveTurnAttachments({
          handles: attachmentHandles,
          sessionId,
          userId: sessionOwner ?? undefined,
          repo: attachments.repo,
          store: attachments.store,
          detections: attachmentDetections,
        });
        if (!resolved.ok) {
          res.status(resolved.error === "attachment_not_found" ? 404 : 400).json({ error: resolved.error, handle: resolved.handle });
          return;
        }
        turnAttachments = resolved.attachments;
      }
      const accepted = await turns.accept(
        sessionId,
        content,
        source,
        sessionOwner ?? undefined,
        fillerEnabled,
        asrEngine,
        turnAttachments,
      );
      // 绑到本轮（F-09-06）：受理拿到 turnId 之后才有轮可绑；同一句柄第二次绑会返回 false，那种情况上面已经拒了。
      for (const a of turnAttachments) {
        void attachments!.repo.bindTurn(a.handle, accepted.turnId).catch((err) => console.warn(`[gateway] 附件绑轮失败 handle=${a.handle}`, err));
      }
      /*
       * 录音转存，不阻塞受理响应。失败只打日志：
       * 少一段回听不应让整轮对话失败。
       */
      if (pendingVoice) {
        const { bytes, meta } = pendingVoice;
        const messageId = accepted.userMessageId;
        if (saveVoiceAudio) {
          // 裸 PCM 浏览器放不出来，补 WAV 头再存。补头与 ASR 用同一个函数
          // （`asr/index.ts::wrapPcmAsWav`），不另写一份。
          const wav =
            meta.format === "pcm_s16le"
              ? { bytes: wrapPcmAsWav(bytes, meta.sampleRateHz, meta.channels), mime: "audio/wav" }
              : { bytes, mime: `audio/${meta.format}` };
          void saveVoiceAudio({
            sessionId,
            messageId,
            engine: asrEngine ?? "unknown",
            bytes: wav.bytes,
            mime: wav.mime,
          }).catch((err: unknown) =>
            console.error(`[gateway] 录音转存失败 message=${messageId}`, err),
          );
        } else {
          // 对象存储未接入：本地落盘（路径不回传端上）。
          writeFileSync(join(AUDIO_DIR, `${messageId}.${meta.format}`), bytes);
        }
      }

      // ASR 记账在拿到 turnId 之后：识别发生在建轮之前，但费用归到这一轮名下。
      if (asrUsage) {
        onAsrUsage?.({
          source: "turn",
          sessionId,
          turnId: (accepted as { turnId?: string }).turnId ?? "unknown",
          ...asrUsage,
        });
      }
      res.status(202).json(accepted);
    },
  );

  /**
   * 只转写，不建轮（F-52-01）。
   *
   * 哨兵监听的语音段走这里判定唤醒词。与 `/messages` 的音频分支三点刻意不同：
   *  1. 不建轮：不碰 `repo`、不进 `bus`、`messages` 零新增，车内闲聊不是对话。
   *  2. 不转存：哨兵段多为未命中的闲聊，落盘等于留痕，与 AC-52-5（判定后即弃）冲突。
   *  3. 日志无正文：失败日志只有状态，成功不记日志。
   * 审计面只暴露次数与时长（durationMs 在响应里，调用方可自行累计）。
   */
  router.post(
    "/v1/asr/transcribe",
    raw({ type: "audio/*", limit: "10mb" }),
    async (req: AuthedRequest, res: Response) => {
      if ((await voiceOff?.()) === true) {
        res.status(403).json(voiceOffBody);
        return;
      }
      if (!Buffer.isBuffer(req.body)) {
        res.status(400).json({ error: "invalid_body" });
        return;
      }
      const meta = parseAudioMeta(req.header("x-audio-meta"));
      if (!meta) {
        res.status(400).json({ error: "invalid_audio_meta" });
        return;
      }
      if (meta.durationMs > MAX_CAPTURE_DURATION_MS) {
        res.status(400).json({ error: "audio_too_long" });
        return;
      }
      /*
       * 日用量闸门（ACR-016）。这条是量最大的一路（车内每段语音都送转写），
       * 是闸门的主要对象。
       *
       * 超限且无本地兜底时回 503 是有意的：端上 `TranscribeGuard` 连续失败
       * 会把哨兵降级，不再上传音频；额度已经用完，继续传只会堆积
       * 注定失败的请求。这与空结果的处理（见下）不同：
       * 那里失败是意外，这里是主动设的上界。
       */
      const gated = asrGate ? await asrGate() : null;
      if (asrGate && !gated) {
        res.status(503).json({ error: "asr_quota_exceeded" });
        return;
      }
      const provider = gated?.provider ?? asr;
      /*
       * 用量回报（成本归因）。与本入口的三条规则不冲突：记的是次数、时长、
       * token，不含转写内容，即路由注释里"审计面只暴露次数与时长"的那个面。
       * 不记的话，量最大的一路在账上是零。
       *
       * 回调放在 transcribe 的参数里而不是拿到 text 之后：空转写（哨兵段的主导
       * 情形）同样是收费调用，provider 会在判空前把 usage 交出来。
       */
      const reportUsage = (u: AsrUsage): void => {
        onAsrUsage?.({ source: "sentinel", ...u });
      };
      try {
        const text = await provider.transcribe(req.body, meta, reportUsage);
        res.status(200).json({ text, durationMs: meta.durationMs });
      } catch (err) {
        // 空结果不是失败：哨兵段大多是风噪/静默/非语音，provider 判空
        // （含强制中文后的 CJK 守门）是一次成功的"这里没有话"判定。回 502 时
        // 端上 TranscribeGuard 连续计 3 次就把哨兵降级，车内安静三段后唤醒失效。
        // 回 200 空文本，端上 classify 判 Miss 即弃，计数器照常复位。PTT 建轮的 /messages
        // 分支不适用此语义：用户明确说了话却识别为空，仍该报错。
        if (err instanceof Error && err.message === "asr_empty_result") {
          res.status(200).json({ text: "", durationMs: meta.durationMs });
          return;
        }
        // 不带 err 细节：provider 的报错可能回显请求内容（含音频 data URL）。
        console.error("[gateway] transcribe-only asr failed");
        res.status(502).json({ error: "asr_failed" });
      }
    },
  );

  /**
   * HITL 确认/拒绝（§3）。
   *
   * 用户动作一律走 POST：SSE 是单向下行，这是协议选型的直接结论。
   * 网关不裁决，只把答案送回 runtime 的权限门；幂等在 `HitlRelay` 这一层挡住，
   * 少一次跨进程往返，且重发在协议层就被识别，不会污染裁决日志。
   */
  router.post("/v1/session/:id/resume", json(), async (req: AuthedRequest, res: Response) => {
    const sessionId = String(req.params.id);
    const { interruptId, approved } = (req.body ?? {}) as { interruptId?: string; approved?: unknown };
    if (!interruptId || typeof approved !== "boolean") {
      res.status(400).json({ error: "missing_interrupt_or_decision" });
      return;
    }
    if (!(await repo.sessionExists(sessionId))) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    const result = await hitl.resume({ sessionId, interruptId, approved });
    // 重复 resume 返回 200 + duplicate：报错会引发端上重试（F-04-11）。
    res.status(result.ok ? 200 : 409).json(result);
  });

  /**
   * 车主打断这一轮（F-08-08 / F-14-04）。
   *
   * # 与「退下」是两件事
   *
   * `/close` 关的是"这段对话结束了"（会话级、软关闭、历史照翻）；
   * 这一条掐的是"这一轮作废"：会话继续，下一句话照常成轮。
   * 车主长按打断之后紧接着要问新问题，路由到 `/close` 会让那个新问题
   * 落在一个已关闭的会话上，端上再去建新会话，上下文丢失。
   *
   * # 未命中不回 404
   *
   * 端上无法知道服务端刚好在这一毫秒收口了。未命中报 404 会让打断时灵时不灵，
   * 而打断必须每次都有反应。所以 runtime 那侧对未命中回
   * `{ cancelled: true, turnId: null }`，这里原样透传。
   *
   * # `sideEffectInFlight`
   *
   * 取消落在副作用窗口内 = 外部动作已经发出，收不回来（F-14-05）。
   * 原样回给端上，让它把话说清楚，不在这里抹成"已取消"。
   */
  router.post("/v1/session/:id/cancel", json(), async (req: AuthedRequest, res: Response) => {
    const sessionId = String(req.params.id);
    if (!(await repo.sessionExists(sessionId))) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    const { turnId } = (req.body ?? {}) as { turnId?: unknown };
    const outcome = await turns.cancel(sessionId, typeof turnId === "string" ? turnId : undefined);
    /*
     * 立刻把端上从 speaking 里放出来。
     *
     * 发在这里而不是等 runtime 那条 `turn_end`：那条要等图真的停下来才到，
     * 而端上此刻已经不出声，状态不能继续停在 speaking。
     * `turn_end` 之后到达的事件端上会丢弃（`fanout.rs` 按轮收口），
     * 所以 idle 必须赶在它前面。重复的 idle 端上是幂等的。
     */
    bus.append(sessionId, { type: "update", kind: "state", state: "idle" });
    res.status(200).json(outcome);
  });

  /**
   * 车主点「退下」：软关闭。
   *
   * 不删任何历史。关掉的是"还能不能接着说"，不是"还能不能翻阅"：
   * 下面那个 GET 对已关闭会话照常返回全部历史（设计定稿 D4）。
   */
  router.post("/v1/session/:id/close", json(), async (req: AuthedRequest, res: Response) => {
    const sessionId = String(req.params.id);
    const closedAt = await repo.closeSession(sessionId, new Date());
    if (!closedAt) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    /*
     * 列表里那条要变成「已结束」（ACR-031）。归属取会话的而不是 `req.userId`：
     * 车机上关会话的请求里没有人，用调用者会漏掉车机那一路。
     * 不 await：关会话的回执不等通知。
     */
    void repo
      .sessionUserId(sessionId)
      .then((owner) => {
        if (owner) notifySessionsChanged?.(owner, "closed", sessionId);
      })
      .catch(() => {});
    // 幂等：连点两次第二次也是 200，且 `closedAt` 是第一次那个值。
    res.status(200).json({ ok: true, sessionId, closedAt: closedAt.getTime() });
  });

  /**
   * 车主自己的会话列表（车机端左侧历史）。
   *
   * 只返回调用者自己的会话：`userId` 取自鉴权中间件，不接受 query 参数，
   * 权限不依赖端上传对参数。跨用户检索是运营的能力，在 `/console/sessions`（另一道角色门）。
   *
   * 懒加载一次 20 条，游标是上一页最后一条的 `updatedAt`（与排序同一列）。
   * 不用 id 当游标：id 是随机的，翻页会乱序，
   * 表现为有的会话重复出现、有的翻不到。
   */
  router.get("/v1/sessions", async (req: AuthedRequest, res: Response) => {
    // 车辆级 token 没有"我的会话"这个概念（车机是共享终端），返回空列表而不是别人的列表。
    if (!req.userId) {
      res.json({ sessions: [], hasMore: false, nextCursor: null });
      return;
    }
    const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100);
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    res.json(
      await repo.userSessionPage({
        userId: req.userId,
        limit,
        cursor,
      }),
    );
  });

  /*
   * 权威历史（F-03-10）。
   *
   * 对已关闭 / 已过期的会话必须照常 200 返回全部历史（设计定稿 D4）。
   * 这里刻意只判"存不存在"，不判 closedAt，否则车主的历史会丢失。
   * `enterprise/backend/gateway/test/session-lifecycle.test.ts` 有一条守卫测试专门盯这行。
   */
  router.get("/v1/session/:id/messages", async (req: AuthedRequest, res: Response) => {
    const sessionId = String(req.params.id);
    if (!(await repo.sessionExists(sessionId))) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
    const before = typeof req.query.before === "string" ? req.query.before : undefined;
    res.json(await repo.historyPage(sessionId, { before, limit }));
  });

  return router;
}
