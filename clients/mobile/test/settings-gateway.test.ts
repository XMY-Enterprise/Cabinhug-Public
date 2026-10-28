/**
 * [F-07-02][AC-7-2] 设置页的网关入口。
 *
 * 登录后换 Wi-Fi 时需要在不退出登录的情况下改网关地址。守两条：
 * 入口存在于设置页；且与登录页是同一个组件，不另写一份
 * （两份会导致某一条路上改地址不生效）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");
const SETTINGS = read("../src/features/settings/index.tsx");

describe("[G6] 登录后也能改网关", () => {
  it("设置页有「网关连接」组且复用登录页的 GatewayField", () => {
    assert.match(SETTINGS, /import \{ GatewayField \} from "\.\.\/auth\/GatewayField"/);
    assert.match(SETTINGS, /<GatewayField \/>/);
    assert.match(SETTINGS, /网关连接/);
  });

  it("只挂一处，不抄第二份表单", () => {
    assert.equal(SETTINGS.split("<GatewayField").length - 1, 1);
    assert.ok(!/set_gateway_settings/.test(SETTINGS), "设置页不许自己另写一条保存链");
  });
});
