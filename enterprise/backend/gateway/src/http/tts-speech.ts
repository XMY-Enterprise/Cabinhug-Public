/**
 * 端上的合成端点，三档共用唯一一个（ACR-018）。
 *
 *   POST /v1/tts/speech   请求体 = 豆包 unidirectional 形状（req_params.text）
 *                         响应   = 豆包 NDJSON（{"code":0,"data":"<base64>"}… + 20000000 终止行）
 *
 * # 端上只有一个地址
 *
 * 按档位下发不同地址时，端上必须持有 `BYTEDANCE_TTS_API_KEY` 才能打 doubao 与 mock 档，
 * A 类密钥要预先装在每一台车机上，比下发更难收回；日用量闸门也看不见那两档的流量。
 *
 * 车机与手机是面向车主的消费端，只认识一个后端。所以三档一律打这里，
 * 由本路由按当前档位分流（`tts/synthesize.ts` 的 `synthesizeSpeech`），
 * 密钥一律留在服务端。
 *
 * # 协议转换也收在这一处
 *
 * `clients/shared/rust/cabinhug-net/src/tts.rs` 的不变量是端上只有一个 URL，
 * 请求体与响应都是豆包形状。qwen3-tts-flash 的协议完全不同（DashScope
 * multimodal-generation，音频回 OSS URL），协议差异全部消化在服务端，不带进各端。
 *
 * # 密钥边界
 *
 * `DASHSCOPE_API_KEY` 与 `BYTEDANCE_TTS_API_KEY` 都只在服务端被读取，
 * 不下发到端上（§8.2 A 类只写不读）。端上打本端点带的是设备 JWT
 * （挂在网关鉴权中间件之后）；豆包协议的 `X-Api-Key` 请求头在这里被忽略，
 * 旧客户端带来的占位值也不参与鉴权。
 *
 * # 音色由服务端定
 *
 * 请求体里的 `req_params.speaker` 不被采用：它本就是 `/v1/tts/config` 下发的值，
 * 没有新信息；且音色必须与档位一起决定（拿豆包音色名打 DashScope 会 400）。
 * 两者在 `synthesizeSpeech` 的同一个分支里决定。
 *
 * # 失败形态
 *
 * 全部失败都折成豆包 NDJSON 的非零 code 行（端上 `parse_ndjson_audio` 会转成
 * `TtsError::Service` 并降级 say，日志里能看到 message）。不用 HTTP 非 200：
 * 那会丢掉 message，端上只剩一个数字。
 */

import { Router, json } from "express";
import type { Response } from "express";

import type { ConfigStore } from "@cabinhug/db";

import type { AuthedRequest } from "../auth";
import type { DailyQuota } from "../quota/daily-quota";
import { voiceOffBody } from "./capabilities";
import { synthesizeSpeech, TtsSynthesisError } from "../tts/synthesize";

/** 豆包协议的正常终止码，与 cabinhug-net::tts::CODE_DONE 同值。 */
const CODE_DONE = 20_000_000;
/** 门面侧错误统一用这个 code（豆包 4xxxxxxx 段是它自己的业务码，不冒用）。 */
const CODE_FACADE_ERROR = 50_000_000;

/** NDJSON 分片的原始字节数。豆包也是分片回的，端上按行拼接，大小不敏感。 */
const CHUNK_BYTES = 48 * 1024;

/** 音频字节 → 豆包 NDJSON 行（纯函数，可单测）。 */
export function audioToDoubaoNdjson(bytes: Buffer): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK_BYTES) {
    lines.push(JSON.stringify({ code: 0, data: bytes.subarray(i, i + CHUNK_BYTES).toString("base64") }));
  }
  lines.push(JSON.stringify({ code: CODE_DONE, message: "OK", data: null }));
  return lines.join("\n") + "\n";
}

function ndjsonError(res: Response, message: string): void {
  // 门面的失败也走 200 + NDJSON：HTTP 状态码进不了端上的错误消息。
  res.status(200).type("application/x-ndjson");
  res.end(JSON.stringify({ code: CODE_FACADE_ERROR, message, data: null }) + "\n");
}

