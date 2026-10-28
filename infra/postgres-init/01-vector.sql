-- pgvector 扩展（§13-11 方案 A）。
--
-- 只在首次建库时由 postgres 镜像的 entrypoint 执行。已有数据卷不会重跑，
-- 所以 infra/scripts/pgvector-setup.sh 提供幂等的补齐路径——升级现存环境走那条。
--
-- IF NOT EXISTS：本文件本身也要能重复执行，不能假设只跑一次。
CREATE EXTENSION IF NOT EXISTS vector;
