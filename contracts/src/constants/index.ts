/**
 * constants —— 全局常量。
 *
 * 音频常量为 Rust 契约的镜像，源头在
 * `clients/shared/rust/cabinhug-core/src/contract/voice.rs`（ts-rs 只生成类型不生成常量）。
 * 两处必须一致：Rust 侧 `contract_roundtrip.rs` 与 TS 侧
 * `scripts/check-contract-fixtures.ts` 均以 fixtures 中的 `audioMeta`
 * 对照各自常量，任一处改动不同步会在测试中暴露。
 *
 * TODO(ASR 选型)：当前为开发期假定值（16kHz 单声道 PCM），
 * ASR 提供方确定后与 Rust 侧同步更新。
 */

export const DEFAULT_AUDIO_FORMAT = "pcm_s16le";
export const DEFAULT_AUDIO_SAMPLE_RATE_HZ = 16000;
export const DEFAULT_AUDIO_CHANNELS = 1;
/** 单条语音时长上限（FL-02 边界：60s 超时自动结束）。 */
export const MAX_CAPTURE_DURATION_MS = 60000;

// ---------------------------------------------------------------------------
// LLM 默认模型
// ---------------------------------------------------------------------------

/**
 * DeepSeek 当前统一使用的对话模型。各服务与旁路不得各自维护默认值。
 *
 * 使用正式名 `deepseek-flash`（V4.1 Flash）。`deepseek-v4-flash` 在 DeepSeek 服务端是它的别名
 * （请求 `deepseek-v4-flash`、响应 `model=deepseek-flash`；`/models` 只列 `deepseek-flash` 与
 * `deepseek-v4-pro`）。别名的指向由服务端决定，指向一变，调用方会在无感知下换模型，
 * 行程四条腿的输出量因此可相差 10~30 倍
 * （内部文档 §1）。别名可能撤销，这里不依赖它。
 * pi 侧的同一设置在 `enterprise/backend/pi-agents/.pi/settings.json`。
 */
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";

const DEPRECATED_DEEPSEEK_MODEL = "deepseek-chat";

/**
 * 解析 DeepSeek 模型配置。
 *
 * 旧值可能已经写进配置数据库或部署环境；在读取边界归一化，确保不会再把
 * 已弃用的模型名发给上游，同时保留通过自定义兼容端点指定其它模型的能力。
 */
export function resolveDeepSeekModel(value?: string | null): string {
  const candidate = value?.trim();
  if (!candidate || candidate === DEPRECATED_DEEPSEEK_MODEL) {
    return DEFAULT_DEEPSEEK_MODEL;
  }
  return candidate;
}

/**
 * DeepSeek 的视觉档（ACR-027）。
 *
 * 只在这一次请求里带了图片时用它；纯文字的请求仍走 `DEFAULT_DEEPSEEK_MODEL`。选档在
 * `agent-runtime/src/llm` 按每次请求判，不是按会话钉死：车主前几轮打字、中途发一张照片、再追问两句——
 * 同一会话里两档交替是常态。
 *
 * 两档缺省是同一个模型 `deepseek-flash`（V4.1 Flash 的正式名）。旧名 `deepseek-v4-flash` /
 * `deepseek-v4-flash-vision-exp` / 预览档 `deepseek-v4.1-flash-expires-on-0910` 在服务端都是它的别名
 * （同一张图四个名字的 prompt token 与 system_fingerprint 完全相同）。
 * 这里写正式名，不依赖别名。两档的区分保留，供两者再分开时使用。
 */
export const DEFAULT_DEEPSEEK_VISION_MODEL = "deepseek-flash";

export function resolveDeepSeekVisionModel(value?: string | null): string {
  const candidate = value?.trim();
  return candidate ? candidate : DEFAULT_DEEPSEEK_VISION_MODEL;
}

// ---------------------------------------------------------------------------
// 每轮附件上限。端上预检与网关校验共用同一份数字。
// ---------------------------------------------------------------------------

/**
 * 数字的来源（api-docs.deepseek.com/guides/vision，2026-09-09 查阅）：
 * DeepSeek 视觉档单次请求最多 600 张图、请求体 48 MiB、单图 32 MiB、每图折算 ≤ 384 token。
 * 实际约束不是 600，而是请求体与可读性：
 * - 9 张照片 + 1 段视频（最多 6 张帧序图）= 15 张图，恰好卡在 DeepSeek「≥ 15 张时单边 ≤ 4096 px」的门内
 *   （帧序图宽 2400 px，照片端上压到 ≤ 8 MB 且长边通常 ≤ 4096）；
 * - 视频只收 1 段、只分析前 60 秒：一分钟以内的异响/抖动/仪表闪烁足够看清，再长的是"两件事"，
 *   合在一次请求里模型会把两段的观察混着说。
 */
