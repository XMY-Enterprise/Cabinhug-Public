import { useEffect, useState } from "react";

import { configureAmap } from "@cabinhug/ui";

import { host } from "./api";
import { Setup } from "./features/setup/Setup";
import { MainScreen } from "./MainScreen";
import { useHostStatus } from "./useHost";

declare global {
  interface Window {
    _AMapSecurityConfig?: { securityJsCode?: string; serviceHost?: string };
  }
}

export function App() {
  const status = useHostStatus();
  const [entered, setEntered] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const ready = status?.phase === "ready";

  // 本地服务就绪后把车主自己的高德 JS Key 与安全密钥交给地图组件。单机版不经网关的
  // `/_AMapService` 代理：key 属于车主本人、只在本机用（ACR-063）。
  useEffect(() => {
    if (!ready || mapReady) return;
    void host.clientConfig().then((c) => {
      if (!c.amapJsKey) return;
      if (c.amapSecurityCode) window._AMapSecurityConfig = { securityJsCode: c.amapSecurityCode };
      configureAmap({ jsKey: c.amapJsKey });
      setMapReady(true);
    });
  }, [ready, mapReady]);

  // 曾经就绪过再进来（重启应用、凭据早已存好）就直接进主界面，不再停在首启页。
  useEffect(() => {
    if (ready && status?.missingCredentials.length === 0) setEntered(true);
  }, [ready, status?.missingCredentials.length]);

  if (!status || !entered || !ready) return <Setup status={status} onEnter={() => setEntered(true)} />;
  return <MainScreen status={status} mapReady={mapReady} />;
}
