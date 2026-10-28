#!/usr/bin/env bash
# 发布态部署（在服务器上执行，由 GitHub Actions 经阿里云云助手 RunCommand 调起）。
#
# 它随部署包镜像 cabinhug-deploy-bundle:<tag> 一起发版，所以这份脚本、Compose 文件
# 与业务镜像恒为同一批次，不会出现镜像已升级而部署逻辑仍是旧版的情况。
#
#   用法（RunCommand 下发的就是这一行）：
#     bash infra/scripts/release-deploy.sh <镜像前缀> <tag>
#   例：bash infra/scripts/release-deploy.sh registry.cn-hangzhou.aliyuncs.com/carlife_agent_ai v1.2.3
#
# 与 infra/scripts/up.sh 的分工：那条用于开发机/首次拉起（在本机构建镜像）；
# 这条用于发布（只拉已构建好的镜像，不 build）。两者共用同一批 Compose 文件。
#
# 它不碰 .env。密钥只存在于服务器上这一份文件里，既不进 git 也不进 GitHub Secrets，
# 也不由发布流程覆写；发布只换镜像。新增环境变量是一次独立的人工操作。

set -euo pipefail

IMAGE_PREFIX="${1:?用法：release-deploy.sh <镜像前缀> <tag>}"
IMAGE_TAG="${2:?用法：release-deploy.sh <镜像前缀> <tag>}"
# 旧名 CARLIFE_APP_DIR（ACR-051 改名前）照收：本脚本在服务器上单独执行，拿不到仓库里的桥接 helper。
APP_DIR="${CABINHUG_APP_DIR:-${CARLIFE_APP_DIR:-/opt/carlife}}"
# 冗长日志留在服务器：云助手回传的输出有截断上限，pull/up 的几百行会把结论挤掉。
# 这里只回传结论，细节留档备查。
LOG="$APP_DIR/.release-deploy.log"

log() { printf '%s\n' "$*"; }
ok()  { printf '  ✓ %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; printf '  细节见服务器 %s 末尾：\n' "$LOG" >&2; tail -30 "$LOG" >&2 2>/dev/null || true; exit 1; }

cd "$APP_DIR" || die "应用目录 $APP_DIR 不存在"
[[ -f .env ]] || die "缺 $APP_DIR/.env——发布流程不生成它，密钥只应由人在服务器上落一次"

COMPOSE=(docker compose --env-file .env
  -f infra/docker-compose.stack.yml
  -f infra/compose/worker.yml
  -f infra/compose/web.yml
  -f infra/compose/clients.yml
  -f infra/compose/release.yml
  --profile worker --profile web --profile clients)

export CABINHUG_IMAGE_PREFIX="$IMAGE_PREFIX"
export CABINHUG_IMAGE_TAG="$IMAGE_TAG"

log "── 发布 $IMAGE_TAG ──"
log "  镜像前缀：$IMAGE_PREFIX"
: >"$LOG"

# ── 上一版是什么：失败时要能一眼看出该退回哪里（回滚就是拿这个 tag 重跑本脚本）
PREV_FILE="$APP_DIR/.release-current"
[[ -f "$PREV_FILE" ]] && log "  上一版：$(cat "$PREV_FILE")" || log "  上一版：（首次发布）"

# ── 拉镜像。同 tag 重推时 pull_policy: always 保证真的换掉，不吃本地旧层
log "① 拉取镜像"
"${COMPOSE[@]}" pull --quiet >>"$LOG" 2>&1 || die "镜像拉取失败（登录过期？tag 不存在？）"
ok "9 个业务镜像已就位"

# ── 起栈。--no-build 是硬要求：服务器上不发生任何构建
log "② 应用新版本（migrate 会先跑完再起 gateway）"
# 改名前的 Compose 项目（ACR-051）：与新项目共用数据卷和端口，先停旧的——不带 -v。
# shellcheck source=infra/scripts/_legacy-compose.sh
source "$(dirname "${BASH_SOURCE[0]}")/_legacy-compose.sh"
stop_legacy_compose_project >>"$LOG" 2>&1 || die "停止改名前的 Compose 项目失败"
"${COMPOSE[@]}" up -d --no-build --remove-orphans >>"$LOG" 2>&1 || die "compose up 失败"
ok "容器已按新镜像重建"

# ── 验证。"起来了"不等于"能用"：等健康 + 打真实请求
log "③ 验证"
for svc in postgres redis minio mock-dealer mock-cabin mock-repair mock-insurance agent-runtime gateway worker web cockpit-web mobile-web; do
  "${COMPOSE[@]}" ps --services --status running 2>/dev/null | grep -qx "$svc" || die "$svc 没在跑"
done
ok "13 个服务在跑"

i=0
until curl -fsS --max-time 5 http://localhost:8790/healthz 2>/dev/null | grep -q '"ok":true'; do
  i=$((i + 1)); [[ $i -lt 24 ]] || die "gateway /healthz 120s 内未通过"
  sleep 5
done
ok "gateway /healthz"

for port in 8792 8793 8797 8798; do
  curl -fsS --max-time 5 "http://localhost:$port/health" 2>/dev/null | grep -q '"ok":true' || die "mock :$port 不健康"
done
ok "四个 mock /health"

curl -fsS --max-time 5 http://localhost:5173/ 2>/dev/null | grep -qiE '<!doctype html|<html' || die "web :5173 首页不通过"
ok "web :5173 首页"

# 两个客户端演示站。它们让后台状态页的 cockpit / mobile 两行在线上也能变绿
# （状态页探的就是 1430 / 1420，见 console/system-status.ts）。
for port in 1430 1420; do
  curl -fsS --max-time 5 "http://localhost:$port/" 2>/dev/null | grep -qiE '<!doctype html|<html' || die "客户端演示站 :$port 首页不通过"
done
ok "cockpit :1430 / mobile :1420 首页"

# ── 留痕：当前跑的是哪个 tag。回滚与排障都从这里读起
printf '%s\t%s\n' "$IMAGE_TAG" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$PREV_FILE"

# 旧镜像不自动删：磁盘 79G 够用，留着上一版才能秒级回滚（免去 pull）。
# 清理用 `docker image prune -a --filter until=720h`，由人工执行。
log "── 发布成功：$IMAGE_TAG ──"
