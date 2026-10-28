/**
 * 车内音乐的让路端点：播报期间把音乐压低，播完恢复。
 *
 * # 它不认车辆
 *
 * 端侧没有"当前这辆车"（vin 在前端 state 里，而播报发生在 Rust 最底层）。
 * 按登录用户的默认车解析会失败：默认车未必绑了车机，正在放歌的可能是另一辆，
 * 表现只是"音乐没让路"。
 *
 * 让路的物理事实是"主机这套喇叭现在要让给播报"，而主机只有一套喇叭。
 * 所以它交给车机侧的 `POST /media/duck`，那一层认的是出声位不是车辆 id，
 * 绑定、默认车、多车都不参与。
 *
 * # 它不是绑定端点的一部分
 *
 * `vehicle-cabin.ts` 管绑定三态（未绑定/离线/已绑定），属于设备接入；
 * 让路是播放器命令。两者共用 `CabinClient` 但职责不同，分开放在两个路由文件里。
 *
 * # 失败一律 204，播报不等它
 *
 * 车机没连上、没有默认车、mock 不可用，对播报来说都是"没什么可压的"。
 * 端侧收到错误也无法处理（不能因此不说话），每一种错误的正确处理都是忽略，
 * 所以统一回 204。真正的原因记在网关日志里。
 *
 * ────────────────────────────────────────────────────────────
 *
 * # 车机端的播放通路：三个端点，失败语义与 duck 相反
 *
 *   GET  /v1/cabin/media/player          播放器现状
 *   POST /v1/cabin/media/sink            认领 + 心跳（响应体也是播放器现状）
 *   GET  /v1/cabin/media/tracks/:id      曲目字节（Range 原样往返）
 *
 * 车机端要自己出声。mock-cabin 的三个播放后端都是 spawn 本进程主机上的二进制，
 * 部署后那台机器是服务器，出声也在服务器上，所以字节要能被端拉走。
 *
 * 失败必须如实报，与上面的 204 相反：duck 失败的后果只是音乐没压低，
 * 而这三个端点失败的后果是车主听不到歌，端要据此停播、助手要据此转述原因。
 * 一律 204 的话，端无法得知播放已失败。
 *
 * # VIN 从 token 取，不从路径或请求体取
 *
 * 端上有 `bound_vin()`，但信它就等于让端自己声明在操作哪辆车。
 * `req.vehicleVin` 来自设备记录（`auth/index.ts` 校验过 token 的 vin 与库里一致），
 * 不是 token 自称的。也不退回"按登录用户的默认车"，原因见本文件头第一节。
 *
 * # 网关在这一跳上只做转发
 *
 * 出声位的租约、后来者赢、`audible` 的取值链都在 mock/tools 那一侧（设计 §3）。
 * 这里没有业务判断，"该不该出声"的判断不写在本文件。
 */

import { Readable } from "node:stream";

import { Router, json } from "express";
import type { Response } from "express";

import { CabinUnboundError, ToolError, type CabinClient, type CabinSinkBeat } from "@cabinhug/tools";

import type { AuthedRequest } from "../auth";

export interface CabinMediaDeps {
  /** 未注入 = MOCK_CABIN_URL 没配。让路静默跳过：没有车机就没有音乐可压。 */
  cabin?: CabinClient;
}

/** 压到原音量的百分之几。车机侧也有默认值，这里显式给出，使口径写在一处。 */
const DUCK_TO_PERCENT = 30;

