#!/usr/bin/env bash
#
# 本地开发服务的起停。它负责三件事：
#
#   1. 服务不自己读根 .env（网关/runtime 都不读），由本脚本 source 后再起。
#   2. 停干净。`corepack pnpm --filter X dev` 起的是三层：corepack 壳 → tsx watch →
#      真正 listen 的 `node --import tsx src/index.ts`。杀最外层不保证杀掉最里层，
#      而最里层的命令行里没有包名，pgrep 按名字找不到它。
#      所以这里按「cwd 属于哪个包」来认进程，而不是按命令行文本。
#   3. 会话/终端关闭后，tsx watch 监护进程被回收，listen 的子进程被 launchd 收养——
#      服务仍在响应，但改代码不再热重载。`status` 会把这种状态标出来。
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOGDIR="$ROOT/.dev-logs"
source "$ROOT/infra/scripts/dev-node-check.sh"

# name : pnpm filter 或容器服务名 : 端口(0=无) : 工作目录 : 类型
#
# 类型决定三件事——怎么起、怎么找它的进程、什么算健康：
#   svc  外面套 `tsx watch`，监护进程死了就不再热重载（见 has_watcher）
#   vite 自己就是 HMR，没有监护层这一说
#   app  Tauri 客户端二进制，只是个壳：debug 构建下 tauri_build 发 cfg(dev)，
#        `generate_context!` 走 devUrl 而不内嵌 dist，所以界面来自 1430/1420 那个 vite。
#        必须等 vite 先就绪，否则是白屏。
#   compose 由项目 Compose 管理的旁车/模拟第三方容器，不读取或调用宿主机全局二进制。
#
# 四个 mock 是模拟第三方的独立服务，用 compose 承载，与 stack 部署形态一致，
# 也不受 svc 的孤儿进程问题影响。mock-tts 例外：它依赖 macOS 自带的 `say`，只能留在宿主。
#
# mock-cabin 在容器里不出声是刻意的：它的播放后端都是 spawn 本机二进制，容器里既没有
# mpg123 也没有 /dev/snd，`/health` 恒报 `backend:"none"`。不要因此把它改回 svc——
# 车内音乐由车机端（cockpit 拉走字节自己放）出声，服务端只维护状态机。
# 服务端那条 mpg123/afplay 的路只服务"全部跑在一台 Mac 上"的单机 demo。
# 判断车机端接上没有：`curl -s localhost:8793/health` 看 `audio.clientSinks`。
TARGETS="
gateway:@cabinhug/gateway:8790:enterprise/backend/gateway:svc
runtime:@cabinhug/agent-runtime:8791:enterprise/backend/agent-runtime:svc
cockpit:@cabinhug/cockpit:1430:clients/cockpit:vite
mobile:@cabinhug/mobile:1420:clients/mobile:vite
web:@cabinhug/web:5173:enterprise/console:vite
cockpit-app:target/debug/cockpit:0:clients/cockpit:app
mobile-app:target/debug/mobile:0:clients/mobile:app
mock-dealer:@cabinhug/mock-dealer:8792:mocks/dealer:compose
mock-cabin:@cabinhug/mock-cabin:8793:mocks/cabin:compose
mock-repair:@cabinhug/mock-repair:8797:mocks/repair:compose
mock-insurance:@cabinhug/mock-insurance:8798:mocks/insurance:compose
mock-tts:@cabinhug/mock-tts:8794:mocks/tts:svc
local-asr:local-asr:8795:.:compose
research-runtime:@cabinhug/research-runtime:8800:enterprise/backend/research-runtime:svc
worker:@cabinhug/worker:8796:enterprise/backend/worker:svc
vision-trainer:vision-trainer:8799:enterprise/backend/vision-trainer:py
"

