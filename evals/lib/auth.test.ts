/**
 * 评测令牌与网关鉴权的同源守护。
 *
 * 评测令牌签错时每条 case 收到 401，表现为评测超时而非报错；`eval:*` 不进
 * `check:all`，样本集单测只测判定内核，因此由本测试兜住。
 *
 * 本目录 `auth.ts` 签的 token 必须能过网关自己那份 `verifyToken`。这里有意跨目录
 * import 网关模块：用复制品验证时，两边会一起漂移。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";

import { verifyToken } from "../../enterprise/backend/gateway/src/auth/jwt";
import { DEV_JWT_SECRET, EVAL_USER_ID, issueEvalToken } from "./auth";

const ORIGINAL = process.env.CABINHUG_JWT_SECRET;
after(() => {
  if (ORIGINAL === undefined) delete process.env.CABINHUG_JWT_SECRET;
  else process.env.CABINHUG_JWT_SECRET = ORIGINAL;
});

describe("评测令牌能过网关的校验", () => {
  it("开发默认密钥下：claims 形状与网关期望一致", () => {
    delete process.env.CABINHUG_JWT_SECRET;
    const claims = verifyToken(issueEvalToken());
    assert.ok(claims, "网关拒了评测 token——两边的签名或 claims 形状漂了");
    assert.equal(claims.sub, EVAL_USER_ID);
    assert.equal(claims.kind, "user");
    // `use` 必须是 access：`resolveIdentity` 对 refresh 直接返回 null，
    // 而那会以 401 的形态出现，与"密钥不对"分不开。
    assert.equal(claims.use, "access");
  });

  it("配了 CABINHUG_JWT_SECRET 时用它——否则 source .env 就全 401、不 source 才正常", () => {
    process.env.CABINHUG_JWT_SECRET = "a-configured-secret-long-enough-32chars";
    assert.ok(verifyToken(issueEvalToken()), "配置密钥下网关拒了评测 token");
  });

  it("密钥不匹配时网关必须拒——防这条断言变成永远为真", () => {
    process.env.CABINHUG_JWT_SECRET = "secret-used-at-signing-time-0123456789";
    const token = issueEvalToken();
    process.env.CABINHUG_JWT_SECRET = "a-totally-different-secret-0123456789";
    assert.equal(verifyToken(token), null);
  });

  it("有效期够一次 real 档全量跑：至少 1 小时", () => {
    delete process.env.CABINHUG_JWT_SECRET;
    const claims = verifyToken(issueEvalToken())!;
    // 网关默认 15 分钟，真实 LLM 全量要跑一个多小时；用默认值时后半段全部 401，
    // 通过率下降与被测系统无关。
    assert.ok(claims.exp - claims.iat >= 3600, `有效期只有 ${claims.exp - claims.iat}s`);
  });
});

describe("抄来的常量没有漂", () => {
  it("DEV_JWT_SECRET 与 enterprise/backend/shared/db 的定义逐字一致", () => {
    // 常量是复制品；漂移时签出的 token 被网关拒绝，与密钥未配置同为 401，
    // 因此直接读源文件比对。
    const src = readFileSync(new URL("../../enterprise/backend/shared/db/src/config/registry.ts", import.meta.url), "utf8");
    const m = src.match(/export const DEV_JWT_SECRET = "([^"]+)"/);
    assert.ok(m, "enterprise/backend/shared/db 里找不到 DEV_JWT_SECRET 的定义——改名了就来这里同步");
    assert.equal(DEV_JWT_SECRET, m![1]);
  });
});
