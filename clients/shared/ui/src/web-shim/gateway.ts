/**
 * 垫片用的网关客户端（ACR-049）。
 *
 * 只发同源相对路径 `/v1/*`：线上由 nginx 反代到网关，开发期由 vite 的 proxy 代劳。
 * 与 `clients/demo-web` 同一个做法：浏览器看不到跨源，网关不需要 CORS。
 *
 * 鉴权头不用 `Authorization`：魔搭创空间的边缘把它连同 `X-modelscope-*` / `X-studio-*`
 * 保留给平台自己，带着它的请求到不了容器（403）。换成 `x-cabinhug-auth` 并同时写一个
 * 同源 cookie，nginx 把它翻回标准头再发给网关（两条通道均可用）。
 */

export const AUTH_HEADER = "x-cabinhug-auth";

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** 响应体原文。网关的拒绝带面向用户的 `reason`，界面依赖它显示原因而不是只有状态码。 */
    readonly body: string = "",
    /** 网关的机器可读错误码（响应体的 `error` 字段），认不出就是 null。 */
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

/** 响应体里的 `error` 字段。不是 JSON（nginx 的错误页）就当没有。 */
export function errorCodeOf(body: string): string | null {
  try {
    const v = (JSON.parse(body) as { error?: unknown }).error;
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

/**
 * 失败响应 → `GatewayError`。错误码必须进 message，不只是进字段。
 *
 * 上层认"会话过期"靠的是 `String(err).includes("session_expired")`
 * （`sendWithRetry.ts` 的 `isExpired`，两端共用同一条判断），与原生端一致：
 * Rust 的 `NetError::SessionExpired` 用 `#[error("session_expired")]` 标注，`to_string()` 即该词，
 * Tauri 命令经 `map_err(|e| e.to_string())` 原样交给 JS。
 *
 * message 里缺这个词时，空会话被服务端清扫器收走（缺省 30 分钟，只收没有消息的会话）后，
 * 浏览器里的恢复逻辑认不出过期，访客看到 `/v1/session/sess-xxx/messages → 409`，
 * 而不是像原生端那样新建会话重发。
 */
async function gatewayError(res: Response, path: string): Promise<GatewayError> {
  const body = await res.text().catch(() => "");
  const code = errorCodeOf(body);
  return new GatewayError(path + " → " + res.status + (code ? " " + code : ""), res.status, body, code);
}

export interface Credentials {
  username: string;
  password: string;
}

export interface AuthUser {
  id: string;
  displayName: string | null;
}

type FetchLike = typeof fetch;

export class Gateway {
  private token: string | null = null;
  private user: AuthUser | null = null;
  private loggingIn: Promise<void> | null = null;

  constructor(
    private readonly fetchImpl: FetchLike,
    private credentials: Credentials,
    private readonly setCookie: (value: string) => void = () => undefined,
  ) {}

  currentUser(): AuthUser | null {
    return this.user;
  }

  /** 换账号登录（端上登录门手输口令时走这里）。 */
  async login(credentials?: Credentials): Promise<AuthUser> {
    if (credentials) this.credentials = credentials;
    const res = await this.fetchImpl("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(this.credentials),
    });
    if (!res.ok) throw await gatewayError(res, "/v1/auth/login");
    const body = (await res.json()) as { accessToken: string; user: AuthUser };
    this.token = body.accessToken;
    this.user = body.user;
    // cookie 只存裸 token：带空格的 "Bearer " 在 cookie 值里非法，编码后 nginx 拼出的头无效（401）
    this.setCookie(body.accessToken);
    return body.user;
  }

  logout(): void {
    this.token = null;
    this.user = null;
    this.setCookie("");
  }

  /** 并发的首批请求只登录一次——端启动时十几个命令同时进来，各登各的会把限流打满。 */
  private ensureLogin(): Promise<void> {
    if (this.token) return Promise.resolve();
    this.loggingIn ??= this.login().then(
      () => {
        this.loggingIn = null;
      },
      (err) => {
        this.loggingIn = null;
        throw err;
      },
    );
    return this.loggingIn;
  }

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return { ...(extra ?? {}), ...(this.token ? { [AUTH_HEADER]: "Bearer " + this.token } : {}) };
  }

  /**
   * 发一个带鉴权的请求。access token 只有 15 分钟，而访客多半是"开着页面看一会儿再动手"，
   * 所以 401 时重登一次再发——只重试一次，口令真错了不会死循环。
   */
  async request(method: string, path: string, init?: { json?: unknown; body?: BodyInit; headers?: Record<string, string> }): Promise<Response> {
    await this.ensureLogin();
    const send = () =>
      this.fetchImpl(path, {
        method,
        headers: this.authHeaders({
          ...(init?.json !== undefined ? { "content-type": "application/json" } : {}),
          ...(init?.headers ?? {}),
        }),
        body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
      });
    let res = await send();
    if (res.status === 401) {
      this.token = null;
      await this.ensureLogin();
      res = await send();
    }
    if (!res.ok) throw await gatewayError(res, path);
    return res;
  }

  /** 原样返回响应体文本——Rust 那侧大多数命令就是把网关的 JSON 串原样交给 WebView。 */
  async text(method: string, path: string, json?: unknown): Promise<string> {
    return (await this.request(method, path, json === undefined ? undefined : { json })).text();
  }

  async json<T>(method: string, path: string, json?: unknown): Promise<T> {
    return (await this.request(method, path, json === undefined ? undefined : { json })).json() as Promise<T>;
  }

  /** 打开一条 SSE。返回响应，调用方自己读流；AbortSignal 用来关。 */
  async stream(path: string, signal: AbortSignal): Promise<Response> {
    await this.ensureLogin();
    const open = () =>
      this.fetchImpl(path, { headers: this.authHeaders({ accept: "text/event-stream" }), signal });
    let res = await open();
    if (res.status === 401) {
      this.token = null;
      await this.ensureLogin();
      res = await open();
    }
    if (!res.ok || !res.body) throw await gatewayError(res, path);
    return res;
  }
}
