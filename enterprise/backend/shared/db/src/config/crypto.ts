/**
 * 配置密钥的对称加密（§13-12）。
 *
 * AES-256-GCM；密钥由 `CABINHUG_CONFIG_MASTER_KEY` 经 scrypt 派生。
 * 主密钥由环境注入、不与密文同库；缺失或过短时直接抛错，
 * 不提供降级成明文存储的路径。
 *
 * 存储形态：`v1:<iv-b64>:<tag-b64>:<ciphertext-b64>`，版本前缀留给未来换算法。
 *
 * # 算法在 `../crypto/field-cipher`，密钥在这里
 *
 * 算法与 PII、日历凭证共用 `field-cipher`；盐与主密钥为本模块独占，
 * 与 PII 侧互不通用（理由见 `pii/crypto.ts` 文件头的"两套钥匙"一节）。
 * `test/field-cipher-compat.test.ts` 用硬编码的历史密文守护密文格式不变。
 */

import { createFieldCipher } from "../crypto/field-cipher";

const SALT = "carlife-config-v1"; // 固定盐：主密钥本身已是高熵注入值

export class MasterKeyMissingError extends Error {
  constructor(reason: string) {
    super(
      `配置主密钥不可用：${reason}。请设置 CABINHUG_CONFIG_MASTER_KEY（至少 16 字符，由部署层注入，不入代码库）`,
    );
    this.name = "MasterKeyMissingError";
  }
}

const cipher = createFieldCipher({
  prefix: "v1",
  salt: SALT,
  envVar: "CABINHUG_CONFIG_MASTER_KEY",
  label: "配置",
  // 配置侧没有"无前缀原样返回"的通路（仅 PII 有，用于迁移期兼容读）：
  // 配置密文全部由本系统写入，格式不对即为错误。
  makeError: (reason) => new MasterKeyMissingError(reason),
});

export const encryptSecret = cipher.encrypt;
export const decryptSecret = cipher.decrypt;

/** 启动期自检：主密钥可用且能完成一次加解密往返。 */
export const assertMasterKeyUsable = cipher.assertUsable;
