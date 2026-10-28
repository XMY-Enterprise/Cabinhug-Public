/**
 * 登录门（F-07-01/03）。
 *
 * # 门而不是页面
 *
 * 未登录时所有网关调用都会 401。在最外层挡住并明示"还没登录"，
 * 避免 HUD 先渲染再逐个报错、被误读为服务故障。
 *
 * # 口令只在这个组件里短暂存在
 *
 * 它进 `invoke("auth_login")` 之后就被清空，不进任何状态容器、不进 localStorage。
 * token 不经过 WebView：Rust 侧登录成功只回"你是谁"（见 commands/auth.rs）。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { MapBackdrop, SPRITES } from "@cabinhug/ui";
import { GatewayField } from "./GatewayField";
import "./login.css";

interface AuthStatus {
  authenticated: boolean;
  userId: string | null;
  displayName: string | null;
}

export interface LoginGateProps {
  children: React.ReactNode;
}

export function LoginGate({ children }: LoginGateProps): React.ReactElement {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 网络诊断结果：只在登录失败后可用，App 自己连几个目标把 errno 带回来。 */
  const [diag, setDiag] = useState<string[] | null>(null);
  const runDiag = useCallback(async () => {
    setDiag(["诊断中…"]);
    try {
      setDiag(await invoke<string[]>("net_diag"));
    } catch (err) {
      setDiag([`诊断命令不可用：${String(err)}`]);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        setStatus(await invoke<AuthStatus>("auth_status"));
      } catch {
        // 不在 Tauri 里（纯浏览器预览）：当作已登录放行，否则界面预览全被挡住。
        setStatus({ authenticated: true, userId: null, displayName: null });
      }
    })();
  }, []);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const next = await invoke<AuthStatus>("auth_login", { username, password });
        setStatus(next);
        // 口令用完即弃，不在任何状态里保留。
        setPassword("");
        /*
         * 注册本设备（登录后调一次，幂等）。不调则这台手机不出现在 `GET /v1/devices` 里，
         * 设备列表与撤销（F-56-02）在手机侧失效；`check:orphan-commands` 守这类未调用的命令。
         *
         * 失败不打断登录：设备注册是附带动作，登录本身已经成功。
         */
        void invoke("register_device", { modelName: "手机" }).catch(() => undefined);
      } catch (err) {
        setError(String(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, username, password],
  );

  // 还没拿到结果时不渲染登录页：先闪登录页再进主界面会被误读为出错。
  if (status === null) return <div className="login-gate login-gate--loading" />;
  /*
   * `?login=demo`：即使已登录也把这道门画出来，作为版式截图入口（与车机端同名 query 同一类）。
   * 纯浏览器里拿不到网关时按 fail-open 放行（见上面的 catch），这道门无从查看。
   * 真实运行不带该 query，行为不受影响。
   */
  if (status.authenticated && !isLoginDemo()) return <>{children}</>;

  return (
    <div className="login-gate">
      {/*
       * 舞台：程序化灰白地图 + 暖暖（定稿 `内部文档`）。
       * 用 `MapBackdrop` 而不是真实底图：这道门在拿到网关之前就要画出来，那时既没有
       * 地图 key 也没有网络；程序化底图零依赖、离线也在。配色由 `.login-gate` 局部改写
       * `--hud-map-*` 压成灰白（见 login.css），与车机端那道门同一条做法。
       */}
      <div className="login-gate__stage" aria-hidden="true">
        <MapBackdrop />
      </div>
      <img className="login-gate__mascot" src={SPRITES.light.assistant} alt="" aria-hidden="true" draggable={false} />
      <form className="login-card" onSubmit={submit}>
        <h1 className="login-title">Cabinhug</h1>
        <p className="login-hint">请登录后使用</p>
        <label className="login-field">
          <span>账号</span>
          <input
            autoFocus
            autoCapitalize="none"
            autoCorrect="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label className="login-field">
          <span>口令</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {/* 错误原文来自 Rust 侧：401 是"账号或口令不正确"，网络故障是另一句。
            前端不再加工——加工会把两种完全不同的处置合并成一句无用的话。 */}
        {error ? <p className="login-error">{error}</p> : null}
        {error ? (
          <div className="login-diag">
            <button type="button" className="login-diag__btn" onClick={() => void runDiag()}>
              网络诊断
            </button>
            {diag ? (
              <ul className="login-diag__list">
                {diag.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        <button className="login-submit" type="submit" disabled={busy || !username || !password}>
          {busy ? "登录中…" : "登录"}
        </button>
        {/* 连不上时唯一可改地址的入口：设置页在登录门后面（见 GatewayField 文件头）。 */}
        <GatewayField />
      </form>
    </div>
  );
}

/** `?login=demo`：版式截图入口，见上面的使用处。 */
function isLoginDemo(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("login") === "demo";
}
