/**
 * 高德 JS API 的服务接口代理（ACR-019）。
 *
 *   GET /_AMapService/*  →  高德三个上游之一，由网关追加 `jscode=<安全密钥>`
 *
 * # 用途
 *
 * 高德官方对生产环境给的形态是：前端只设 `_AMapSecurityConfig.serviceHost` 指向
 * 自己的代理，安全密钥（`securityJsCode`）留在代理侧，不随客户端产物分发。本文件即该代理。
 *
 * `clients/shared/ui/src/map/amap-loader.ts` 与 `clients/cockpit/src/vite-env.d.ts` 里
 * 提到的代理形态指的就是本文件。
 *
 * # 能力边界
 *
 * JS key 仍在前端：加载 SDK 的 `webapi.amap.com/maps?key=…` 这个 script
 * 标签必须带着它，那是 SDK 的固有形态。本代理只把安全密钥收回服务端，
 * 所以 `client-isolation` 不变量里高德仍保留一条例外（loader 那次 script 加载）。
 *
 * # 不鉴权
 *
 * 这些请求由高德 SDK 自己发出，无法带上设备 JWT 或自定义头，
 * 高德官方的 nginx 示例同样是一条不鉴权的路径。所以本路由挂在 `jwtAuth` 之前。
 *
 * 风险是「能访问网关的人可以借用我们的额度调高德服务接口」，收敛手段都在下面的
 * 代码里，且都不由请求方决定：
 *   1. 只挂三条精确路径前缀，其余一律 404；
 *   2. 上游主机硬编码在 `UPSTREAMS` 里，请求方改不了目的地（不是开放代理）；
 *   3. 只放行 `GET` / `HEAD`；
 *   4. 不透传 `authorization` / `cookie`：它们对高德没有意义，只会扩大泄漏面。
 * Referer/Origin 校验与 per-IP 限流不在本文件范围，限流归 FL-10。
 *
 * # 密钥现取，不缓存
 *
 * `jscode` 每次请求从配置层取（`ConfigStore.runtimeValues()` 自带缓存），
 * 后台轮换密钥不必重启网关。取不到时不追加而不是报错：由高德返回它自己的
 * 鉴权错误码，信息更准确，也能在浏览器控制台里看到。
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { createProxyMiddleware, type Options } from "http-proxy-middleware";

import type { ConfigStore } from "@cabinhug/db";

/** 前端 `_AMapSecurityConfig.serviceHost` 指向的路径前缀。高德约定，不可改。 */
export const AMAP_SERVICE_PREFIX = "/_AMapService";

/**
 * 路径 → 上游。顺序有意义：前两条是更长的精确前缀，必须排在兜底之前。
 *
 * 三条的分法与高德官方 nginx 示例一致：矢量底图样式、矢量瓦片、其余服务接口
 * 分别在不同域名上。少配一条时不报错，而是某一类地图请求静默失败
 * （样式不生效或瓦片空白）。
 */
const UPSTREAMS: ReadonlyArray<{ prefix: string; target: string }> = [
  { prefix: "/v4/map/styles", target: "https://webapi.amap.com" },
  { prefix: "/v3/vectormap", target: "https://fmap01.amap.com" },
  { prefix: "/", target: "https://restapi.amap.com" },
];

/** 只放行读。高德这些接口都是 GET，写方法只会是误用或探测。 */
const ALLOWED_METHODS = new Set(["GET", "HEAD"]);

export interface AmapProxyOptions {
  /** 测试注入：替掉真正的转发，回一个可断言的假上游。 */
  proxyFactory?: (options: Options) => ReturnType<typeof createProxyMiddleware>;
}

/** 把 `jscode` 追加进 query。已有同名参数时以网关的为准：那是密钥，不接受请求方指定。 */
export function withJsCode(path: string, jscode: string): string {
  if (!jscode) return path;
  const [bare, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  params.set("jscode", jscode);
  return `${bare}?${params.toString()}`;
}

/** 命中哪个上游（导出供单测直接钉住分流规则）。 */
export function upstreamFor(pathAfterPrefix: string): string {
  const hit = UPSTREAMS.find((u) => pathAfterPrefix.startsWith(u.prefix));
  // 最后一条 prefix 是 "/"，任何以 / 开头的路径都会命中；这里的兜底只防空串。
  return (hit ?? UPSTREAMS[UPSTREAMS.length - 1]).target;
}

export function createAmapProxyRouter(config: ConfigStore, opts: AmapProxyOptions = {}): Router {
  const router = Router();
  const factory = opts.proxyFactory ?? createProxyMiddleware;

  /*
   * 方法白名单放在中间件之前：不合规的请求不进入转发层。
   * 返回 405 而不是 404：路径正确，方法不对。
   */
  router.use(`${AMAP_SERVICE_PREFIX}`, (req: Request, res: Response, next: NextFunction) => {
    if (!ALLOWED_METHODS.has(req.method)) {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }
    next();
  });

  const proxy = factory({
    changeOrigin: true,
    // 目的地按路径现算，请求方无法指定：`req.url` 此时已被 express 剥掉挂载前缀。
    router: (req) => upstreamFor(req.url ?? "/"),
    // 不需要 target 字段，但类型要求给一个；`router` 的返回值优先。
    target: UPSTREAMS[UPSTREAMS.length - 1].target,
    on: {
      proxyReq: (proxyReq) => {
        /*
         * 到这一步 `proxyReq.path` 已是剥掉挂载前缀之后的路径，
         * 即高德期望的原始路径，直接追加 jscode 即可。
         *
         * 密钥从下面那个闭包变量取，由每次请求前的中间件刷新。
         * `proxyReq` 是同步回调，不在这里 await 配置层。
         */
        proxyReq.path = withJsCode(proxyReq.path, currentJsCode);
        // 我们自己的凭证对高德没有意义，不透传，避免扩大泄漏面。
        proxyReq.removeHeader("authorization");
        proxyReq.removeHeader("cookie");
      },
      error: (err, _req, res) => {
        console.error("[amap-proxy] 上游失败", err);
        // res 可能是 Socket（websocket 路径），这里只处理 HTTP 响应。
        if ("status" in res && typeof (res as Response).status === "function") {
          (res as Response).status(502).json({ error: "amap_upstream_failed" });
        }
      },
    },
  });

  /*
   * 密钥现取。放在 proxy 之前的一个中间件里，把值写进闭包变量供同步的
   * `proxyReq` 回调读：`http-proxy-middleware` 的钩子是同步的，
   * 而 `runtimeValues()` 是异步的。
   *
   * 单进程内并发请求共享这个变量，但读到的是同一把密钥
   * （全局唯一，不随请求变），所以竞态无害。若密钥变为 per-request，
   * 这里必须改成随请求走的上下文。
   */
  let currentJsCode = "";
  router.use(AMAP_SERVICE_PREFIX, async (_req: Request, _res: Response, next: NextFunction) => {
    try {
      const values = await config.runtimeValues();
      currentJsCode = values.get("AMAP_JS_SECURITY_CODE")?.trim() ?? "";
    } catch (err) {
      // 配置层抖动不让地图整体失效：不追加 jscode 继续走，由高德回它自己的错误码。
      console.warn("[amap-proxy] 配置读取失败，本次不追加 jscode", err);
      currentJsCode = "";
    }
    next();
  });

  router.use(AMAP_SERVICE_PREFIX, proxy);
  return router;
}