# 默认集合。顺序即启动顺序：
#   - 两个 vite 必须排在对应的 -app 前面；
#   - mock-dealer 必须排在 runtime 前面：runtime 启动时会探活门店系统，
#     晚起的话启动探活失败，日志里留一条误导人的告警。
#
# URL 已写进 .env 的 mock 都在默认集合里：mock-dealer 进程没起时，助手会回答
# "门店系统没连上"，与缺配置的现象相同，容易被误判为产品故障。
#
# worker 随默认开发集合启动：它承载记忆衰减、用车聚合、知识库同步和车辆提醒，
# 缺它时这部分功能静默失效。它的 8796 不是业务端口，是只读探活端点，
# 让 `status` 能区分"没起"和"起了但还没到点执行"。
# 只调试在线链路时显式指定目标（例如 `dev:restart gateway runtime`），
# 不要手工起第二个 worker 实例。
#
# local-asr（ACR-006）在生效档位为 mock 时自动加入默认集合，并排在 Gateway 前面
# （档位的取法见 asr-engine.sh——.env 钉档，没钉就问后台热配置，与网关同源）；
# 它由项目自己的 Compose image 提供，不查找也不调用 Host whisper-server。未启用 local
# 时不创建这个旁车，Ark/Fake 的既有启动行为保持不变。
#
# mock-tts 依赖 macOS 自带的 `say`，因此 macOS 是默认启动它的宿主平台。
# 其它平台不把它放进默认集合：服务虽能监听健康端点，但真正合成会明确报平台不支持；
# 仍可用 `dev:start mock-tts` 显式启动做协议检查。
DEV_HOST_OS="$(uname -s 2>/dev/null || printf '%s' unknown)"
# mock-cabin / mock-repair / mock-insurance 同理在默认集合里，且排在 runtime 前面
# （runtime 启动探活会打它们，同 mock-dealer）。
DEFAULT_TARGETS="gateway mock-dealer mock-cabin mock-repair mock-insurance"
if [ "$DEV_HOST_OS" = "Darwin" ]; then
  DEFAULT_TARGETS="$DEFAULT_TARGETS mock-tts"
fi
DEFAULT_TARGETS="$DEFAULT_TARGETS runtime cockpit mobile web cockpit-app mobile-app worker"
# research-runtime 在默认集合里：后台热配置里 RESEARCH_RUNTIME_URL 填了 8800 时，
# 网关按 DB 优先读到地址就去探活，进程不起则控制台系统页报 research_unreachable。
# 排在 worker 之后：它只依赖 PG（pg-boss），不依赖 runtime，工具走它自己的
# /internal/research/tools/*。RESEARCH_ENABLED 缺省 off，只管 worker 挂不挂取数任务。
DEFAULT_TARGETS="$DEFAULT_TARGETS research-runtime"
BASE_DEFAULT_TARGETS="$DEFAULT_TARGETS"
ALL_TARGETS="gateway mock-dealer mock-cabin mock-repair mock-insurance mock-tts local-asr runtime cockpit mobile web cockpit-app mobile-app worker research-runtime vision-trainer"

. "$ROOT/infra/scripts/asr-engine.sh"
. "$ROOT/infra/scripts/_legacy-env.sh"

# 档位看 effective_asr_engine（.env 钉档 → 后台热配置 → ark），不只看 shell 环境变量，
# 与网关的选法一致，避免网关往 8795 发而容器没起。
refresh_default_targets() {
  DEFAULT_TARGETS="$BASE_DEFAULT_TARGETS"
  if [ "$(effective_asr_engine)" = "mock" ] &&
    [ "${CABINHUG_DEV_INFRA_LOCAL_ASR_READY:-0}" != "1" ]; then
    DEFAULT_TARGETS="local-asr $DEFAULT_TARGETS"
  fi
}

field() { echo "$TARGETS" | grep "^$1:" | cut -d: -f"$2"; }
known()  { echo "$TARGETS" | grep -q "^$1:"; }

# 端口上正在 listen 的 pid
port_pids() {
  [ "${1:-0}" = "0" ] && return 0
  lsof -ti "tcp:$1" -sTCP:LISTEN 2>/dev/null
}

# cwd 落在该包目录下的所有进程——这是唯一能抓到最里层那个
# `node --import tsx src/index.ts` 的办法，它的命令行里没有包名。
#
# 一次 lsof 批量查完：这个函数每次运行会被调二十多次，按 pid 逐个 fork lsof
# 在 node 进程多时要跑数分钟；批量是一次 fork，约 100ms。
cwd_pids() {
  local pids
  pids="$(pgrep -x node 2>/dev/null | tr '\n' ',' | sed 's/,$//')"
  [ -z "$pids" ] && return 0
  lsof -a -d cwd -p "$pids" -Fpn 2>/dev/null \
    | awk '/^p/{p=substr($0,2)} /^n/{print p" "substr($0,2)}' \
    | awk -v d="$ROOT/$1" '{i=index($0," "); if (substr($0,i+1)==d) print substr($0,1,i-1)}'
}

