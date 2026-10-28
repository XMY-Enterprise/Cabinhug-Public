/**
 * 运行轨迹仓储。
 *
 * # 写入永不阻塞主链路
 *
 * 轨迹是旁路：采集失败不能让对话失败。`TraceSink.write` 是同步接口，
 * 落库是异步的，直接在里面 `await` 会把数据库延迟加到每一次 token 之间。
 *
 * 因此采用缓冲 + 定时批量落库：write 只往内存队列塞，后台按批写 PG。
 * 进程被 kill -9 时最后一批可能丢失；对轨迹可接受（丢的是排障素材，
 * 不是用户数据），①Working 检查点则走 LangGraph 的同步写。
 *
 * # 只追加，没有删除接口
 *
 * 回放要能证明失败没被隐藏，能按条删除的轨迹表做不到这一点。
 * 过期清理走独立的 `prune`，按时间批量删除。
 */

import { PrismaClient } from "@prisma/client";

export interface TraceEventRecord {
  sessionId: string;
  turnId?: string;
  kind: string;
  at: number;
  data: Record<string, unknown>;
}

export interface TraceRepository {
  /** 同步入队，**永不抛错**。 */
  write(e: TraceEventRecord): void;
  /** 把队列里的都落库。装配层在退出前调一次，减少丢失。 */
  flush(): Promise<void>;
  /** 按会话读取，时间升序。回放的唯一入口。 */
  bySession(sessionId: string, limit?: number, afterAt?: number): Promise<TraceEventRecord[]>;
  /** 最近有轨迹的会话（回放页的列表）。 */
  recentSessions(
    limit?: number,
  ): Promise<Array<{ sessionId: string; title: string | null; events: number; lastAt: number }>>;
  /** 过期清理（按天）。返回删除条数。 */
  prune(olderThanDays: number, now?: number): Promise<number>;
  stop(): void;
}

const FLUSH_MS = 1_000;
/**
 * 队列上限。满了丢最早的而不是拒绝新的：排障看的是最近发生的事
 * （与 `MemoryTraceSink` 同一取向）。
 */
const QUEUE_CAP = 5_000;

export function createTraceRepository(prisma: PrismaClient): TraceRepository {
  let queue: TraceEventRecord[] = [];
  let seq = 0;
  let flushing = false;

  async function flush(): Promise<void> {
    if (flushing || queue.length === 0) return;
    flushing = true;
    const batch = queue;
    queue = [];
    try {
      await prisma.traceEvent.createMany({
        data: batch.map((e) => ({
          // 时间 + 序号：同一毫秒内的多条事件不能互相覆盖，
          // 而回放要按发生顺序还原并行与挂起的区间。
          id: `tr-${e.at}-${(seq += 1)}`,
          sessionId: e.sessionId,
          turnId: e.turnId ?? null,
          kind: e.kind,
          at: BigInt(e.at),
          data: e.data as never,
        })),
        skipDuplicates: true,
      });
    } catch (err) {
      // 落库失败只记日志，不影响对话。batch 不放回队列：
      // 持续失败的写会让队列无限增长，最终拖垮进程。
      console.error(`[trace] 落库失败，丢弃 ${batch.length} 条`, err);
    } finally {
      flushing = false;
    }
  }

  const timer = setInterval(() => void flush(), FLUSH_MS);
  // 定时器不该拖住进程退出。
  timer.unref?.();

  return {
    write(e) {
      queue.push(e);
      if (queue.length > QUEUE_CAP) queue.splice(0, queue.length - QUEUE_CAP);
    },
    flush,
    stop() {
      clearInterval(timer);
    },

    /**
     * 取一个会话的轨迹。超出 limit 时取最近的那批，不是最早的：
     * 会话页按最近轮次倒序展示，排障看的是最近发生的事（与 `QUEUE_CAP` 同一原则）。
     *
     * 取完必须反转回升序：`summarize()` 算并行重叠、`buildFlow()` 画时间轴、
     * `hopBreakdown()` 排耗时，都假设入参是时间升序。
     */
    async bySession(sessionId, limit = 1_000, afterAt) {
      // 先把待落库的刷出去，保证刚发生的那一轮也能回放。
      await flush();
      const rows = await prisma.traceEvent.findMany({
        where: { sessionId, ...(afterAt !== undefined ? { at: { gt: BigInt(afterAt) } } : {}) },
        orderBy: { at: "desc" },
        take: limit,
      });
      rows.reverse();
      return rows.map((r) => ({
        sessionId: r.sessionId,
        turnId: r.turnId ?? undefined,
        kind: r.kind,
        at: Number(r.at),
        data: (r.data ?? {}) as Record<string, unknown>,
      }));
    },

    async recentSessions(limit = 20) {
      await flush();
      /*
       * 裸 SQL 而不是 `groupBy`：要滤掉被清理（软删除）的会话，
       * 该状态在 `sessions` 表上，`groupBy` 无法关联另一张表。
       *
       * 用 `NOT EXISTS`，不用 inner join：部分会话在 `sessions` 里没有行
       * （自检会话、脚本直接调用 runtime 的会话），它们要照常列出；
       * 这里只滤掉"有行且已清理"的。先滤再 `LIMIT`，被滤掉的会话不占 limit 名额。
       */
      const rows = await prisma.$queryRaw<
        Array<{ session_id: string; events: bigint; last_at: bigint | null }>
      >`
        SELECT t.session_id, count(*) AS events, max(t.at) AS last_at
          FROM trace_events t
         WHERE NOT EXISTS (
                 SELECT 1 FROM sessions s
                  WHERE s.id = t.session_id AND s.deleted_at IS NOT NULL)
         GROUP BY t.session_id
         ORDER BY max(t.at) DESC
         LIMIT ${limit}`;
      /*
       * 带上会话标题，供"切换会话"弹窗展示；轨迹表本身没有标题。
       *
       * 一次 `in` 查询，最多 limit 个 id。
       * 查不到的（自检会话、已清理的）保持 `null`，不编造名字。
       */
      const titles = new Map<string, string | null>(
        (
          await prisma.session.findMany({
            where: { id: { in: rows.map((r) => r.session_id) } },
            select: { id: true, title: true },
          })
        ).map((x) => [x.id, x.title]),
      );
      return rows.map((r) => ({
        sessionId: r.session_id,
        title: titles.get(r.session_id) ?? null,
        events: Number(r.events),
        lastAt: Number(r.last_at ?? 0n),
      }));
    },

    async prune(olderThanDays, now = Date.now()) {
      const cutoff = BigInt(now - olderThanDays * 86_400_000);
      const { count } = await prisma.traceEvent.deleteMany({ where: { at: { lt: cutoff } } });
      return count;
    },
  };
}
