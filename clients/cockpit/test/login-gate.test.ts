/**
 * [F-07-01][AC-7-1] 车机端登录门的接线（缺口 G1–G5a）。
 *
 * 守的是**接线**不是像素：命令注册了却没有调用方时，编译与运行都不报错，功能却不存在。
 * 逐条钉住的都是"少了也不报错"的约束。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const GATE = read("../src/features/auth/LoginGate.tsx");
const MAIN = read("../src/main.tsx");
const ACCOUNT = read("../src/features/settings/AccountSection.tsx");
const SETTINGS = read("../src/features/settings/SettingsScreen.tsx");

describe("[G1] 登录门存在且接上了三条登录命令", () => {
  it("auth_login / auth_status 有调用方", () => {
    assert.match(GATE, /invoke<AuthStatus>\("auth_login", \{ username, password \}\)/);
    assert.match(GATE, /invoke<AuthStatus>\("auth_status"\)/);
  });

  it("登录成功后注册设备（幂等、失败不挡）", () => {
    assert.match(GATE, /invoke\("register_device"/);
    assert.match(GATE, /\.catch\(\(\) => undefined\)/);
  });

  it("挂在 main.tsx 最外层——写了没挂等于没做", () => {
    assert.match(MAIN, /<LoginGate>/);
    assert.equal(MAIN.split("<LoginGate>").length - 1, 1, "只挂一处");
  });

  it("口令用完即弃", () => {
    assert.match(GATE, /setPassword\(""\)/);
  });
});

describe("[G4] 车机免密出口——没有它全新 pad 永远绑不了车", () => {
  it("门上有「用作车机」且走 switch_device_role", () => {
    const code = stripComments(GATE);
    assert.match(code, /switch_device_role/, "出口必须真切角色，不是摆一个按钮");
    assert.match(GATE, /把这台设备用作车机/);
  });

  it("车机角色**不经过**本门（凭证是车辆级的，门是 BoardingGate）", () => {
    assert.match(GATE, /if \(role === "cockpit" \|\| boundVin\)/);
  });

  it("[M54-11] 握着车辆凭证就是车机——不能只认角色标记", () => {
    /*
     * 角色持久化在 device.rs；这道以凭证为准的判据是第二重保险。
     * 只留其中一条时，它一失效，已绑定的车机就会退回登录屏、被要求输账号口令。
     */
    assert.match(GATE, /invoke<string>\("bound_vin"\)/);
  });
});

describe("[G5a] 连不上网关时改地址的入口就在门上", () => {
  it("登录屏能展开 GatewayForm（同一个组件，不抄写）", () => {
    assert.match(GATE, /import \{ GatewayForm \} from "\.\.\/settings\/GatewayForm"/);
    assert.match(GATE, /<GatewayForm active=\{showGateway\} \/>/);
  });
});

describe("[G2/G3] 设置页能看到登录状态与当前使用人", () => {
  it("账号区挂进了设置页", () => {
    assert.match(SETTINGS, /<AccountSection \/>/);
  });

  it("私人模式显示账号并能退出；车机模式显示声明的使用人", () => {
    assert.match(ACCOUNT, /auth_logout/);
    assert.match(ACCOUNT, /boarding_declared/);
    assert.match(ACCOUNT, /访客模式/);
  });

  it("映射不到名字时显示 id 片段——**不编名字**", () => {
    assert.match(ACCOUNT, /uid\.slice\(0, 8\)/);
  });

  it("boarding_declared 命令已在 Rust 侧注册", () => {
    const registry = read("../src-tauri/src/lib.rs");
    assert.match(registry, /commands::device::boarding_declared/, "没注册的话运行时是 command not found");
  });
});
