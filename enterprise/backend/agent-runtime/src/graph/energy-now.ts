/**
 * 从车机能量遥测取这辆车此刻的电量 / 油量与仪表剩余续航（`vehicle_energy`）。
 *
 * 与 `range-facts.ts` 同一手法：编排层在行程节点读一次，作为事实写进分支提示词，
 * 读失败不阻塞、按"没有实时读数"处理（那是独立的一档，不是回落到某个默认值）。
 *
 * # 与 ⑥ 的实测续航并存
 *
 * ⑥ 回答"这车衰减到什么程度"（满量程），车机回答"现在还剩多少"（余量）。
 * 规划补能点两样都要：满量程定插点间距，余量定出发时的起始 SoC。
 * 没有余量时 startSoc 只能按满电 1.0 估算。
 *
 * 口径冲突时以 ⑥ 为准：车机的满量程是拿剩余续航回推的仪表估计，
 * ⑥ 是按真实行程折算的统计值。
 */

import { invokeTool, type ToolCallContext } from "@cabinhug/tools";

/** 车机此刻报的能量读数。"读不到"是独立的一档，带理由。 */
export type VehicleEnergyNow =
  | {
      status: "live";
      energyType: "bev" | "phev" | "icev";
      /** 电量百分比（0~100）；燃油车没有。 */
      batteryPercent?: number;
      /** 仪表剩余续航（km，电）。 */
      batteryRangeKm?: number;
      /** 油量百分比（0~100）；纯电没有。 */
      fuelPercent?: number;
      /** 仪表剩余续航（km，油）。 */
      fuelRangeKm?: number;
      /** 「剩余续航 ÷ 当前百分比」回推的仪表口径满量程。 */
      fullRangeKm?: number;
      charging?: boolean;
      /** 读数时刻（ISO）。转述时要带上，读数会随时间变化。 */
      asOf: string;
    }
  | { status: "unavailable"; reason: string };

interface VehicleEnergyToolData {
  energyType: "bev" | "phev" | "icev";
  battery?: { percent: number; rangeKm: number; charging: boolean };
  fuel?: { percent: number; rangeKm: number };
  fullRangeKm?: number;
  asOf: string;
}

/** 单测可换的取数面：缺省走 `vehicle_energy` 工具。 */
export type VehicleEnergyFetch = (
  args: { userId: string; vin?: string },
  ctx: ToolCallContext,
) => Promise<VehicleEnergyToolData>;

const defaultFetch: VehicleEnergyFetch = async (args, ctx) => {
  const r = (await invokeTool("vehicle_energy", args, ctx)) as { data: VehicleEnergyToolData };
  return r.data;
};

/** 工具响应 → 事实。纯函数，单测直接喂响应。 */
export function energyNowFromReading(d: VehicleEnergyToolData): VehicleEnergyNow {
  const battery = usable(d.battery?.percent);
  const fuel = usable(d.fuel?.percent);
  if (battery === undefined && fuel === undefined) {
    // 有响应但两样都没有：车机连上了却没报能量，与"没连上"同样不能给数。
    return { status: "unavailable", reason: "车机没有报这辆车的电量或油量" };
  }
  return {
    status: "live",
    energyType: d.energyType,
    ...(battery !== undefined ? { batteryPercent: battery } : {}),
    ...(usable(d.battery?.rangeKm) !== undefined ? { batteryRangeKm: d.battery!.rangeKm } : {}),
    ...(fuel !== undefined ? { fuelPercent: fuel } : {}),
    ...(usable(d.fuel?.rangeKm) !== undefined ? { fuelRangeKm: d.fuel!.rangeKm } : {}),
    ...(usable(d.fullRangeKm) !== undefined ? { fullRangeKm: d.fullRangeKm } : {}),
    ...(d.battery?.charging !== undefined ? { charging: d.battery.charging } : {}),
    asOf: d.asOf,
  };
}

/** 0 与非有限值都当没有——一个"0%"进提示词与"读不到"是两回事，但都不该拿去算。 */
function usable(v: number | undefined): number | undefined {
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : undefined;
}

export async function loadVehicleEnergyNow(
  args: { userId: string; vin?: string },
  ctx: ToolCallContext,
  fetch: VehicleEnergyFetch = defaultFetch,
): Promise<VehicleEnergyNow> {
  try {
    return energyNowFromReading(await fetch(args, ctx));
  } catch (err) {
    // 未绑车机 / 车机不可达都走这里。理由写进提示词，不作为沉默的缺省。
    console.warn("[graph] 取车机能量读数失败，本次按「没有实时读数」处理", err);
    return { status: "unavailable", reason: "车机没连上或这辆车还没绑定车机" };
  }
}
