/**
 * 本地存储键的改名迁移（ACR-051）：`carlife.*` → `cabinhug.*`。
 *
 * # 拷贝而不是改名
 *
 * 旧键在并读期内保留：万一回滚到旧版本，旧版读的还是旧键，数据还在。
 * 新键已有值时不覆盖——那说明新版本已经写过，旧键里的是更早的状态。
 *
 * # 键表显式列出，不做前缀通配
 *
 * 通配会把不属于我们的、或已经废弃的键一并搬过来，而且搬了什么没人说得清。
 * 新增一个 `cabinhug.*` 键不需要改这里：这张表只记录改名那一刻已经存在的旧键。
 *
 * # 生效范围
 *
 * 只对"同一个 origin 下键名变了"生效：网页演示版与浏览器走查。原生客户端的
 * bundle ID 同时改了，WebView 存储随之换了位置，旧键根本不在新 origin 里——
 * 那一端的会话与偏好回到缺省，是已接受的代价。
 */

/** `[旧键, 新键]`。 */
export const LEGACY_STORAGE_KEYS: ReadonlyArray<readonly [legacy: string, current: string]> = [
  ["carlife.sessionId", "cabinhug.sessionId"],
  ["carlife.sessionMeta", "cabinhug.sessionMeta"],
  ["carlife.dev.token", "cabinhug.dev.token"],
  ["carlife.ui.soundscape", "cabinhug.ui.soundscape"],
  ["carlife.trip-review.announce", "cabinhug.trip-review.announce"],
  ["carlife.trip-review.announced", "cabinhug.trip-review.announced"],
  ["carlife.mobile.sessionId", "cabinhug.mobile.sessionId"],
  ["carlife.mobile.sessionMeta", "cabinhug.mobile.sessionMeta"],
  ["carlife.vision.onDevice", "cabinhug.vision.onDevice"],
  ["carlife.location.v1", "cabinhug.location.v1"],
];

type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

/**
 * 把旧键的值拷到新键（新键为空时）。返回实际迁移了的旧键名，调用方据此打弃用日志。
 *
 * 存储不可用（隐私模式、配额满）时逐键吞掉异常：迁移失败的后果只是回到缺省值，
 * 不该挡住应用启动。
 */
export function migrateLegacyStorageKeys(
  storage: KeyValueStore,
  keys: ReadonlyArray<readonly [string, string]> = LEGACY_STORAGE_KEYS,
): string[] {
  const migrated: string[] = [];
  for (const [legacy, current] of keys) {
    try {
      if (storage.getItem(current) !== null) continue;
      const value = storage.getItem(legacy);
      if (value === null) continue;
      storage.setItem(current, value);
      migrated.push(legacy);
    } catch {
      // 见函数注释：存储不可用时跳过这一个键。
    }
  }
  return migrated;
}

/** 应用入口调用：对 `window.localStorage` 做一次迁移并打日志。非浏览器环境无操作。 */
export function migrateLegacyLocalStorage(): void {
  if (typeof globalThis.localStorage === "undefined") return;
  const migrated = migrateLegacyStorageKeys(globalThis.localStorage);
  if (migrated.length > 0) {
    console.warn(`[storage] 已把 ${migrated.length} 个旧键（carlife.*，已弃用）迁到 cabinhug.*：${migrated.join(", ")}`);
  }
}
