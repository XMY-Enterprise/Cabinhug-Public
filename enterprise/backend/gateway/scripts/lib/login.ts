/**
 * 端到端脚本的登录助手。
 *
 * # 先登录换 token
 *
 * 脚本像真实客户端一样先登录换 token，每条 e2e 因此都覆盖一次登录路径。
 *
 * # 带重试
 *
 * 脚本刚拉起 gateway 就调登录，进程可能还没 listen。
 * 登录失败（401）与"还没起来"（ECONNREFUSED）分开处理：
 * 后者重试，前者直接抛，避免把启动问题误判为鉴权问题。
 */

/** 与 `seed-dev-credentials.ts` 的缺省值一致。 */
const DEV_USERNAME = "demo";
const DEV_PASSWORD = process.env.CABINHUG_DEV_PASSWORD?.trim() || "carlife-dev";

/**
 * 确保目标库里的开发账号可登录。
 *
 * 端到端脚本跑在测试库上，而迁移种下的 `demo-user` 是锁定的（散列 `!`）。
 * 由脚本自己设好口令，不依赖跑前手工播种；漏了播种的现象是登录 401，
 * 容易被误判为鉴权实现问题。
 */
export async function ensureDevCredentials(databaseUrl: string): Promise<void> {
  /*
   * 从 `@cabinhug/db` 拿 PrismaClient，不直接 import `@prisma/client`。
   *
   * `@prisma/client` 只是 `@cabinhug/db` 的依赖，不是 gateway 的。pnpm 的严格
   * node_modules 下，从 `enterprise/backend/gateway/scripts/` 解析它必然 ERR_MODULE_NOT_FOUND。
   * 这几条 e2e 脚本不在 `check:all` 里，解析失败不会让全仓检查变红。
   */
  const { PrismaClient } = await import("@cabinhug/db");
  const { hashPassword } = await import("../../src/auth/password");
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    await prisma.user.update({
      where: { username: DEV_USERNAME },
      data: { passwordHash: await hashPassword(DEV_PASSWORD) },
    });
  } finally {
    await prisma.$disconnect();
  }
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  userId: string;
}

/** 登录换 token。连不上时重试（服务可能刚起），凭证不对则直接抛。 */
export async function login(
  gatewayUrl: string,
  opts: { username?: string; password?: string; deviceId?: string; retries?: number } = {},
): Promise<LoginResult> {
  const body = JSON.stringify({
    username: opts.username ?? DEV_USERNAME,
    password: opts.password ?? DEV_PASSWORD,
    ...(opts.deviceId ? { deviceId: opts.deviceId } : {}),
  });
  const retries = opts.retries ?? 30;

  for (let i = 0; i < retries; i += 1) {
    let res: Response;
    try {
      res = await fetch(`${gatewayUrl}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    } catch {
      // 还没 listen，等一下再试。
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }
    if (res.status === 401) {
      throw new Error(
        "登录被拒（401）。开发账号口令没设过？跑：" +
          "corepack pnpm --filter @cabinhug/gateway seed:dev-credentials",
      );
    }
    if (!res.ok) throw new Error(`登录失败 HTTP ${res.status}`);
    const json = (await res.json()) as {
      accessToken: string;
      refreshToken: string;
      user: { id: string };
    };
    return { accessToken: json.accessToken, refreshToken: json.refreshToken, userId: json.user.id };
  }
  throw new Error(`登录超时：${gatewayUrl} 一直连不上`);
}
