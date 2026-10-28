/**
 * 空闲空会话的兜底收口（FL-07 F-07-09）。
 *
 * # 补懒关闭够不到的会话
 *
 * 网关的会话过期是**懒关闭**：`checkSessionUsable` 判出过期就顺手落 `closed_at`，
 * 但只发生在**下一次访问那个会话**时（见 `enterprise/backend/gateway/src/http/index.ts`）。
 *
 * 零消息的会话多半没有下一次访问，`closed_at` 保持 NULL，在每一个按"未关闭"判活的地方
 * 都显示成活着的会话（车机的会话列表、运营控制台、演示大屏的会话选择）。
 *
 * 两条路并存是刻意的：访问路径要立刻回 `expired`，兜底路径负责不再被访问的会话。
 *
 * # 状态收敛型，不是窗口聚合型
 *
 * 与 `usage-aggregation` 形态不同：本任务每次跑都扫**当前**所有符合条件的会话，
 * `ctx.from/to` 与 `isCatchUp` 不改变它的行为（因此 `maxCatchUpWindows: 1`）。
 * 不套窗口：漏跑一小时不会漏掉任何会话，下一拍照样扫得到。
 *
 * # 只关不删
 *
 * `deleted` 恒为 0，由测试断言守护。关掉的是"还能不能接着说"，
 * 行与消息一条不删：删行会让"这辆车上发生过一次访客对话"这类审计证据消失。
 */

import { DEFAULT_SESSION_IDLE_MIN } from "@cabinhug/shared";

import type { JobContext, JobDefinition, JobResult } from "./job-runner";

const HOUR_MS = 3_600_000;

/** 一次最多处理多少条：不长时间占着表；剩下的下一拍继续（`remaining` 会报出来）。 */
export const SWEEP_LIMIT = 500;

/**
 * 空闲多久算结束。
 *
 * **与网关同源**：读同一个 `CABINHUG_SESSION_IDLE_MIN`、回落同一个默认值。
 * 两处阈值不同会出现"车机认为还能接着说、兜底已经把它关了"。
 * 与网关的 `sessionIdleMs()` 一样在调用时读 env（非入口模块不在模块级读环境变量）。
 */
export function sweepIdleMs(): number {
  const raw = Number(process.env.CABINHUG_SESSION_IDLE_MIN);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SESSION_IDLE_MIN;
  return minutes * 60 * 1000;
}

export interface SessionSweeperDeps {
  /** 批量收口。返回扫到几条、真关了几条、这一批之外还剩几条。 */
  closeIdleEmptySessions(opts: {
    idleMs: number;
    now?: Date;
    limit?: number;
  }): Promise<{ scanned: number; closed: number; remaining: number }>;
  now?: () => number;
}

export async function runSessionSweeper(
  _ctx: JobContext,
  deps: SessionSweeperDeps,
): Promise<JobResult> {
  const now = new Date((deps.now ?? Date.now)());
  const idleMs = sweepIdleMs();
  const { scanned, closed, remaining } = await deps.closeIdleEmptySessions({
    idleMs,
    now,
    limit: SWEEP_LIMIT,
  });
  if (remaining > 0) {
    // 到达上限要打日志，否则"这轮关了 500 条"看起来像已经清完。
    console.log(`[worker] session-sweeper 本轮到达上限 ${SWEEP_LIMIT}，还剩 ${remaining} 条待下一拍`);
  }
  return {
    processed: scanned,
    changed: closed,
    // **恒为 0**：这个任务只关不删，由测试断言守护。
    deleted: 0,
    /*
     * 扫到 0 条**不是失败**：库里此刻没有可关的会话是正常状态。
     * 记成 failure 会让正常状态每小时产生一条告警，稀释真实告警。
     */
    failures: [],
  };
}

export const sessionSweeperJob: JobDefinition = {
  name: "session-sweeper",
  intervalMs: HOUR_MS,
  // 状态收敛型（见模块注释）：漏跑的窗口不需要补，下一拍照样扫得到。
  maxCatchUpWindows: 1,
  run: (ctx) => runSessionSweeper(ctx, createSessionSweeperDeps()),
};

function createSessionSweeperDeps(): SessionSweeperDeps {
  // 延迟到调用时才建仓储：与其它任务一致，装配失败不该在模块加载时炸。
  return {
    async closeIdleEmptySessions(opts) {
      const { getPrisma, createChatRepository } = await import("@cabinhug/db");
      return createChatRepository(getPrisma()).closeIdleEmptySessions(opts);
    },
  };
}