# 客户端二进制按完整路径认，不能按 cwd——它的 cwd 是仓库根，会和别的进程撞上。
# macOS 上它跑在 `target/debug/<名>.app/Contents/MacOS/<名>` 里（见 make_app_bundle），
# 前缀 `^$ROOT/target/debug/cockpit` 同时罩住裸二进制与 bundle 里那份，
# 两种方式拉起的窗口 restart 都能停掉。
bin_pids() { pgrep -f "^$ROOT/$1" 2>/dev/null; }

target_pids() {
  if [ "$(field "$1" 5)" = "app" ]; then bin_pids "$(field "$1" 2)"; return; fi
  # Compose 旁车的端口由 Docker proxy 占用，不能把它当作宿主 PID 发送信号。
  if [ "$(field "$1" 5)" = "compose" ]; then port_pids "$(field "$1" 3)"; return; fi
  { port_pids "$(field "$1" 3)"; cwd_pids "$(field "$1" 4)"; } | sort -un
}

# 有没有 `tsx watch` 监护层还活着。不能用 ppid=1 来判：本脚本是 nohup 拉起的，
# 最外层本来就挂在 launchd 下，ppid=1 是正常状态。
# 故障态是端口仍有应答而 watch 层已不在，改代码不再生效。
has_watcher() {
  local pid
  for pid in $(target_pids "$1"); do
    case "$(ps -o command= -p "$pid" 2>/dev/null)" in *watch*) return 0 ;; esac
  done
  return 1
}

stop_one() {
  local name="$1" pids
  if [ "$(field "$name" 5)" = "compose" ]; then
    case "$name" in
      mock-*)
        # 宿主上残留的同名 tsx watch 进程会占住端口，容器就绑不上。
        # 只按 cwd 认包目录里的进程杀（docker proxy 的 cwd 不在仓库里，不会误杀）。
        pids="$(cwd_pids "$(field "$name" 4)" | tr '\n' ' ')"
        if [ -n "${pids// /}" ]; then
          kill -TERM $pids 2>/dev/null
          sleep 1
          kill -KILL $pids 2>/dev/null
          printf '  %-12s 清掉宿主残留进程 (%s)\n' "$name" "$(echo $pids)"
        fi
        bash "$ROOT/infra/scripts/dev-infra.sh" mock-down "$name"
        ;;
      *)
        bash "$ROOT/infra/scripts/dev-infra.sh" asr-down
        ;;
    esac
    return $?
  fi
  pids="$(target_pids "$name" | tr '\n' ' ')"
  if [ -z "${pids// /}" ]; then printf '  %-12s 未在运行\n' "$name"; return 0; fi
  kill -TERM $pids 2>/dev/null
  sleep 1
  kill -KILL $pids 2>/dev/null
  printf '  %-12s 已停 (%s)\n' "$name" "$(echo $pids)"
}

# macOS 上 app 目标不直接跑裸二进制，而是包成最小 .app 经 LaunchServices（`open`）拉起。
#
# macOS 的隐私授权（TCC）按责任进程记账。从终端派生的进程，责任进程就是那个终端
# （Terminal / VS Code 等），nohup、disown、ppid=1 都改不了这层归属，它由 launchd
# 在 spawn 时确定。于是麦克风授权记在终端头上；终端未获授权时 CoreAudio 照样给设备、
# 回调却全是零——界面显示"正在聆听"，网关 ASR 收到静音，报 asr_empty_result。
# 经 `open` 拉起的进程由 launchd 直接 spawn，责任进程是它自己；TCC 按 bundle id
# 记账，系统设置里显示的是「Cabinhug Cockpit」，签名身份稳定时授权一次后重编也认。
# `open` 只认 .app，所以把裸二进制拷进 `target/debug/<名>.app`——
# Info.plist 由 src-tauri/Info.plist（用途声明）+ tauri.conf.json（名字、版本）拼出，
# 二进制没重编就不重拷、不重签。`open --stdout/--stderr` 是追加写，
# 环境变量照样传给子进程，只有 cwd 变成 `/`（客户端不依赖 cwd：dev_env.rs 用
# 编译期路径找 .env，其余文件都走 app data 目录）。
#
# 稳定签名也落在 bundle 上：cargo 产物只有链接器打的 ad-hoc 签名，Identifier 是
# `cockpit-<构建哈希>`，每次重编身份都变，钥匙串拒绝读机密，凭证库降级到内存，
# 表现为每次 dev:restart 后车机都要重新输配对码。用本机 Apple Development 证书
# 重签后 designated requirement 是"这个 identifier + 这张证书"，identifier 由
# CFBundleIdentifier 给出，与 `--identifier` 钉的值相同，既有钥匙串条目继续有效。
# 没有证书的机器退到 ad-hoc 签 bundle：TCC 仍按 bundle id 显示 Cabinhug，
# 只是每次重编后钥匙串与麦克风都会再问一次。
app_bundle() { echo "$ROOT/target/debug/${1%-app}.app"; }

