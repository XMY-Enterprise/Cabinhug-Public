/**
 * 顶栏连接指示灯与刷新按钮。
 *
 * 刷新重新请求主页数据，不改变操作状态（如已选中的行程）。各条判据尽量落在可运行的代码上：
 *
 *  1. 刷新不动选择。破坏时不报错，屏幕跳回列表首条，所以判据是实际执行 `select` + `refresh`。
 *  2. 顶栏刷新要求最新数据，带 pretrip 重算；确认/取消之后的重拉不带
 *     （缺省一半由 `hud-gateway-source.test.ts` 守，这里只守 opt-in 一半）。
 *  3. 兑现时机。`refresh()` 的 promise 等取数落地后兑现，成功失败都兑现；
 *     按钮据此结束转圈，不兑现则失败后按钮一直转。
 *  4. 绿灯不是缺省。`.hud-topbar__link-dot` 的基础色是中性的，
 *     绿只出现在 `.is-online` 上，否则未认领的取值都会显示成已连接。
 *
 * 本包没有 jsdom，组件无法渲染：TopBar 与样式相关的几条只检查源码形状。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { paginateTipItems, WEATHER_LABELS, type HudSnapshot } from "@cabinhug/shared";

import { createGatewayHudSource, hudSourceFailure } from "../src/hud/gateway-source";
import { startEnergyPolling } from "../src/hud/energy-source";
import { TOP_BAR_LINK_LABEL, type TopBarLink } from "../src/hud/TopBar";

const TSX = readFileSync(new URL("../src/hud/TopBar.tsx", import.meta.url), "utf8")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const CSS = readFileSync(new URL("../src/hud/hud.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** 某条选择器的声明块（同名多条时取最后一条——同特指度下它赢）。 */
function declsOf(selector: string): string | undefined {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hits = [...CSS.matchAll(new RegExp(`(?:^|[},])\\s*${esc}\\s*\\{([^{}]*)\\}`, "g"))];
  return hits.length ? hits[hits.length - 1]![1] : undefined;
}

/** 与车机 mock 基线同形的最小快照（本包没有各端的 mock 源）。 */
function baseSnapshot(): HudSnapshot {
  return {
    trip: {
      origin: { anchor: "home", name: "家", kind: "home" },
      nodes: [
        { anchor: "park", name: "亲子乐园", kind: "leisure" },
        { anchor: "charge", name: "充电站", kind: "charging" },
      ],
      activeSegment: 1,
    },
    energy: { distanceKm: 36, batteryPercent: 68, requiredPercent: 21 },
    tips: { headline: "行前温馨提示", pages: paginateTipItems([{ key: "hat", label: "遮阳帽" }]) },
    weather: { kind: "sunny", label: WEATHER_LABELS.sunny },
    assistantState: "idle",
    freshness: { stale: false, updatedAt: "刚刚" },
  };
}

