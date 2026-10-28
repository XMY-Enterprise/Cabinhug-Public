/**
 * Guardrails 运行时裁决审计仓储（F-27-11 / F-10-07 / F-10-13）。
 *
 * # 不复用 trace_events
 *
 * 权限门裁决也随轨迹进 `trace_events`（回放页展示安全链路，F-29-07），
 * 但轨迹是可过期的排障素材（`prune` 按天清理），审计要求保留。
 * 轨迹里那份用于回放，本表用于保留：两份、两个用途、两种生命周期。
 *
 * # 追加式
 *
 * 没有更新与删除接口（与 `AuditLog` 同纪律）。
 * F-10-13 的归档走 `archivedAt` 标记（当前只有字段，归档作业未实现），不物理删。
 *
 * # 写入是异步的，但不在这里做 fire-and-forget
 *
 * 仓储只提供 `write(): Promise<void>`；"不阻塞裁决路径 + 失败降级"是
 * 装配层（agent-runtime `PersistentGuardAuditSink`）的职责。在仓储里吞错误
 * 会让调用方无从得知是否写入成功。
 */

import { PrismaClient } from "@prisma/client";

export interface GuardAuditRow {
  sessionId: string;
  turnId?: string;
  layer: string;
  decision: string;
  rule?: string;
  tool?: string;
  reason?: string;
  durationMs?: number;
  detail?: Record<string, unknown>;
  at?: Date;
}

export interface GuardAuditRepository {
  write(row: GuardAuditRow): Promise<void>;
  /** 按会话回查（最近在前），是"这轮对话经过了哪些裁决"的唯一读端。 */
  listBySession(
    sessionId: string,
    opts?: { limit?: number },
  ): Promise<
    Array<{
      id: string;
      at: Date;
      sessionId: string;
      turnId: string | null;
      layer: string;
      decision: string;
      rule: string | null;
      tool: string | null;
      reason: string | null;
      durationMs: number | null;
    }>
  >;
  /**
   * 一组会话在时间窗内各层的裁决条数（ACR-066 单机版费用明细）。
   * 审核层（`input_moderation` / `output_moderation`）每条对应一次外部审核调用，放行也记，
   * 所以条数就是调用次数。`sessionIds` 给空数组时直接回空，不查库。
   */
  countByLayer(opts: {
    sessionIds: readonly string[];
    since?: Date;
    until?: Date;
    layers?: readonly string[];
  }): Promise<Array<{ layer: string; count: number }>>;
}

export function createGuardAuditRepository(prisma: PrismaClient): GuardAuditRepository {
  return {
    async write(row) {
      await prisma.guardAuditLog.create({
        data: {
          sessionId: row.sessionId,
          turnId: row.turnId ?? null,
          layer: row.layer,
          decision: row.decision,
          rule: row.rule ?? null,
          tool: row.tool ?? null,
          reason: row.reason ?? null,
          durationMs: row.durationMs ?? null,
          // prisma 的 Json 输入类型收不下 Record<string, unknown>（unknown 不是
          // InputJsonValue）；记录来源是内部拼装的结构化对象，这里窄化是安全的。
          detail: (row.detail ?? undefined) as import("@prisma/client").Prisma.InputJsonValue | undefined,
          ...(row.at ? { at: row.at } : {}),
        },
      });
    },
    async listBySession(sessionId, opts) {
      return prisma.guardAuditLog.findMany({
        where: { sessionId },
        orderBy: { at: "desc" },
        take: opts?.limit ?? 100,
        select: {
          id: true,
          at: true,
          sessionId: true,
          turnId: true,
          layer: true,
          decision: true,
          rule: true,
          tool: true,
          reason: true,
          durationMs: true,
        },
      });
    },
    async countByLayer(opts) {
      if (opts.sessionIds.length === 0) return [];
      const at =
        opts.since || opts.until
          ? { at: { ...(opts.since ? { gte: opts.since } : {}), ...(opts.until ? { lte: opts.until } : {}) } }
          : {};
      const rows = await prisma.guardAuditLog.groupBy({
        by: ["layer"],
        where: {
          sessionId: { in: [...opts.sessionIds] },
          ...at,
          ...(opts.layers ? { layer: { in: [...opts.layers] } } : {}),
        },
        _count: { _all: true },
      });
      return rows.map((r) => ({ layer: r.layer, count: r._count._all })).sort((a, b) => b.count - a.count);
    },
  };
}
