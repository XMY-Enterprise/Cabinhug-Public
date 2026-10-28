/**
 * ④车辆档案仓储集成测试。连真实 PG，不是纯函数测试。
 *
 * 事务性、只前进的里程、级联删除这些性质只有连真实数据库才能验证；
 * 内存实现只能验证内存实现本身。
 *
 * 没有 DATABASE_URL 时整组跳过（CI 未接 PG 的场景），跳过以显式用例报告，
 * 避免"没跑"显示为"跑过"。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import { createVehicleRepository, VehicleNotFoundError } from "../src/repositories/vehicle";
import { seedTestUsers } from "./helpers/seed-users";

const DATABASE_URL = process.env.DATABASE_URL;
const VIN = "LSJA24U91NS123456"; // 17 位，不含 I/O/Q
const OWNER = "test-owner-m7-03";

if (!DATABASE_URL) {
  describe("④车辆档案仓储", () => {
    it("跳过：未设置 DATABASE_URL（这组测试必须连真库，见文件头）", () => {
      assert.ok(true);
    });
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const repo = createVehicleRepository(prisma);

  const base = {
    vin: VIN,
    ownerId: OWNER,
    model: "测试车型",
    modelYear: 2024,
    purchasedAt: Date.UTC(2024, 0, 15),
    odometerKm: 12_000,
    maintenanceIntervalKm: 10_000,
    maintenance: [],
    repairs: [],
    updatedAt: 0,
  };

  const clean = async () => {
    await prisma.vehicle.deleteMany({ where: { ownerId: OWNER } });
  };

  before(async () => {
    // owner_id 是 users 外键，车主必须先是个账号。
    await seedTestUsers(prisma, [OWNER]);
    await clean();
  });
  after(async () => {
    await clean();
    await prisma.$disconnect();
  });

  describe("④车辆档案：建档与精确查询", () => {
    it("建档后可按 VIN 精确读回", async () => {
      await repo.upsert(base);
      const p = await repo.get(VIN);
      assert.equal(p?.vin, VIN);
      assert.equal(p?.odometerKm, 12_000);
      assert.equal(p?.maintenanceIntervalKm, 10_000);
    });

    it("查不到就是 null：精确查询不是语义检索，不推测填充", async () => {
      assert.equal(await repo.get("LSJA24U91NS999999"), null);
    });

    it("对不存在的车追加记录直接抛，不静默建档", async () => {
      await assert.rejects(
        () => repo.appendMaintenance("LSJA24U91NS999999", {
          at: Date.now(), odometerKm: 1, items: "x", source: "y",
        }),
        VehicleNotFoundError,
      );
    });
  });

  describe("事件驱动更新：事务性 + 只追加", () => {
    it("追加保养记录后立刻可读到，且里程被同步推进", async () => {
      const p = await repo.appendMaintenance(VIN, {
        at: Date.UTC(2026, 5, 1),
        odometerKm: 18_500,
        items: "机油机滤、空调滤芯",
        source: "4S 店工单 #A123",
      });
      // 事务性：返回值里记录与里程同时是新的，
      // 不存在"已保养但里程还是旧值"的中间态，否则保养推算会出错。
      assert.equal(p.maintenance.length, 1);
      assert.equal(p.odometerKm, 18_500);
    });

    it("补录旧保养不会把当前里程改小", async () => {
      const p = await repo.appendMaintenance(VIN, {
        at: Date.UTC(2025, 2, 14),
        odometerKm: 8_000,
        items: "首保",
        source: "用户自述",
      });
      assert.equal(p.maintenance.length, 2);
      assert.equal(p.odometerKm, 18_500, "里程表不会倒转");
    });

    it("维修记录同样只追加，且能带回问诊会话", async () => {
      const p = await repo.appendRepair(VIN, {
        at: Date.UTC(2026, 6, 20),
        odometerKm: 19_200,
        symptom: "低速刹车异响",
        source: "用户自述",
        sessionId: "sess-abc",
      });
      assert.equal(p.repairs.length, 1);
      assert.equal(p.repairs[0].sessionId, "sess-abc");
      assert.equal(p.odometerKm, 19_200);
    });

    it("里程只前进：变小的上报被忽略而不是被接受", async () => {
      // 用户输错、单位混淆或上报了另一辆车；静默接受会让保养推算长期偏离。
      const p = await repo.advanceOdometer(VIN, 100);
      assert.equal(p.odometerKm, 19_200);
    });

    it("正常前进的上报生效", async () => {
      const p = await repo.advanceOdometer(VIN, 21_000);
      assert.equal(p.odometerKm, 21_000);
    });

    it("upsert 不会覆盖历史记录", async () => {
      await repo.upsert({ ...base, odometerKm: 21_000, model: "改了个名" });
      const p = await repo.get(VIN);
      assert.equal(p?.model, "改了个名");
      assert.equal(p?.maintenance.length, 2, "保养记录仍在");
      assert.equal(p?.repairs.length, 1, "维修记录仍在");
    });
  });

  describe("一人多车（F-23-09）", () => {
    const VIN2 = "LSJA24U91NS654321";

    it("按车主列举，默认车排最前", async () => {
      await repo.upsert({ ...base, vin: VIN2, model: "第二辆车" });
      await repo.setDefault(OWNER, VIN2);
      const list = await repo.listByOwner(OWNER);
      assert.equal(list.length, 2);
      assert.equal(list[0].vin, VIN2, "默认车排最前");
    });

    /**
     * 默认车唯一性（F-23-09）。
     *
     * 同一 owner 下出现两辆 `isDefault: true` 时，`listByOwner` 退化成按
     * `purchasedAt` 排序，助手会基于错误的车辆档案作答。
     */
    it("setDefault 先清后设：换默认车后不会留下两辆", async () => {
      await repo.setDefault(OWNER, VIN);
      const rows = await prisma.vehicle.findMany({ where: { ownerId: OWNER } });
      assert.equal(rows.filter((r) => r.isDefault).length, 1, "isDefault 只能有一辆");
      assert.equal(
        rows.filter((r) => r.defaultForOwner !== null).length,
        1,
        "约束列必须跟着一起写——只写 isDefault 等于让约束失效",
      );
      assert.equal(rows.find((r) => r.vin === VIN)?.defaultForOwner, OWNER);
    });

    it("绕过仓储直写也会被数据库约束拦住", async () => {
      // 事务化的 setDefault 挡不住不经仓储的写入（如脚本直写），由数据库唯一约束兜底。
      await assert.rejects(
        () =>
          prisma.vehicle.update({
            where: { vin: VIN2 },
            data: { isDefault: true, defaultForOwner: OWNER },
          }),
        /[Uu]nique/,
        "同一 owner 的第二辆默认车必须写不进去",
      );
    });

    /**
     * 能源类型需真实落库并读回（F-23-09）。
     *
     * 字段是可选的，"加了字段但没接映射"不会产生类型错误，由这条断言覆盖。
     */
    it("energyType 存得进读得回", async () => {
      await repo.upsert({ ...base, energyType: "icev" });
      assert.equal((await repo.get(VIN))?.energyType, "icev");
    });

    it("库里是非法值时当作「不知道」，不把脏值交给下游", async () => {
      // 下游按它分叉续驶评估的口径，"电动" 既不等于 bev 也不触发未知分支。
      await prisma.vehicle.update({ where: { vin: VIN }, data: { energyType: "电动" } });
      assert.equal((await repo.get(VIN))?.energyType, undefined);
      await repo.upsert({ ...base, energyType: "icev" }); // 复原，后续断言依赖它
    });

    it("没填能源类型时是 undefined，不是编一个默认值", async () => {
      await repo.upsert({ ...base, energyType: undefined });
      assert.equal((await repo.get(VIN))?.energyType, undefined);
    });

    it("vin 不属于该车主时抛错，不静默改别人的车", async () => {
      await assert.rejects(
        () => repo.setDefault("别的车主", VIN),
        (e: unknown) => e instanceof VehicleNotFoundError,
      );
    });

    it("删档案级联清掉它的记录，不留孤儿", async () => {
      await prisma.vehicle.delete({ where: { vin: VIN2 } });
      assert.equal(await repo.get(VIN2), null);
      const orphans = await prisma.maintenanceRecord.count({ where: { vin: VIN2 } });
      assert.equal(orphans, 0);
    });
  });

  describe("保养完成闭环（F-17-08）", () => {
    const reminder = (kind: string) => ({
      userId: OWNER,
      vin: VIN,
      kind,
      message: `${kind} 提醒`,
      basis: ["测试"],
      degraded: false,
    });

    it("appendMaintenance 同事务失效旧保养提醒", async () => {
      await prisma.vehicleReminder.deleteMany({ where: { vin: VIN } });
      await prisma.vehicleReminder.create({ data: reminder("maintenance") });
      await prisma.vehicleReminder.create({ data: reminder("inspection") });

      await repo.appendMaintenance(VIN, {
        at: Date.UTC(2026, 7, 1),
        odometerKm: 22_000,
        items: "常规保养",
        source: "4S",
      });

      const rows = await prisma.vehicleReminder.findMany({ where: { vin: VIN } });
      const mnt = rows.find((r) => r.kind === "maintenance");
      const insp = rows.find((r) => r.kind === "inspection");
      assert.ok(mnt?.invalidatedAt, "旧保养提醒必须被标记失效");
      assert.equal(insp?.invalidatedAt, null, "年检提醒不该被保养失效——两回事");
      assert.equal(rows.length, 2, "失效是标记不是删除：审计事实必须保留");
    });

    it("repair / odometer 不触发失效——修车≠保养，里程推进是推算输入不是失效理由", async () => {
      await prisma.vehicleReminder.deleteMany({ where: { vin: VIN } });
      await prisma.vehicleReminder.create({ data: reminder("maintenance") });

      await repo.appendRepair(VIN, {
        at: Date.UTC(2026, 7, 2),
        odometerKm: 22_100,
        symptom: "异响",
        source: "用户自述",
      });
      await repo.advanceOdometer(VIN, 22_500);

      const row = await prisma.vehicleReminder.findFirst({ where: { vin: VIN, kind: "maintenance" } });
      assert.equal(row?.invalidatedAt, null);
      await prisma.vehicleReminder.deleteMany({ where: { vin: VIN } });
    });
  });

  /**
   * 里程更新时刻（F-53-01）。
   *
   * 里程有四条写入路径（appendMaintenance / appendRepair / advanceOdometer / upsert），
   * 任何一条漏写时刻都表现为"里程推进了但时刻没动"，逐条覆盖。
   */
  describe("里程更新时刻", () => {
    const freshCar = async (km: number) => {
      await clean();
      await repo.upsert({ ...base, odometerKm: km });
    };
    const rawAt = async () =>
      (await prisma.vehicle.findUniqueOrThrow({ where: { vin: VIN } })).odometerAt;

    it("新建时记 now——这个里程值确实是此刻才录进来的", async () => {
      const t0 = Date.now();
      await freshCar(10_000);
      const at = await rawAt();
      assert.ok(at, "新建的车必须有里程时刻");
      assert.ok(at.getTime() >= t0 - 1_000 && at.getTime() <= Date.now() + 1_000);
    });

    it("advanceOdometer 前进时，里程与时刻一起变", async () => {
      await freshCar(10_000);
      await prisma.vehicle.update({
        where: { vin: VIN },
        data: { odometerAt: new Date(Date.now() - 90 * 86_400_000) },
      });
      const before = await rawAt();

      const p = await repo.advanceOdometer(VIN, 11_000);
      const after = await rawAt();
      assert.equal(p.odometerKm, 11_000);
      assert.ok(after && before && after.getTime() > before.getTime(), "时刻必须跟着前进");
      assert.equal(p.odometerAt, after?.getTime(), "读路径要把时刻带出来");
    });

    it("里程未前进（新值 ≤ 旧值）时，里程与时刻都不动", async () => {
      await freshCar(20_000);
      const stale = new Date(Date.now() - 90 * 86_400_000);
      await prisma.vehicle.update({ where: { vin: VIN }, data: { odometerAt: stale } });

      await repo.advanceOdometer(VIN, 19_000); // 倒退
      await repo.advanceOdometer(VIN, 20_000); // 持平：又上报一次同样的数，不是新观测
      const at = await rawAt();
      assert.equal(at?.getTime(), stale.getTime(), "没有新观测就不该刷新时刻");
      const p = await repo.get(VIN);
      assert.equal(p?.odometerKm, 20_000);
    });

    it("appendMaintenance 顺带推进里程时也写时刻", async () => {
      await freshCar(20_000);
      const stale = new Date(Date.now() - 90 * 86_400_000);
      await prisma.vehicle.update({ where: { vin: VIN }, data: { odometerAt: stale } });

      await repo.appendMaintenance(VIN, {
        at: Date.UTC(2026, 7, 1),
        odometerKm: 21_000,
        items: "小保养",
        source: "owner-stated",
      });
      const at = await rawAt();
      assert.ok(at && at.getTime() > stale.getTime(), "保养带来的里程读数同样是一次观测");
    });

    it("appendRepair 顺带推进里程时也写时刻", async () => {
      await freshCar(20_000);
      const stale = new Date(Date.now() - 90 * 86_400_000);
      await prisma.vehicle.update({ where: { vin: VIN }, data: { odometerAt: stale } });

      await repo.appendRepair(VIN, {
        at: Date.UTC(2026, 7, 2),
        odometerKm: 21_500,
        symptom: "异响",
        source: "用户自述",
      });
      const at = await rawAt();
      assert.ok(at && at.getTime() > stale.getTime());
    });

    it("upsert 原样回写不刷新时刻", async () => {
      await freshCar(30_000);
      const stale = new Date(Date.now() - 90 * 86_400_000);
      await prisma.vehicle.update({ where: { vin: VIN }, data: { odometerAt: stale } });

      // cabin backend 为回写 cabinVehicleId 会把整份 profile 原样 upsert 回来
      const cur = await repo.get(VIN);
      assert.ok(cur);
      await repo.upsert({ ...cur, cabinVehicleId: "cabin-veh-1" });

      const at = await rawAt();
      assert.equal(at?.getTime(), stale.getTime(), "里程没变就不该动时刻");
      assert.equal((await repo.get(VIN))?.cabinVehicleId, "cabin-veh-1", "别的字段照常写");
    });

    it("upsert 带来更大的里程时，时刻跟着走", async () => {
      await freshCar(30_000);
      const stale = new Date(Date.now() - 90 * 86_400_000);
      await prisma.vehicle.update({ where: { vin: VIN }, data: { odometerAt: stale } });

      const cur = await repo.get(VIN);
      assert.ok(cur);
      await repo.upsert({ ...cur, odometerKm: 31_000 });

      const at = await rawAt();
      assert.ok(at && at.getTime() > stale.getTime());
      assert.equal((await repo.get(VIN))?.odometerKm, 31_000);
    });

    it("来源随里程一起写：owner-stated 落库并读得回来", async () => {
      await freshCar(50_000);
      await repo.advanceOdometer(VIN, 51_000, "owner-stated");
      const p = await repo.get(VIN);
      assert.equal(p?.odometerSource, "owner-stated");
    });

    it("不传来源就不写，不默认成「车辆上报」", async () => {
      await freshCar(50_000);
      await repo.advanceOdometer(VIN, 51_000, "owner-stated");
      await repo.advanceOdometer(VIN, 52_000); // 不带来源
      const p = await repo.get(VIN);
      assert.equal(p?.odometerKm, 52_000, "里程照常前进");
      assert.equal(p?.odometerSource, "owner-stated", "旧来源保留，不被空值抹掉");
      const virgin = await prisma.vehicle.findUniqueOrThrow({ where: { vin: VIN } });
      assert.ok(virgin.odometerSource, "库里也不该是 null");
    });

    it("库里写了非法来源 → 读出来当「不知道」，不原样交给下游", async () => {
      await freshCar(50_000);
      await prisma.vehicle.update({ where: { vin: VIN }, data: { odometerSource: "用户自述" } });
      assert.equal((await repo.get(VIN))?.odometerSource, undefined);
    });

    it("存量行（时刻为 NULL）读出来是 undefined——不知道 ≠ 很久以前", async () => {
      await freshCar(40_000);
      await prisma.vehicle.update({ where: { vin: VIN }, data: { odometerAt: null } });
      const p = await repo.get(VIN);
      assert.equal(p?.odometerAt, undefined);
      assert.equal(p?.odometerKm, 40_000, "值还在，只是不知道它是什么时候的");
    });
  });
}
