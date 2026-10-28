#!/usr/bin/env node
/**
 * 起浏览器预览（ACR-063，只给开发与走查用）：登录一个正在运行的单机版本机网关，把令牌交给 vite 代理。
 *
 *   node standalone/app/scripts/preview.mjs <网关地址> <凭据文件>
 *
 * 凭据文件是宿主 `--secrets-file` 或应用 `CABINHUG_STANDALONE_SECRETS_FILE` 用的那份（只读，不打印）。
 * 然后打开 http://127.0.0.1:1441/preview.html。
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [gateway, secretsFile] = process.argv.slice(2);
if (!gateway || !secretsFile) {
  console.error("用法：preview.mjs <网关地址> <凭据文件>");
  process.exit(2);
}
const secrets = JSON.parse(readFileSync(secretsFile, "utf8"));
const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 令牌会过期（几十分钟），代理每次请求从这个文件读，这里定时重登。0600，放在已忽略的 target/ 下。
const tokenFile = resolve(app, "../../target/standalone-dev/preview-token");
async function login() {
  const res = await fetch(`${gateway}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "demo", password: secrets.internal.ownerPassword }),
  });
  if (!res.ok) throw new Error(`登录失败：${res.status}`);
  const { accessToken } = await res.json();
  writeFileSync(tokenFile, accessToken, { mode: 0o600 });
}
await login();
setInterval(() => login().catch((err) => console.error(`预览令牌刷新失败：${err.message}`)), 5 * 60_000);
const child = spawn("npx", ["vite", "--port", "1441", "--strictPort"], {
  cwd: app,
  stdio: "inherit",
  env: {
    ...process.env,
    CABINHUG_PREVIEW_GATEWAY: gateway,
    CABINHUG_PREVIEW_TOKEN_FILE: tokenFile,
    VITE_PREVIEW_AMAP_JS_KEY: secrets.credentials?.AMAP_JS_KEY ?? "",
    VITE_PREVIEW_AMAP_SECURITY_CODE: secrets.credentials?.AMAP_JS_SECURITY_CODE ?? "",
  },
});
child.on("exit", (code) => process.exit(code ?? 0));