export interface TtsSpeechOptions {
  /** 测试注入；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 语音是否关闭（ACR-059）。关闭时回 403，不调合成供应商。不注入 = 不关。 */
  voiceOff?: () => Promise<boolean>;
  /**
   * 日用量闸门（ACR-016）。不注入即不设闸。
   *
   * 计的是字符数不是次数：这一档按字符计费，按次数设闸挡不住
   * "一次合成一整篇"，重复播报的成本体现在字符数上。
   */
  quota?: DailyQuota;
}

/**
 * 旧路径：ACR-018 之前 aliyun 档的独立地址。已在运行的旧客户端二进制
 * 可能仍缓存着 `/v1/tts/config` 给过的这个地址（复查间隔 30s，但进程
 * 可能几天不重启）。同一个 handler 挂两条路径，保证升级期间端不会失声。
 *
 * 删除条件：两个端都发过一次新版本之后（届时连同 `LEGACY_ALIYUN_TTS_GATEWAY_PATH`
 * 一起删）。保留它只为兼容。
 */
const LEGACY_PATH = "/v1/tts/aliyun";

export function createTtsSpeechRouter(config: ConfigStore, opts: TtsSpeechOptions = {}): Router {
  const doFetch = opts.fetchImpl ?? fetch;
  const router = Router();

  router.post(["/v1/tts/speech", LEGACY_PATH], json(), async (req: AuthedRequest, res: Response) => {
    // 与 /v1/tts/config 同一条判据：车机以 vehicleVin 身份鉴权，
    // 而车机是主要的播报端，只认人的话合成到不了车机。
    if (!req.userId && !req.vehicleVin) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if ((await opts.voiceOff?.()) === true) {
      res.status(403).json(voiceOffBody);
      return;
    }

    const text = (req.body as { req_params?: { text?: unknown; speaker?: unknown } } | undefined)
      ?.req_params?.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      ndjsonError(res, "req_params.text 缺失或为空");
      return;
    }

    let values: ReadonlyMap<string, string>;
    try {
      values = await config.runtimeValues();
    } catch (err) {
      console.error("[tts-speech] 配置读取失败", err);
      ndjsonError(res, "config_unavailable");
      return;
    }

    // 日用量闸门（ACR-016）。放在取密钥之前，超限即停止。
    // 超限回 NDJSON 错误行而不是 HTTP 非 200：端上据此走既有降级路径到系统 say，
    // message 里的原因供运维事后排查声音变化。
    if (opts.quota) {
      const limit = Number(values.get("TTS_DAILY_CHAR_LIMIT"));
      const decision = await opts.quota.consume(
        "tts",
        text.length,
        Number.isFinite(limit) ? limit : 0,
      );
      if (!decision.allowed) {
        console.warn(`[quota] 云 TTS 今日字符数 ${decision.used} 已超上界 ${decision.limit}——本次降级端上 say`);
        ndjsonError(
          res,
          `今日合成字符已达上界（${decision.used}/${decision.limit}），本次降级本地播报；` +
            `要继续用云端音色请在后台调高 TTS_DAILY_CHAR_LIMIT 或置 0 解除`,
        );
        return;
      }
    }

    try {
      /*
       * 按当前档位分流。合成的调用形状只有一份（`tts/synthesize.ts`），
       * 控制台试听走同一个函数，保证两处行为一致。
       *
       * 不传 `engine`：由它自己问配置层，端上不能指定档位，
       * 否则"后台切引擎"只是建议而不是开关。
       */
      const { bytes, engine } = await synthesizeSpeech(values, text, { fetchImpl: doFetch });
      // 计费档留一行痕：与端上那行合成日志一样，这是本地对账的原始记录。
      if (engine !== "mock") {
        console.log(`[tts-speech] ${engine} 合成 ${text.length} 字，${bytes.length} bytes`);
      }
      res.status(200).type("application/x-ndjson");
      res.end(audioToDoubaoNdjson(bytes));
    } catch (err) {
      // 合成侧的失败消息面向运维，原样折进 NDJSON 行（端上日志里看得到）。
      ndjsonError(
        res,
        err instanceof TtsSynthesisError
          ? err.message
          : `合成失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  return router;
}
