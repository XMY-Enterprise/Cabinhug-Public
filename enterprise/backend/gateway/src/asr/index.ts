/**
 * ASR 提供方。
 *
 * 默认档是豆包 omni（`doubao-seed-2-0-mini`，火山方舟 Ark），中文车载口语可逐字转写。
 *
 * 调用形态（Ark `/responses`）：
 *   content: [{ type: "input_audio", audio_url: "data:audio/wav;base64,…" },
 *             { type: "input_text",  text: "<转写指令>" }]
 * 取文本：output[type=message].content[type=output_text].text
 *
 * 这里只把 omni 当 ASR 用（音频 → 文本），不做端到端对话，
 * 之后仍走 DeepSeek 生成回复。文本管线保持完整，§8 Guardrails
 * （规则筛 / Qwen3Guard-Gen / PII 脱敏）与 §4 LangGraph 编排均不受影响。
 *
 * 音频格式：端上按契约常量上传 raw PCM（pcm_s16le/16k/mono，无容器头），
 * Ark 需要容器格式，故此处补 WAV 头再送（`wrapPcmAsWav`）。
 *
 * 本地档：llama.cpp `llama-server` + Qwen3-ASR-0.6B GGUF（ACR-007），
 * 用于去掉"第三方账号余额能停掉默认交互入口"这个单点，见 `LocalAsr`。
 *
 * 阿里云百炼档：`qwen3-asr-flash`（见 `AliyunAsr`），云侧平替档，
 * 火山账号不可用时不必降级到兜底精度。
 *
 * 选档由 `ASR_ENGINE` 唯一决定（ACR-017）：
 * `ark`（默认）｜`aliyun`｜`mock`（本机 llama.cpp 容器）｜
 * `fake`（固定文本，仅供测试脚本经 env 注入，不进后台下拉）。
 * env 写死即钉档（env-override）。优先级只在配置层 store 里解析，本文件不读
 * process.env；配置层不可达时 configured 工厂回退纯 env 构造（见 `createConfiguredAsrProvider`）。
 * 无 key 时一律回落 Fake。
 */

import type { AudioMeta } from "@cabinhug/shared";
import type { ConfigStore } from "@cabinhug/db";

/** 一次识别的用量（Ark 回包的 usage；音频按 token 计费，也是成本的一部分）。 */
export interface AsrUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface AsrProvider {
  /**
   * 音频 → 识别文本。失败抛错，由调用方转换为用户可理解的提示。
   * `onUsage` 可选：Ark 路径回报 token 用量，Fake 不回报。
   */
  transcribe(audio: Buffer, meta: AudioMeta, onUsage?: (u: AsrUsage) => void): Promise<string>;
}

const TRANSCRIBE_PROMPT = "把这段语音逐字转写成文本，只输出文本本身，不要任何解释。";
const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_MODEL = "doubao-seed-2-0-mini-260428";
/** 本地 llama.cpp `llama-server` 的 OpenAI 风格转写端点（ACR-007）。 */
const DEFAULT_LOCAL_ASR_URL = "http://127.0.0.1:8795/v1/audio/transcriptions";
/**
 * 本地档强制语种（llama-server 会拼成 `(language: Chinese)` 进模型提示词）。
 * Qwen3-ASR 默认自动判语种，噪声或含糊段可能被判成其他语言。
 * 产品语境是中文车载语音，默认钉死 Chinese；
 * `LOCAL_ASR_LANGUAGE=""` 可退回自动判定（同时关掉下面的 CJK 守门）。
 */
const DEFAULT_LOCAL_ASR_LANGUAGE = "Chinese";

