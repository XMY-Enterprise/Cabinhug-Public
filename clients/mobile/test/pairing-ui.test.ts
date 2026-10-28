/**
 * [F-56-03][AC-56-3] 手机端绑定屏的接线。
 *
 * # 为什么读源码
 *
 * 要守的是接线不是像素：Tauri 命令注册了却没有调用方时，编得过、跑得起来、
 * 功能不存在，且不报任何错。
 *
 * 这里逐条钉住的都是"少了也不报错"的那种约束。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");

const PAIRING = read("../src/features/ownership/pairing.tsx");
const PEOPLE = read("../src/features/ownership/people.tsx");

/** 去掉注释，只留会真的跑起来的那部分。本文件没有 URL，`//` 可以放心切。 */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("[F-56-03][AC-56-3] 手机端绑定屏接线", () => {
  it("`request_pairing_code` 有调用方", () => {
    assert.match(PAIRING, /invoke<string>\("request_pairing_code"/);
    assert.match(PAIRING, /cockpitDeviceId/, "参数名要与 Tauri 命令一致，写错不报错只是永远失败");
  });

  /*
   * 跨语言对齐：命令名或参数名写错，Tauri 在编译期不报错，表现是这一屏永远失败，
   * 错误文案像网络问题。浏览器预览渲染不出这一区（档案页在没有网关通道时是
   * offline 态，仓库不提供假车辆数据），所以在这里对齐。
   */
  it("命令名与 Rust 侧注册的一致", () => {
    /*
     * 读 `lib.rs` 而不是 `main.rs`（ACR-013）：手机端为编 iOS 是 lib crate，
     * `generate_handler!` 清单在 `lib.rs`，`main.rs` 只是壳。
     * 清单换位置时这条应当变红，而不是在旧位置上永远通过。
     */
    const registry = read("../src-tauri/src/lib.rs");
    assert.match(registry, /generate_handler!/, "命令清单不在 lib.rs 了？这条守卫要跟着搬");
    assert.match(registry, /commands::profile::request_pairing_code/, "没注册的话运行时是 command not found");
  });

  it("参数名与 Rust 函数签名对得上（camelCase ↔ snake_case）", () => {
    const profile = read("../src-tauri/src/commands/profile.rs");
    const sig = profile.match(/pub async fn request_pairing_code\(([\s\S]*?)\)/);
    assert.ok(sig, "Rust 侧签名没找到，这条对齐就失效了");
    const params = (sig[1] ?? "")
      .split(",")
      .map((s) => s.split(":")[0]!.trim())
      .filter(Boolean);
    assert.deepEqual(params, ["cockpit_device_id", "vin"]);
    for (const p of params) {
      const camel = p.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
      assert.ok(
        new RegExp(`\\b${camel}\\b`).test(PAIRING),
        `前端没传 ${camel}——Tauri 不会报错，只会永远失败`,
      );
    }
  });

  it("已挂进档案页", () => {
    assert.match(PEOPLE, /import \{ PairingSection \}/);
    assert.match(PEOPLE, /<PairingSection/);
  });

  it("只挂了一处", () => {
    assert.equal(PEOPLE.split("<PairingSection").length - 1, 1);
  });

  it("非车主整区不渲染，不是渲染后禁用", () => {
    assert.match(PAIRING, /if \(myRole !== "owner"\) return null;/);
  });

  it("扫码按钮在能力探测之后才渲染", () => {
    assert.match(PAIRING, /"BarcodeDetector" in window/);
    assert.match(PAIRING, /navigator\.mediaDevices\?\.getUserMedia/);
    assert.match(PAIRING, /canScan\(\) && !scanning/, "探测不通过就不该有这个按钮");
  });

  it("扫来的内容也要过同一套校验，不直接当成合法编号", () => {
    assert.match(PAIRING, /setRaw\(hits\[0\]!\.rawValue\)/);
    assert.match(PAIRING, /validateDeviceId/);
  });

  it("停止扫码时把 track 停掉——不停的话相机灯一直亮着", () => {
    assert.match(PAIRING, /getTracks\(\)\.forEach\(\(t\) => t\.stop\(\)\)/);
    assert.match(PAIRING, /useEffect\(\(\) => stopScan, \[stopScan\]\)/, "组件卸载也要停");
  });

  it("只用 vinSuffix，不渲染完整 VIN", () => {
    assert.match(PAIRING, /issued\.vinSuffix/);
    assert.ok(
      !/\{vin\}/.test(PAIRING),
      "完整 VIN 会出现在手机截图与日志里，服务端刻意只回末 4 位，界面不许从别处拼出来",
    );
  });

  it("429 有专门话术，不与「绑定失败」混为一谈", () => {
    assert.match(PAIRING, /too_many_pairing_requests/);
    assert.match(PAIRING, /上限/);
  });

  it("不替服务端猜错误原因：话术里不出现「不是车主」这类推测", () => {
    /*
     * 只看代码不看注释：源码注释里写着不做哪些推测，断言的对象是会显示给人的字。
     */
    const code = stripComments(PAIRING);
    for (const guess of ["你可能不是车主", "不是这辆车的车主", "车辆不存在", "无权限"]) {
      assert.ok(!code.includes(guess), `非车主与车不存在服务端刻意回同一句，界面不许拆开猜（${guess}）`);
    }
  });

  it("没有自动重发 / 自动续期", () => {
    // 倒计时那个 interval 里只允许改 left，不许触发取码
    const timers = PAIRING.match(/setInterval\([\s\S]*?\)/g) ?? [];
    for (const t of timers) {
      assert.ok(
        !t.includes("request_pairing_code") && !t.includes("request("),
        "自动重发会静默吃掉每小时 5 次的配额，而耗尽的表现是 429",
      );
    }
    assert.match(PAIRING, /重新获取/, "重发必须是用户显式点的按钮");
  });

  it("倒计时归零后明说码已作废，而不是静静地留在屏上", () => {
    assert.match(PAIRING, /const expired = issued !== null && left <= 0;/);
    assert.match(PAIRING, /已经过期/);
  });

  it("浏览器预览里如实说没有网关通道，不 mock 一个假码", () => {
    assert.match(PAIRING, /浏览器预览没有网关通道/);
  });

  it("与舒适域那个「车机」区划清界限（源码注释写明不合并）", () => {
    assert.match(PAIRING, /cabin-section/);
    assert.match(PAIRING, /别合并/);
  });
});