# app 目标的日志真身在 ~/Library/Logs/Cabinhug/<名>.log，.dev-logs/<名>.log 只是指过去的
# 符号链接（`dev:logs`、tail -f、人眼看，路径都不变）。
#
# 不能直接把 .dev-logs/<名>.log 交给 `open --stdout`：那个文件句柄由 launchd 一侧
# 代开，仓库若在「文稿 / 桌面 / 下载」这类 TCC 保护目录下，它打不开由开发者 shell
# 创建的已有文件，`open` 报 -10810 "LSOpenURLs failed"。由 `open` 新建的文件不受影响，
# 所以首次启动正常，日志文件已存在时才失败。
# ~/Library/Logs 不受 TCC 管，经符号链接过去也认。普通文件形式的旧日志
# 整段追加进真身再换成链接，跨重启的日志不丢。
app_log() {
  local name="$1" real="$HOME/Library/Logs/Cabinhug/$1.log" link="$LOGDIR/$1.log"
  mkdir -p "$HOME/Library/Logs/Cabinhug" "$LOGDIR"
  if [ -f "$link" ] && [ ! -L "$link" ]; then
    cat "$link" >>"$real" && rm -f "$link"
  fi
  # 链接存在但指向别处（改名前的 ~/Library/Logs/CarLife）时重指，否则日志写进新目录、人眼看的还是旧的。
  [ "$(readlink "$link" 2>/dev/null)" = "$real" ] || ln -sfn "$real" "$link"
  touch "$real"
  echo "$real"
}

# 从 tauri.conf.json 取一个顶层字符串字段（只用于 productName / version，
# 两者都是简单字面量，不值得为此拉起 node）。
tauri_conf_str() { sed -n "s/^ *\"$2\": *\"\([^\"]*\)\".*/\1/p" "$ROOT/$1/src-tauri/tauri.conf.json" | head -1; }

make_app_bundle() {
  local name="$1" bin="$ROOT/$2" dir="$3"
  local bundle exe plist
  bundle="$(app_bundle "$name")"; exe="$bundle/Contents/MacOS/$(basename "$bin")"
  plist="$bundle/Contents/Info.plist"
  # 二进制没变（bundle 里那份不比 cargo 产物旧）就什么都不做——签名也还在。
  if [ -x "$exe" ] && [ ! "$bin" -nt "$exe" ] && codesign -v "$bundle" 2>/dev/null; then return 0; fi
  mkdir -p "$bundle/Contents/MacOS" || return 1
  cp -f "$bin" "$exe" || return 1
  cp -f "$ROOT/$dir/src-tauri/Info.plist" "$plist" || return 1
  local pb=/usr/libexec/PlistBuddy product version
  product="$(tauri_conf_str "$dir" productName)"; version="$(tauri_conf_str "$dir" version)"
  "$pb" -c "Add :CFBundleExecutable string $(basename "$bin")" \
        -c "Add :CFBundleIdentifier string com.cabinhug.${name%-app}" \
        -c "Add :CFBundleName string ${product:-Cabinhug}" \
        -c "Add :CFBundleDisplayName string ${product:-Cabinhug}" \
        -c "Add :CFBundlePackageType string APPL" \
        -c "Add :CFBundleInfoDictionaryVersion string 6.0" \
        -c "Add :CFBundleShortVersionString string ${version:-0.0.0}" \
        -c "Add :CFBundleVersion string ${version:-0.0.0}" \
        -c "Add :LSMinimumSystemVersion string 12.0" \
        -c "Add :NSHighResolutionCapable bool true" \
        "$plist" >/dev/null 2>>"$LOGDIR/$name.log" || return 1
  local ident; ident="$(security find-identity -p codesigning -v 2>/dev/null | sed -n 's/^ *[0-9]*) *\([0-9A-F]*\) .*/\1/p' | head -1)"
  if [ -z "$ident" ]; then
    printf '  %-12s ⚠ 无签名证书，改用 ad-hoc 签名：每次重编后钥匙串与麦克风授权都会再问一次\n' "$name"
    ident="-"
  fi
  if codesign --force --sign "$ident" "$bundle" 2>>"$LOGDIR/$name.log"; then
    printf '  %-12s 已包成 %s 并签为 com.cabinhug.%s\n' "$name" "target/debug/${name%-app}.app" "${name%-app}"
  else
    printf '  %-12s ⚠ 签名失败（看 .dev-logs/%s.log），钥匙串可能反复询问\n' "$name" "$name"
  fi
}

