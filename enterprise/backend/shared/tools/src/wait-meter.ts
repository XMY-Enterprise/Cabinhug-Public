/**
 * 限速闸的等待计量：一次工具调用里有多少时间是在排本进程自己的队。
 *
 * # 区分上游耗时与本地排队
 *
 * 并发 fan-out 时多个高德请求会在限速闸（`amap.ts` 的 `createAmapRateGate`）前排队，
 * 工具一跳的总耗时里混着上游计算时间与本地排队时间。两者处置相反：
 * 前者只能等上游，后者取决于本地并发策略，可以调整。
 *
 * # 用 AsyncLocalStorage，不把 ctx 一路传下去
 *
 * 等待发生在 `amap.ts` 的 `get()` 里，离 `invokeTool` 隔着
 * `defineExternalTool` → 各工具的 `real()` → 后端接口（`PoiSearchBackend` 之流）
 * → `AmapClient` 四层，这些接口都只收 signal，没有 ctx
 * （`PoiSearchBackend.textSearch(params, signal)`）。给四层接口各加一个参数
 * 会把观测成本摊到每个实现上，新后端漏传时不报错、数字只是偏小。
 *
 * 异步上下文按"一次调用链"隔离：并发分支各有各的账，互不串。
 *
 * # 合并区间，不是累加
 *
 * 一次工具调用可能并发打好几个高德请求（`map_route` 的两端地理编码就是），
 * 它们的等待在时间上重叠。累加会得出比这一跳总时长还大的等待，所以记区间、取并集。
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface WaitLedger {
  /** 每次等待的 [起, 止]，最后取并集（见文件头）。 */
  spans: Array<{ s: number; e: number }>;
}

const store = new AsyncLocalStorage<WaitLedger>();

/**
 * 开一本新账；`run()` 里发生的排队都记进去，`waitMs()` 随时可读。
 *
 * 分成两个动作而不是单个 `withWaitMeter(fn)`，是因为失败时也要拿到数：
 * 被限流退避到超时的调用是从 catch 里出去的。
 *
 * 不支持嵌套：`invokeTool` 是工具的唯一执行入口，一次调用一本账。
 * 工具里再调工具时内层自己开一本，外层不含内层的等待，那笔时间记在内层那一跳上。
 */
export function openWaitMeter(): { waitMs: () => number; run: <T>(fn: () => Promise<T>) => Promise<T> } {
  const ledger: WaitLedger = { spans: [] };
  return {
    waitMs: () => unionMs(ledger.spans),
    run: (fn) => store.run(ledger, fn),
  };
}

/**
 * 记一段排队。由闸门自己调用，调用点无需感知。
 *
 * 不在任何一本账里（没经 `invokeTool` 的直调、单测）时静默丢弃，
 * 计量不给被计量的代码增加分支。
 */
export function recordWait(startedAt: number, endedAt: number): void {
  if (!(endedAt > startedAt)) return;
  store.getStore()?.spans.push({ s: startedAt, e: endedAt });
}

function unionMs(spans: Array<{ s: number; e: number }>): number {
  if (spans.length === 0) return 0;
  const sorted = [...spans].sort((a, b) => a.s - b.s);
  let total = 0;
  let cur = { ...sorted[0]! };
  for (const sp of sorted.slice(1)) {
    if (sp.s > cur.e) {
      total += cur.e - cur.s;
      cur = { ...sp };
      continue;
    }
    cur.e = Math.max(cur.e, sp.e);
  }
  return Math.round(total + (cur.e - cur.s));
}
