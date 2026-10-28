import { readFileSync } from "node:fs";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/*
 * 单机版桌面界面（ACR-063）。Tauri 窗口里网关请求全部经 Rust 侧转发（令牌不进 WebView），
 * 所以平时不配 /v1 代理。端口 1440 与车机端 1430、手机端 1420 错开。
 *
 * 浏览器预览（`scripts/preview.mjs`，只给开发与走查）另起在 1441：那时设了
 * CABINHUG_PREVIEW_GATEWAY，`/v1` 代理到正在运行的本机网关并由代理加令牌
 * （令牌每次从 CABINHUG_PREVIEW_TOKEN_FILE 读，预览脚本定时重登）。
 */
const previewGateway = process.env.CABINHUG_PREVIEW_GATEWAY;
const previewTokenFile = process.env.CABINHUG_PREVIEW_TOKEN_FILE;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 1440,
    strictPort: true,
    host: "127.0.0.1",
    ...(previewGateway
      ? {
          proxy: {
            "/v1": {
              target: previewGateway,
              configure(proxy: { on(ev: "proxyReq", cb: (req: { setHeader(k: string, v: string): void }) => void): void }) {
                proxy.on("proxyReq", (req) => req.setHeader("authorization", `Bearer ${readFileSync(previewTokenFile!, "utf8").trim()}`));
              },
            },
          },
        }
      : {}),
  },
  build: { outDir: "dist", target: "es2022" },
});
