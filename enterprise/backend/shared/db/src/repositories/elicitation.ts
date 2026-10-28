/**
 * 补录询问的拒答冷却仓储（F-53-09，架构文档 §4.6 约束 2/4）。
 *
 * # 落 PG 而不是图状态
 *
 * 冷却必须跨会话与进程重启存活；只放图状态时，车主拒答后下次上车会被再问一遍。
 *
 * # 独立成表
 *
 * §4.6 约束 4：拒答不构成新的信息。挂进 `Vehicle` 会随 `VehicleProfile`
 * 的读路径流到每个下游，让出行/座舱/售后/购车都得知车主拒答过。
 * 独立成表以最低成本保证"两态逐字段相同"不变量。
 *
 * # 只追加更新，不删
 *
 * 拒答是审计事实。冷却过期靠时间判定（`listActive` 的 `since`），不靠删行。
 */

import { PrismaClient } from "@prisma/client";

import type { ElicitationCooldown, ElicitationKind } from "@cabinhug/shared";

export interface ElicitationCooldownRepository {
  /**
   * 记一次拒答。同一 (vin, kind) 再拒时次数累加、时刻刷新：
   * 连续多次拒答与首次拒答是不同的信号，当前尚不据此分叉。
   */
  decline(input: {
    vin: string;
    ownerId: string;
    kind: ElicitationKind;
    at: number;
  }): Promise<ElicitationCooldown>;
  /**
   * 记一次"刚问过、也拿到过答复"。不是拒答，所以 `declineCount` 不加。
   *
   * 车主报的里程若不大于档案里的值，仓储层的「只前进」规则会丢弃它
   * （`advanceOdometerWithin`），`odometerAt` 仍为 null、体检仍判 `unknown`、
   * `suggested` 仍含 odometer。不记这一笔时，助手会反复询问已答复的项。
   *
   * 与 `decline` 共用同一行：冷却期的判定（`listActive`）只看 `declinedAt`，
   * 两者对"暂时别再问"的作用相同，区别在于不计入连续拒答次数。
   */
  touch(input: {
    vin: string;
    ownerId: string;
    kind: ElicitationKind;
    at: number;
  }): Promise<ElicitationCooldown>;
  /**
   * 该车仍在冷却期内的项。`since` 由调用方按配置的冷却时长算出：
   * 时长是策略值，不硬编码进仓储。
   */
  listActive(vin: string, since: number): Promise<ElicitationCooldown[]>;
}

export function createElicitationCooldownRepository(
  prisma: PrismaClient,
): ElicitationCooldownRepository {
  return {
    async decline({ vin, ownerId, kind, at }) {
      const declinedAt = new Date(at);
      const row = await prisma.elicitationCooldown.upsert({
        where: { vin_kind: { vin, kind } },
        create: { vin, ownerId, kind, declinedAt, declineCount: 1 },
        update: { declinedAt, declineCount: { increment: 1 }, ownerId },
      });
      return {
        vin: row.vin,
        kind: row.kind as ElicitationKind,
        declinedAt: row.declinedAt.getTime(),
        declineCount: row.declineCount,
      };
    },

    async touch({ vin, ownerId, kind, at }) {
      const declinedAt = new Date(at);
      const row = await prisma.elicitationCooldown.upsert({
        where: { vin_kind: { vin, kind } },
        // 新建时 `declineCount: 0`：这一行不是拒答，运营侧不应看到不存在的拒绝。
        create: { vin, ownerId, kind, declinedAt, declineCount: 0 },
        update: { declinedAt, ownerId },
      });
      return {
        vin: row.vin,
        kind: row.kind as ElicitationKind,
        declinedAt: row.declinedAt.getTime(),
        declineCount: row.declineCount,
      };
    },

    async listActive(vin, since) {
      const rows = await prisma.elicitationCooldown.findMany({
        where: { vin, declinedAt: { gte: new Date(since) } },
      });
      return rows.map((r) => ({
        vin: r.vin,
        kind: r.kind as ElicitationKind,
        declinedAt: r.declinedAt.getTime(),
        declineCount: r.declineCount,
      }));
    },
  };
}
