// cockpit — 车机端 WebView 入口（HUD 为默认视图）
import React from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { configureAmap, configureLocationPort, migrateLegacyLocalStorage } from "@cabinhug/ui";
import "@cabinhug/ui/styles";
import "./styles.css";

/*
 * 端标记（新版 UI）：`clients/shared/ui` 的对话页 / 导览页 / 变化弹层两端共用，
 * 车机端用新版式而手机端不用。新版样式一律写成 `[data-surface="cockpit"] …`，
 * 由这一行开闸，不影响手机端（见 `内部文档` 末节）。
 */
if (typeof document !== "undefined") document.documentElement.dataset.surface = "cockpit";
import { App } from "./App";
import { BoardingGate, LoginGate } from "./features/auth";
import { createTauriLocationPort } from "./bridge/locationPort";

/**
 * 高德服务接口的代理地址（ACR-019）。
 *
 * 安全密钥不进产物：前端只告诉 SDK「服务接口去这里要」，密钥由网关的
 * `/_AMapService/*` 追加（`enterprise/backend/gateway/src/http/amap-proxy.ts`）。
 *
 * 传函数而不是字符串，是因为 Tauri 下网关地址要经 `invoke` 异步取，
 * 而本文件是同步执行的；`loadAmap()` 会在注入 script 前 await 它一次。
 *
 * 两条形态：
 *   - Tauri：以端上设置里生效的网关地址为准（端上只认识网关，
 *     用户在设置页配什么就走什么）。
 *   - 浏览器预览：同源 `/_AMapService`，由 vite 的 proxy 转到本机网关。
 *
 * 拿不到就回 undefined：loader 照常加载地图，只是服务接口按未授权处理。
 * 在这里抛异常会让整张地图不显示。
 */
async function amapServiceHost(): Promise<string | undefined> {
  const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  if (!inTauri) return `${window.location.origin}/_AMapService`;
  const view = await invoke<{ effectiveUrl: string }>("get_gateway_settings");
  const base = view.effectiveUrl?.trim().replace(/\/+$/, "");
  return base ? `${base}/_AMapService` : undefined;
}

// 高德 JS API 的 key 在这里注入：`clients/shared/ui` 自己不读环境变量，
// 它要能在 Vite 之外的环境里编译。vite 只注入 VITE_ 前缀的变量，所以 .env 里
// 除了服务端那把 AMAP_JS_KEY，还要有一份同值的 VITE_AMAP_JS_KEY。
//
// 只有 jsKey 在产物里，安全密钥不在（ACR-019）：加载 SDK 的 script 标签
// 必须带 jsKey，由高德控制台的域名白名单约束；安全密钥在网关代理里。
//
// 没配 = 车机 HUD 用程序化底图，与离线时是同一条路径，不需要额外处理。
// 旧 carlife.* 存储键拷到新键名（ACR-051），必须先于任何读取。
migrateLegacyLocalStorage();

configureAmap({
  // 浏览器演示构建的 key 来自容器的 /config.js（运行时、no-store），原生构建没有这个全局量，走构建期常量。
  // 不在容器启动时往编好的 JS 里换占位符：带哈希的产物是 immutable 永久缓存，内容变了文件名不变，
  // 打开过页面的浏览器会一直拿着旧的空 key（ACR-049）。
  jsKey: window.__CABINHUG_DEMO__?.amapJsKey || (import.meta.env.VITE_AMAP_JS_KEY ?? ""),
  serviceHost: amapServiceHost,
  // 行程路线的流动粒子与真实道路路径规划。
  // 插件跟脚本一起注入；加载失败只丢动画/退回直线，不丢标注。
  // AMap.Geolocation 是定位的前置条件：它没随脚本加载进来时，
  // 定位会静默退到浏览器 `navigator.geolocation`，在国内网络下成功率低得多，
  // 且给的是 WGS-84，与这张底图不是同一坐标系。
  plugins: ["AMap.MoveAnimation", "AMap.Driving", "AMap.Geolocation"],
});

// 定位授权与地图视图接到 Rust（落盘在设备上）。不在 Tauri 里时返回 undefined，
// `clients/shared/ui` 自动退回 localStorage 版端口，浏览器预览里开关同样可用。
configureLocationPort(createTauriLocationPort());

const el = document.getElementById("root");
if (!el) throw new Error("#root not found");
/**
 * 车机形态下先过绑定与上车声明。
 *
 * 挡在 App 之前而不是塞进 App 里：未绑定/未声明时车机拿不到任何会话，
 * HUD 渲染出来只会满屏报错。
 * 私人身份与浏览器预览下 `BoardingGate` 自己返回 null，不拦。
 */
/**
 * 访客态的常驻标记（F-56-06）。
 *
 * 播报是一次性的，标记常驻：中途上车的人也能知道现在读不到个人偏好。
 * 只在访客态渲染：非访客时多一条横幅是噪声。
 */
function GuestBadge() {
  return (
    <div className="cockpit-guest-badge" role="status">
      访客模式 · 不读取个人偏好与日历
    </div>
  );
}

function Root() {
  const [ready, setReady] = React.useState(false);
  const [guest, setGuest] = React.useState(false);
  /**
   * 上车声明建出来的会话。
   *
   * 车机是车辆级 token，`POST /v1/session` 必须显式声明谁在用，
   * 所以这道门是车机唯一能建出会话的地方。sid 交给 App，
   * 否则懒建之后车机的第一句话没有会话可用。
   */
  const [declaredSessionId, setDeclaredSessionId] = React.useState<string | undefined>(undefined);

  const onDeclared = React.useCallback((result: { sessionId: string; guest: boolean }) => {
    setGuest(result.guest);
    setDeclaredSessionId(result.sessionId);
    setReady(true);
    /*
     * 降级要说出来（AC-56-7）。静默降级会让用户以为助手"忘了他的偏好"，
     * 而不是"进了访客模式"。
     * 非访客不播报：每次上车都念一遍会让人把声音关掉。
     */
    if (result.guest) {
      void invoke("announce_downgrade", {
        text: "访客模式，不读取个人偏好与日历。",
      }).catch((err) => {
        /*
         * 不静默吞掉。浏览器预览里没有 Tauri，这里必然抛，属预期，不能带崩界面；
         * 但错误要打出来，便于排查播报是否调成。横幅不依赖这次调用。
         */
        console.warn("[boarding] 降级播报没调成（浏览器走查里这是正常的）：", err);
      });
    }
  }, []);

  /**
   * 会话过期后再说话，服务端会要求重新声明谁在用，这里把门挂回来。
   *
   * 不静默重建：车机上"谁在用车"是每次上车都要回答的问题，
   * 按上一个人继续等于绕过上车声明。
   */
  const onNeedBoarding = React.useCallback(() => {
    setDeclaredSessionId(undefined);
    setReady(false);
  }, []);

  return (
    /*
     * 两道门的顺序：LoginGate 只拦 personal 角色（账号凭证），
     * BoardingGate 只拦 cockpit 角色（车辆凭证），互斥，不会同时出现。
     * LoginGate 在外层是因为它还承担 G4 的"切成车机"出口：切完重载后
     * 它对 cockpit 角色放行，BoardingGate 接管。
     */
    <LoginGate>
      {!ready ? <BoardingGate onDeclared={onDeclared} /> : null}
      {ready && guest ? <GuestBadge /> : null}
      <App declaredSessionId={declaredSessionId} onNeedBoarding={onNeedBoarding} />
    </LoginGate>
  );
}

createRoot(el).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
