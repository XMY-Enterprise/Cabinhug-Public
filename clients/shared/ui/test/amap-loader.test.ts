/**
 * 高德加载器的代理形态（ACR-019）。
 *
 * 这一组覆盖出错时不报错的行为：
 *  1. `_AMapSecurityConfig` 必须在 script 注入之前挂到 window 上。晚了不抛错，
 *     地图照样出来，但所有服务接口按未授权处理（路径规划退直线、样式不生效），
 *     表现与网络不佳相同。
 *  2. 解析器是异步的（Tauri 下网关地址要 invoke 取），loader 必须等它。
 *  3. 解析失败要降级而不是阻断：拿不到代理地址只少功能，不整块空白。
 *  4. 不产生 `securityJsCode`：那条路会把安全密钥写进产物。
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { configureAmap, loadAmap } from "../src/map/amap-loader";

interface FakeScript {
  async?: boolean;
  src?: string;
  onload?: (() => void) | null;
  onerror?: (() => void) | null;
}

/** 记录事件顺序，第 1 条断言依赖它。 */
let order: string[] = [];

function installFakeDom(): void {
  order = [];
  const win = {
    // 每次重装都清掉，否则 loadAmap 会走 "已加载" 短路。
    AMap: undefined as unknown,
    _AMapSecurityConfig: undefined as { securityJsCode?: string; serviceHost?: string } | undefined,
    location: { origin: "http://127.0.0.1:1430" },
  };
  const doc = {
    createElement(): FakeScript {
      return { onload: null, onerror: null };
    },
    head: {
      appendChild(script: FakeScript) {
        order.push(`script:${script.src ?? ""}`);
        // 模拟脚本就绪：SDK 挂上 window.AMap 再回调。
        (win as { AMap: unknown }).AMap = { __fake: true };
        queueMicrotask(() => script.onload?.());
      },
    },
  };
  (globalThis as { window?: unknown }).window = win;
  (globalThis as { document?: unknown }).document = doc;
}

const securityConfig = () =>
  (globalThis as { window: { _AMapSecurityConfig?: { securityJsCode?: string; serviceHost?: string } } })
    .window._AMapSecurityConfig;

describe("amap-loader 的代理形态（ACR-019）", () => {
  beforeEach(() => {
    installFakeDom();
    configureAmap(undefined);
  });

  it("serviceHost 给字符串：设进 _AMapSecurityConfig，且在 script 之前", async () => {
    configureAmap({ jsKey: "k", serviceHost: "http://gw.local:8790/_AMapService" });
    await loadAmap();
    assert.equal(securityConfig()?.serviceHost, "http://gw.local:8790/_AMapService");
    // 顺序：设配置那一步没进 order，但 script 一定是最后一件事；
    // 真正的判据是下一条：解析器还没回来时 script 不许出现。
    assert.equal(order.length, 1);
    assert.match(order[0], /^script:https:\/\/webapi\.amap\.com\/maps/);
  });

  it("serviceHost 给异步解析器：loader 等它解析完才注入 script", async () => {
    let resolved = false;
    configureAmap({
      jsKey: "k",
      serviceHost: async () => {
        // 解析期间不许注入任何 script，这是竞态所在。
        assert.equal(order.length, 0, "解析器还没回来就注入了 script");
        await new Promise((r) => setTimeout(r, 5));
        resolved = true;
        return "http://gw.local:8790/_AMapService";
      },
    });
    await loadAmap();
    assert.equal(resolved, true);
    assert.equal(securityConfig()?.serviceHost, "http://gw.local:8790/_AMapService");
    assert.equal(order.length, 1);
  });

  it("解析器抛错：不设代理地址，但地图照常加载（降级方向是少点功能，不是空白）", async () => {
    configureAmap({
      jsKey: "k",
      serviceHost: () => {
        throw new Error("网关问不到");
      },
    });
    const ns = await loadAmap();
    assert.ok(ns, "地图仍应加载出来");
    assert.equal(securityConfig(), undefined);
  });

  it("解析器回空串：按没配处理，不设一个空的 serviceHost", async () => {
    configureAmap({ jsKey: "k", serviceHost: () => "   " });
    await loadAmap();
    assert.equal(securityConfig(), undefined);
  });

  it("不给 serviceHost：不设 _AMapSecurityConfig", async () => {
    configureAmap({ jsKey: "k" });
    await loadAmap();
    assert.equal(securityConfig(), undefined);
  });

  it("任何路径都不产生 securityJsCode（会把安全密钥写进产物）", async () => {
    for (const cfg of [
      { jsKey: "k" },
      { jsKey: "k", serviceHost: "http://gw.local:8790/_AMapService" },
      { jsKey: "k", serviceHost: async () => "http://gw.local:8790/_AMapService" },
    ]) {
      installFakeDom();
      configureAmap(cfg);
      await loadAmap();
      assert.equal(securityConfig()?.securityJsCode, undefined);
    }
  });

  it("script 上带的仍是 jsKey：它无法从产物里移走", async () => {
    configureAmap({ jsKey: "the-js-key", serviceHost: "http://gw.local:8790/_AMapService" });
    await loadAmap();
    assert.match(order[0], /key=the-js-key/);
  });
});
