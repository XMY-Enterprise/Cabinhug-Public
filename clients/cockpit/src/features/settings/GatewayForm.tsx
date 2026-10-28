/**
 * 网关连接表单（ACR-004）。
 *
 * # 两个壳共用一份表单
 *
 * iOS 首启的引导弹层（`SettingsSheet`）与底部导航的设置页（`SettingsScreen`）
 * 共用本表单，避免两处各写一遍后某一条路上改地址不生效。
 * 首启引导保留弹层形态：那时不先教用户认底部导航。
 *
 * # 保存后整页刷新
 *
 * SSE 流、会话、轮询源都是按旧地址建的；设置网关是低频动作，
 * 整页刷新比逐个通知它们重连简单可靠。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface GatewaySettingsView {
  effectiveUrl: string;
  storedUrl: string | null;
  /** 生效地址来自哪一层（Rust 侧 `UrlSource`）。端上配过就恒是 `stored`。 */
  source: "stored" | "env" | "default";
  /** 环境变量里的那份（开发机 `.env`），可能为 null。 */
  envUrl: string | null;
  platform: string;
}

export interface GatewayFormProps {
  /** 首启引导语境（iOS 第一次打开）：文案从"设置"换成"先连上你的服务器"。 */
  firstRun?: boolean;
  /** 取消/跳过。整页形态下不给这个回调，就不渲染那个按钮。 */
  onCancel?: () => void;
  /** 表单何时该重新读一次当前值（弹层是"打开时"，整页是"挂载时"）。 */
  active: boolean;
}

export function GatewayForm({ firstRun = false, onCancel, active }: GatewayFormProps) {
  const [view, setView] = useState<GatewaySettingsView | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    setError(null);
    void invoke<GatewaySettingsView>("get_gateway_settings")
      .then((v) => {
        setView(v);
        setUrl(v.storedUrl ?? "");
      })
      .catch((e) => setError(String(e)));
  }, [active]);

  const save = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke<GatewaySettingsView>("set_gateway_settings", {
        gatewayUrl: url.trim() || null,
        // token 由登录产生，设置页不碰它：null = 保持现状。
        demoToken: null,
      });
      /*
       * 刷新前不做连通性验证：地址错了刷新后满屏"连不上"，用户可再打开本页改，
       * 失败可见且可恢复。在这里探活会误拒"网关暂时没起但地址是对的"的情况。
       */
      window.location.reload();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }, [url]);

  return (
    <>
      {firstRun && (
        <p className="settings-hint">
          这台设备第一次运行 Cabinhug。请填入运行服务的那台电脑的局域网地址
          （形如 <code>http://192.168.x.x:8790</code>），两台设备需在同一 Wi-Fi。
        </p>
      )}
      {/*
        * 地址来源明示：端上配置最优先，这一段如实说明此刻生效的是哪一份。
        */}
      {view?.source === "stored" && (
        <p className="settings-hint">
          当前生效：<code>{view.effectiveUrl}</code>（本机设置）
          {view.envUrl && view.envUrl !== view.effectiveUrl && (
            <>；环境变量里的 <code>{view.envUrl}</code> 已被它覆盖，清空下方地址栏并保存可回到环境变量</>
          )}
        </p>
      )}
      {view?.source === "env" && (
        <p className="settings-hint">
          当前地址来自环境变量 <code>{view.envUrl}</code>（开发机 <code>.env</code>）。
          在这里保存后，以你填的为准。
        </p>
      )}
      <label>
        网关地址
        <input
          type="url"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={view ? `当前：${view.effectiveUrl}` : "http://192.168.x.x:8790"}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      {/*
        * 本表单不提供访问令牌输入：token 由登录流程产生（`cabinhug_core::auth` 持有），
        * `settings.rs` 的 `gateway()` 不读持久化里的令牌字段；放一个不生效的凭证框
        * 会让人以为在这里能配鉴权。
        */}
      {error && <p className="settings-error">{error}</p>}
      <div className="settings-actions">
        {/* 首启引导也允许跳过：mock 数据下看界面是合法用法，不锁死用户 */}
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={busy}>
            {firstRun ? "先跳过" : "取消"}
          </button>
        )}
        <button type="button" className="is-primary" onClick={() => void save()} disabled={busy}>
          {busy ? "保存中…" : "保存并重新连接"}
        </button>
      </div>
    </>
  );
}