/** 回包：当前行程 + 一份两程的列表（与 hud-gateway-source.test.ts 同形）。 */
function listJson(plans: string[]): string {
  const mk = (destination: string) => ({
    status: "confirmed",
    destination,
    startDate: "2099-01-01",
    days: 2,
    skeleton: [
      { day: 1, theme: "a", spots: [{ name: `${destination}-1` }] },
      { day: 2, theme: "b", spots: [{ name: `${destination}-2` }] },
    ],
    caveats: [],
    updatedTurnId: "t",
  });
  return JSON.stringify({
    plan: mk(plans[0]!),
    plans: plans.map((d) => ({
      planId: `p-${d}`,
      plan: mk(d),
      committedAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    })),
  });
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("顶栏刷新：只换数据，不换选择", () => {
  it("刷新之后选中的还是那一程——不悄悄跳回列表首条", async () => {
    const shown: string[] = [];
    const src = createGatewayHudSource({
      intervalMs: 10_000,
      base: baseSnapshot,
      fetchPlanJson: async () => listJson(["杭州", "徐州"]),
      onPlan: (p) => shown.push(p ? p.destination : "-"),
    });
    const stop = src.subscribe(
      () => {},
      () => {},
    );
    await settle();
    assert.equal(shown.at(-1), "杭州", "首帧应是列表首条");

    src.select("p-徐州");
    assert.equal(shown.at(-1), "徐州", "选中应立即重投影，不等下一轮");

    await src.refresh({ pretrip: true });
    stop();
    assert.equal(
      shown.at(-1),
      "徐州",
      "刷新把选中的行程换回了首条——用户明说过「页面的选择的状态是不去改变的」",
    );
  });

  it("refresh() 的 promise 等这一跳真的落地——按钮靠它决定转到什么时候", async () => {
    let released!: () => void;
    const gate = new Promise<void>((r) => (released = r));
    const src = createGatewayHudSource({
      intervalMs: 10_000,
      base: baseSnapshot,
      fetchPlanJson: async () => {
        await gate;
        return listJson(["杭州"]);
      },
    });
    const stop = src.subscribe(
      () => {},
      () => {},
    );
    let done = false;
    const p = src.refresh().then(() => {
      done = true;
    });
    await settle();
    assert.equal(done, false, "取数还挂着，refresh() 不该已经兑现");
    released();
    await p;
    stop();
    assert.equal(done, true);
  });

  it("refresh({pretrip:true}) 才要求按最新天气重算——缺省那一半由 hud-gateway-source 守", async () => {
    const asked: Array<boolean | undefined> = [];
    const src = createGatewayHudSource({
      intervalMs: 10_000,
      base: baseSnapshot,
      fetchPlanJson: async (refresh) => {
        asked.push(refresh);
        return listJson(["杭州"]);
      },
    });
    const stop = src.subscribe(
      () => {},
      () => {},
    );
    await settle();
    await src.refresh(); // 确认/取消之后的那种重拉
    await src.refresh({ pretrip: true }); // 顶栏按钮
    stop();
    assert.deepEqual(asked, [true, false, true]);
  });

  it("刷新失败也兑现——不然按钮会永远转下去", async () => {
    const src = createGatewayHudSource({
      intervalMs: 10_000,
      base: baseSnapshot,
      fetchPlanJson: async () => {
        throw new Error("网关没应答");
      },
    });
    const stop = src.subscribe(
      () => {},
      () => {},
    );
    await settle();
    await src.refresh({ pretrip: true }); // 不抛就是通过
    stop();
  });
});

describe("能量那一路也要被踢到", () => {
  it("poller.refresh() 立刻重读一次，不等 15 秒的下一拍", async () => {
    let reads = 0;
    const poller = startEnergyPolling("VIN-1", () => {}, {
      intervalMs: 10_000,
      fetchEnergyJson: async () => {
        reads += 1;
        return JSON.stringify({
          state: "bound",
          battery: { percent: 63, rangeKm: 285, charging: false },
        });
      },
    });
    await settle();
    assert.equal(reads, 1, "订阅即读一次");
    await poller.refresh();
    poller.stop();
    assert.equal(reads, 2, "刷新应额外读一次");
  });

  it("没选中车辆时 refresh() 是空操作，不抛", async () => {
    const poller = startEnergyPolling(null, () => {}, { fetchEnergyJson: async () => "{}" });
    await poller.refresh();
    poller.stop();
  });
});

/*
 * 网关应答 401（车机未做上车声明或声明为访客）与连不上是两种故障：
 * 连不上需要重试，没身份需要重新上车声明；对 401 反复刷新不会恢复。
 */
describe("401 不是「连不上」", () => {
  it("Rust 侧 NetError::Unauthorized 的原文判成 unauthorized", () => {
    // `fetch_trip_plan` 把 NetError 原样 to_string() 交给 invoke 的 reject。
    assert.equal(hudSourceFailure(new Error("unauthorized")), "unauthorized");
    assert.equal(hudSourceFailure("unauthorized"), "unauthorized");
  });

  it("裸 401 文本也判得出来", () => {
    assert.equal(hudSourceFailure(new Error("HTTP 401")), "unauthorized");
    assert.equal(hudSourceFailure(new Error('{"error":"unauthorized"}')), "unauthorized");
  });

  it("真的连不上就是连不上——不许被含 401 的无关文本带偏", () => {
    for (const msg of [
      "network: error sending request: connection refused",
      "network: operation timed out",
      "server: status=502",
      "bad_response: unexpected end of JSON input",
      // 4013 里有 401 三个字符，但它不是状态码。
      "network: port 4013 unreachable",
    ]) {
      assert.equal(hudSourceFailure(new Error(msg)), "unreachable", `「${msg}」被误判成没身份`);
    }
  });

  it("认不出来的一律当连不上——保守的那一侧是让人查链路，不是让人怀疑自己没登录", () => {
    assert.equal(hudSourceFailure(undefined), "unreachable");
    assert.equal(hudSourceFailure(new Error("")), "unreachable");
  });
});

describe("指示灯：五种状态各说各的", () => {
  it("五个取值都有字面，且互不相同——合并任意两个就会把一种情况说成另一种", () => {
    const all: TopBarLink[] = ["connecting", "online", "offline", "noidentity", "demo"];
    const labels = all.map((k) => TOP_BAR_LINK_LABEL[k]);
    for (const [i, k] of all.entries()) assert.ok(labels[i], `${k} 没有字面`);
    assert.equal(new Set(labels).size, all.length, `字面撞车了：${JSON.stringify(labels)}`);
  });

  it("绿不是缺省色——没被认领的取值必须是中性灰，不能长得像已连接", () => {
    const dot = declsOf(".hud-topbar__link-dot");
    assert.ok(dot, "找不到 .hud-topbar__link-dot");
    const base = /background:\s*([^;]+)/.exec(dot)?.[1]?.trim();
    assert.equal(
      base,
      "var(--hud-text-muted)",
      `指示灯的基础色是 ${base}——它必须是中性的：绿只许出现在 .is-online 上`,
    );
    assert.match(declsOf(".hud-topbar__link.is-online .hud-topbar__link-dot") ?? "", /var\(--hud-ok\)/);
    assert.match(declsOf(".hud-topbar__link.is-offline .hud-topbar__link-dot") ?? "", /var\(--hud-danger\)/);
  });

  it("红只给「未连接」——design-system §4 的红色纪律；未上车不是故障，不许染红", () => {
    for (const state of ["online", "connecting", "demo", "noidentity"] as const) {
      const decls = [
        declsOf(`.hud-topbar__link.is-${state}`),
        declsOf(`.hud-topbar__link.is-${state} .hud-topbar__link-dot`),
      ]
        .filter(Boolean)
        .join(";");
      assert.ok(
        !/--hud-danger/.test(decls),
        `.is-${state} 用了 --hud-danger：红只给「拥堵」和「读不到」两个判定`,
      );
    }
  });

  /*
   * 字号引用 `--hud-type-*` 命名样式之一（design-system §5.4）。
   * 指示灯带状态点、可点击，且是连接状态的唯一出口，不能用最小的陪衬档位（15 / 13）。
   */
  it("指示灯引用命名样式，且不是最小那一档", () => {
    const decls = declsOf(".hud-topbar__link") ?? "";
    const m = /font:\s*var\(--hud-type-([a-z]+)\)/.exec(decls);
    assert.ok(m, `指示灯没有引用 --hud-type-*，写的是：${decls.slice(0, 80)}`);
    const tokens = readFileSync(
      fileURLToPath(new URL("../src/themes/tokens.css", import.meta.url)),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    const sizeToken = new RegExp(`--hud-type-${m[1]}:\\s*\\d+\\s+var\\((--hud-font-[a-z]+)\\)`).exec(tokens);
    assert.ok(sizeToken, `tokens.css 里没有 --hud-type-${m[1]}`);
    const px = new RegExp(`${sizeToken![1]}:\\s*calc\\(\\s*([\\d.]+)`).exec(tokens);
    assert.ok(px, `${sizeToken![1]} 不是按基准单位写的`);
    assert.ok(
      Number(px![1]) >= 18,
      `指示灯落在 ${m[1]}（${px![1]} 基准 px）——它可点、带状态点，不能用 15 / 13 这两档陪衬尺寸`,
    );
  });

  it("刷新按钮说得清刷的是什么，且转圈时锁住不叠发", () => {
    assert.match(TSX, /aria-label="刷新主页数据"/, "「刷新」两个字在车机上可以指地图、指音乐");
    assert.match(TSX, /disabled=\{refreshing\}/, "转圈期间要锁住，否则连点会叠发三路请求");
    assert.match(declsOf(".hud-topbar__refresh.is-busy svg") ?? "", /animation:\s*hud-topbar-spin/);
  });

  it("两个都不传就都不渲染——「没显示」不等于「一切正常」", () => {
    assert.match(TSX, /\{link &&/, "link 缺省时不该渲染一枚说不出所以然的灯");
    assert.match(TSX, /\{onRefresh &&/, "没有刷新入口时不该摆一枚点了没反应的按钮");
  });

  it("有补救动作时灯是按钮，没有时是纯播报——不给点了没反应的东西装按钮的长相", () => {
    assert.match(TSX, /onLinkAction \? \(/, "灯没有按动作分叉：能修的那一下要挂在说明问题的这一处");
    assert.match(TSX, /role="status"/, "无动作那一支应保持 role=status 的纯播报");
    assert.match(declsOf(".hud-topbar__link.is-actionable") ?? "", /cursor:\s*pointer/);
  });
});
