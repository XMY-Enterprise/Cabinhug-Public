/**
 * 提示卡的天气署名（ACR-052）。
 *
 * 和风天气的许可要求：显示天气的界面标明「和风天气」并链接官网，且单独放、不混在正文里。
 * 这里守两件事：有来源时署名与链接都在；没有来源（没拿到天气）时一个字都不出。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TipsCard } from "../src/hud/TipsCard";

const base = { weatherIcon: "sun.png", items: [], page: 1, pageCount: 1 };
/** 署名的真实链接由服务端随数据下发；端上测试用 RFC 2606 占位域名（端上不得出现非网关地址）。 */
const source = { name: "和风天气", url: "https://example.com/weather" };

describe("TipsCard 天气署名（ACR-052）", () => {
  it("有来源时卡底单独一行署名并链接官网", () => {
    const html = renderToStaticMarkup(createElement(TipsCard, { ...base, weatherSource: source }));
    assert.match(html, /<a class="hud-tips__source" href="https:\/\/example\.com\/weather"/);
    assert.match(html, /天气数据：和风天气/);
  });

  it("没有来源时不渲染署名——没有数据就没有来源可署", () => {
    const html = renderToStaticMarkup(createElement(TipsCard, base));
    assert.ok(!html.includes("hud-tips__source"));
  });
});
