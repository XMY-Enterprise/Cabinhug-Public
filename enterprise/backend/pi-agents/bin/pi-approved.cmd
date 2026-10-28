@echo off
rem Windows 入口（ACR-058）：pi-acp 0.0.33 对 .cmd 结尾的命令走 shell，经这里转给 pi-launch.mjs。
rem 启动逻辑全部在 pi-launch.mjs；CABINHUG_NODE_BIN 由 agent-runtime 传入，入口不依赖 PATH 上的 node。
if defined CABINHUG_NODE_BIN (
  "%CABINHUG_NODE_BIN%" "%~dp0pi-launch.mjs" %*
) else (
  node "%~dp0pi-launch.mjs" %*
)
exit /b %ERRORLEVEL%
