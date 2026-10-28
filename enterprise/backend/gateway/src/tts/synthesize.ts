/**
 * 服务端合成：「文本 → 音频字节」在网关这一侧的唯一实现。
 *
 * # 消费方
 *
 * 控制台回放（第一次点播放时按当时档位补合成，存进对象存储，之后不再向供应商
 * 重复请求），以及端上播报：端上不直连任何供应商（ACR-018），`/v1/tts/speech`
 * 收到请求后调用本模块。合成经过服务端，才能施加日用量闸门，并在不发客户端
 * 版本的情况下更换供应商。
 *
 * # 三档的差别只在这一层
 *
 * 端上"换 URL 不换客户端"的不变量靠的是三档同协议（豆包 NDJSON）。
 * 服务端要拆开：aliyun 档的实际上游是 DashScope（回 OSS 音频 URL），
 * 豆包协议是 `http/tts-aliyun.ts` 套上的门面。这里直接调 DashScope，
 * 不绕门面，省去一次 base64 编解码。
 *
 * # 它不判断"该不该花这笔钱"
 *
 * 闸门（ACR-016）与鉴权都在调用方。本模块只负责"给我文本，还你字节"，
 * 失败一律抛 `TtsSynthesisError`，消息面向调用方而不是终端用户。
 *
 * # 三档一律交出 WAV（ACR-067）
 *
 * 端上只带 WAV / FLAC / Vorbis 解码（ACR-068：车载设备不带 MP3/AAC 解码器）。
 * 豆包协议两档向上游要裸 PCM，在这里补 44 字节的 WAV 头；百炼档本来就回 WAV，
 * 回的不是 WAV 时报错，而不是把端上解不了的字节发下去、让端上静默降级。
 */

import { resolveTts, type TtsEngine } from "@cabinhug/db";

/** 豆包协议的正常终止码，与 cabinhug-net::tts::CODE_DONE 同值。 */
const CODE_DONE = 20_000_000;
/** 与 registry / asr 侧默认值同源同值。 */
const DEFAULT_DASHSCOPE_BASE_URL = "https://dashscope.aliyuncs.com/api/v1";
/** 合成采样率，与端上 `cabinhug-net::tts::SAMPLE_RATE` 同值。 */
const SAMPLE_RATE = 24_000;
/**
 * 豆包协议上游 `format: "pcm"` 回的裸采样：16 bit 有符号小端、单声道。
 * 火山单向流式接口的 pcm 输出与本机 mock-tts（`say --data-format=LEI16`）同形。
 */
const PCM_BITS_PER_SAMPLE = 16;
const PCM_CHANNELS = 1;
/** WAV 头长度：RIFF 块头 12 + fmt 块 24 + data 块头 8。 */
const WAV_HEADER_BYTES = 44;

export class TtsSynthesisError extends Error {}

/**
 * 裸 PCM → WAV：在前面补 44 字节的 RIFF/WAVE 头（格式码 1 = PCM）。
 *
 * 长度不是整样本时报错而不是截掉：那说明上游回的不是 16 bit 单声道，
 * 照样封装只会在端上放出杂音。
 */
