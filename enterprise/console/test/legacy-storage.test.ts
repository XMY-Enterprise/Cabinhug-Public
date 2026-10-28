/** 控制台本地存储键改名迁移（ACR-051）：新键空才拷、旧键保留、不覆盖。 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { migrateLegacyConsoleStorage } from "../src/api/legacy-storage";

function memoryStorage(initial: Record<string, string>) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
}

describe("[M110-02] 控制台存储键 carlife.console.* → cabinhug.console.*", () => {
  it("登录 token 迁过去后控制台不用重新登录，旧键保留", () => {
    const s = memoryStorage({ "carlife.console.token": "t-1" });
    assert.deepEqual(migrateLegacyConsoleStorage(s), ["carlife.console.token"]);
    assert.equal(s.data.get("cabinhug.console.token"), "t-1");
    assert.equal(s.data.get("carlife.console.token"), "t-1");
  });

  it("新键已有值时不覆盖", () => {
    const s = memoryStorage({ "carlife.console.traceView": "dev", "cabinhug.console.traceView": "business" });
    assert.deepEqual(migrateLegacyConsoleStorage(s), []);
    assert.equal(s.data.get("cabinhug.console.traceView"), "business");
  });
});
