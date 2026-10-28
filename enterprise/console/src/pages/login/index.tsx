/**
 * 登录页（POC 简化形态）。
 *
 * 用后台角色 token 换身份，没有用户名密码与注册；
 * 退出条件见 `gateway/src/auth/console.ts`（FL-07 F-07-01）。
 *
 * # 两类失败分开提示
 *
 * 网关没起、端口不通时，`whoami` 抛的是网络错误，不是 401。
 * 只有网关作出回答且判定失败才提示 token 无效；连不上时提示连接失败并给出排查方向。
 * 「token 不存在 / 错误」仍然不区分，不泄露账号存在性（FL-07 约束）。
 *
 * # 开发态的快捷填入
 *
 * `.env.example` 缺省给的是 `admin-token` / `ops-token`，本机开发通常就是这两个值；
 * 只在 Vite 开发模式（`import.meta.env.DEV`）下显示两个填入按钮，生产构建里没有这段。
 * 真值以本机 `.env` 的 CABINHUG_ADMIN_TOKEN / CABINHUG_OPS_TOKEN 为准，
 * 改过时按钮填入的值会失败，错误提示会说明。
 */

import { useState, type FormEvent } from "react";

import { api, ApiError, setToken, clearToken, type ConsoleIdentity } from "../../api";

const DEV_TOKENS = [
  { label: "填入管理员", value: "admin-token", note: "CABINHUG_ADMIN_TOKEN 的缺省值" },
  { label: "填入运营", value: "ops-token", note: "CABINHUG_OPS_TOKEN 的缺省值" },
] as const;

/** 网关回答了才有 ApiError；fetch 连不上（拒绝连接 / 断网 / DNS）抛的是浏览器的 TypeError */
function isNetworkError(err: unknown): boolean {
  return !(err instanceof ApiError);
}

export function LoginPage({
  onSignedIn,
}: {
  onSignedIn: (identity: ConsoleIdentity) => void;
}): JSX.Element {
  const [token, setTokenInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setToken(token.trim());
    try {
      onSignedIn(await api.whoami());
    } catch (err) {
      clearToken();
      if (isNetworkError(err)) {
        setError(
          "无法连接到后端网关（默认 http://localhost:8790）。请确认服务已启动：corepack pnpm dev:status",
        );
      } else {
        // 不区分"token 不存在/错误"，不泄露账号存在性（沿用 FL-07 约束）
        setError("登录失败：token 无效。本机开发的 token 在 .env 的 CABINHUG_ADMIN_TOKEN / CABINHUG_OPS_TOKEN");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <h1>Cabinhug Console</h1>
        <p className="muted">输入后台访问 token（角色由 token 决定）</p>
        <input
          type="password"
          value={token}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder="console token"
          autoFocus
        />
        <button type="submit" disabled={busy || token.trim() === ""}>
          {busy ? "验证中…" : "登录"}
        </button>
        {import.meta.env.DEV ? (
          <p className="muted">
            开发态快捷填入：
            {DEV_TOKENS.map((t) => (
              <button
                key={t.value}
                type="button"
                className="btn-link"
                title={t.note}
                onClick={() => setTokenInput(t.value)}
              >
                {t.label}
              </button>
            ))}
          </p>
        ) : null}
        {error ? <p className="error">{error}</p> : null}
      </form>
    </div>
  );
}
