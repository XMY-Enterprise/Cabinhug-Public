/**
 * 字段级对称加密的共用实现（AES-256-GCM + scrypt 派生 + 版本前缀）。
 *
 * # 共用的是算法，不是密钥
 *
 * 配置密钥（`config/crypto.ts`）与 PII（`pii/crypto.ts`）刻意不共钥：轮换周期与
 * 泄露影响面不同，共钥意味着换任何一把都得重加密两类数据。这里只收纳算法，
 * 每个实例各有一个 `envVar`、一份盐、一个前缀；这一层不感知有几把密钥。
 *
 * # 密文格式由参数完全决定
 *
 * `<prefix>:<iv-b64>:<tag-b64>:<data-b64>`。只要 prefix/salt/envVar 不变，
 * 产出与解读的字节不变。`test/field-cipher-compat.test.ts` 用硬编码的历史密文
 * 守护这一点，修改本文件后须保持它通过。
 *
 * # 两处差异，均参数化
 *
 *  - `passthroughUnprefixed`：PII 对无前缀的值原样返回。这不是降级成明文，
 *    而是迁移期兼容读：存量明文行在跑迁移脚本前也要能读出。配置侧不需要，
 *    格式不对即为错误。
 *  - `makeError`：两边的错误类被 `instanceof` 消费（`config/startup.ts` 按它
 *    区分"缺钥"与"其它异常"），所以类留在各自文件里，由调用方传入构造器。
 *
 * # 没有降级成明文的路径
 *
 * 主密钥缺失或过短一律抛错。
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const KEY_LEN = 32;
const IV_LEN = 12;
/** 主密钥最短长度。低于它的值熵不足以撑住固定盐的 scrypt。 */
const MIN_MASTER_LEN = 16;

export interface FieldCipherSpec {
  /** 版本前缀，可含冒号（`v1` / `pii:v1` / `cal:v1`）。换算法时换它。 */
  prefix: string;
  /** 固定盐。主密钥本身已是高熵注入值，故不随行变化。 */
  salt: string;
  /** 主密钥的环境变量名。每次调用时读，不在构造时定死（测试要能改）。 */
  envVar: string;
  /** 无前缀的值原样返回（迁移期兼容读）。缺省 false：格式不对即抛。 */
  passthroughUnprefixed?: boolean;
  /** 缺钥/自检失败时抛什么。各家的错误类被 `instanceof` 消费，故由外部给。 */
  makeError: (reason: string) => Error;
  /** 格式错话术里的主语（"配置" / "PII"）。 */
  label: string;
}

export interface FieldCipher {
  encrypt(plain: string, master?: string): string;
  decrypt(stored: string, master?: string): string;
  isCiphertext(value: string): boolean;
  /** 启动期自检：主密钥可用且能完成一次加解密往返。 */
  assertUsable(master?: string): void;
}

export function createFieldCipher(spec: FieldCipherSpec): FieldCipher {
  const marker = `${spec.prefix}:`;
  // 前缀自带的段数：`v1` 占 1 段、`pii:v1` 占 2 段。密文总段数 = 它 + iv/tag/data。
  const prefixSegments = spec.prefix.split(":").length;
  const totalSegments = prefixSegments + 3;

  // 派生一次 scrypt 要几十毫秒，而主密钥在进程生命周期内不变，
  // 因此必须缓存。每个实例一份（密钥不共享，缓存也不共享）。
  let cachedKey: Buffer | undefined;
  let cachedMaster: string | undefined;

  /** `??` 而不是默认参数：显式传 `""` 要走"缺钥"而不是回落到环境变量。 */
  const resolveMaster = (master: string | undefined): string | undefined =>
    master ?? process.env[spec.envVar];

  function derive(master: string | undefined): Buffer {
    if (!master) throw spec.makeError("未设置");
    if (master.length < MIN_MASTER_LEN) {
      throw spec.makeError(`长度不足 ${MIN_MASTER_LEN} 字符`);
    }
    if (cachedKey && cachedMaster === master) return cachedKey;
    cachedKey = scryptSync(master, spec.salt, KEY_LEN);
    cachedMaster = master;
    return cachedKey;
  }

  function isCiphertext(value: string): boolean {
    return value.startsWith(marker);
  }

  function malformed(): Error {
    return new Error(`${spec.label}密文格式非法（期望 ${spec.prefix}:iv:tag:data）`);
  }

  function encrypt(plain: string, master?: string): string {
    const key = derive(resolveMaster(master));
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return [
      spec.prefix,
      iv.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      enc.toString("base64"),
    ].join(":");
  }

  /**
   * 解密。有前缀但解不开（错钥/密文损坏）时抛错：返回密文串会让下游把
   * `pii:v1:...` 当成手机号使用。
   */
  function decrypt(stored: string, master?: string): string {
    if (!isCiphertext(stored)) {
      if (spec.passthroughUnprefixed) return stored;
      throw malformed();
    }
    const parts = stored.split(":");
    if (parts.length !== totalSegments) throw malformed();
    const [ivB64, tagB64, dataB64] = parts.slice(prefixSegments);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      derive(resolveMaster(master)),
      Buffer.from(ivB64, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  // 具名函数而不是 `this.decrypt`：这四个会被各 crypto 模块解构后再导出
  // （`export const encryptPii = cipher.encrypt`），依赖 this 的实现解构后会失效。
  function assertUsable(master?: string): void {
    const probe = `cabinhug-${spec.prefix}-key-probe`;
    if (decrypt(encrypt(probe, master), master) !== probe) {
      throw spec.makeError("加解密自检失败");
    }
  }

  return { encrypt, decrypt, isCiphertext, assertUsable };
}