export function pcmToWav(pcm: Buffer, sampleRate: number = SAMPLE_RATE): Buffer {
  const blockAlign = PCM_CHANNELS * (PCM_BITS_PER_SAMPLE / 8);
  if (pcm.length === 0) throw new TtsSynthesisError("PCM 为空，不封装");
  if (pcm.length % blockAlign !== 0) {
    throw new TtsSynthesisError(`PCM 长度 ${pcm.length} 不是整样本（${blockAlign} 字节一个），上游格式与预期不符`);
  }
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(WAV_HEADER_BYTES - 8 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt 块负载长度
  header.writeUInt16LE(1, 20); // 格式码 1 = PCM
  header.writeUInt16LE(PCM_CHANNELS, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28); // 每秒字节数
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(PCM_BITS_PER_SAMPLE, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** 字节是不是 WAV（RIFF 容器 + WAVE 形式类型），按内容判，不信 URL 后缀与 MIME。 */
export function isWav(bytes: Buffer): boolean {
  return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE";
}

export interface SynthesizedAudio {
  bytes: Buffer;
  mime: string;
  /** 实际用来合成的档位（调用方可能只给了 `undefined` 让本模块问配置）。 */
  engine: TtsEngine;
  /** 音色（豆包 speaker / 百炼 voice）。 */
  voice: string;
}

export interface SynthesizeOptions {
  /** 指定档位；缺省用配置层当前值（`resolveTts`）。 */
  engine?: TtsEngine;
  /** 测试注入；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

/**
 * 豆包 NDJSON → 音频字节。端上 `parse_ndjson_audio` 的 TS 对侧，判据逐条对齐：
 * 非零且非终止码即业务错误；解析不了的行跳过而不是中断（元信息行就长那样）。
 */
export function parseDoubaoNdjson(body: string): Buffer {
  const chunks: Buffer[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let parsed: { code?: number; message?: string; data?: string | null };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      continue;
    }
    const code = parsed.code ?? 0;
    if (code !== 0 && code !== CODE_DONE) {
      throw new TtsSynthesisError(`合成失败 code=${code} ${parsed.message ?? ""}`.trim());
    }
    if (typeof parsed.data === "string" && parsed.data.length > 0) {
      chunks.push(Buffer.from(parsed.data, "base64"));
    }
  }
  const audio = Buffer.concat(chunks);
  if (audio.length === 0) throw new TtsSynthesisError("合成回包里没有音频");
  return audio;
}

/**
 * 豆包协议档（`doubao` 直连火山 / `mock` 打本机 mock-tts）。
 *
 * 两档共用一个函数，因为它们是同一套请求与响应，即端上"换 URL 不换客户端"
 * 不变量的内容。该不变量不再成立时，这里要拆成两个。
 *
 * 向上游要 `pcm` 而不是 `mp3`（ACR-067），回来的裸采样封装成 WAV 再交出。
 */
async function synthesizeDoubaoProtocol(
  url: string,
  apiKey: string,
  resourceId: string,
  speaker: string,
  text: string,
  doFetch: typeof fetch,
): Promise<Buffer> {
  const res = await doFetch(url, {
    method: "POST",
    headers: {
      "X-Api-Key": apiKey,
      "X-Api-Resource-Id": resourceId,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      req_params: {
        text,
        speaker,
        audio_params: { format: "pcm", sample_rate: SAMPLE_RATE },
      },
    }),
  });
  if (!res.ok) {
    throw new TtsSynthesisError(`合成端点 status=${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return pcmToWav(parseDoubaoNdjson(await res.text()));
}

interface DashScopeTtsReply {
  output?: { audio?: { url?: string; data?: string } };
  code?: string;
  message?: string;
}

/**
 * 百炼档（`qwen3-tts-flash`）。非流式回的是 OSS 上的音频 URL（24h 有效），
 * 当场取回字节，因为 URL 会过期。
 *
 * 与 `http/tts-aliyun.ts` 那条门面路由共用本函数：门面只是把这里的字节
 * 再套成豆包 NDJSON 发给端上，DashScope 的调用形状只应存在一份。
 */
export async function synthesizeDashScope(
  values: ReadonlyMap<string, string>,
  text: string,
  voice: string,
  doFetch: typeof fetch,
): Promise<{ bytes: Buffer; mime: string }> {
  const key = values.get("DASHSCOPE_API_KEY");
  if (!key) {
    throw new TtsSynthesisError(
      "DASHSCOPE_API_KEY 未配置——aliyun 档不可用，请在后台配置或切回其它引擎",
    );
  }
  const baseUrl = values.get("DASHSCOPE_BASE_URL")?.trim() || DEFAULT_DASHSCOPE_BASE_URL;
  const model = values.get("ALIYUN_TTS_MODEL")?.trim() || "qwen3-tts-flash";

  const synth = await doFetch(`${baseUrl}/services/aigc/multimodal-generation/generation`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, input: { text, voice, language_type: "Chinese" } }),
  });
  if (!synth.ok) {
    throw new TtsSynthesisError(`dashscope status=${synth.status} ${(await synth.text()).slice(0, 200)}`);
  }
  const reply = (await synth.json()) as DashScopeTtsReply;
  if (typeof reply.code === "string" && reply.code.length > 0 && !reply.output) {
    throw new TtsSynthesisError(`dashscope ${reply.code} ${reply.message ?? ""}`.trim());
  }
  const audioUrl = reply.output?.audio?.url;
  if (!audioUrl) throw new TtsSynthesisError("dashscope 回包无音频 URL");

  const audioRes = await doFetch(audioUrl);
  if (!audioRes.ok) throw new TtsSynthesisError(`音频下载失败 status=${audioRes.status}`);
  const bytes = Buffer.from(await audioRes.arrayBuffer());
  if (bytes.length === 0) throw new TtsSynthesisError("音频下载为空");
  // 百炼当前回 wav。按字节判：端上不解 MP3（ACR-068），回的不是 WAV 就在这里报错，
  // 不把端上解不了的字节发下去。
  if (!isWav(bytes)) {
    throw new TtsSynthesisError("dashscope 回的音频不是 WAV，端上只解 WAV/FLAC/Vorbis（ACR-068）");
  }
  return { bytes, mime: "audio/wav" };
}

/**
 * 按档位合成一段语音。
 *
 * `engine` 缺省取配置层当前档；显式传入时音色也跟随那一档：
 * 拿豆包音色名去打 DashScope 会 400（见 `tts-aliyun.ts`），
 * 所以音色的选取与档位在同一个分支里决定，不在调用方拼。
 */
export async function synthesizeSpeech(
  values: ReadonlyMap<string, string>,
  text: string,
  opts: SynthesizeOptions = {},
): Promise<SynthesizedAudio> {
  const doFetch = opts.fetchImpl ?? fetch;
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new TtsSynthesisError("文本为空，不合成");

  const engine = opts.engine ?? resolveTts(values).engine;

  if (engine === "aliyun") {
    const voice = values.get("ALIYUN_TTS_VOICE")?.trim() || "Cherry";
    const { bytes, mime } = await synthesizeDashScope(values, trimmed, voice, doFetch);
    return { bytes, mime, engine, voice };
  }

  // 豆包协议两档：URL 与"要不要真钥匙"不同，其余一致。
  const resolved = resolveTts(new Map([...values, ["TTS_ENGINE", engine]]));
  const speaker = resolved.speaker;
  if (engine === "doubao") {
    const key = values.get("BYTEDANCE_TTS_API_KEY")?.trim();
    if (!key) {
      // 与端上同一条约束：没有真钥匙就明确报错，不拿占位值去打计费接口，
      // 否则只会得到 401 与笼统的"合成失败"。
      throw new TtsSynthesisError(
        "BYTEDANCE_TTS_API_KEY 未配置——豆包档不可用，请在后台配置或切到其它引擎试听",
      );
    }
    const bytes = await synthesizeDoubaoProtocol(
      resolved.upstreamUrl,
      key,
      resolved.resourceId,
      speaker,
      trimmed,
      doFetch,
    );
    return { bytes, mime: "audio/wav", engine, voice: speaker };
  }

  // mock 档：本机 mock-tts 只校验请求头带没带 Key、不校验值。
  const bytes = await synthesizeDoubaoProtocol(
    resolved.upstreamUrl,
    values.get("BYTEDANCE_TTS_API_KEY")?.trim() || "mock-local",
    resolved.resourceId,
    speaker,
    trimmed,
    doFetch,
  );
  return { bytes, mime: "audio/wav", engine, voice: speaker };
}
