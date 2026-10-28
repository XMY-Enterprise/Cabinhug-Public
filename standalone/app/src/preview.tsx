/**
 * 浏览器预览（只给开发与走查用，ACR-063）：不开 Tauri 窗口，在浏览器里跑同一套界面。
 *
 * 用 `@tauri-apps/api/mocks` 顶替 Rust 那一侧：宿主状态给「已就绪」，网关请求与事件流走 vite 代理
 * 打到一个正在运行的单机版本机网关（代理负责加令牌，见 scripts/preview.mjs）。生产构建的入口
 * 只有 index.html，本文件不进产物。
 */
import { mockIPC } from "@tauri-apps/api/mocks";

import { fixtureGateway } from "./preview-fixture";

/** `?fixture=hangzhou`：网关请求回样例行程，不连本机网关（对着定稿逐屏核对用）。 */
const FIXTURE = new URLSearchParams(location.search).get("fixture");
/** `?setup=1`：宿主停在首启（一组已存、服务在起），看首启页用。 */
const SETUP = new URLSearchParams(location.search).has("setup");

type Channelish = { onmessage: (m: unknown) => void };

const READY = {
  phase: "ready",
  // id 与宿主 STEPS 一一对应（standalone/host/src/host.rs），状态栏按 id 取格。
  steps: [
    ["database", "本地数据库"],
    ["migrate", "数据迁移"],
    ["account", "本机账号"],
    ["agent-runtime", "智能体服务"],
    ["gateway", "本机网关"],
    ["worker", "后台任务"],
    ["selfcheck", "启动核对"],
  ].map(([id, label]) => ({ id, label, state: "done", detail: null })),
  message: null,
  missingCredentials: [],
  logDir: "",
};

const GROUPS = [
  { group: "deepseek", label: "DeepSeek", fields: [{ env: "DEEPSEEK_API_KEY", label: "API Key" }], saved: true },
  {
    group: "aliyun-guard",
    label: "阿里云内容审核",
    fields: [
      { env: "Aliyun_AccessKey_ID", label: "AccessKey ID" },
      { env: "Aliyun_AccessKey_Secret", label: "AccessKey Secret" },
    ],
    saved: true,
  },
  {
    group: "amap",
    label: "高德开放平台",
    fields: [
      { env: "AMAP_SERVER_KEY", label: "Web 服务 Key" },
      { env: "AMAP_JS_KEY", label: "Web 端（JS API）Key" },
      { env: "AMAP_JS_SECURITY_CODE", label: "JS 安全密钥" },
    ],
    saved: true,
  },
];

/*
 * 事件流要能关：`useChat` 每次换会话、每次热更新重挂都会先关旧流再开新流。不关的话浏览器对同一主机
 * 只给 6 条连接，热更新几次之后连页面本身都加载不出来（一直「加载中」）。
 */
const streams = new Map<number, AbortController>();
let nextStream = 1;

async function stream(path: string, channel: Channelish): Promise<number> {
  const id = nextStream++;
  const abort = new AbortController();
  streams.set(id, abort);
  const res = await fetch(path, { headers: { accept: "text/event-stream" }, signal: abort.signal });
  // 与 Rust 侧同一个时点：响应头到了就算接上。
  queueMicrotask(() => channel.onmessage({ kind: "open" }));
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) {
        // 主动关掉的流不再回报，与 Rust 那一侧的 `gateway_stream_close` 一致。
        if (streams.delete(id)) channel.onmessage({ kind: "closed", reason: "ended" });
        return;
      }
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6))
          .join("\n");
        if (data) channel.onmessage({ kind: "data", data });
      }
    }
  })();
  return id;
}

mockIPC(async (cmd, raw) => {
  const args = (raw ?? {}) as Record<string, unknown>;
  switch (cmd) {
    case "host_status":
      return SETUP
        ? {
            ...READY,
            phase: "starting",
            missingCredentials: ["AMAP_SERVER_KEY"],
            steps: READY.steps.map((x, i) => ({ ...x, state: i < 1 ? "done" : i === 1 ? "running" : "waiting" })),
          }
        : READY;
    case "credential_groups":
      return SETUP ? GROUPS.map((g) => ({ ...g, saved: g.group === "deepseek" })) : GROUPS;
    case "client_config":
      return {
        amapJsKey: import.meta.env.VITE_PREVIEW_AMAP_JS_KEY ?? null,
        amapSecurityCode: import.meta.env.VITE_PREVIEW_AMAP_SECURITY_CODE ?? null,
      };
    case "gateway_request": {
      if (FIXTURE) return fixtureGateway(String(args.method), String(args.path));
      const res = await fetch(String(args.path), {
        method: String(args.method),
        headers: args.body ? { "content-type": "application/json" } : {},
        body: args.body ? JSON.stringify(args.body) : undefined,
      });
      return { status: res.status, body: await res.text() };
    }
    case "gateway_stream":
      if (FIXTURE) {
        // 样例里没有在跑的一轮：接上就够了，不再推事件。
        queueMicrotask(() => (args.onEvent as Channelish).onmessage({ kind: "open" }));
        return nextStream++;
      }
      return stream(String(args.path), args.onEvent as Channelish);
    case "gateway_stream_close": {
      const id = Number(args.id);
      const abort = streams.get(id);
      streams.delete(id);
      abort?.abort();
      return null;
    }
    default:
      return null;
  }
});

await import("./main");
