# shellcheck shell=bash
# 改名前的 Compose 项目（ACR-051）：`carlife` → `cabinhug`。
#
# 两个项目的容器钉着同一组数据卷（卷名显式写死，不带项目前缀）与同一组宿主端口。
# 旧项目的容器还在时起新项目，轻则端口撞车起不来，重则两个 PG 挂同一个数据目录。
# 因此在 `up` 之前先停掉并移除旧项目，且不带 -v：数据卷由两个项目共用，
# 删卷即删库。

LEGACY_COMPOSE_PROJECT="carlife"

# stop_legacy_compose_project [项目名]：该项目有容器就 down（不删卷），没有就什么都不做。
# 参数只为能拿一次性的探针项目验证本函数；调用方一律不传。
stop_legacy_compose_project() {
  local project="${1:-$LEGACY_COMPOSE_PROJECT}" ids
  ids="$(docker ps -aq --filter "label=com.docker.compose.project=$project" 2>/dev/null)"
  [ -n "$ids" ] || return 0
  printf '  发现改名前的 Compose 项目 %s 的容器，先停掉并移除（数据卷保留，不带 -v）\n' "$project" >&2
  docker compose -p "$project" down
}