start_one() {
  local name="$1" filter port kind
  filter="$(field "$name" 2)"; port="$(field "$name" 3)"; kind="$(field "$name" 5)"
  mkdir -p "$LOGDIR"

  if [ "$kind" = "app" ]; then
    if [ ! -x "$ROOT/$filter" ]; then
      printf '  %-12s ❌ 没有 %s —— 先跑 `corepack pnpm build:%s`\n' "$name" "$filter" "${name%-app}"
      return 1
    fi
    cd "$ROOT" || return 1
    # 追加而不是覆盖：保留跨重启的日志，排查时"没有日志"才能说明"没发生"。
    if [ "$(uname)" = "Darwin" ]; then
      # 经 `open` 拉起（理由见 make_app_bundle；日志为何绕道见 app_log）。
      # `-n`：已有窗口时再开一个，而不是把旧的激活一下就当启动成功。
      local real_log; real_log="$(app_log "$name")"
      printf '\n===== 启动 %s =====\n' "$(date '+%F %T')" >>"$real_log"
      make_app_bundle "$name" "$filter" "$(field "$name" 4)" || return 1
      open -n "$(app_bundle "$name")" --stdout "$real_log" --stderr "$real_log" || return 1
    else
      printf '\n===== 启动 %s =====\n' "$(date '+%F %T')" >>"$LOGDIR/$name.log"
      nohup "$ROOT/$filter" >>"$LOGDIR/$name.log" 2>&1 </dev/null &
      disown 2>/dev/null || true
    fi
    local i pid
    for i in $(seq 1 10); do
      pid="$(bin_pids "$filter" | head -1)"
      [ -n "$pid" ] && { printf '  %-12s 已拉起窗口 (pid %s)\n' "$name" "$pid"; return 0; }
      sleep 0.5
    done
    printf '  %-12s ❌ 起来就退了 —— 看 .dev-logs/%s.log\n' "$name" "$name"
    tail -n 8 "$LOGDIR/$name.log" | sed 's/^/       /'
    return 1
  fi

  # compose 目标使用项目自有 Compose image。构建、health 等待集中在 dev-infra，
  # dev.sh 只保留目标编排，不复制另一套容器生命周期逻辑。
  if [ "$kind" = "compose" ]; then
    case "$name" in
      mock-*)
        # 起容器前先清掉宿主残留的同名进程（同 stop_one，start 单独调用时也要有）。
        local stale
        stale="$(cwd_pids "$(field "$name" 4)" | tr '\n' ' ')"
        if [ -n "${stale// /}" ]; then
          kill -TERM $stale 2>/dev/null
          sleep 1
          kill -KILL $stale 2>/dev/null
          printf '  %-12s 清掉宿主残留进程 (%s)\n' "$name" "$(echo $stale)"
        fi
        bash "$ROOT/infra/scripts/dev-infra.sh" mock-up "$name" || return 1
        printf '  %-12s 已就绪 :%s（容器 cabinhug-%s healthy）\n' "$name" "$port" "$name"
        return 0
        ;;
      *)
        bash "$ROOT/infra/scripts/dev-infra.sh" asr-up
        return $?
        ;;
    esac
  fi

  # 不能写成 `( ... & )`：子 shell 会一直等到后台作业退出才返回，于是
  # `pnpm dev:start | tail` 会挂到服务被杀为止。
  # 直接后台 + disown，并把 stdin 也断开，否则子进程还攥着调用方的管道。
  cd "$ROOT" || return 1
  if [ "$kind" = "py" ]; then
    # Python 服务（ACR-026 vision-trainer）：uv 管的独立 venv，不在 pnpm workspace 里。
    # 跑在宿主机而不是容器，因为它要 MPS。没装 uv 时立即报错，而不是等 20s 超时报"没监听"。
    # 训练服务目录可能不在本树（只在开发机使用），目录不在就跳过而不是报错。
    [ -d "$ROOT/$(field "$name" 4)" ] || { printf '  %-12s ⏭ 目录不在本仓，跳过\n' "$name"; return 0; }
    command -v uv >/dev/null 2>&1 || { printf '  %-12s ❌ 没有 uv（brew install uv）\n' "$name"; return 1; }
    # 同上：不能包在 `( ... & )` 里，否则子 shell 等到服务退出才返回。
    cd "$ROOT/$(field "$name" 4)" || return 1
    nohup uv run serve.py >"$LOGDIR/$name.log" 2>&1 </dev/null &
    disown 2>/dev/null || true
    cd "$ROOT" || return 1
  else
    nohup corepack pnpm --filter "$filter" dev >"$LOGDIR/$name.log" 2>&1 </dev/null &
    disown 2>/dev/null || true
  fi
  if [ "$port" = "0" ]; then printf '  %-12s 已拉起（无端口，看日志确认）\n' "$name"; return 0; fi
  local i
  for i in $(seq 1 40); do
    [ -n "$(port_pids "$port")" ] && { printf '  %-12s 已就绪 :%s (pid %s)\n' "$name" "$port" "$(port_pids "$port" | head -1)"; return 0; }
    sleep 0.5
  done
  printf '  %-12s ❌ 20s 内没监听 :%s —— 看 .dev-logs/%s.log\n' "$name" "$port" "$name"
  tail -n 12 "$LOGDIR/$name.log" | sed 's/^/       /'
  return 1
}

