/**
 * 能力开关的配置项与读取口（ACR-056）。
 *
 * 守三件事：缺省不关任何能力；本地一体版的 env 钉档压过后台；配置层抛错时退回 env 而不是放开。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readCapabilitiesOff } from "../src/config/capabilities";
import { findConfigDef } from "../src/config/registry";
import { createConfigStore } from "../src/config/store";

function prismaOf(rows: Record<string, string> | Error) {
  return {
    configItem: {
      findMany: async () => {
        if (rows instanceof Error) throw rows;
        return Object.entries(rows).map(([key, value]) => ({
          key,
          value,
          isSecret: false,
          updatedBy: "test",
          updatedAt: new Date("2026-10-22T00:00:00.000Z"),
          verifiedAt: null,
        }));
      },
      findUnique: async () => null,
      upsert: async () => ({}),
    },
    configItemRevision: { create: async () => ({}) },
  } as never;
}

describe("[ACR-056] CABINHUG_CAPABILITIES_OFF 配置项", () => {
  it("env-override、没有缺省值：不设就什么都不关", () => {
    const def = findConfigDef("CABINHUG_CAPABILITIES_OFF");
    assert.equal(def?.storage, "env-override");
    assert.equal(def?.default, undefined);
  });

  it("validate：闭集内的组合与空值放行，错字拒绝并点名", () => {
    const v = findConfigDef("CABINHUG_CAPABILITIES_OFF")!.validate!;
    assert.equal(v(""), null);
    assert.equal(v("photo-diagnosis,ownership-qa,service-qa"), null);
    assert.match(v("photo-diagnosis,buying-qa") ?? "", /buying-qa/);
  });
});

describe("[ACR-056] readCapabilitiesOff", () => {
  it("库与 env 都没有 → 空集（分离部署的现状）", async () => {
    const store = createConfigStore(prismaOf({}), { env: {}, ttlMs: 60_000 });
    assert.equal((await readCapabilitiesOff(store, {})).size, 0);
  });

  it("后台写的值生效", async () => {
    const store = createConfigStore(prismaOf({ CABINHUG_CAPABILITIES_OFF: "photo-diagnosis" }), { env: {}, ttlMs: 60_000 });
    assert.deepEqual([...(await readCapabilitiesOff(store, {}))], ["photo-diagnosis"]);
  });

  it("env 钉档压过后台：本地一体版的关闭项后台改不回来", async () => {
    const env = { CABINHUG_CAPABILITIES_OFF: "photo-diagnosis,ownership-qa,service-qa" };
    const store = createConfigStore(prismaOf({ CABINHUG_CAPABILITIES_OFF: "" }), { env, ttlMs: 60_000 });
    assert.equal((await readCapabilitiesOff(store, env)).size, 3);
  });

  it("配置层抛错 → 退回 env，不把钉档关掉的能力放出来", async () => {
    const env = { CABINHUG_CAPABILITIES_OFF: "ownership-qa" };
    const store = createConfigStore(prismaOf(new Error("db down")), { env, ttlMs: 60_000 });
    assert.deepEqual([...(await readCapabilitiesOff(store, env))], ["ownership-qa"]);
  });
});
