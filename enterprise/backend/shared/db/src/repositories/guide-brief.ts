/**
 * 景区导览简报的持久仓储，缺省每个景点只采集一次。
 *
 * 读写维度只有 (city, spotName)，与⑤缓存键同构：city 为空统一写 "-"。
 * 两套键必须同源，否则同一景点会在两条路径上各存一份。
 * brief 是 @cabinhug/shared `GuideBrief` 的 JSON 快照，结构由契约管，这里不校验
 * 不拆列；只存三支齐全的简报，由调用方把关（半成品占位会让景点不再补全）。
 *
 * 保鲜期（ACR-065）：读时可带 `maxAgeMs`，`updated_at` 早于它的视同没有，调用方随之重采、
 * upsert 覆盖并刷新 `updated_at`。不给就是永久，与「只采一次」的现状一致。用已有的列，不改表。
 */

import type { Prisma, PrismaClient } from "@prisma/client";

export interface GuideBriefGetOptions {
  /** 保鲜期（毫秒）。不给 = 永久。 */
  maxAgeMs?: number;
  /** 单测注入时钟；缺省 `Date.now()`。 */
  now?: number;
}

export interface GuideBriefStore {
  /** 命中返回 brief JSON（unknown，调用方按 shared 契约用）；没有或已过保鲜期返回 null。 */
  get(city: string | undefined, spotName: string, opts?: GuideBriefGetOptions): Promise<unknown | null>;
  /** upsert：重新采集（force）或过期重采覆盖旧份。 */
  put(city: string | undefined, spotName: string, brief: unknown): Promise<void>;
}

const cityKey = (city: string | undefined): string => city?.trim() || "-";

/**
 * `GUIDE_BRIEF_TTL_DAYS` → 保鲜期毫秒。没设、不是正数都按永久（undefined）：
 * 写错一个值不该让每次点击都重采——那是按次计费的联网搜索。
 */
export function guideBriefMaxAgeMs(days: string | undefined): number | undefined {
  const n = Number(days?.trim());
  return Number.isFinite(n) && n > 0 ? n * 86_400_000 : undefined;
}

export function createGuideBriefRepository(
  prisma: Pick<PrismaClient, "guideBriefRecord">,
): GuideBriefStore {
  return {
    async get(city, spotName, opts = {}) {
      const row = await prisma.guideBriefRecord.findUnique({
        where: { city_spotName: { city: cityKey(city), spotName } },
      });
      if (!row) return null;
      if (opts.maxAgeMs !== undefined && (opts.now ?? Date.now()) - row.updatedAt.getTime() > opts.maxAgeMs) return null;
      return row.brief ?? null;
    },

    async put(city, spotName, brief) {
      const value = brief as Prisma.InputJsonValue;
      await prisma.guideBriefRecord.upsert({
        where: { city_spotName: { city: cityKey(city), spotName } },
        create: { city: cityKey(city), spotName, brief: value },
        update: { brief: value },
      });
    },
  };
}
