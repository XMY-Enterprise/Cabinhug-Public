/**
 * [ACR-066] 单机版费用明细用到的两处只读过滤：用量按一组会话聚合、审核记录按会话与层计数。
 *
 * 守的是「圈到本人」这一条：给了会话清单就只按清单取，清单为空就一行不取（不是退回不过滤），
 * 不给清单时行为与改动前一致。只看传给 Prisma 的查询条件，用假 Prisma 测，不连库。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PrismaClient } from "@prisma/client";

import { createGuardAuditRepository } from "../src/repositories/guard-audit";
import { createUsageRepository } from "../src/repositories/usage";

function usageWith(rows: Array<Record<string, unknown>>) {
  const calls: Array<{ where?: Record<string, unknown> }> = [];
  const prisma = {
    llmUsage: {
      findMany: async (args: { where?: Record<string, unknown> }) => {
        calls.push(args);
        return rows;
      },
    },
  } as unknown as PrismaClient;
  return { repo: createUsageRepository(prisma), calls };
}

const ROW = {
  at: new Date("2026-10-27T02:00:00Z"),
  sessionId: "s1",
  agent: "drive-task",
  provider: "pi-acp",
  model: "deepseek-flash",
  promptTokens: 1000,
  completionTokens: 200,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  costEstimate: 0.0048,
  durationMs: 900,
};

describe("用量聚合的会话清单过滤", () => {
  it("给了清单就按清单取", async () => {
    const { repo, calls } = usageWith([ROW]);
    const out = await repo.summary({ dimension: "agent", sessionIds: ["s1", "__guide__"] });
    assert.deepEqual(calls[0]?.where, { sessionId: { in: ["s1", "__guide__"] } });
    assert.equal(out.total.calls, 1);
    assert.equal(out.buckets[0]?.key, "drive-task");
  });

  it("清单为空是一行都不取，不是不过滤", async () => {
    const { repo, calls } = usageWith([]);
    await repo.summary({ dimension: "agent", sessionIds: [] });
    assert.deepEqual(calls[0]?.where, { sessionId: { in: [] } });
  });

  it("清单与时间窗一起生效", async () => {
    const { repo, calls } = usageWith([]);
    const since = new Date("2026-10-20T00:00:00Z");
    await repo.summary({ dimension: "provider", since, sessionIds: ["s1"] });
    assert.deepEqual(calls[0]?.where, { at: { gte: since }, sessionId: { in: ["s1"] } });
  });

  it("单个会话不在清单里时取交集为空", async () => {
    const { repo, calls } = usageWith([]);
    await repo.summary({ dimension: "agent", sessionId: "s9", sessionIds: ["s1"] });
    assert.deepEqual(calls[0]?.where, { sessionId: { in: [] } });
  });

  it("不给清单时与改动前一致", async () => {
    const { repo, calls } = usageWith([]);
    await repo.summary({ dimension: "agent" });
    assert.equal(calls[0]?.where, undefined);
    await repo.summary({ dimension: "agent", sessionId: "s1" });
    assert.deepEqual(calls[1]?.where, { sessionId: "s1" });
  });
});

describe("审核记录按会话与层计数", () => {
  function auditWith(groups: Array<{ layer: string; _count: { _all: number } }>) {
    const calls: Array<Record<string, unknown>> = [];
    const prisma = {
      guardAuditLog: {
        groupBy: async (args: Record<string, unknown>) => {
          calls.push(args);
          return groups;
        },
      },
    } as unknown as PrismaClient;
    return { repo: createGuardAuditRepository(prisma), calls };
  }

  it("按清单、时间窗与层过滤，按条数降序回", async () => {
    const { repo, calls } = auditWith([
      { layer: "output_moderation", _count: { _all: 3 } },
      { layer: "input_moderation", _count: { _all: 5 } },
    ]);
    const since = new Date("2026-10-27T00:00:00Z");
    const out = await repo.countByLayer({
      sessionIds: ["s1", "s2"],
      since,
      layers: ["input_moderation", "output_moderation"],
    });
    assert.deepEqual(out, [
      { layer: "input_moderation", count: 5 },
      { layer: "output_moderation", count: 3 },
    ]);
    assert.deepEqual(calls[0], {
      by: ["layer"],
      where: {
        sessionId: { in: ["s1", "s2"] },
        at: { gte: since },
        layer: { in: ["input_moderation", "output_moderation"] },
      },
      _count: { _all: true },
    });
  });

  it("清单为空直接回空，不查库", async () => {
    const { repo, calls } = auditWith([{ layer: "input_moderation", _count: { _all: 9 } }]);
    assert.deepEqual(await repo.countByLayer({ sessionIds: [] }), []);
    assert.equal(calls.length, 0);
  });
});
