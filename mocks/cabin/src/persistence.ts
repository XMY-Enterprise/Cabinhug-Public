/**
 * 车机状态落盘（原子 JSON 快照，零依赖）。
 *
 * # 定位
 *
 * 落盘模拟的是车机把设置写进自己的 NVM：进程重启后仍是同一辆车。
 * `index.ts` 开头的硬约束中，「状态重启即清」由本文件放宽，
 * 其余两条不变：不引 `@cabinhug/*`、不连 PG/Redis/MinIO。
 * 进程停止时仍是连接被拒，助手照常如实说「车机没连上」。
 *
 * # 整份存
 *
 * 车辆本身也在内存里（`vehicles` Map）。只存变更流水时，重启后车辆不存在，
 * 上游 `withVehicle()` 会重新造车并拿到新 id，旧流水成为无车的孤儿记录。
 * 因此快照连同发号器（`vehicleSeq` / `changeSeq`）一起存：id 不重号，seq 不倒流。
 *
 * # JSON 文件而不是 SQLite
 *
 * 数据量是「几辆车 × 几百条流水」，访问形态是「启动读一次、变更整份写」，
 * 用不上索引和事务；`node:sqlite` 还会把服务与 Node 版本绑定。JSON 可直接 `cat` 排查。
 *
 * 写入用「临时文件 + rename」：rename 在同一文件系统上是原子的，
 * 断电或被 kill 最多丢掉最后一个防抖窗口内的变更，不会留下半个文件。
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** 快照格式版本。形状不兼容地改动时 +1，`load` 会拒绝并从空白开始（而不是读出畸形对象）。 */
export const SNAPSHOT_VERSION = 1;

export interface Snapshot {
  version: number;
  savedAt: string;
  /** 车辆发号器——不存的话重启后会把 VEH-000001 发给第二辆车。 */
  vehicleSeq: number;
  /** 变更序号——后台按 seq 排序与去重，倒流会让时间线错乱。 */
  changeSeq: number;
  vehicles: unknown[];
}

/**
 * 落盘目标。
 *
 * - `CABIN_PERSIST=off` → 完全不落盘（**测试用**：用例之间靠 `__resetAll()` 隔离，
 *   落盘会让它们互相污染，还会在仓库里留下垃圾文件）。
 * - `CABIN_DATA_FILE` → 显式路径（容器里指到挂载卷）。
 * - 默认 `var/mock-cabin-state.json`，相对**当前工作目录**解析。
 *
 * 不放进 `data/`：那里是随镜像发布的种子数据（`models.json`），挂卷会把种子盖掉。
 */
const DISABLED = process.env.CABIN_PERSIST === "off";
const FILE = DISABLED ? null : resolve(process.env.CABIN_DATA_FILE ?? "var/mock-cabin-state.json");

/** 供启动日志打印：默认路径随 cwd 解析。 */
export function snapshotPath(): string | null {
  return FILE;
}

export function load(): Snapshot | null {
  if (!FILE) return null;
  let raw: string;
  try {
    raw = readFileSync(FILE, "utf8");
  } catch (err) {
    // 首次启动没有文件是正常的，其它读取错误要说出来
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[mock-cabin] 读取快照失败，按空白启动：${String(err)}`);
    }
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Snapshot;
    if (parsed?.version !== SNAPSHOT_VERSION) {
      console.warn(`[mock-cabin] 快照版本 ${parsed?.version} 与本版 ${SNAPSHOT_VERSION} 不符，按空白启动`);
      return null;
    }
    if (!Array.isArray(parsed.vehicles)) return null;
    return parsed;
  } catch (err) {
    /*
     * 坏文件不阻止服务启动；改名留证后按空白启动。
     */
    const broken = `${FILE}.broken-${Date.now()}`;
    try {
      renameSync(FILE, broken);
      console.warn(`[mock-cabin] 快照损坏（${String(err)}），已另存为 ${broken}，按空白启动`);
    } catch {
      console.warn(`[mock-cabin] 快照损坏且无法改名（${String(err)}），按空白启动`);
    }
    return null;
  }
}

/** 防抖窗口：一次 apply 会连续推多条 change，合并后再写盘。 */
const DEBOUNCE_MS = 200;

let timer: NodeJS.Timeout | null = null;
let build: (() => Snapshot) | null = null;

/**
 * 标记"状态变了"。真正的写入延后合并，进程退出时兜底 flush。
 * 传入取快照的函数而不是快照本身：防抖期间还会有新变更，到期时现取才是最终态。
 */
export function markDirty(snapshot: () => Snapshot): void {
  if (!FILE) return;
  build = snapshot;
  if (timer) return;
  // unref：定时器不阻止进程退出
  timer = setTimeout(flush, DEBOUNCE_MS);
  timer.unref?.();
}

/** 立刻写盘（防抖到期、或进程要退出了）。同步写——退出钩子里没有 await 可用。 */
export function flush(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!FILE || !build) return;
  const snapshot = build();
  const tmp = `${FILE}.tmp`;
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(tmp, JSON.stringify(snapshot), "utf8");
    renameSync(tmp, FILE); // 原子替换：读者要么看到旧的完整快照，要么看到新的
  } catch (err) {
    console.warn(`[mock-cabin] 写入快照失败：${String(err)}`);
    try {
      unlinkSync(tmp);
    } catch {
      /* 清不掉临时文件不值得再报一次错 */
    }
  }
}

/**
 * 退出前兜底。
 *
 * `exit` 事件对 `process.exit()` 与自然退出有效，但信号杀进程时不触发，
 * 容器停服发送的是 SIGTERM，因此两者都挂。信号处理器只 flush 再退出，
 * 不改变退出语义（`dev:restart` 与 `docker stop` 依赖进程照常退出）。
 */
export function installExitHooks(): void {
  if (!FILE) return;
  process.on("exit", flush);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      flush();
      process.exit(0);
    });
  }
}
