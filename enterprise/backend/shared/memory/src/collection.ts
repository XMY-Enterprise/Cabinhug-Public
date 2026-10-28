/**
 * Mem0 的集合名（pgvector 下即表名）。
 *
 * Mem0 客户端与仓储的裸 SQL 都从这里取表名，保证读写同一张表。
 *
 * # 旧表名（ACR-051）
 *
 * 表名为 `cabinhug_memories`，旧名 `carlife_memories` 已迁移。配置仍为旧名时，
 * Mem0 会照旧名另建一张空表，使记忆分裂；因此旧名按新名处理，并提示一次弃用。
 */

export const DEFAULT_MEMORY_COLLECTION = "cabinhug_memories";
const LEGACY_MEMORY_COLLECTION = "carlife_memories";

/**
 * 表名会被拼进 SQL（`chat.ts` 的记忆面板），且来自可热改的配置，
 * 因此只接受普通的小写标识符，其余一律拒绝，不做转义。
 */
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

let warnedLegacy = false;

/** 读 `MEM0_COLLECTION`；未配时用缺省值；不是合法标识符时抛错（fail fast，不静默回落）。 */
export function memoryCollectionName(env: Record<string, string | undefined> = process.env): string {
  const configured = env.MEM0_COLLECTION?.trim();
  if (!configured) return DEFAULT_MEMORY_COLLECTION;
  if (configured === LEGACY_MEMORY_COLLECTION) {
    if (!warnedLegacy) {
      warnedLegacy = true;
      console.warn(
        `[memory] MEM0_COLLECTION=${LEGACY_MEMORY_COLLECTION} 是改名前的表名，已按 ${DEFAULT_MEMORY_COLLECTION} 处理；请改配置`,
      );
    }
    return DEFAULT_MEMORY_COLLECTION;
  }
  if (!IDENTIFIER.test(configured)) {
    throw new Error(`MEM0_COLLECTION=${JSON.stringify(configured)} 不是合法表名：只允许小写字母、数字与下划线`);
  }
  return configured;
}

/** 配置校验用：与 `memoryCollectionName` 同一条判据，返回错误文案或 null。 */
export function validateMemoryCollectionName(value: string): string | null {
  return IDENTIFIER.test(value.trim()) ? null : "只允许小写字母、数字与下划线，且不以数字开头";
}
