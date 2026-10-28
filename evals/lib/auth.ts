/**
 * 评测 runner 的鉴权令牌。
 *
 * 网关不接受硬编码的演示令牌，评测进程按网关的 claims 形状自签 access token。
 * 缺令牌时 SSE 一路抛 `stream 401`、主流程卡在 60s 超时上；`eval:*` 不进 `check:all`，
 * 因此由 `auth.test.ts` 守住：签出的 token 必须过网关自己的 `verifyToken`，两边用同一个密钥来源。
 *
 * # 在这里重签而不是 import 网关的 `issueToken`
 *
 * infra 脚本不 import 服务内部模块（与 `eval-risk-lib.ts` 复制 `CONFIRM_REQUIRED_TOOLS` 同一约束）。
 * 代价是这里要跟着 `auth/jwt.ts` 的 claims 形状走，所以
 * `auth.test.ts` 用网关的 `verifyToken` 反过来验本文件签的 token，
 * 漂移时红在单测上，而不是在付费的 real 档全量跑到一半时。
 *
 * # 有效期 8 小时
 *
 * 网关的 access token 是 15 分钟（撤销靠"下一次请求查库"）。
 * 一次 real 档全量要跑一个多小时，中途过期会让后半段全部 401，
 * 形成与被测系统无关的通过率断崖。
 * 这把 token 只发给本机隔离栈（18797/18798）里的评测进程，不落盘、不出网。
 */

import { createHmac } from "node:crypto";
import { bridgeLegacyEnv } from "../../enterprise/backend/shared/db/src/config/legacy-env";

// 旧名环境变量（ACR-051）：`source .env` 后只有旧名时先搬到新名，保证这里读到的密钥
// 与被拉起的服务（它们自己也桥接）是同一把。
bridgeLegacyEnv(process.env);

/** 评测统一用演示账号——`demo:seed` 的两辆车（`DEM00SEED0*`）归它，⑥用车数据也挂在它名下。 */
export const EVAL_USER_ID = "demo-user";

/**
 * 开发默认签名密钥，与 `enterprise/backend/shared/db/src/config/registry.ts` 的 `DEV_JWT_SECRET` 逐字一致。
 *
 * 复制而不 import：本文件被 `node --import tsx --test` 加载时走 CJS 解析路径，
 * 而根 `package.json` 没有 `@cabinhug/db` 依赖，import 会让 `test:infra` 报
 * 「Cannot find module」。防漂移由 `auth.test.ts` 的一条断言直接读该文件比对。
 */
export const DEV_JWT_SECRET = "carlife-dev-insecure-jwt-secret-changeme";

const TTL_SEC = 8 * 60 * 60;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * 签一把 access token。
 *
 * 密钥来源与网关的 `auth/jwt.ts` 一致：`CABINHUG_JWT_SECRET` 够长就用它，
 * 否则落回上面那份开发默认值。两处必须同源，否则会出现「source 了 .env 就全 401」。
 */
export function issueEvalToken(userId: string = EVAL_USER_ID): string {
  const raw = process.env.CABINHUG_JWT_SECRET?.trim();
  const secret = raw && raw.length >= 16 ? raw : DEV_JWT_SECRET;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      sub: userId,
      kind: "user",
      use: "access",
      iat: now,
      exp: now + TTL_SEC,
      jti: `eval-${now}-${Math.random().toString(36).slice(2, 10)}`,
    }),
  );
  const data = `${header}.${payload}`;
  return `${data}.${createHmac("sha256", Buffer.from(secret, "utf8")).update(data).digest("base64url")}`;
}

/** `assertEvalUser` 需要的最小 Prisma 形状——由调用方注入，本文件不 import `@cabinhug/db`。 */
export interface EvalUserLookup {
  user: { findUnique(q: unknown): Promise<{ id: string } | null> };
}

/**
 * 起跑前确认账号真的在库里。
 *
 * 网关对「token 坏」「用户不存在」一律回 401（防账号存在性探测），
 * runner 侧无法区分二者，因此在起跑前检查：
 * 没有这个账号时直接提示跑 `demo:seed`，而不是让每条 case 各自 401。
 *
 * Prisma 由调用方传入：本文件 import `@cabinhug/db` 会让
 * `test:infra` 的 CJS 解析路径报「Cannot find module」（根 package.json 没有这个依赖）。
 */
export async function assertEvalUser(prisma: EvalUserLookup, userId: string = EVAL_USER_ID): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new Error(
      `评测账号 \`${userId}\` 不在库里——网关会把它和「token 坏了」一样回 401，逐条跑只会得到一张全红的表。\n` +
        `先跑：corepack pnpm demo:seed`,
    );
  }
}
