/**
 * 口令散列（FL-07 F-07-01）。
 *
 * # 用 node 内置 scrypt，不用 bcrypt
 *
 * 使用 `node:crypto` 的 scrypt：不引入需要编译的 native 依赖。
 * scrypt 与 bcrypt 同属 OWASP 推荐的口令 KDF，且是内存硬的（bcrypt 只是计算硬），
 * 对 GPU 爆破更不友好。换 argon2id 属于加依赖，需走 ACR。
 *
 * # 落盘格式
 *
 * `scrypt$N$r$p$<salt-b64>$<hash-b64>`：参数写进串里，校验按串里记的参数重算，
 * 调高参数后老口令仍可校验。
 *
 * # 锁定账号
 *
 * 迁移种下的 `demo-user` 口令散列是 `!`。它不是合法格式，`verifyPassword`
 * 对任何输入都返回 false，表达"账号存在但不能登录"；
 * 比在表里加一个 `disabled` 布尔更难被误用（忘了查布尔即谁都能登）。
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

/** 与 OWASP 对 scrypt 的最低建议同档（N=2^15, r=8, p=1）。 */
const PARAMS = { N: 32_768, r: 8, p: 1 } as const;
const KEY_LEN = 32;
const SALT_LEN = 16;
/** 默认 maxmem 是 32MB，N=32768/r=8 需要约 128 * N * r ≈ 32MB，卡在边界上——给足。 */
const MAX_MEM = 96 * 1024 * 1024;

/** 永不匹配的散列：账号存在但被锁定（迁移的种子账号用它）。 */
export const LOCKED_PASSWORD_HASH = "!";

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const hash = await scrypt(plain, salt, KEY_LEN, { ...PARAMS, maxmem: MAX_MEM });
  return [
    "scrypt",
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

/**
 * 校验。任何异常都返回 false，不抛：调用方是登录路径，
 * 抛出去会变成 500，而 500 与 401 的区别本身就是一条信息泄露通道
 * （"这个用户名的散列是坏的"）。
 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    const salt = Buffer.from(parts[4]!, "base64");
    const expected = Buffer.from(parts[5]!, "base64");
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = await scrypt(plain, salt, expected.length, { N, r, p, maxmem: MAX_MEM });
    // 长度不等时 timingSafeEqual 会抛，先挡掉。
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