cmd_status() {
  printf '  %-12s %-7s %-8s %s\n' 目标 端口 PID 状态
  local name port kind pids pid disp state
  for name in $ALL_TARGETS; do
    port="$(field "$name" 3)"; kind="$(field "$name" 5)"
    [ "$port" = "0" ] && disp="-" || disp="$port"

    if [ "$kind" = "compose" ]; then
      pid="$(port_pids "$port" | head -1)"
      if [ "$name" = "local-asr" ] && [ "$(effective_asr_engine)" != "mock" ]; then
        printf '  %-12s %-7s %-8s %s\n' "$name" "$disp" "-" "未启用（生效档位 $(effective_asr_engine)，来源 $(asr_engine_source)）"
        continue
      fi
      if ! command -v docker >/dev/null 2>&1; then
        state="⚠️ Docker CLI 不可用"
        pid="-"
      else
        local container container_state health
        container="cabinhug-$name"
        # --type container 不能省：mock 的镜像与容器同名，裸 inspect 会命中镜像。
        container_state="$(docker inspect --type container -f '{{.State.Status}}' "$container" 2>/dev/null || printf '%s' missing)"
        health="$(docker inspect --type container -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$container" 2>/dev/null || printf '%s' missing)"
        case "$container_state:$health" in
          running:healthy) state="正常（容器 healthy）" ;;
          running:starting) state="⚠️ 启动中（health=starting）" ;;
          running:unhealthy) state="❌ 容器 unhealthy" ;;
          running:*) state="⚠️ 容器运行中（health=${health}）" ;;
          exited:*|dead:*) state="❌ 容器已退出（health=${health}）" ;;
          *) state="未运行"; pid="-" ;;
        esac
        # 容器没建、端口却有人应答：宿主上有残留的同名进程。
        if [ "$container_state" = "missing" ] && [ -n "$pid" ]; then
          state="⚠️ 容器未建，但 :$port 有宿主进程应答——跑一次 dev:restart $name 收编"
        fi
      fi
      printf '  %-12s %-7s %-8s %s\n' "$name" "$disp" "$pid" "$state"
      continue
    fi

    pids="$(target_pids "$name")"
    pid="$(port_pids "$port" | head -1)"; [ -n "$pid" ] || pid="$(echo "$pids" | head -1)"
    if [ -z "$pid" ]; then
      state="未运行"; pid="-"
    elif [ "$kind" = "app" ]; then
      state="窗口已开（界面来自 :$(field "${name%-app}" 3) 的 vite）"
    elif [ "$kind" = "svc" ] && ! has_watcher "$name"; then
      state="⚠️ 监护层已死：还在应答，但改代码不再生效，重启它"
    else
      state="正常"
    fi
    printf '  %-12s %-7s %-8s %s\n' "$name" "$disp" "$pid" "$state"
  done
}

