/**
 * middleware —— 请求日志。
 *
 * 每条日志带 `session_id`（§3"贯穿全链路，关联短期记忆与日志"），
 * 作为排障与审计的关联键（FL-07）。限流/熔断归 FL-10，不在此处。
 */

import type { NextFunction, Request, Response } from "express";

export function requestLog(req: Request, res: Response, next: NextFunction): void {
  const startedAt = Date.now();
  res.on("finish", () => {
    // 中间件层 req.params 未填充（路由匹配前），从路径提取。
    const sessionId = /^\/v1\/session\/([^/]+)/.exec(req.path)?.[1] ?? "-";
    /*
     * `by=` 标明请求发起方，多端同时在线时用于区分车机与手机的请求。
     *
     * 鉴权中间件跑在本中间件之后，这些字段在 finish 时才填好，
     * 所以必须在 `res.on("finish")` 里读，不能在 next() 之前读。
     *
     * 不打 token、不打完整 VIN：日志会被复制进工单和聊天记录。
     * 车机打 vin 末 4 位（够定位是哪辆车），人打 userId 前 8 位。
     */
    const a = req as AuthedLike;
    const by = a.tokenKind === "vehicle"
      ? `车机:${a.vehicleVin?.slice(-4) ?? "?"}`
      : a.userId
        ? `人:${a.userId.slice(0, 8)}`
        : "未鉴权";
    console.log(
      `[gateway] ${req.method} ${req.path} by=${by} session=${sessionId} status=${res.statusCode} ${Date.now() - startedAt}ms`,
    );
  });
  next();
}

/** 鉴权中间件往 req 上挂的那几个字段（`enterprise/backend/gateway/src/auth` 的 `AuthedRequest`）。 */
interface AuthedLike {
  userId?: string;
  vehicleVin?: string;
  tokenKind?: "user" | "vehicle";
}