/** 给裸 PCM 加 44 字节 WAV 头（RIFF/WAVE，PCM fmt）。 */
export function wrapPcmAsWav(pcm: Buffer, sampleRateHz: number, channels: number): Buffer {
  const bitsPerSample = 16;
  const byteRate = (sampleRateHz * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

interface ArkResponsesReply {
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  /** OpenAI Responses 风格的用量；音频输入折算进 input_tokens。 */
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** 从 Ark `/responses` 回包中取出转写文本（跳过 reasoning 段）。 */
export function extractOutputText(reply: ArkResponsesReply): string | null {
  for (const item of reply.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content ?? []) {
      if (c.type === "output_text" && typeof c.text === "string" && c.text.length > 0) {
        return c.text.trim();
      }
    }
  }
  return null;
}

class ArkOmniAsr implements AsrProvider {
  constructor(
    private apiKey: string,
    private baseUrl: string = DEFAULT_BASE_URL,
    private model: string = DEFAULT_MODEL,
  ) {}

  async transcribe(audio: Buffer, meta: AudioMeta, onUsage?: (u: AsrUsage) => void): Promise<string> {
    const startedAt = Date.now();
    // 端上送裸 PCM；其它容器格式（wav/mp3）原样透传。
    const container =
      meta.format === "pcm_s16le"
        ? { bytes: wrapPcmAsWav(audio, meta.sampleRateHz, meta.channels), mime: "audio/wav" }
        : { bytes: audio, mime: `audio/${meta.format}` };

    const res = await fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                audio_url: `data:${container.mime};base64,${container.bytes.toString("base64")}`,
              },
              { type: "input_text", text: TRANSCRIBE_PROMPT },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      throw new Error(`asr_failed status=${res.status} body=${(await res.text()).slice(0, 200)}`);
    }
    const reply = (await res.json()) as ArkResponsesReply;
    /*
     * 用量回报在判空之前：音频已上传、模型已跑完，回包带 usage 即已计费，
     * 空转写同样是一次收费调用。哨兵路上的语音段多为噪声，判空是主导情形，
     * 先判空再回报会让成本观察项（§13 待确认 22）严重低估。
     */
    if (onUsage && reply.usage) {
      try {
        onUsage({
          model: this.model,
          inputTokens: reply.usage.input_tokens ?? 0,
          outputTokens: reply.usage.output_tokens ?? 0,
          durationMs: Date.now() - startedAt,
        });
      } catch {
        // 记账坏了不该让识别坏。
      }
    }
    const text = extractOutputText(reply);
    if (text === null) throw new Error("asr_empty_result");
    return text;
  }
}

/** 百炼（DashScope）默认端点与模型（ACR-015）。与 registry 的默认值同源同值。 */
const DEFAULT_DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
const DEFAULT_ALIYUN_ASR_MODEL = "qwen3-asr-flash";

interface AliyunAsrReply {
  output?: {
    choices?: Array<{
      message?: { content?: Array<{ text?: string }> };
    }>;
  };
  usage?: {
    seconds?: number;
    input_tokens_details?: { text_tokens?: number };
    output_tokens_details?: { text_tokens?: number };
  };
  /** DashScope 出错时 HTTP 200 + body 带 code/message 的形态也存在，防御同 LocalAsr。 */
  code?: string;
  message?: string;
}

/** 从百炼 multimodal-generation 回包取转写文本。 */
export function extractAliyunText(reply: AliyunAsrReply): string | null {
  for (const choice of reply.output?.choices ?? []) {
    for (const c of choice.message?.content ?? []) {
      if (typeof c.text === "string" && c.text.trim().length > 0) return c.text.trim();
    }
  }
  return null;
}

/**
 * 阿里云百炼档：`qwen3-asr-flash` 同步识别（ACR-015）。
 *
 * 选同步档而不是 `-filetrans` 异步档的原因写在 registry 的 ALIYUN_ASR_MODEL 里：
 * 异步档要公网可访问的音频 URL，哨兵段是几百 KB 的本机 Buffer，没有 URL 可给。
 * 同步档收 base64 data URI（≤10MB，补头后的哨兵段远小于此），形态与 Ark 档同构。
 */
class AliyunAsr implements AsrProvider {
  constructor(
    private apiKey: string,
    private baseUrl: string = DEFAULT_DASHSCOPE_BASE_URL,
    private model: string = DEFAULT_ALIYUN_ASR_MODEL,
  ) {}

  async transcribe(audio: Buffer, meta: AudioMeta, onUsage?: (u: AsrUsage) => void): Promise<string> {
    const startedAt = Date.now();
    const container =
      meta.format === "pcm_s16le"
        ? { bytes: wrapPcmAsWav(audio, meta.sampleRateHz, meta.channels), mime: "audio/wav" }
        : { bytes: audio, mime: `audio/${meta.format}` };

    const res = await fetch(`${this.baseUrl}/services/aigc/multimodal-generation/generation`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: {
          messages: [
            {
              role: "user",
              content: [
                { audio: `data:${container.mime};base64,${container.bytes.toString("base64")}` },
              ],
            },
          ],
        },
        // 产品语境是中文车载语音，钉死 zh（与本地档钉 Chinese 同一个理由）；
        // enable_itn 关掉——数字归一化会改写口令原文，端上唤醒匹配要逐字。
        parameters: { asr_options: { enable_itn: false, language: "zh" } },
      }),
    });

    if (!res.ok) {
      throw new Error(`asr_failed status=${res.status} body=${(await res.text()).slice(0, 200)}`);
    }
    const reply = (await res.json()) as AliyunAsrReply;
    // DashScope 部分错误也走 200 + code/message，防御分支同 LocalAsr。
    if (typeof reply.code === "string" && reply.code.length > 0 && !reply.output) {
      throw new Error(`asr_failed aliyun=${reply.code} ${reply.message ?? ""}`.trim());
    }
    // 判空之前先记账，理由见 ArkOmniAsr 里那段注释（空转写同样是收费调用）。
    if (onUsage && reply.usage) {
      try {
        onUsage({
          model: this.model,
          // 百炼按秒计费（usage.seconds），token 明细只有文本部分——
          // 口径差异记录在 ACR-015「不动的东西」，这里如实转发文本 token。
          inputTokens: reply.usage.input_tokens_details?.text_tokens ?? 0,
          outputTokens: reply.usage.output_tokens_details?.text_tokens ?? 0,
          durationMs: Date.now() - startedAt,
        });
      } catch {
        // 记账坏了不该让识别坏。
      }
    }
    const text = extractAliyunText(reply);
    if (text === null) throw new Error("asr_empty_result");
    return text;
  }
}