export function createCabinMediaRouter(deps: CabinMediaDeps): Router {
  const router = Router();

  router.post("/v1/cabin/media/duck", async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    // 先回，再做。让路是装饰性的，播报不等它：端侧这一跳是
    // fire-and-forget，网关这边也不做同步等待。
    res.status(204).end();

    const on = (req.body as { on?: unknown })?.on !== false;
    const holdMs = (req.body as { holdMs?: unknown })?.holdMs;

    try {
      if (!deps.cabin) return;
      await deps.cabin.mediaDuck({
        on,
        toPercent: DUCK_TO_PERCENT,
        ...(typeof holdMs === "number" ? { holdMs } : {}),
      });
    } catch (err) {
      // 记一行日志：让路失败的后果只是音乐没压低，不影响说话，但原因要可查。
      console.warn(
        `[cabin] 让路失败（on=${on}）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // ── 车机端播放通路 ────────────────────────────────

  /**
   * 三个端点共用的门。返回 VIN，或者已经把拒绝写完了（返回 null）。
   *
   * 集中在一处判断 `deps.cabin` 的空值，避免某处遗漏时表现为 500 而不是"车机没接入"。
   */
  const cockpitVin = (req: AuthedRequest, res: Response): string | null => {
    if (!req.vehicleVin) {
      res.status(403).json({
        error: "cockpit_token_required",
        hint: "这三个端点只给绑定车机用：请用车机的设备令牌调用",
      });
      return null;
    }
    if (!deps.cabin) {
      res.status(503).json({
        error: "cabin_not_configured",
        hint: "网关没有配 MOCK_CABIN_URL，车机侧没有接入",
      });
      return null;
    }
    return req.vehicleVin;
  };

  /**
   * 错误映射。`ToolError` 的三档由上游分好，这里只换算 HTTP 状态码，
   * 不重新判断，避免出现第二处真相源。
   */
  const sendCabinError = (res: Response, err: unknown): void => {
    if (err instanceof CabinUnboundError) {
      res.status(409).json({ error: "cabin_unbound", hint: err.message });
      return;
    }
    if (err instanceof ToolError) {
      res.status(err.category === "invalid" ? 400 : 502).json({ error: err.category, hint: err.message });
      return;
    }
    res.status(502).json({ error: "upstream", hint: err instanceof Error ? err.message : String(err) });
  };

  router.get("/v1/cabin/media/player", async (req: AuthedRequest, res: Response) => {
    const vin = cockpitVin(req, res);
    if (!vin) return;
    try {
      res.json(await deps.cabin!.mediaPlayer(vin));
    } catch (err) {
      sendCabinError(res, err);
    }
  });

  /**
   * 心跳即取状态：一次往返完成两件事。
   *
   * 分成两个端点时端每秒要打两次，且两次之间状态可能变化，
   * 端拿到的"该放哪首"与"刚上报的进度"会对不上。
   */
  router.post("/v1/cabin/media/sink", json({ limit: "8kb" }), async (req: AuthedRequest, res: Response) => {
    const vin = cockpitVin(req, res);
    if (!vin) return;
    const body = (req.body ?? {}) as Partial<CabinSinkBeat>;
    const sinkId = typeof body.sinkId === "string" ? body.sinkId.trim() : "";
    if (!sinkId) {
      res.status(400).json({ error: "sink_id_required", hint: "心跳要带 sinkId" });
      return;
    }
    try {
      res.json(await deps.cabin!.mediaSink(vin, { ...body, sinkId }));
    } catch (err) {
      sendCabinError(res, err);
    }
  });

  /**
   * 曲目字节，原样往返：状态码、四个头、字节流都不重写。
   *
   * 不缓存：没有失效策略的缓存会让换歌之后还放旧的。
   * 不接配额：它不计费，接上只会让配额报表失真。
   */
  router.get("/v1/cabin/media/tracks/:trackId", async (req: AuthedRequest, res: Response) => {
    if (!cockpitVin(req, res)) return;
    try {
      const upstream = await deps.cabin!.mediaTrack(String(req.params.trackId), req.header("range"));
      res.writeHead(upstream.status, upstream.headers);
      if (!upstream.body) {
        res.end();
        return;
      }
      // 边收边转发。`arrayBuffer()` 会把整曲读进内存，也会让 Range 失效。
      Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
    } catch (err) {
      sendCabinError(res, err);
    }
  });

  return router;
}
