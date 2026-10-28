/**
 * 能力开关的端上一侧（ACR-056）。
 *
 *   GET /v1/capabilities → { off: Capability[], refreshMs }
 *
 * 端上据此隐藏入口（ACR-057）：拍照问诊关闭时不显示首页卡与相机按钮，而不是让车主拍完才被拒。
 * 入口隐藏只是体验，拦截在服务端：照片与视频的上传、带附件的消息各有一道（见 `photoOffBody` 的调用方）。
 *
 * # 读不到时回 503，不回「全开」
 *
 * 读取口（`readCapabilitiesOff`）自己会退回 env，正常情况下不会抛。真抛到这里时回 503：
 * 端上收到 503 沿用上一次的值，比替它决定「全开」安全——本地一体版关掉的入口不该因一次抖动冒出来。
 */

import { Router, type Response } from "express";

import { CAPABILITIES, type CapabilitiesPayload, type Capability } from "@cabinhug/shared";

import type { AuthedRequest } from "../auth";

/** 端上多久复查一次。与 ConfigStore 的 30 秒缓存同量级，后台改值约 30 秒到端。 */
const REFRESH_MS = 30_000;

/** 拍照问诊关闭时，上传与带附件的消息共用的拒绝体。reason 面向车主：说清是这一版没有，不是出错了。 */
export const photoOffBody = {
  error: "capability_off",
  capability: "photo-diagnosis",
  reason: "这一版还没有开放拍照问诊，照片和视频暂时发不了。",
} as const;

/** 语音关闭时（ACR-059），语音消息、转写与播报共用的拒绝体。端上收到它应改用文字，不重试。 */
export const voiceOffBody = {
  error: "capability_off",
  capability: "voice",
  reason: "这一版还没有开放语音，请改用文字输入。",
} as const;

export function createCapabilitiesRouter(readOff: () => Promise<ReadonlySet<Capability>>): Router {
  const router = Router();

  router.get("/v1/capabilities", async (req: AuthedRequest, res: Response) => {
    // 人或车机都读得到：内容与身份无关，全局一份。
    if (!req.userId && !req.vehicleVin) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    let off: ReadonlySet<Capability>;
    try {
      off = await readOff();
    } catch (err) {
      console.error("[capabilities] 开关读取失败，端上将沿用上一次的值", err);
      res.status(503).json({ error: "config_unavailable" });
      return;
    }
    // 按闭集顺序输出：同一配置每次下发的字节一样，端上不会因顺序不同误判为变化。
    const payload: CapabilitiesPayload = { off: CAPABILITIES.filter((c) => off.has(c)), refreshMs: REFRESH_MS };
    res.json(payload);
  });

  return router;
}
