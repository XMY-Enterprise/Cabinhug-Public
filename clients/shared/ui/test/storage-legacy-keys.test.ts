/**
 * 本地存储键改名迁移（ACR-051）。
 *
 * 判据是三条：旧键有值而新键空时拷过去、旧键保留（回滚后旧版本还读得到）、
 * 新键已有值时不覆盖（那是新版本写的，比旧键新）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LEGACY_STORAGE_KEYS, migrateLegacyStorageKeys } from "../src/storage";

function memoryStorage(initial: Record<string, string>) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

describe("[M110-02] 本地存储键 carlife.* → cabinhug.*", () => {
  it("只有旧键时拷到新键，旧键保留", () => {
    const s = memoryStorage({ "carlife.location.v1": '{"consent":"precise"}' });
    assert.deepEqual(migrateLegacyStorageKeys(s), ["carlife.location.v1"]);
    assert.equal(s.data.get("cabinhug.location.v1"), '{"consent":"precise"}');
    assert.equal(s.data.get("carlife.location.v1"), '{"consent":"precise"}');
  });

  it("新键已有值时不覆盖", () => {
    const s = memoryStorage({ "carlife.sessionId": "sess-old", "cabinhug.sessionId": "sess-new" });
    assert.deepEqual(migrateLegacyStorageKeys(s), []);
    assert.equal(s.data.get("cabinhug.sessionId"), "sess-new");
  });

  it("存储抛错时跳过该键，不挡启动", () => {
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => undefined,
    };
    assert.deepEqual(migrateLegacyStorageKeys(broken), []);
  });

  it("键表一一对应：旧键都是 carlife.*，新键是同名的 cabinhug.*，无重复", () => {
    const legacy = LEGACY_STORAGE_KEYS.map(([l]) => l);
    assert.equal(new Set(legacy).size, legacy.length);
    for (const [l, c] of LEGACY_STORAGE_KEYS) {
      assert.ok(l.startsWith("carlife."), l);
      assert.equal(c, "cabinhug." + l.slice("carlife.".length));
    }
  });
});
