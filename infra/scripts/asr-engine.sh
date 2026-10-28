#!/usr/bin/env bash
# 当前生效的 ASR 档位，起停脚本与网关看同一处（ACR-017 的选档规则）：
#
#   1. .env 写了 ASR_ENGINE 即钉档（后台该项只读）；
#   2. 没写，则档位来自后台热配置（config_items 表的 ASR_ENGINE，运营控制台可热切）；
#   3. 都问不到，按网关的缺省 ark。
#
# dev.sh / dev-infra.sh 据此决定起不起 local-asr 容器。只看 shell 环境变量会与网关
# 分歧：后台热切到 mock 时网关把语音发到 127.0.0.1:8795，容器却没起，
# 车机端得到 upload_failed（网关 502，ECONNREFUSED 8795）。
#
# 用法：`. infra/scripts/asr-engine.sh; effective_asr_engine`。结果按进程缓存一次：
# 一次 dev:status 会问四五回，每回 docker exec 都是 100ms 级。
effective_asr_engine() {
  if [ -n "${_CABINHUG_ASR_ENGINE_CACHED:-}" ]; then printf '%s\n' "$_CABINHUG_ASR_ENGINE_CACHED"; return 0; fi
  local engine="${ASR_ENGINE:-}" container="${CABINHUG_PG_CONTAINER:-cabinhug-postgres}"
  if [ -z "$engine" ] && command -v docker >/dev/null 2>&1 &&
    docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$container"; then
    engine="$(docker exec "$container" psql -U "${POSTGRES_USER:-carlife}" -d "${POSTGRES_DB:-carlife}" -tAc \
      "select value from config_items where key = 'ASR_ENGINE'" 2>/dev/null | tr -d '[:space:]')"
    [ -n "$engine" ] && ASR_ENGINE_SOURCE="后台热配置"
  else
    [ -n "$engine" ] && ASR_ENGINE_SOURCE=".env"
  fi
  : "${ASR_ENGINE_SOURCE:=缺省}"
  _CABINHUG_ASR_ENGINE_CACHED="${engine:-ark}"
  printf '%s\n' "$_CABINHUG_ASR_ENGINE_CACHED"
}

# 档位的来源用这个函数取，不要直接读 ASR_ENGINE_SOURCE：调用方拿档位走
# `$(effective_asr_engine)`，赋值发生在命令替换的子 shell 里传不出来，调用方的这个
# 变量未定义，`set -u` 下会报 `unbound variable`。
# 这里先在本函数（也是子 shell）里把档位算出来，再读同一层的 ASR_ENGINE_SOURCE。
asr_engine_source() {
  effective_asr_engine >/dev/null
  printf '%s\n' "${ASR_ENGINE_SOURCE:-缺省}"
}
