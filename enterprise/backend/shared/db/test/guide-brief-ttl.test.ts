/**
 * [ACR-065] 导览持久层的保鲜期：不给参数时与「只采一次」的现状一致；给了就按 `updated_at` 判过期。
 *
 * 判定只是一次日期比较，用一个只实现 `findUnique` 的假 Prisma 测，不连库。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createGuideBriefRepository, guideBriefMaxAgeMs } from "../src/repositories/guide-brief";

const DAY = 86_400_000;
const UPDATED = Date.UTC(2026, 9, 1);

function fakePrisma(row: { brief: unknown; updatedAt: Date } | null) {
  return {
    guideBriefRecord: {
      findUnique: async () => row,
      upsert: async () => row,
    },
  } as unknown as Parameters<typeof createGuideBriefRepository>[0];
}

describe("[ACR-065] 导览持久层保鲜期", () => {
  const repo = createGuideBriefRepository(fakePrisma({ brief: { spot: "清河坊" }, updatedAt: new Date(UPDATED) }));

  it("不带参数：多旧都命中（现状）", async () => {
    assert.deepEqual(await repo.get("杭州", "清河坊", { now: UPDATED + 400 * DAY }), { spot: "清河坊" });
  });

  it("保鲜期内命中，过了就视同没有", async () => {
    const maxAgeMs = 14 * DAY;
    assert.deepEqual(await repo.get("杭州", "清河坊", { maxAgeMs, now: UPDATED + 13 * DAY }), { spot: "清河坊" });
    assert.equal(await repo.get("杭州", "清河坊", { maxAgeMs, now: UPDATED + 15 * DAY }), null);
  });

  it("没有这一行就是 null，不管保鲜期", async () => {
    assert.equal(await createGuideBriefRepository(fakePrisma(null)).get("杭州", "x", { maxAgeMs: DAY }), null);
  });

  it("天数解析：正数换成毫秒；没设、0、负数、非数字都按永久", () => {
    assert.equal(guideBriefMaxAgeMs("14"), 14 * DAY);
    assert.equal(guideBriefMaxAgeMs(" 0.5 "), DAY / 2);
    for (const v of [undefined, "", "0", "-3", "两周"]) assert.equal(guideBriefMaxAgeMs(v), undefined);
  });
});
