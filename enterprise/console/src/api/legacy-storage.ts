/**
 * 控制台本地存储键的改名迁移（ACR-051）：`carlife.console.*` → `cabinhug.console.*`。
 *
 * 与 `clients/shared/ui/src/storage/legacy-keys.ts` 是同一套规则的两份实现：
 * 控制台不依赖端上组件库（`@cabinhug/ui`），为两个键引入这条依赖不值得。
 * 规则：新键为空才拷、旧键保留、存储不可用时跳过该键。
 */

const LEGACY_CONSOLE_KEYS: ReadonlyArray<readonly [legacy: string, current: string]> = [
  ["carlife.console.token", "cabinhug.console.token"],
  ["carlife.console.traceView", "cabinhug.console.traceView"],
];

/** 入口调用一次：把旧键的值拷到新键（新键为空时），迁移了就打一条弃用日志。 */
export function migrateLegacyConsoleStorage(storage: Pick<Storage, "getItem" | "setItem"> = localStorage): string[] {
  const migrated: string[] = [];
  for (const [legacy, current] of LEGACY_CONSOLE_KEYS) {
    try {
      if (storage.getItem(current) !== null) continue;
      const value = storage.getItem(legacy);
      if (value === null) continue;
      storage.setItem(current, value);
      migrated.push(legacy);
    } catch {
      // 存储不可用：这一个键回到缺省值，不挡控制台启动。
    }
  }
  if (migrated.length > 0) {
    console.warn(`[storage] 已把旧键（已弃用）迁到新键名：${migrated.join(", ")}`);
  }
  return migrated;
}