# 结果写进全局 RESOLVED 而不是 echo：在 `$(resolve ...)` 里 `exit 2` 只退出
# 命令替换的子 shell，父进程照跑，打错目标名会静默返回 0。
RESOLVED=""
resolve() {
  if [ "$#" -eq 0 ]; then RESOLVED="$DEFAULT_TARGETS"; return 0; fi
  if [ "$1" = "all" ]; then RESOLVED="$ALL_TARGETS"; return 0; fi
  local t
  for t in "$@"; do
    known "$t" || { echo "未知目标：${t}（可选：$ALL_TARGETS all）" >&2; return 2; }
  done
  RESOLVED="$*"
}

load_env() {
  [ -f "$ROOT/.env" ] || { echo "❌ 没有 $ROOT/.env，服务起来也是一堆'未接入'" >&2; exit 1; }
  set -a; . "$ROOT/.env"; set +a
  # 改名前的变量名（ACR-051）：旧名的值搬到新名，服务与子脚本只读新名。
  bridge_legacy_env
}

case "${1:-restart}" in
  status)
    [ -f "$ROOT/.env" ] && load_env
    cmd_status
    ;;
  stop)
    shift
    [ -f "$ROOT/.env" ] && load_env
    refresh_default_targets
    resolve "$@" || exit 2
    echo "停止："; for t in $RESOLVED; do stop_one "$t"; done ;;
  start)
    shift; load_env; refresh_default_targets; resolve "$@" || exit 2
    if [ "${CABINHUG_NODE_PREFLIGHT_DONE:-0}" != "1" ]; then
      require_supported_node || exit 1
    fi
    echo "启动："; for t in $RESOLVED; do start_one "$t"; done ;;
  restart)
    shift; load_env; refresh_default_targets; resolve "$@" || exit 2
    if [ "${CABINHUG_NODE_PREFLIGHT_DONE:-0}" != "1" ]; then
      require_supported_node || exit 1
    fi
    echo "停止："; for t in $RESOLVED; do stop_one "$t"; done
    echo "启动："; for t in $RESOLVED; do start_one "$t"; done
    echo; cmd_status ;;
  logs)
    shift; [ "$#" -eq 1 ] || { echo "用法：dev.sh logs <目标>" >&2; exit 2; }
    known "$1" || { echo "未知目标：$1" >&2; exit 2; }
    # compose 目标的日志在容器里，.dev-logs 下没有它的文件。
    if [ "$(field "$1" 5)" = "compose" ]; then
      exec docker logs -f "cabinhug-$1"
    fi
    tail -f "$LOGDIR/$1.log" ;;
  *)
    cat <<EOF
用法：corepack pnpm dev:<子命令> [目标...]

  dev:restart [目标...]   停干净再起（不带目标 = ${DEFAULT_TARGETS}）
  dev:start   [目标...]   只起
  dev:stop    [目标...]   只停
  dev:status              看谁在跑、谁的监护层已死（还应答但不再热重载）
  dev:logs    <目标>      tail -f 该目标日志

  macOS 默认集合会额外启动 mock-tts（依赖系统 say）；ASR 档位为 mock 时默认集合
  还会启动项目 Compose 中的 local-asr（不依赖 Host whisper-server）。档位与网关看
  同一处：.env 的 ASR_ENGINE 钉档，没写则取后台热配置（运营控制台可热切）

目标：$ALL_TARGETS
      all = 全部（含 worker cron；默认集合已经包含 worker）

日志在 .dev-logs/<目标>.log
EOF
    exit 2 ;;
esac
