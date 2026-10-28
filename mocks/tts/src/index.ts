/**
 * mock-tts：模拟字节 openspeech 的 seed-tts-2.0（形态同 mock-dealer / mock-cabin）。
 *
 * # mock 的是「接口」，不是「合成」
 *
 * 端点、请求头、请求体、响应的 NDJSON 分帧、base64 分片、终止码，
 * 逐项与 `clients/shared/rust/cabinhug-net/src/tts.rs` 的真实客户端对齐；
 * 客户端无需改动，只把 `BYTEDANCE_TTS_URL` 指过来。
 * 音频由本机 `say` 生成（不复用 cockpit 里 `CARLIFE_TTS=say` 短路分支的原因见 synth.ts 文件头）。
 *
 *   POST /api/v3/tts/unidirectional
 *   headers: X-Api-Key, X-Api-Resource-Id, Content-Type: application/json
 *   body:    {"req_params":{"text","speaker","audio_params":{"format","sample_rate"}}}
 *
 *   200 application/json，分行流式：
 *     {"code":0,"data":"<base64 音频分片>"}      ← 可多条
 *     {"code":0,"data":null,"sentence":{…}}      ← 句级元信息
 *     {"code":20000000,"message":"OK","data":null} ← 正常终止
 *
 * # 与 mock-dealer 相同的硬约束
 *
 * 不 import 本仓任何业务包（不引 `@cabinhug/*`），不连 PG/Redis/MinIO，
 * 它代表外部服务。可被单独停掉：停掉后 cockpit 如实打出「合成失败，降级 say」。
 *
 * # 记录「字数」
 *
 * 真实服务按合成字数计费。mock 打出同一行字数日志作为本地对账单，
 * 播报链路重复触发时可在这里直接看到字数放大。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  SynthError,
  detectEncoder,
  isSupportedFormat,
  installedVoices,
  resolveVoice,
  synthesize,
  type AudioFormat,
} from "./synth";

/** 真实服务的正常终止码。 */
export const CODE_DONE = 20_000_000;

/** 与真实服务同形的业务错误码（HTTP 仍是 200，错误在 body 里）。 */
const CODE_BAD_REQUEST = 40_000_001;

const DEFAULT_SAMPLE_RATE = 24_000;
/** 分片大小。真实服务按合成进度切，这里按字节切，分帧行为一致。 */
const CHUNK_BYTES = Number(process.env.MOCK_TTS_CHUNK_BYTES ?? 16 * 1024);
/** 片间延时。默认 0；调大用来演示「流式返回」与首字延迟。 */
const CHUNK_DELAY_MS = Number(process.env.MOCK_TTS_CHUNK_DELAY_MS ?? 0);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ReqParams {
  text?: unknown;
  speaker?: unknown;
  audio_params?: { format?: unknown; sample_rate?: unknown } | null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** 一行 NDJSON。真实服务每帧一行、行尾 `\n`，客户端按行解析。 */
function line(res: ServerResponse, obj: unknown): void {
  res.write(`${JSON.stringify(obj)}\n`);
}

/** 业务错误：HTTP 200 + 单行错误帧，走客户端的 `TtsError::Service` 分支。 */
function serviceError(res: ServerResponse, code: number, message: string): void {
  if (!res.headersSent) {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  }
  line(res, { code, message, data: null });
  res.end();
}

async function handleSynthesis(req: IncomingMessage, res: ServerResponse): Promise<void> {
  /*
   * 鉴权失败用 HTTP 4xx 而不是业务码：真实网关在业务逻辑之前拦截，
   * 客户端对应 `TtsError::Status(401)`。"密钥错了"与"参数错了"保持两种错误形状，
   * 与真实服务一致。
   */
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    return json(res, 401, { code: 40_100_001, message: "missing X-Api-Key" });
  }
  const resourceId = req.headers["x-api-resource-id"];
  if (typeof resourceId !== "string" || resourceId.trim() === "") {
    return json(res, 401, { code: 40_100_002, message: "missing X-Api-Resource-Id" });
  }

  let params: ReqParams;
  try {
    const parsed = JSON.parse(await readBody(req)) as { req_params?: ReqParams };
    if (!parsed || typeof parsed !== "object" || !parsed.req_params) {
      return serviceError(res, CODE_BAD_REQUEST, "req_params required");
    }
    params = parsed.req_params;
  } catch {
    return serviceError(res, CODE_BAD_REQUEST, "invalid json body");
  }

  const text = typeof params.text === "string" ? params.text : "";
  if (text.trim() === "") {
    return serviceError(res, CODE_BAD_REQUEST, "req_params.text required");
  }
  const speaker = typeof params.speaker === "string" ? params.speaker : undefined;

  const rawFormat = typeof params.audio_params?.format === "string" ? params.audio_params.format : "mp3";
  if (!isSupportedFormat(rawFormat)) {
    return serviceError(res, CODE_BAD_REQUEST, `unsupported audio format: ${rawFormat}`);
  }
  const format: AudioFormat = rawFormat;
  const sampleRate =
    typeof params.audio_params?.sample_rate === "number" && params.audio_params.sample_rate > 0
      ? params.audio_params.sample_rate
      : DEFAULT_SAMPLE_RATE;

  const started = Date.now();
  let audio: Buffer;
  try {
    audio = await synthesize({ text, speaker, format, sampleRate });
  } catch (e) {
    if (e instanceof SynthError) return serviceError(res, e.code, e.message);
    throw e;
  }

  // 与 cockpit 的 `[tts] 合成 N 字` 同源的本地对账单（见文件头）。
  console.log(
    `[mock-tts] 合成 ${[...text].length} 字（${format}@${sampleRate}, speaker=${speaker ?? "-"}）→ ` +
      `${audio.length} bytes，耗时 ${Date.now() - started}ms`,
  );

  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  for (let offset = 0; offset < audio.length; offset += CHUNK_BYTES) {
    line(res, { code: 0, data: audio.subarray(offset, offset + CHUNK_BYTES).toString("base64") });
    if (CHUNK_DELAY_MS > 0) await sleep(CHUNK_DELAY_MS);
  }
  // 句级元信息帧：真实服务会插，客户端要能跳过它而不把 data:null 当成结束。
  line(res, {
    code: 0,
    data: null,
    sentence: { text, start_time: 0, end_time: null, provenance: "simulated" },
  });
  line(res, { code: CODE_DONE, message: "OK", data: null });
  res.end();
}

export function createTtsServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        return json(res, 200, {
          ok: true,
          service: "mock-tts",
          engine: "macos-say",
          encoder: await detectEncoder(),
          voice: await resolveVoice(undefined),
          provenance: "simulated",
        });
      }
      if (req.method === "GET" && url.pathname === "/voices") {
        return json(res, 200, { voices: await installedVoices() });
      }
      if (req.method === "POST" && url.pathname === "/api/v3/tts/unidirectional") {
        return await handleSynthesis(req, res);
      }
      json(res, 404, { error: "not_found", path: url.pathname });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (res.headersSent) {
        // 已开始发帧，只能用错误帧收尾：半截 NDJSON 会让客户端
        // 拿到一段能解码但缺尾巴的音频，比明确失败更难排查。
        line(res, { code: 50_000_000, message: detail, data: null });
        return res.end();
      }
      json(res, 500, { error: "internal", detail });
    }
  });
}