export const TURN_ATTACHMENT_LIMITS = {
  /** 单轮最多几张照片。 */
  maxImages: 9,
  /** 单轮最多几段视频。 */
  maxVideos: 1,
  /** 单轮附件总数（照片 + 视频）。 */
  maxTotal: 10,
  /** 视频只分析前这么多毫秒；更长的不拒绝，截断并在上下文里如实说明。 */
  videoAnalyzedMs: 60_000,
  /** 视频原件上限（字节）。iOS 相册经 WebView 文件选择器导出的 60 秒 720p 约 15–40 MB。 */
  videoMaxBytes: 64 * 1024 * 1024,
  /** 照片原件上限（字节），与网关 `upload/policy.ts` 的 image 白名单一致。 */
  imageMaxBytes: 8 * 1024 * 1024,
} as const;

/** 视频抽帧参数：每张帧序图覆盖 10 秒、每 2 秒一帧 → 1 行 5 列；60 秒 → 6 张。 */
export const VIDEO_SHEET_PARAMS = {
  segmentMs: 10_000,
  frameIntervalMs: 2_000,
  /** 单帧缩放后的宽（像素）；5 帧并排 2400 px，DeepSeek 会再按 ~800×800 等效像素缩放（每图 ≤ 384 token）。 */
  frameWidth: 480,
} as const;

// ---------------------------------------------------------------------------
// 桥接事件名（Rust emit ↔ TS listen）。
// Rust 侧镜像：`clients/shared/rust/cabinhug-core/src/fanout.rs`（改动必须两侧同步）。
// ---------------------------------------------------------------------------

export const BRIDGE_EVENTS = {
  /** payload: AssistantState 字面量 */
  assistantState: "assistant:state",
  /** payload: UpdateDelta */
  dialogDelta: "dialog:delta",
  /** payload: ChatMessage */
  dialogMessage: "dialog:message",
  /** payload: { state: "online" | "reconnecting" } */
  netConnection: "net:connection",
  /** payload: CaptureStatus */
  voiceCapture: "voice:capture",
  /** payload: PermissionRequest（HITL 确认弹窗） */
  dialogPermission: "dialog:permission",
  /** payload: UpdateFiller（等待期垫场话） */
  dialogFiller: "dialog:filler",
  /** payload: ToolCallEvent（FL-08 F-08-05，工具进展；不进历史） */
  dialogToolCall: "dialog:tool_call",
  /** payload: WakeStatus（唤醒状态；只有状态事实，不携带转写文本） */
  voiceWake: "voice:wake",
  /** payload: SentinelIndication（哨兵指示快照；采集层真实状态推导） */
  voiceSentinel: "voice:sentinel",
  /** payload: UpdateTitle（会话标题；不进历史，只更新左侧列表） */
  dialogTitle: "dialog:title",
  /** payload: UpdateBranch（分支起止；failed/timeout 出"部分结果"标识，不进历史） */
  dialogBranch: "dialog:branch",
} as const;

/**
 * 账号级通道推给 WebView 的事件名（ACR-032）。
 *
 * # 为什么不在 `BRIDGE_EVENTS` 里
 *
 * 那一组是对话桥：Rust 把会话流（`/v1/session/:id/stream`）的事件 fan-out 给
 * WebView，两端 `bridge/index.ts` 逐字相同、且必须订满那一组的每一个键
 * （`clients/mobile/test/bridge-parity.test.ts` 是这条承诺的守卫）。
 *
 * 本事件来自另一条流（`/v1/events`，按账号订阅），生命周期也不同：它跨会话存活，
 * 换会话不换它。放进 `BRIDGE_EVENTS` 会让那道守卫要求对话桥订阅一个不属于它的事件；
 * 分开定义由类型表达这一区别，守卫无需开例外。
 */
export const ACCOUNT_EVENTS = {
  /**
   * payload: `{ reason: string }`。语义是「别的端动了你的会话列表，整拉一次」。
   *
   * 刻意不带会话摘要：带上会诱导端上做增量合并，而增量合并容易引入乱序与漏更新。
   * `reason` 只进日志，端上不按它分支。
   */
  sessionsChanged: "session:list-changed",
} as const;

/**
 * 会话已过期 / 已关闭时 `POST /v1/session/:id/messages` 的错误码。
 *
 * 不用 404：404 的语义是"没有这个会话"，端上两种情况都会去建新的、行为碰巧一样，
 * 但排障时分不清"过期了"和"id 传错了"。
 *
 * 两个 TS 消费方（网关发、车机端认），所以常量放在这里防两处字面量漂移。
 * Rust 侧按字面量匹配，注释指回本常量，不为一个字符串新开 ts-rs 结构体。
 */
export const SESSION_EXPIRED = "session_expired";

/** 会话空闲多久算结束。默认 30 分钟，由 `CABINHUG_SESSION_IDLE_MIN` 覆盖。 */
export const DEFAULT_SESSION_IDLE_MIN = 30;

// 途中提醒的文案表（F-62-06）：两端一份，槽位缺省整句去掉，不出现疲劳判断。
// 附件 MIME 归一化：端上预检 / 上传请求头 / 网关白名单同一份判断。
export * from "./media";
export * from "./en-route";
export * from "./weather";
export * from "./capabilities";
