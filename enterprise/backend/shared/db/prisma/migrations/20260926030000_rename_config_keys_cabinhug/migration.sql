-- ACR-051 / M110-09：三个热配置键随环境变量改名（CARLIFE_* → CABINHUG_*）。
-- 只改数据不改结构。配置存储跳过注册表外的键，不迁的话库里的旧行会被静默忽略、
-- 回落到 env 或缺省值，修订历史也会按新旧键断成两截。
-- 密文按值加密、不以键名作附加数据（config/crypto.ts），改键不需重新加密。
-- 新键已存在时（迁移前已有人按新名保存过）以新键为准，删掉旧行，避免主键冲突。
-- 回滚：把三组语句里的新旧键名对调后执行。

DELETE FROM "config_items" WHERE "key" = 'CARLIFE_LLM_FAKE_TAG'
  AND EXISTS (SELECT 1 FROM "config_items" WHERE "key" = 'CABINHUG_LLM_FAKE_TAG');
UPDATE "config_items" SET "key" = 'CABINHUG_LLM_FAKE_TAG' WHERE "key" = 'CARLIFE_LLM_FAKE_TAG';
UPDATE "config_item_revisions" SET "key" = 'CABINHUG_LLM_FAKE_TAG' WHERE "key" = 'CARLIFE_LLM_FAKE_TAG';

DELETE FROM "config_items" WHERE "key" = 'CARLIFE_TOOLS'
  AND EXISTS (SELECT 1 FROM "config_items" WHERE "key" = 'CABINHUG_TOOLS');
UPDATE "config_items" SET "key" = 'CABINHUG_TOOLS' WHERE "key" = 'CARLIFE_TOOLS';
UPDATE "config_item_revisions" SET "key" = 'CABINHUG_TOOLS' WHERE "key" = 'CARLIFE_TOOLS';

DELETE FROM "config_items" WHERE "key" = 'CARLIFE_WEATHER_CMA'
  AND EXISTS (SELECT 1 FROM "config_items" WHERE "key" = 'CABINHUG_WEATHER_CMA');
UPDATE "config_items" SET "key" = 'CABINHUG_WEATHER_CMA' WHERE "key" = 'CARLIFE_WEATHER_CMA';
UPDATE "config_item_revisions" SET "key" = 'CABINHUG_WEATHER_CMA' WHERE "key" = 'CARLIFE_WEATHER_CMA';
