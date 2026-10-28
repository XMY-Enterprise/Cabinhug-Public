/**
 * 能力开关在手机端（ACR-057）：取不到时全开；只有网关明确下发拍照问诊关闭时，首页卡与相机按钮才消失。
 *
 * 取值与轮询是纯逻辑，直接调；界面部分与 `home-hub.test.ts` 同一做法读源码——组件引用的图片与样式
 * 在 node 里加载不了。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { Capability } from "@cabinhug/shared";

import { CAPABILITIES_RETRY_MS, parseCapabilitiesResponse, startCapabilitiesPolling } from "../src/data/capabilities";
import { DEFAULT_REMINDER, DEFAULT_REMINDER_NO_PHOTO } from "../src/features/home/model";

describe("[ACR-057] 解析下发结果", () => {
  it("正常形状 → 关闭集合与复查间隔", () => {
    const r = parseCapabilitiesResponse(JSON.stringify({ off: ["photo-diagnosis"], refreshMs: 15_000 }));
    assert.deepEqual([...(r?.off ?? [])], ["photo-diagnosis"]);
    assert.equal(r?.refreshMs, 15_000);
  });

  it("没给或给了离谱的 refreshMs → 退回 30 秒，不打成忙等", () => {
    assert.equal(parseCapabilitiesResponse('{"off":[]}')?.refreshMs, CAPABILITIES_RETRY_MS);
    assert.equal(parseCapabilitiesResponse('{"off":[],"refreshMs":5}')?.refreshMs, CAPABILITIES_RETRY_MS);
  });

  it("不是 JSON、形状不对 → undefined（沿用上一次的值）", () => {
    for (const raw of ["", "<html>", "null", '{"off":"photo-diagnosis"}']) {
      assert.equal(parseCapabilitiesResponse(raw), undefined, raw);
    }
  });
});

/** 手动推进的定时器：只记最近一次排的那一格。 */
function manualTimers() {
  const queue: Array<{ fn: () => void; ms: number }> = [];
  return {
    queue,
    timers: {
      set: (fn: () => void, ms: number) => {
        queue.push({ fn, ms });
        return queue.length;
      },
      clear: () => {
        queue.length = 0;
      },
    },
    async fire() {
      const next = queue.shift();
      next?.fn();
      await new Promise((r) => setImmediate(r));
    },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

describe("[ACR-057] 轮询", () => {
  it("立刻取一次；集合变了才回调，没变不回调", async () => {
    const replies = ['{"off":["photo-diagnosis"],"refreshMs":1000}', '{"off":["photo-diagnosis"],"refreshMs":1000}', '{"off":[],"refreshMs":1000}'];
    const seen: Array<Capability[]> = [];
    const t = manualTimers();
    const stop = startCapabilitiesPolling(async () => replies.shift() ?? "{}", (off) => seen.push([...off]), t.timers);
    await flush();
    assert.deepEqual(seen, [["photo-diagnosis"]]);
    assert.equal(t.queue[0]?.ms, 1000, "按下发的 refreshMs 排下一次");
    await t.fire();
    assert.deepEqual(seen, [["photo-diagnosis"]], "同一结果不重复回调");
    await t.fire();
    assert.deepEqual(seen, [["photo-diagnosis"], []], "网关改回全开，入口跟着回来");
    stop();
  });

  it("取不到 → 不回调（初值全开不变），30 秒后再试", async () => {
    const seen: Array<Capability[]> = [];
    const t = manualTimers();
    const stop = startCapabilitiesPolling(
      async () => {
        throw new Error("404 旧网关没有这个端点");
      },
      (off) => seen.push([...off]),
      t.timers,
    );
    await flush();
    assert.deepEqual(seen, []);
    assert.equal(t.queue[0]?.ms, CAPABILITIES_RETRY_MS);
    stop();
  });

  it("关闭后又抖一次 → 沿用关闭，不因一次失败把入口放出来", async () => {
    let fail = false;
    const seen: Array<Capability[]> = [];
    const t = manualTimers();
    const stop = startCapabilitiesPolling(
      async () => {
        if (fail) throw new Error("503");
        return '{"off":["photo-diagnosis"],"refreshMs":1000}';
      },
      (off) => seen.push([...off]),
      t.timers,
    );
    await flush();
    fail = true;
    await t.fire();
    assert.deepEqual(seen, [["photo-diagnosis"]]);
    stop();
  });

  it("停止后不再排下一次", async () => {
    const t = manualTimers();
    const stop = startCapabilitiesPolling(async () => '{"off":[]}', () => {}, t.timers);
    stop();
    await flush();
    assert.equal(t.queue.length, 0);
  });
});

/** 剥掉注释再匹配：守的是代码，不是注释的措辞。 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const HOME = strip(readFileSync(new URL("../src/features/home/index.tsx", import.meta.url), "utf8"));
const APP = strip(readFileSync(new URL("../src/app/index.tsx", import.meta.url), "utf8"));
const CSS = readFileSync(new URL("../src/features/home/home.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("[ACR-057] 入口按开关显隐", () => {
  it("首页：拍照问诊卡只在有 onOpenDiagnosis 时渲染，缺席时行程卡占满一行", () => {
    assert.match(HOME, /\{onOpenDiagnosis && \(\s*<button type="button" className="mh-entry" data-entry="diagnosis"/);
    assert.match(HOME, /onOpenDiagnosis \? "mh-entries" : "mh-entries mh-entries--single"/);
    assert.match(CSS, /\.mh-entries--single\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);?\s*\}/);
  });

  it("App：开关经 fetch_capabilities 取，关闭时不给首页诊断入口", () => {
    assert.match(APP, /invoke<string>\("fetch_capabilities"\)/);
    assert.match(APP, /useCapabilitiesOff\(fetchCapabilities\)\.has\("photo-diagnosis"\)/);
    assert.match(APP, /onOpenDiagnosis=\{photoOff \? undefined : openDiagnosis\}/);
  });

  it("首页暖暖的缺省提醒：拍照问诊关闭时不说「拍给我看」", () => {
    assert.match(DEFAULT_REMINDER.body, /拍/, "开着时保留原文案");
    assert.doesNotMatch(DEFAULT_REMINDER_NO_PHOTO.body, /拍|照片|相机/);
    assert.match(HOME, /reminder \?\? \(onOpenDiagnosis \? DEFAULT_REMINDER : DEFAULT_REMINDER_NO_PHOTO\)/);
  });

  it("App：对话框拿的是去掉 upload 的那份（相机按钮随之不显示），load 保留看历史照片", () => {
    assert.match(APP, /attachmentsPort && photoOff \? \{ load: attachmentsPort\.load \} : attachmentsPort/);
    assert.match(APP, /<DialogScreen[\s\S]{0,2000}attachments=\{dialogAttachments\}/);
  });
});
