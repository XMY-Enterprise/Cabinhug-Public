/**
 * `createFieldCipher` 的历史密文兼容。
 *
 * # 用途
 *
 * `config/crypto.ts` 与 `pii/crypto.ts` 共用 `createFieldCipher`，
 * 已经落在库里的密文必须仍能解开，否则配置密钥与车主家人的姓名电话无法恢复。
 *
 * # 样本独立生成
 *
 * 下面两条密文按契约参数（前缀 / 盐 / AES-256-GCM / scrypt-32 / iv-12）
 * 用 `node:crypto` 直接产出，不经过本仓实现代码。
 * 所以它守的是算法契约本身：改盐或换派生函数都会让这里失败。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  decryptSecret,
  encryptSecret,
  assertMasterKeyUsable,
  MasterKeyMissingError,
} from "../src/config/crypto";
import {
  decryptPii,
  encryptPii,
  isPiiCiphertext,
  assertPiiMasterKeyUsable,
  PiiMasterKeyMissingError,
} from "../src/pii/crypto";

const KEY = "carlife-test-master-key-0123456789";

/** 历史格式的密文样本。改动这两行即失去这个文件的意义。 */
const LEGACY_CONFIG = "v1:ub2Q9QNM534F++6Y:aid00UObRsViajfTE987qw==:ZQFEkTsdNoZXLo9gVIa/rHFg";
const LEGACY_PII = "pii:v1:uluOy/yQik2dKr9T:yDGBGInzEXj39/2MfZ3v+w==:2ZYXvz1feXSqK84=";

describe("字段加密：历史密文兼容", () => {
  it("提炼前写下的配置密文仍解得开", () => {
    assert.equal(decryptSecret(LEGACY_CONFIG, KEY), "sk-secret-value-42");
  });

  it("提炼前写下的 PII 密文仍解得开", () => {
    assert.equal(decryptPii(LEGACY_PII, KEY), "13800001234");
  });

  it("新产出的密文格式与历史一致（前缀与段数）", () => {
    // 段数是解密侧的判据，格式漂了会表现为"存进去读不出来"。
    assert.equal(encryptSecret("x", KEY).split(":").length, 4);
    assert.match(encryptSecret("x", KEY), /^v1:/);
    assert.equal(encryptPii("x", KEY).split(":").length, 5);
    assert.match(encryptPii("x", KEY), /^pii:v1:/);
  });

  it("两把钥匙互不通用：同一主密钥也解不开对方的密文", () => {
    // 盐不同 → 派生出的 key 不同，这正是"刻意不共钥"要的效果；
    // 共用实现只共用算法，不共用钥匙。
    assert.throws(() => decryptPii(`pii:${LEGACY_CONFIG}`, KEY));
    assert.throws(() => decryptSecret(LEGACY_PII.replace("pii:", ""), KEY));
  });
});

describe("字段加密：两处刻意保留的差异", () => {
  it("PII 对无前缀的值原样返回（迁移期兼容读）", () => {
    assert.equal(decryptPii("13800001234", KEY), "13800001234");
    assert.equal(decryptPii("张先生", KEY), "张先生");
    assert.ok(!isPiiCiphertext("v1:aaa:bbb:ccc"));
  });

  it("配置侧没有那条通路：格式不对就是不对", () => {
    assert.throws(() => decryptSecret("sk-明文漏进来了", KEY), /格式非法/);
    assert.throws(() => decryptSecret("v1:only:two", KEY), /格式非法/);
  });

  it("错钥抛错，绝不返回密文串本身", () => {
    const wrong = "wrong-key-0123456789abcdef";
    assert.throws(() => decryptSecret(LEGACY_CONFIG, wrong));
    assert.throws(() => decryptPii(LEGACY_PII, wrong));
  });
});

describe("字段加密：缺钥不降级", () => {
  it("两侧各抛各的错误类（startup 与迁移脚本按类区分）", () => {
    assert.throws(() => encryptSecret("x", ""), MasterKeyMissingError);
    assert.throws(() => encryptSecret("x", "short"), MasterKeyMissingError);
    assert.throws(() => assertMasterKeyUsable(""), MasterKeyMissingError);

    assert.throws(() => encryptPii("x", ""), PiiMasterKeyMissingError);
    assert.throws(() => encryptPii("x", "short"), PiiMasterKeyMissingError);
    assert.throws(() => assertPiiMasterKeyUsable(""), PiiMasterKeyMissingError);
  });

  it("钥匙够长时自检通过", () => {
    assert.doesNotThrow(() => assertMasterKeyUsable(KEY));
    assert.doesNotThrow(() => assertPiiMasterKeyUsable(KEY));
  });
});
