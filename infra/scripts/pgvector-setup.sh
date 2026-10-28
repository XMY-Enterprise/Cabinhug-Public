#!/usr/bin/env bash
# pgvector 扩展的幂等补齐（§13-11 方案 A）。
#
# `docker-entrypoint-initdb.d` 只在数据卷为空时执行。已有数据卷的 postgres:16 环境
# 换成 pgvector 镜像后，初始化目录不会运行，扩展不存在且没有报错。
# 本脚本提供一条显式、幂等、可重复运行的补齐路径。
#
# 用法：infra/scripts/pgvector-setup.sh [container_name]

set -euo pipefail

CONTAINER="${1:-cabinhug-postgres}"
DB="${POSTGRES_DB:-carlife}"
USER="${POSTGRES_USER:-carlife}"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "✗ 容器 $CONTAINER 未运行。先 docker compose -f infra/docker-compose.yml up -d" >&2
  exit 1
fi

# 镜像里没有扩展文件时，CREATE EXTENSION 会失败——先把这条区分出来，
# 否则报错会被误读成"权限问题"。
if ! docker exec "$CONTAINER" psql -U "$USER" -d "$DB" -tAc \
  "select 1 from pg_available_extensions where name='vector'" | grep -q 1; then
  echo "✗ 镜像不含 pgvector。docker-compose.yml 的 image 是否仍是 postgres:16？" >&2
  echo "  改成 pgvector/pgvector:pg16 后 docker compose up -d 重建容器（命名卷不丢数据）。" >&2
  exit 2
fi

docker exec "$CONTAINER" psql -U "$USER" -d "$DB" -c "CREATE EXTENSION IF NOT EXISTS vector" >/dev/null

VER=$(docker exec "$CONTAINER" psql -U "$USER" -d "$DB" -tAc \
  "select extversion from pg_extension where extname='vector'")
echo "✓ pgvector 已就绪（版本 ${VER}，容器 ${CONTAINER}）"