/**
 * llama.cpp #26749：Qwen3-ASR 经 `/v1/audio/transcriptions` 的输出带
 * `language Chinese` + `<asr_text>` 标记前缀。前缀混进端上 `wake::classify`
 * 的精确匹配会让每条控制口令都判 Miss。上游修复后本函数自然变成 no-op。
 */
export function stripLocalAsrMarkup(raw: string): string {
  return raw
    .replace(/^\s*language\s+[^<\n]{0,64}(?=<asr_text>)/, "")
    .replace(/<\/?asr_text>/g, "")
    .trim();
}

/**
 * 中文守门：强制中文后模型对纯噪声会回显指令原文
 * （如 "Transcribe audio to text (language: Chinese)"），自动判定下则可能输出任意语种。
 * 整段没有一个 CJK 字符就按非语音丢弃，让调用方走与空转写相同的
 * `asr_empty_result` 路径（哨兵段判 Miss 即弃）。
 * 只在强制中文时启用：转写外语时把 LOCAL_ASR_LANGUAGE 置空。
 */
export function hasCjk(text: string): boolean {
  return /[㐀-鿿豈-﫿]/u.test(text);
}

/**
 * 本地 ASR：llama.cpp 的 `llama-server` + Qwen3-ASR-0.6B GGUF（ACR-007）。
 *
 * 用途是去掉"一个第三方账号的余额能停掉默认交互入口"这个单点：云端账号欠费时
 * `/v1/asr/transcribe` 全部 502，哨兵段无法转写。本档与 Ark 档并存，由 `ASR_ENGINE=mock` 选。
 *
 * `{"error":…}` 防御分支保留：转写服务可能以 HTTP 200 + `{"error":"…"}` 报失败；
 * 只判 `res.ok` 会把失败当成空转写，空串进端上 `wake::classify` 得 Miss 被丢弃，
 * 网关视为成功，端上 `TranscribeGuard` 的连续失败计数器不会触发降级。
 * llama-server 失败时通常回非 2xx，这个分支对它无害。
 *
 * Qwen3-ASR 对普通话默认输出简体，不加简体提示词；「10dB 信噪比 20 条零繁体」
 * 的判据见同一变更单的回归表。
 *
 * 端上送的是裸 PCM（pcm_s16le/16k/mono，无容器头），转写端点要容器格式，
 * 故复用 Ark 档同一个 `wrapPcmAsWav`。
 */
class LocalAsr implements AsrProvider {
  constructor(
    private url: string = DEFAULT_LOCAL_ASR_URL,
    private language: string = DEFAULT_LOCAL_ASR_LANGUAGE,
  ) {}

  async transcribe(audio: Buffer, meta: AudioMeta): Promise<string> {
    const container =
      meta.format === "pcm_s16le"
        ? { bytes: wrapPcmAsWav(audio, meta.sampleRateHz, meta.channels), mime: "audio/wav" }
        : { bytes: audio, mime: `audio/${meta.format}` };

    const form = new FormData();
    // Buffer 的 ArrayBufferLike 不满足 BlobPart 的 ArrayBuffer 约束（可能是 SharedArrayBuffer），
    // 拷一份成普通 Uint8Array；哨兵段只有几百 KB，这次拷贝可以忽略。
    const blob = new Blob([new Uint8Array(container.bytes)], { type: container.mime });
    form.append("file", blob, "audio.wav");
    form.append("response_format", "json");
    // 转写要可复现：温度 0，不要采样带来的随机改写。
    form.append("temperature", "0");
    if (this.language.length > 0) form.append("language", this.language);

    const res = await fetch(this.url, { method: "POST", body: form });
    if (!res.ok) throw new Error(`asr_failed status=${res.status}`);

    const reply = (await res.json()) as { text?: unknown; error?: unknown };
    // 见上：200 也可能是失败。这一支不能省。
    if (typeof reply.error === "string" && reply.error.length > 0) {
      throw new Error(`asr_failed local=${reply.error}`);
    }
    const text = typeof reply.text === "string" ? stripLocalAsrMarkup(reply.text) : "";
    if (text.length === 0) throw new Error("asr_empty_result");
    // 见 hasCjk：强制中文时，无一个 CJK 字符的输出按非语音处理。
    if (this.language === "Chinese" && !hasCjk(text)) throw new Error("asr_empty_result");
    return text;
  }
}

