/**
 * 端上取合成端点（配合后台的 TTS 引擎开关）。
 *
 *   GET /v1/tts/config → { engine, url, resourceId, speaker, billed, streamSpeech, refreshMs }
 *
 * # 用途
 *
 * 合成客户端在端上（`clients/shared/rust/cabinhug-net/src/tts.rs`）。本端点把后台的
 * 引擎切换送到端上，端上按 `refreshMs` 复查，约 30s 内自动切换，不重启客户端。
 *
 * # 它不下发密钥
 *
 * 响应里没有 API Key。A 类密钥「只写不读、全链路掩码」（§8.2），
 * 本端点不因"端上也需要"而例外。
 *
 * 端上不需要任何 vendor 密钥（ACR-018）：下发的 url 恒是网关自己的
 * `/v1/tts/speech`，密钥留在服务端。`keyRequired` 因此恒为 false，字段保留
 * 只为兼容旧客户端（它读不到会回落 `billed`，从而误以为本机得有 key）。
 *
 * # 不可用时给上一次的值，不给空
 *
 * 配置层读不到（DB 抖动）时 `ConfigStore` 自己会沿用缓存；真到了抛错那一步，
 * 这里回 503 而不是回一个"默认配置"：端上收到 503 会继续用上一次拿到的值，
 * 比切回某个默认端点安全，默认端点可能是计费档。
 */

import { Router } from "express";
import type { Response } from "express";

import { resolveTts, type ConfigStore } from "@cabinhug/db";

import type { AuthedRequest } from "../auth";

/**
 * 端上多久复查一次。与 `ConfigStore` 的 TTL 同量级：比它小没意义
 * （网关自己还在吃缓存），比它大则后台"约 30s 生效"不成立。
 */
const REFRESH_MS = 30_000;

export function createTtsConfigRouter(config: ConfigStore): Router {
  const router = Router();

  router.get("/v1/tts/config", async (req: AuthedRequest, res: Response) => {
    // 人或车机都读得到：播报配置里没有任何个人数据，
    // 而车机是主要的播报端，只认人的话 TTS 引擎热切换到不了车机。
    if (!req.userId && !req.vehicleVin) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    let values: ReadonlyMap<string, string>;
    try {
      values = await config.runtimeValues();
    } catch (err) {
      console.error("[tts-config] 配置读取失败，端上将沿用上一次的值", err);
      res.status(503).json({ error: "config_unavailable" });
      return;
    }
    const resolved = resolveTts(values);
    // 下发的 url 恒是网关自己的合成端点（ACR-018，三档皆然）。db 层给的是
    // 相对路径（它不知道网关对外叫什么名字），按本次请求的 Host 补成绝对地址：
    // 端上能打到 /v1/tts/config，就一定能打到同源的 /v1/tts/speech。
    //
    // `startsWith("/")` 的判断保留：真值恒为真，但它同时是一道断言，
    // 若 resolveTts 下发绝对地址（即把供应商地址交给端上），
    // 这里原样透传而不是拼出畸形 URL，故障形态可读。
    const url = resolved.url.startsWith("/")
      ? `${req.protocol}://${req.get("host")}${resolved.url}`
      : resolved.url;
    // `runtimeValues()` 的返回值含明文密钥，只能逐字段挑出来，
    // 不能 spread，否则会把 DEEPSEEK_API_KEY 一起发到端上。
    res.json({
      engine: resolved.engine,
      url,
      resourceId: resolved.resourceId,
      speaker: resolved.speaker,
      billed: resolved.billed,
      // 端上「无 key 拒绝合成」的判据（ACR-015）。与 billed 分开下发：
      // aliyun 档计费，但密钥在网关侧。
      keyRequired: resolved.keyRequired,
      // 边收边播（流式播报）。默认关：它改变的是开口时机，
      // 听感需要在真车上判断。
      streamSpeech: values.get("TTS_STREAM_SPEECH")?.trim() === "on",
      refreshMs: REFRESH_MS,
    });
  });

  return router;
}
