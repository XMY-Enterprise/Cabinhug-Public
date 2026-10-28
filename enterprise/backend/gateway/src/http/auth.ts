/**
 * 登录与刷新端点（FL-07 F-07-01/02）。
 *
 * # 这条路由挂在鉴权中间件之前
 *
 * 登录发生在还没有身份的时候。它与后台路由一样属于"自带鉴权"的那一类，
 * 鉴权方式就是口令本身。
 *
 * # 刷新也要查库
 *
 * refresh 有效期 14 天（车机长离线）。若刷新只验签名，被撤销的设备
 * 在 14 天里仍能换出新的 access token，撤销形同虚设。
 * 所以刷新路径与请求路径查同样的东西：账号还在吗、设备还生效吗。
 */

import { Router, json, type Response } from "express";

import type { DeviceRepository, UserRepository } from "@cabinhug/db";

import { issueToken, verifyToken, ACCESS_TTL_SEC } from "../auth/jwt";
import { verifyPassword } from "../auth/password";

export interface AuthRouterDeps {
  users: Pick<UserRepository, "findByUsername" | "findById">;
  devices: Pick<DeviceRepository, "findActive">;
}

/** 登录/刷新失败一律这一句。不区分原因：区分即构成账号存在性探测通道。 */
function unauthorized(res: Response): void {
  res.status(401).json({ error: "unauthorized" });
}

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const router = Router();

  /**
   * 登录。`deviceId` 可选：带上则 token 与设备绑定，
   * 之后该设备被撤销时这枚 token 立刻失效（`createJwtAuth` 会查）。
   */
  router.post("/v1/auth/login", json(), async (req, res) => {
    const { username, password, deviceId } = (req.body ?? {}) as {
      username?: unknown;
      password?: unknown;
      deviceId?: unknown;
    };
    if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
      unauthorized(res);
      return;
    }

    const user = await deps.users.findByUsername(username);
    /*
     * 用户不存在时照样跑一次口令校验：直接返回会让"不存在"比"口令错"
     * 快一个数量级（scrypt 是刻意慢的），响应时间就成了账号枚举通道。
     * 拿一个不可能匹配的散列去比，耗时与真实路径同量级。
     */
    const stored = user?.passwordHash ?? "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const ok = await verifyPassword(password, stored);
    if (!ok || !user) {
      unauthorized(res);
      return;
    }

    const boundDevice = typeof deviceId === "string" && deviceId ? deviceId : undefined;
    res.json({
      accessToken: issueToken({ sub: user.id, kind: "user", use: "access", deviceId: boundDevice }),
      refreshToken: issueToken({
        sub: user.id,
        kind: "user",
        use: "refresh",
        deviceId: boundDevice,
      }),
      expiresIn: ACCESS_TTL_SEC,
      user: { id: user.id, displayName: user.displayName ?? null },
    });
  });

  /** 刷新。人 token 与车辆 token 都走这里，区别只在查什么。 */
  router.post("/v1/auth/refresh", json(), async (req, res) => {
    const { refreshToken } = (req.body ?? {}) as { refreshToken?: unknown };
    if (typeof refreshToken !== "string" || !refreshToken) {
      unauthorized(res);
      return;
    }
    const claims = verifyToken(refreshToken);
    if (!claims || claims.use !== "refresh") {
      unauthorized(res);
      return;
    }

    if (claims.kind === "vehicle") {
      const device = await deps.devices.findActive(claims.sub);
      if (!device?.vehicleVin) {
        unauthorized(res);
        return;
      }
      /*
       * 必须把 vin 回给端上。这里读的 `device.vehicleVin` 是绑定的当前值：
       * 车辆补录 VIN（`PEND-xxx` → 真 VIN）或换绑之后，它与端上配对时记下的值不同。
       *
       * 只回 accessToken 时新 vin 只在 token 里，端上无从得知，`bound_vin()` 会停在
       * 已不存在的 `PEND-` 上，表现为车机"已绑定"却列不出成员（404 vehicle_not_found）。
       */
      res.json({
        accessToken: issueToken({
          sub: device.id,
          kind: "vehicle",
          use: "access",
          deviceId: device.id,
          vin: device.vehicleVin,
        }),
        expiresIn: ACCESS_TTL_SEC,
        vin: device.vehicleVin,
      });
      return;
    }

    const user = await deps.users.findById(claims.sub);
    if (!user) {
      unauthorized(res);
      return;
    }
    if (claims.deviceId) {
      const device = await deps.devices.findActive(claims.deviceId);
      if (!device || device.userId !== user.id) {
        unauthorized(res);
        return;
      }
    }
    res.json({
      accessToken: issueToken({
        sub: user.id,
        kind: "user",
        use: "access",
        ...(claims.deviceId ? { deviceId: claims.deviceId } : {}),
      }),
      expiresIn: ACCESS_TTL_SEC,
    });
  });

  return router;
}
