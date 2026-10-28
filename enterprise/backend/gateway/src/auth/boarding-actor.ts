/**
 * 上车声明的代理身份。
 *
 * # 它解决什么
 *
 * 车机拿车辆级 token，`req.userId` 为空（设计裁决 R4），于是所有个人域端点
 * （常用人员、偏好、行程计划…）一律 401，即使已经完成了上车声明。
 *
 * 声明由服务端校验并落库：`POST /v1/session` 核对声明的人
 * 在这辆车的成员名单里，然后把 `(userId, deviceId)` 写进 `Session` 行。
 * 所以"这台车机此刻代表谁"有权威答案可查。
 *
 * 端上出示会话 id（`x-cabinhug-session`；旧名 `x-carlife-session` 并读期内照收），本中间件回查那一行：
 * 设备对得上、会话未关闭、有归属人，才把 `req.userId` 补上。
 * 端上从不自称是谁，自称等于伪造。
 *
 * # 必须校验 deviceId
 *
 * 不校验的话，出示任意一个别人的会话 id 就能冒充成那个人。
 *
 * # 它不授予车主权限
 *
 * 声明只校验"这个人在名单里"，不校验就是本人（架构 §13-23 的已知简化：
 * 家庭信任场景下选错是误操作而非攻击，公开部署前要补 PIN/生物识别）。
 * 所以由声明得来的身份只能读写"这个人自己的"东西，不能行使车主的管理权
 * （改车辆档案、增删成员授权、绑定车机——设计裁决 R7）。
 * `actingViaBoarding` 这个标记就是给那道门用的，见 `requireVehicleOwner`。
 */

import type { NextFunction, Response } from "express";

import type { AuthedRequest } from "./index";

/** 端上出示声明会话的请求头。值是会话 id，不含任何身份主张。 */
export const BOARDING_SESSION_HEADER = "x-cabinhug-session";

/**
 * 改名前的请求头（ACR-051）。已装的旧版客户端还在发它，并读期内照收；
 * 两个头都在时以新名为准。
 */
export const LEGACY_BOARDING_SESSION_HEADER = "x-carlife-session";

let legacyHeaderNoticed = false;

/** 取声明会话 id：新名优先，旧名兜底，旧名第一次出现时打一条弃用日志。 */
function boardingSessionHeader(req: BoardingActorRequest): string | undefined {
  const current = req.header(BOARDING_SESSION_HEADER);
  if (current !== undefined) return current;
  const legacy = req.header(LEGACY_BOARDING_SESSION_HEADER);
  if (legacy !== undefined && !legacyHeaderNoticed) {
    legacyHeaderNoticed = true;
    console.warn(
      `[gateway] 收到旧请求头 ${LEGACY_BOARDING_SESSION_HEADER}（已弃用，改用 ${BOARDING_SESSION_HEADER}）；并读期内照常处理`,
    );
  }
  return legacy;
}

export interface BoardingActorRequest extends AuthedRequest {
  /** 身份来自上车声明而非账号登录，不得据此授予车主权限。 */
  actingViaBoarding?: boolean;
}

interface SessionActorSource {
  sessionActor(
    sessionId: string,
  ): Promise<{ userId: string | null; deviceId: string | null } | undefined>;
}

export function createBoardingActorMiddleware(chat: SessionActorSource) {
  return async function boardingActor(
    req: BoardingActorRequest,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    // 只对"车辆级 token 且还没有人"生效：人的 token 一律不受影响。
    if (req.userId || !req.vehicleVin || !req.deviceId) {
      next();
      return;
    }
    const raw = boardingSessionHeader(req);
    if (!raw) {
      next();
      return;
    }
    let actor;
    try {
      actor = await chat.sessionActor(raw);
    } catch (err) {
      // 库不可用不该变成"没声明"：如实放过去，后面的端点会照常 401。
      // 报 500 会把一次抖动升级成"车机身份全丢"。
      console.error("[boarding-actor] 会话回查失败", err);
      next();
      return;
    }
    // 会话不存在 / 访客 / 已关闭 / 不是这台设备建的：一律不补身份。
    if (!actor || !actor.userId || actor.deviceId !== req.deviceId) {
      next();
      return;
    }
    req.userId = actor.userId;
    req.actingViaBoarding = true;
    next();
  };
}
