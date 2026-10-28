/**
 * `confirmedById`：按 id 读一份仍然 confirmed 的行程。连真实 PG。
 *
 * 沿途服务与目的地推荐的后台补算，写回前核对该行程是否仍然有效。车主能从列表里
 * 载入并变更任何一程，且 `update` 不改 `committedAt`，所以核对不能依赖
 * `currentForUser`（= 最新一条 confirmed）。
 *
 * 本组守三条：不是最新那一条也读得到；按 id 读也必须带 userId；已取消的不再返回
 * （后两条与 `cancelById` / `update` 同一纪律）。
 * 这些性质只有真跑数据库才验得到，与 `trip-plan-review.test.ts` 同理。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";
import type { TripPlanSnapshot } from "@cabinhug/shared";

import { createTripPlanRepository } from "../src/repositories/trip-plan";

const DATABASE_URL = process.env.DATABASE_URL;
const U1 = "test-confirmed-by-id-u1";
const U2 = "test-confirmed-by-id-u2";

const snapshot = (destination: string, startDate: string, days = 3): TripPlanSnapshot => ({
  status: "confirmed",
  destination,
  startDate,
  days,
  skeleton: Array.from({ length: days }, (_, i) => ({
    day: i + 1,
    theme: `第 ${i + 1} 天`,
    spots: [{ name: `${destination}景点${i + 1}` }],
  })),
  caveats: [],
  updatedTurnId: "turn-confirmed-by-id",
});

if (!DATABASE_URL) {
  describe("confirmedById", () => {
    it("跳过：未设置 DATABASE_URL（这组测试必须连真库，见文件头）", () => {
      assert.ok(true);
    });
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const plans = createTripPlanRepository(prisma);

  // 不播测试账号：理由同 trip-plan-review.test.ts（trip_plans 没有指向 users 的外键）。
  before(async () => {
    await prisma.tripPlan.deleteMany({ where: { userId: { in: [U1, U2] } } });
  });

  after(async () => {
    await prisma.tripPlan.deleteMany({ where: { userId: { in: [U1, U2] } } });
    await prisma.$disconnect();
  });

  describe("confirmedById", () => {
    it("排第几都读得到：补算写回前核对的是这一行，不是「当前行程」", async () => {
      const older = await plans.commit(U1, "s-older", snapshot("湖州南浔", "2026-09-16"));
      const newer = await plans.commit(U1, "s-newer", snapshot("苏州", "2026-09-19", 2));

      // 前提：最新那一条是后确认的那份，被读的那份排在它后面。
      assert.equal((await plans.currentForUser(U1))?.planId, newer.planId);

      const got = await plans.confirmedById(U1, older.planId);
      assert.equal(got?.planId, older.planId);
      assert.equal(got?.plan.destination, "湖州南浔");
      assert.equal(got?.sessionId, "s-older", "写回要用它的会话 id");
    });

    it("别人的读不到：不能仅凭 planId 读别人的行程", async () => {
      const mine = await plans.commit(U1, "s-mine", snapshot("宁波", "2026-09-21", 2));
      assert.equal(await plans.confirmedById(U2, mine.planId), null);
    });

    it("已取消的读不到；库里没有这一行也是 null，不是抛错", async () => {
      const doomed = await plans.commit(U1, "s-doomed", snapshot("要取消", "2026-09-22", 1));
      await plans.cancelById(U1, doomed.planId);
      assert.equal(await plans.confirmedById(U1, doomed.planId), null);
      assert.equal(await plans.confirmedById(U1, "no-such-plan-id"), null);
    });
  });
}
