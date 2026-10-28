/**
 * refuel_log —— 记一次加油（F-54-01，架构文档 §7⑥ / §5 工具表）。
 *
 * # 用途：油侧能耗的数据源
 *
 * 电侧的能耗从 `Trip` 的实测续航折算得出，油侧没有数据：`Trip` 里没有加油量。
 * 没有加油流水时，"这趟 500 公里要多少油"的能耗输入只能取厂标，
 * 而厂标与真实油耗可能差三成。
 *
 * 本工具与消费它的 `energy_gap` 同时落地，数据源与消费者不分开交付
 * （ADR-002）。
 *
 * # 不是敏感动作
 *
 * `vehicle_profile_write` 敏感，是因为 ④ 的保养/维修记录会被拿去和修理厂争议（F-23-11）。
 * 加油流水是 ⑥ 的观测，与 `Trip` 同族，而 ⑥ 的写入（`usage-telemetry/ingest`）
 * 不过权限门。加确认只会制造确认疲劳。
 *
 * 校验照做，脏数据在写入口挡住，理由与 ingest 相同：
 * 聚合每天才跑一次，一条记错的流水在被发现前已经影响多次回答。
 */

import type { ProfileFactSource } from "@cabinhug/shared";

import { defineExternalTool, ToolError, type ExternalTool } from "./external";

/** 一条补能流水的读出形态。与 `@cabinhug/memory` 的 `RefuelRecord` 结构一致（那边算油耗只用这三栏）。 */
export interface RefuelRecordRow {
  at: number;
  liters: number;
  odometerKm: number;
}

/** 存储抽象。Prisma 实现在 `@cabinhug/db`（`createRefuelRepository`）。 */
export interface RefuelLogStore {
  append(input: {
    userId: string;
    vin?: string;
    at: number;
    liters: number;
    odometerKm: number;
    source: ProfileFactSource;
  }): Promise<{ id: string }>;
  /**
   * 区间读，给油侧的能耗口径用（`measuredEnergyPer100km` 的输入）。
   *
   * 可选：真实仓储（`createRefuelRepository`）实现了这个方法，单测里只实现 `append`
   * 的写入桩不必实现。拿不到流水时油侧口径缺席，
   * 与「没有数据」同一档，不回落到某个标称值。
   */
  range?(
    userId: string,
    fromMs: number,
    toMs: number,
    vin?: string,
  ): Promise<readonly RefuelRecordRow[]>;
}

export interface RefuelLogArgs {
  /** 必填：不允许跨用户混算，与 ⑥ 其余写入同一条红线。 */
  userId: string;
  vin?: string;
  /** 加油时间（epoch ms），省略取当前。 */
  at?: number;
  /** 这次加了多少升。不是油箱容量，也不是剩余量。 */
  liters: number;
  /** 加油时的里程读数。区间油耗依赖它，缺了这条记录就没有价值。 */
  odometerKm: number;
  source?: ProfileFactSource;
}

export interface RefuelLogData {
  id: string;
  /** 说明这一条能不能立刻变成油耗：一条算不出来，两条才有一个区间。 */
  note: string;
}

let store: RefuelLogStore | undefined;

/** 装配层注入。传 undefined 表示补能流水未接入。 */
export function setRefuelStore(s: RefuelLogStore | undefined): void {
  store = s;
}

export function getRefuelStore(): RefuelLogStore | undefined {
  return store;
}

export const refuelLogTool: ExternalTool<RefuelLogArgs, RefuelLogData> = defineExternalTool<
  RefuelLogArgs,
  RefuelLogData
>({
  name: "refuel_log",
  provider: "cabinhug-telemetry",
  timeoutMs: 5_000,
  // 有副作用：重试一次就是两条加油记录，而它会直接压低算出来的油耗。
  retries: 0,
  async real(args) {
    if (!store) {
      // 未接入与"没有数据"是两回事（与 `usage_profile` 相同）。
      throw new ToolError("refuel_log", "unconfigured", "⑥补能流水未接入", false);
    }
    if (!args.userId?.trim()) {
      throw new ToolError("refuel_log", "invalid", "写入必须带用户维度：userId 为空", false);
    }
    const row = await store.append({
      userId: args.userId,
      vin: args.vin,
      at: args.at ?? Date.now(),
      liters: args.liters,
      odometerKm: args.odometerKm,
      // 缺省车主自述：这个工具的入参是从对话里抽出来的，而对话里的事实只能是他说的。
      source: args.source ?? "owner-stated",
    });
    return {
      id: row.id,
      note:
        "已记下这次加油。百公里油耗按**两次加油之间**算，" +
        "所以要等下一次加油才算得出这一段的真实油耗。",
    };
  },
  mock(args) {
    return { id: `mock-refuel-${args.odometerKm}`, note: "（模拟）已记下这次加油。" };
  },
});
