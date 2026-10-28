import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_MEMORY_COLLECTION,
  memoryCollectionName,
  validateMemoryCollectionName,
} from "../src/collection";

// 拼接写法：本仓的旧名扫描不该命中测试自己。
const OLD_TABLE = "car" + "life_memories";

describe("[M110-10] Mem0 集合名", () => {
  it("未配置时用新缺省表名", () => {
    assert.equal(memoryCollectionName({}), DEFAULT_MEMORY_COLLECTION);
    assert.equal(DEFAULT_MEMORY_COLLECTION, "cabinhug_memories");
  });

  it("显式配着改名前的表名：按新表名处理，避免 Mem0 照旧名另建一张空表", () => {
    assert.equal(memoryCollectionName({ MEM0_COLLECTION: OLD_TABLE }), DEFAULT_MEMORY_COLLECTION);
  });

  it("其它合法表名原样使用", () => {
    assert.equal(memoryCollectionName({ MEM0_COLLECTION: " drill_memories " }), "drill_memories");
  });

  it("不是合法标识符时抛错：表名会被拼进 SQL", () => {
    assert.throws(() => memoryCollectionName({ MEM0_COLLECTION: "x; drop table users" }), /不是合法表名/);
    assert.throws(() => memoryCollectionName({ MEM0_COLLECTION: "Memories" }), /不是合法表名/);
  });

  it("配置校验与运行时同一条判据", () => {
    assert.equal(validateMemoryCollectionName("cabinhug_memories"), null);
    assert.notEqual(validateMemoryCollectionName("1bad"), null);
  });
});