/** 离线开发/测试用：固定返回可配置文本，不访问网络。 */
class FakeAsr implements AsrProvider {
  constructor(private fixedText: string) {}
  async transcribe(): Promise<string> {
    return this.fixedText;
  }
}

export function createAsrProvider(env: NodeJS.ProcessEnv = process.env): AsrProvider {
  const engine = env.ASR_ENGINE?.trim() || "ark";
  if (engine === "mock") {
    // `?? undefined` 让空串保留（空串 = 自动判语种），只有未设置才落默认 Chinese。
    return new LocalAsr(env.LOCAL_ASR_URL, env.LOCAL_ASR_LANGUAGE ?? undefined);
  }
  if (engine === "fake") {
    return new FakeAsr(env.CABINHUG_ASR_FAKE_TEXT ?? "（模拟识别文本）");
  }
  if (engine === "aliyun") {
    const dashKey = env.DASHSCOPE_API_KEY;
    if (!dashKey) return new FakeAsr(env.CABINHUG_ASR_FAKE_TEXT ?? "（模拟识别文本）");
    return new AliyunAsr(dashKey, env.DASHSCOPE_BASE_URL, env.ALIYUN_ASR_MODEL);
  }
  const key = env.ARK_API_KEY;
  if (!key) {
    return new FakeAsr(env.CABINHUG_ASR_FAKE_TEXT ?? "（模拟识别文本）");
  }
  return new ArkOmniAsr(key, env.ARK_BASE_URL, env.ARK_ASR_MODEL);
}

/**
 * 按配置版本缓存的 ASR 工厂。
 *
 * 每次取用时按配置版本决定复用还是重建，使配置变更无需重启网关；
 * 重启会打断 SSE 与挂起中的 HITL（§3、§8.4）。版本没变则复用同一个实例。
 */
export function createConfiguredAsrProvider(store: ConfigStore): AsrProvider {
  let cached: { version: number; provider: AsrProvider } | undefined;

  async function current(): Promise<AsrProvider> {
    try {
      const version = await store.version();
      if (cached && cached.version === version) return cached.provider;

      const values = await store.runtimeValues();
      // 选档只看 ASR_ENGINE。env-override 的优先级在 store 里解析，
      // 这里拿到的值已包含 env 钉档，不再读 process.env。
      const provider: AsrProvider = (() => {
        const engine = values.get("ASR_ENGINE")?.trim() || "ark";
        if (engine === "mock") {
          return new LocalAsr(
            values.get("LOCAL_ASR_URL"),
            values.get("LOCAL_ASR_LANGUAGE") ?? process.env.LOCAL_ASR_LANGUAGE ?? undefined,
          );
        }
        if (engine === "fake") {
          return new FakeAsr(process.env.CABINHUG_ASR_FAKE_TEXT ?? "（模拟识别文本）");
        }
        if (engine === "aliyun") {
          const dashKey = values.get("DASHSCOPE_API_KEY");
          if (dashKey) {
            return new AliyunAsr(dashKey, values.get("DASHSCOPE_BASE_URL"), values.get("ALIYUN_ASR_MODEL"));
          }
          return new FakeAsr(process.env.CABINHUG_ASR_FAKE_TEXT ?? "（模拟识别文本）");
        }
        const key = values.get("ARK_API_KEY");
        if (!key) return new FakeAsr(process.env.CABINHUG_ASR_FAKE_TEXT ?? "（模拟识别文本）");
        return new ArkOmniAsr(key, values.get("ARK_BASE_URL"), values.get("ARK_ASR_MODEL"));
      })();

      cached = { version, provider };
      return provider;
    } catch (err) {
      /*
       * 逃生路径：配置层不可达且缓存冷启动时，env 里钉了档就按 env 纯构造，
       * 覆盖"数据库故障 + 重启网关"的组合。env 没钉档就如实抛错，不掩盖配置层故障。
       */
      if (process.env.ASR_ENGINE?.trim()) {
        console.warn("[asr] 配置层不可达，按 env 的 ASR_ENGINE 构造 provider 逃生", err);
        return createAsrProvider(process.env);
      }
      throw err;
    }
  }

  return {
    async transcribe(audio, meta, onUsage) {
      return (await current()).transcribe(audio, meta, onUsage);
    },
  };
}
