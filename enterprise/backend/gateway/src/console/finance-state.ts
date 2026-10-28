/**
 * 财务快照的落盘（形态与 mocks/cabin/src/persistence.ts 一致）。
 *
 * 落盘使网关重启后页面能立刻给出上一次的快照，再在后台换新，
 * 不必每次重启都全量打五家上游（其中高德探针消耗当日额度）。
 *
 * 不进 Postgres：这是缓存不是账本，丢了可由下次采集重建，不值得建表与迁移。
 * `var/` 是仓里运行时状态的既有位置（mock-cabin 的车辆状态也在那）。
 *
 * 安全前提：快照里没有任何密钥。这里落的就是 finance.test.ts 断言
 * "响应里不得出现密钥"的那个响应，快照混入凭据时该测试先红。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { FinanceBillPage } from "./finance-providers";
import type { FinanceSnapshot } from "./finance";

/** 结构变了就升版本；旧版文件按空白处理，不做迁移——缓存不值得迁移。 */
const STATE_VERSION = 1;

export interface FinanceState {
  version: number;
  snapshot: { at: number; snapshot: FinanceSnapshot } | null;
  bills: Record<string, { at: number; page: FinanceBillPage }>;
}

export function emptyState(): FinanceState {
  return { version: STATE_VERSION, snapshot: null, bills: {} };
}

/** 默认路径相对 cwd 解析（与 mock-cabin 同约定）；环境变量可改。惰性读，避开 env-timing 不变量。 */
export function defaultStateFile(): string {
  return resolve(process.env.CABINHUG_FINANCE_STATE_FILE ?? "var/finance-cache.json");
}

export function loadState(file: string): FinanceState {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    // 首次启动没有文件是正常的，其它读取错误要说出来
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[finance] 读取快照失败，按空白启动：${String(err)}`);
    }
    return emptyState();
  }
  try {
    const parsed = JSON.parse(raw) as FinanceState;
    if (parsed?.version !== STATE_VERSION || typeof parsed.bills !== "object" || parsed.bills === null) {
      return emptyState();
    }
    return parsed;
  } catch (err) {
    // 坏文件不能让网关起不来，但也不能装作没事：改名留证，下次启动是干净的空白。
    const broken = `${file}.broken-${Date.now()}`;
    try {
      renameSync(file, broken);
      console.warn(`[finance] 快照损坏（${String(err)}），已另存为 ${broken}，按空白启动`);
    } catch {
      console.warn(`[finance] 快照损坏且无法改名（${String(err)}），按空白启动`);
    }
    return emptyState();
  }
}

/**
 * 先写临时文件再改名——进程在写一半时被杀（dev:stop 就是 kill）不该留下半个 JSON。
 * 写失败只告警不抛：落盘是锦上添花，不能让"磁盘满了"挡住余额查询本身。
 */
export function saveState(file: string, state: FinanceState): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, file);
  } catch (err) {
    console.warn(`[finance] 快照落盘失败（不影响本次查询）：${String(err)}`);
  }
}
