#!/usr/bin/env node
/**
 * 单机版宿主起来之后，经本机网关走一轮真实的行程规划（ACR-061 / ACR-062 的端到端冒烟）。
 *
 *   corepack pnpm probe:standalone-trip <网关地址> <凭据文件> [问题]
 *
 * 网关地址看宿主的「就绪」那一行；凭据文件是 `cabinhug-standalone-host run --secrets-file` 用的那份
 * （本机账号口令在里面，本脚本只读不打印）。会花一次真实的 DeepSeek / 阿里云 / 高德调用。
 *
 * 判据：登录成功 → 建会话 → 发消息 → 流里收到增量文本并以 turn_end 收尾 → 草案端点返回逐天骨架。
 */
import { readFileSync } from "node:fs";

const [base, secretsFile, question = "下周六从上海出发，自驾去杭州玩两天，帮我排个行程"] = process.argv.slice(2);
if (!base || !secretsFile) {
  console.error("用法：standalone-trip-smoke.mjs <网关地址> <凭据文件> [问题]");
  process.exit(2);
}
const password = JSON.parse(readFileSync(secretsFile, "utf8")).internal?.ownerPassword;
if (!password) throw new Error("凭据文件里没有本机账号口令：宿主还没成功启动过？");

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? `：${detail}` : ""}`);
};

const login = await fetch(`${base}/v1/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "demo", password }),
});
check("本机账号登录", login.ok, String(login.status));
const { accessToken } = await login.json();
const auth = { authorization: `Bearer ${accessToken}` };

const caps = await (await fetch(`${base}/v1/capabilities`, { headers: auth })).json();
check("能力开关七项全关", caps.off?.length === 7, (caps.off ?? []).join(","));

const created = await fetch(`${base}/v1/session`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
const { sessionId } = await created.json();
check("建会话", created.ok && !!sessionId, sessionId);

const controller = new AbortController();
const stream = await fetch(`${base}/v1/session/${sessionId}/stream`, { headers: { ...auth, accept: "text/event-stream" }, signal: controller.signal });
check("打开事件流", stream.ok, String(stream.status));

const sent = await fetch(`${base}/v1/session/${sessionId}/messages`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ content: question }),
});
check("发消息", sent.ok, String(sent.status));

const started = Date.now();
let text = "";
let ended = false;
const decoder = new TextDecoder();
let buffer = "";
const timer = setTimeout(() => controller.abort(), 240_000);
try {
  for await (const chunk of stream.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = block.split("\n").find((l) => l.startsWith("data: "));
      if (!data) continue;
      const event = JSON.parse(data.slice(6)).event ?? {};
      if (event.kind === "delta" && typeof event.text === "string") text += event.text;
      if (event.kind === "turn_end") ended = true;
    }
    if (ended) break;
  }
} catch {
  // 超时由下面的判据报出来
} finally {
  clearTimeout(timer);
  controller.abort();
}
check("流以 turn_end 收尾", ended, `${Math.round((Date.now() - started) / 1000)} 秒`);
check("收到回答正文", text.length > 20, `${text.length} 字`);

const draft = await (await fetch(`${base}/v1/session/${sessionId}/trip-draft`, { headers: auth })).json();
const days = draft.plan?.skeleton?.length ?? 0;
check("草案端点给出逐天骨架", days > 0, `${draft.plan?.destination ?? "?"}，${days} 天`);

console.log(`\n回答前 120 字：${text.slice(0, 120)}`);
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
