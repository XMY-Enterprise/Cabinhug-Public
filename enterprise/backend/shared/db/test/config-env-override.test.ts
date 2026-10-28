/**
 * env-override 存储模式（ACR-017）。
 *
 * 这个模式的目的是让"配置被 .env 覆盖"在后台可见，所以测试守的是三条可见性契约，
 * 而不只是解析顺序：
 *
 *  1. env 在场 → 值取 env、`source: "env"`、界面 `writable: false`、写入被拒
 *     且错误文案点名 envFallback 变量名（指明要删 .env 的哪一行）。
 *  2. env 不在场 → 回落 db → default，行为与普通 db 项无异。
 *  3. 既有两种模式（db / env-only）的语义不变：回归由既有测试文件守，
 *     这里只加一条对照断言。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CONFIG_REGISTRY, findConfigDef, isWritable } from "../src/config/registry";
import { createConfigStore } from "../src/config/store";

describe("注册表形状（ACR-017）", () => {
  it("ASR_ENGINE/TTS_ENGINE 是 env-override；闭集是约定的那两组", () => {
    const asr = findConfigDef("ASR_ENGINE");
    const tts = findConfigDef("TTS_ENGINE");
    assert.equal(asr?.storage, "env-override");
    assert.equal(tts?.storage, "env-override");
    assert.deepEqual(asr?.options, ["ark", "aliyun", "mock"]);
    assert.deepEqual(tts?.options, ["mock", "doubao", "aliyun"]);
  });

  it("闭集 validate：mock 过、local 与 fake 不过（fake 只走 env 注入，不进下拉）", () => {
    const v = findConfigDef("ASR_ENGINE")?.validate;
    assert.equal(v?.("mock"), null);
    assert.notEqual(v?.("local"), null);
    assert.notEqual(v?.("fake"), null);
  });

  /*
   * 两个 `mock` 是不同的服务，只是同名：
   *   ASR_ENGINE=mock → local-asr 容器（llama.cpp + Qwen3-ASR），运行真实模型，
   *                     只是在本机、不计费；端点 LOCAL_ASR_URL（8795）。
   *   TTS_ENGINE=mock → mocks/tts，把本机 `say` 包装成豆包协议，是模拟实现；
   *                     端点 MOCK_TTS_URL（8794）。
   * ASR 的 mock 会给出真实转写，不是"假识别"。描述里必须点明差别。
   */
  it("两个 mock 档的描述必须点明彼此不是同一个服务", () => {
    const asr = findConfigDef("ASR_ENGINE")!.description;
    const tts = findConfigDef("TTS_ENGINE")!.description;
    assert.match(asr, /local-asr|llama/, "ASR 的 mock 要说清是 local-asr 容器");
    assert.match(asr, /不是同一个服务/, "ASR 描述要点明与 TTS_ENGINE=mock 的区别");
    assert.match(tts, /mock-tts|say/, "TTS 的 mock 要说清是 mock-tts 的 say 包装");
    assert.match(tts, /不是同一个服务/, "TTS 描述要点明与 ASR_ENGINE=mock 的区别");
  });

  it("CARLIFE_ASR / CARLIFE_TTS 已从注册表退休", () => {
    assert.equal(findConfigDef("CARLIFE_ASR"), undefined);
    assert.equal(findConfigDef("CARLIFE_TTS"), undefined);
    assert.equal(
      CONFIG_REGISTRY.some((d) => d.key.startsWith("CARLIFE_ASR") || d.key === "CARLIFE_TTS"),
      false,
    );
  });

  it("isWritable：env-override 原则上可写；env-only 仍不可写（对照）", () => {
    assert.equal(isWritable(findConfigDef("ASR_ENGINE")!), true);
    assert.equal(isWritable(findConfigDef("DATABASE_URL")!), false);
  });
});

// ── store 层：钉死语义 ──────────────────────────────────────────

/** 假 prisma：db 里存着指定键值，写入路径不落地（本组不测落库）。 */
function prismaOf(rows: Record<string, string>) {
  return {
    configItem: {
      findMany: async () =>
        Object.entries(rows).map(([key, value]) => ({
          key,
          value,
          isSecret: false,
          updatedBy: "test",
          updatedAt: new Date("2026-09-01T00:00:00.000Z"),
          verifiedAt: null,
        })),
      findUnique: async () => null,
      upsert: async () => ({}),
    },
    configItemRevision: { create: async () => ({}) },
  } as never;
}

describe("env-override 的钉死语义（store 层）", () => {
  it("env 在场：值取 env、source=env、界面按只读渲染，db 里的值被覆盖", async () => {
    const store = createConfigStore(prismaOf({ ASR_ENGINE: "aliyun" }), {
      env: { ASR_ENGINE: "mock" },
      ttlMs: 60_000,
    });
    assert.equal(await store.get("ASR_ENGINE"), "mock");
    const item = (await store.displayItems()).find((e) => e.key === "ASR_ENGINE");
    assert.equal(item?.source, "env");
    assert.equal(item?.writable, false, "钉死期间界面必须只读，不能让人填完才被拒");
  });

  it("env 在场：写入被拒，错误文案点名 envFallback 变量名", async () => {
    const store = createConfigStore(prismaOf({}), { env: { ASR_ENGINE: "mock" }, ttlMs: 60_000 });
    const r = await store.write([{ key: "ASR_ENGINE", value: "aliyun" }], "tester", {
      verified: false,
    });
    assert.equal(r.accepted.length, 0);
    assert.match(r.rejected[0]?.reason ?? "", /ASR_ENGINE/);
    assert.match(r.rejected[0]?.reason ?? "", /\.env/);
  });

  it("env 不在场：回落 db → default，与普通 db 项无异（钉档是例外不是常态）", async () => {
    const withDb = createConfigStore(prismaOf({ TTS_ENGINE: "aliyun" }), { env: {}, ttlMs: 60_000 });
    assert.equal(await withDb.get("TTS_ENGINE"), "aliyun");
    assert.equal(
      (await withDb.displayItems()).find((e) => e.key === "TTS_ENGINE")?.source,
      "db",
    );

    const bare = createConfigStore(prismaOf({}), { env: {}, ttlMs: 60_000 });
    assert.equal(await bare.get("TTS_ENGINE"), "mock");
    const item = (await bare.displayItems()).find((e) => e.key === "TTS_ENGINE");
    assert.equal(item?.source, "default");
    assert.equal(item?.writable, true, "没被钉死时照常可写");
  });

  it("env 空串不算钉死：空串等同于「未设置」，没有覆盖力", async () => {
    const store = createConfigStore(prismaOf({ ASR_ENGINE: "aliyun" }), {
      env: { ASR_ENGINE: "" },
      ttlMs: 60_000,
    });
    assert.equal(await store.get("ASR_ENGINE"), "aliyun");
  });

  it("对照：storage=db 的项仍是 db 优先于 env（既有语义不变）", async () => {
    const store = createConfigStore(prismaOf({ ALIYUN_TTS_VOICE: "Serena" }), {
      env: { ALIYUN_TTS_VOICE: "Cherry" },
      ttlMs: 60_000,
    });
    assert.equal(await store.get("ALIYUN_TTS_VOICE"), "Serena");
  });
});
