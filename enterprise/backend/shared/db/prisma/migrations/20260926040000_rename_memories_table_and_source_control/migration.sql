-- ACR-051 / M110-10：Mem0 记忆表与研究来源的控制方值随品牌改名。只改名、改值，不改结构。
--
-- 记忆表不在 schema.prisma 里（Mem0 自管，启动时"表不在就建"）。所以这里是条件语句：
--   只有旧表、没有新表 → 改表名，连同 Mem0 按"表名_后缀"建的索引一起改——
--     不改的话 Mem0 按新名 CREATE INDEX IF NOT EXISTS，会在同一列上再建一份向量索引；
--   两张都在       → 不动，只报警（多半是旧代码在迁移后又起过一次、建了空的新表，需要人来判断）；
--   两张都不在     → 什么都不做（新库：Mem0 首次启动时按新名建表）。
-- 迁移先于应用启动（dev:bootstrap、release 的 migrate 服务都是如此），Mem0 起来时新表已在。
-- 回滚：把 DO 块里的新旧名对调后执行；research_sources 反向 UPDATE。

DO $$
BEGIN
  IF to_regclass('public.carlife_memories') IS NOT NULL
     AND to_regclass('public.cabinhug_memories') IS NULL THEN
    ALTER TABLE "carlife_memories" RENAME TO "cabinhug_memories";
    IF to_regclass('public.carlife_memories_pkey') IS NOT NULL THEN
      ALTER INDEX "carlife_memories_pkey" RENAME TO "cabinhug_memories_pkey";
    END IF;
    IF to_regclass('public.carlife_memories_hnsw_idx') IS NOT NULL THEN
      ALTER INDEX "carlife_memories_hnsw_idx" RENAME TO "cabinhug_memories_hnsw_idx";
    END IF;
    IF to_regclass('public.carlife_memories_diskann_idx') IS NOT NULL THEN
      ALTER INDEX "carlife_memories_diskann_idx" RENAME TO "cabinhug_memories_diskann_idx";
    END IF;
  ELSIF to_regclass('public.carlife_memories') IS NOT NULL
     AND to_regclass('public.cabinhug_memories') IS NOT NULL THEN
    RAISE WARNING 'carlife_memories 与 cabinhug_memories 同时存在，未改名：请人工核对两张表的行数后再合并';
  END IF;
END $$;

-- 热配置里显式配着旧表名的，一并改掉（运行时也会把旧名当新名处理，这里让配置页显示真实值）。
UPDATE "config_items" SET "value" = 'cabinhug_memories'
 WHERE "key" = 'MEM0_COLLECTION' AND "value" = 'carlife_memories';

-- 来源护照的可查询副本：判断一律读代码常量，这里只让 SQL 里看到的值与代码一致。
UPDATE "research_sources" SET "control" = 'cabinhug' WHERE "control" = 'carlife';
