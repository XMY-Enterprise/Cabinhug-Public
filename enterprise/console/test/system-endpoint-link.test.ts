/**
 * 系统状态卡片上那条地址的防退化断言。
 *
 * 这一页常从局域网另一台机器打开（车机、手机、其他电脑），而服务端给的链接
 * 一律写 localhost，那是网关的视角；照搬会指向访问者自己的机器，端口无人应答，
 * 被误读为服务故障。因此只换回环主机名，端口与路径不动；真外部地址原样保留。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openableHref } from "../src/pages/system/index";

describe("openableHref", () => {
  it("回环主机名换成访问者的主机名，端口与路径不动", () => {
    assert.equal(
      openableHref("http://localhost:8792/health", "192.168.50.67"),
      "http://192.168.50.67:8792/health",
    );
    assert.equal(
      openableHref("http://127.0.0.1:8795/health", "192.168.50.67"),
      "http://192.168.50.67:8795/health",
    );
    // 容器里的网关探宿主服务时用的名字，对浏览器同样没意义
    assert.equal(
      openableHref("http://host.docker.internal:8794/health", "192.168.50.67"),
      "http://192.168.50.67:8794/health",
    );
  });

  it("真外部地址原样保留：不是回环就不改写", () => {
    assert.equal(
      openableHref("http://192.168.50.20:9000/x", "192.168.50.67"),
      "http://192.168.50.20:9000/x",
    );
  });

  it("非 HTTP 与不合法的地址不给链接：点开必然失败的链接比没有更糟", () => {
    assert.equal(openableHref("postgres://localhost:55433", "192.168.50.67"), null);
    assert.equal(openableHref(":8790", "192.168.50.67"), null);
  });
});
