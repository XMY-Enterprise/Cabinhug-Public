/**
 * 车辆 ↔ 车机绑定的端点（F-49-11）。
 *
 * 三态必须可区分：未绑定 / 车机离线 / 已绑定。离线显示成"未绑定"会诱导
 * 用户重绑；绑定幂等不坏数据，但用户会误以为绑定丢失。
 *
 * 网关只做鉴权 + 转调 + 投影（§3）：绑定幂等与悬空重建的语义都在
 * `@cabinhug/tools` 的 CabinClient 里，这里不重复实现。
 */

import { Router } from "express";
import type { Response } from "express";

import { CabinUnboundError, ToolError, type CabinClient, type CabinCapabilities } from "@cabinhug/tools";
import type { VehicleStore } from "@cabinhug/memory";

import type { AuthedRequest } from "../auth";
import { hasVehicleAccess, type VehicleRoleRequest, isBoundCockpit } from "../auth/vehicle-role";

/** 能力摘要：端上车机区只要"几温区/有无通风/有无香氛"这个粒度。 */
function summarize(caps: CabinCapabilities): Record<string, unknown> {
  const anyVentilation = Object.values(caps.seats).some((s) => s.ventilationLevels > 0);
  return {
    model: caps.model,
    source: caps.source,
    climateZones: caps.climate.zones.length,
    tempRangeC: caps.climate.tempRangeC,
    seatVentilation: anyVentilation,
    fragrance: caps.fragrance.present,
    rearMedia: caps.media.zones.includes("rear"),
  };
}

export interface VehicleCabinDeps {
  vehicles: VehicleStore;
  /** 未注入 = MOCK_CABIN_URL 没配，端点如实报未接入。 */
  cabin?: CabinClient;
}

export function createVehicleCabinRouter(deps: VehicleCabinDeps): Router {
  const router = Router();

  /**
   * 归属校验。`need` 决定门槛：车机状态与能量是车辆共享域（设计 §4.1），
   * 被授权成员读得到；绑定车机是管理动作，只有车主（§4.2）。
   */
  const owned = async (
    req: VehicleRoleRequest,
    res: Response,
    need: "member" | "owner" = "owner",
  ): Promise<string | null> => {
    const vin = String(req.params.vin);
    /*
     * 绑定车机可读自己绑的那辆：车机状态与能量是车辆共享域，energy 的
     * "读时推进仿真"本身是车机侧概念。只放行 member 门槛的读；owner 门槛
     * （绑定车机等管理动作）仍要求用户身份。
     */
    if (need === "member" && isBoundCockpit(req, vin)) return vin;
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return null;
    }
    /*
     * DB 查询必须自己接错：express 4 不接异步 handler 的异常，PG 瞬时抖动
     * 抛出的 Prisma P1001 会成为 unhandledRejection 并终止整个网关进程。
     * 数据库不可达时返回 503，进程保持存活。
     */
    let profile;
    try {
      profile = await deps.vehicles.get(vin);
    } catch (err) {
      console.warn("[vehicle-cabin] 归属校验查库失败（DB 抖动？）", err);
      res.status(503).json({ error: "db_unavailable" });
      return null;
    }
    // 跨用户按不存在处理（不泄露存在性，与档案端点同一条）。
    if (!profile || !hasVehicleAccess(req, profile.ownerId, need)) {
      res.status(404).json({ error: "vehicle_not_found" });
      return null;
    }
    return vin;
  };

  /** 三态映射：CabinClient 的错误形态 → 端上可渲染的状态。 */
  const stateOf = async (vin: string): Promise<Record<string, unknown>> => {
    if (!deps.cabin) return { state: "unconfigured", reason: "车机能力未接入（MOCK_CABIN_URL 未配）" };
    try {
      const r = await deps.cabin.status(vin);
      return {
        state: "bound",
        cabinVehicleId: r.vehicleId,
        capabilities: summarize(r.capabilities),
        rebuilt: r.rebuilt,
        provenance: "simulated",
        fetchedAt: new Date().toISOString(),
      };
    } catch (err) {
      if (err instanceof CabinUnboundError) return { state: "unbound" };
      if (err instanceof ToolError && err.category === "upstream") {
        // 离线 ≠ 未绑定：绑定还在（档案里），只是这会儿够不着车机。
        return { state: "offline", reason: "车机离线（服务不可达）" };
      }
      throw err;
    }
  };

  router.get("/v1/vehicles/:vin/cabin", async (req: VehicleRoleRequest, res: Response) => {
    const vin = await owned(req, res, "member");
    if (!vin) return;
    res.json(await stateOf(vin));
  });

  /**
   * 剩余电量 / 剩余油量（能量遥测）。
   *
   * 与 `/cabin` 同一套三态与归属校验。离线不能显示成 0%：真实的 0 会让车主
   * 立刻去找充电桩，所以离线原样报 offline，端上显示"读不到"。
   *
   * 车机侧是读时推进仿真，这里不缓存，保证读数随时间变化。
   */
  router.get("/v1/vehicles/:vin/energy", async (req: VehicleRoleRequest, res: Response) => {
    const vin = await owned(req, res, "member");
    if (!vin) return;
    if (!deps.cabin) {
      res.status(503).json({ state: "unconfigured", reason: "车机能力未接入（MOCK_CABIN_URL 未配）" });
      return;
    }
    try {
      const r = await deps.cabin.energy(vin);
      res.json({
        state: "bound",
        cabinVehicleId: r.vehicleId,
        energyType: r.energyType,
        battery: r.battery,
        fuel: r.fuel,
        mode: r.mode,
        // 仿真系统的读数必须自报家门（§8 的 provenance 纪律），端上据此标注。
        provenance: "simulated",
        asOf: r.asOf,
      });
    } catch (err) {
      if (err instanceof CabinUnboundError) {
        res.json({ state: "unbound", reason: "这辆车还没绑定车机" });
        return;
      }
      if (err instanceof ToolError && err.category === "upstream") {
        res.status(502).json({ state: "offline", reason: "车机离线，这会儿读不到电量/油量" });
        return;
      }
      throw err;
    }
  });

  router.post("/v1/vehicles/:vin/cabin/bind", async (req: AuthedRequest, res: Response) => {
    const vin = await owned(req, res);
    if (!vin) return;
    if (!deps.cabin) {
      res.status(503).json({ state: "unconfigured", reason: "车机能力未接入（MOCK_CABIN_URL 未配）" });
      return;
    }
    try {
      // bind 幂等：已绑定且车机侧存在则原样返回（CabinClient 语义，不重复实现）。
      const r = await deps.cabin.bind(vin);
      console.log(`[vehicle-cabin] bind vin=${vin} -> ${r.vehicleId}${r.rebuilt ? "（重建）" : ""}`);
      res.json({
        state: "bound",
        cabinVehicleId: r.vehicleId,
        capabilities: summarize(r.capabilities),
        rebuilt: r.rebuilt,
        provenance: "simulated",
        fetchedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (err instanceof ToolError && err.category === "upstream") {
        res.status(502).json({ state: "offline", reason: "车机离线，绑定这次没做成——服务恢复后再试" });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
