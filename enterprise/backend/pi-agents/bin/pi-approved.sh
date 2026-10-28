#!/bin/sh
# pi 的 Unix 入口（ACR-058）：pi-acp 经 PI_ACP_PI_COMMAND 执行本文件，这里只转给 pi-launch.mjs。
# 启动逻辑（--approve、工具清单、业务 prompt、离线与 agent 目录环境）全部在 pi-launch.mjs，
# 与 Windows 入口 pi-approved.cmd 共用一份。
# CABINHUG_NODE_BIN 由 agent-runtime 传入（它自己的 node），入口不依赖 PATH 上的 node。
SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
exec "${CABINHUG_NODE_BIN:-node}" "$SCRIPT_DIR/pi-launch.mjs" "$@"
