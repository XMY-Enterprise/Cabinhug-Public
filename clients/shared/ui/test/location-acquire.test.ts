/**
 * 采一次坐标的回退链：原生系统定位 → 高德 → 浏览器。
 *
 * 最终错误若只带最后一条路（浏览器）的原因，例如「定位失败：User denied Geolocation」，
 * 第一条路为什么没成就无从排查。
 *
 * 这里锁两件事：谁排在最前面，以及每条路的失败原因都保留在最终错误里。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { acquireRawFix } from "../src/location/acquire";
import { configureNativeLocator, type RawLocationFix } from "../src/location/port";

const FIX: RawLocationFix = { lat: 22.543, lon: 114.057, accuracyM: 8, source: "gps" };

describe("acquireRawFix 的回退链", () => {
  // 注入是全局的，漏了这一句会串到别的用例上（而且是按文件顺序随机地串）。
  afterEach(() => configureNativeLocator(undefined));

  it("注入了原生定位就先用它——只有它会弹系统授权框，也只有它给得出米级坐标", async () => {
    let called = 0;
    configureNativeLocator(async () => {
      called += 1;
      return FIX;
    });
    const got = await acquireRawFix("precise");
    assert.equal(called, 1);
    assert.deepEqual(got, FIX);
  });

  it("粒度要传给原生实现——模糊档不该去启动 GPS 芯片", async () => {
    const seen: string[] = [];
    configureNativeLocator(async (precision) => {
      seen.push(precision);
      return FIX;
    });
    await acquireRawFix("coarse");
    await acquireRawFix("precise");
    assert.deepEqual(seen, ["coarse", "precise"]);
  });

  it("全都走不通时，每一条路的原因都要在最终错误里", async () => {
    configureNativeLocator(async () => {
      throw new Error("系统未授权定位（当前：denied）");
    });
    // 高德未配置（测试环境从不调 configureAmap），浏览器侧 node 里没有
    // navigator.geolocation，两条都会失败。
    await assert.rejects(acquireRawFix("precise"), (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      assert.match(msg, /系统定位：系统未授权定位/, "第一条路的原因被吞了——这正是那次排查踩的坑");
      assert.match(msg, /浏览器定位：/, "最后一条路的原因也要在");
      return true;
    });
  });

  it("没注入原生实现时行为不变（浏览器走查 / 桌面端照旧两条路）", async () => {
    await assert.rejects(acquireRawFix("precise"), (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      assert.doesNotMatch(msg, /系统定位/, "没注入却报了系统定位，说明多跑了一条不存在的路");
      return true;
    });
  });
});
