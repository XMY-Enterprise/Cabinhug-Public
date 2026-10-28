/**
 * 沿途服务 POI 可得性探针（行程详情抽屉「沿途服务」五格）。
 *
 * 抽屉里餐饮 / 卫生间 / 停车场三格恒显「待查」，口径写在
 * `clients/shared/ui/src/hud/trip-detail.ts` 文件头第 2 条：工具层没有数据源。
 * 本脚本回答"接上之后能拿到什么"——沿一条真实路线取样，逐个类目打高德
 * `/v5/place/around`，打印每个类目在多少个取样点上有命中、命中的是什么。
 *
 * 只读，不改代码、不落库。判据是命中率与命中内容；接口连通性由 `probe:amap` 负责。
 *
 * 运行（根目录）：corepack pnpm probe:route-services
 */

import { readFileSync } from "node:fs";

import { AMAP_KEY_ENV_NAMES, createAmapClient } from "../../../enterprise/backend/shared/tools/src/amap";

const env: Record<string, string> = {};
try {
  for (const l of readFileSync(".env", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)="?([^"]*)"?$/.exec(l.trim());
    if (m) env[m[1]] = m[2];
  }
} catch {
  /* 没有 .env 就只看 process.env */
}
const get = (k: string): string => process.env[k] ?? env[k] ?? "";

/**
 * 高德 POI 类目码与各自的搜索半径。
 *
 * `180300` 半径取 8km：服务区间距大，3km 只在恰好停在门口时命中。
 * 其余类目按步行尺度取 3km。
 *
 * `180300` 是中类「服务区」，一次带回三个子类：`180300` 高速服务区 /
 * `180301` 高速加油站服务区（只有油枪）/ `180303` 公路驿站（省道与城市道路上的停车区）。
 * 本探针量的是沿途可停靠的地点，三类都计入，不在这里筛；按子类取舍由 `map_route`
 * 在调用层完成。类目码与标签不符时探针不报错，只表现为命中率偏低。
 *
 * `200300` 是大类，含母婴室(200304) 与无障碍卫生间(200303)；接进产品时按子码过滤，
 * 或如实标出类型。
 */
const CATEGORIES: ReadonlyArray<{ label: string; types: string; radiusM: number }> = [
  { label: "服务区(含驿站)", types: "180300", radiusM: 8_000 },
  { label: "餐饮", types: "050000", radiusM: 3_000 },
  { label: "公共厕所", types: "200300", radiusM: 3_000 },
  { label: "停车场", types: "150900", radiusM: 3_000 },
  { label: "充电站", types: "011100", radiusM: 3_000 },
];

/** 一条跨城高速路线：既有高速段也有市区段，还经过粤北的稀疏地带。 */
const ORIGIN = { name: "深圳市民中心", city: "深圳" };
const DESTINATION = { name: "韶关丹霞山", city: "韶关" };
/** 取样间距（km）。与 `map_route` 的取样点上限 8 个不同，这里要看真实密度。 */
const SAMPLE_EVERY_KM = 40;

async function main(): Promise<void> {
  const keys = AMAP_KEY_ENV_NAMES.map((n) => get(n).trim()).filter((v) => v.length > 0);
  if (keys.length === 0) {
    console.log("高德未接入（AMAP_SERVER_KEY 未配置），无法探测。先看 probe:amap。");
    return;
  }
  const client = createAmapClient({ key: keys });

  const o = await client.geocode(ORIGIN.name, ORIGIN.city);
  const d = await client.geocode(DESTINATION.name, DESTINATION.city);
  const path = await client.driving({ origin: o, destination: d });
  console.log(
    `路线 ${ORIGIN.name} → ${DESTINATION.name}：` +
      `${(path.distanceM / 1000).toFixed(0)}km / ${(path.durationS / 60).toFixed(0)}min`,
  );

  // 把各 step 的折线拉平，按点序等距抽；精度到一个 step 足够看密度。
  const pts: { lat: number; lon: number }[] = [];
  for (const s of path.steps) pts.push(...s.points);
  const want = Math.max(2, Math.round(path.distanceM / 1000 / SAMPLE_EVERY_KM));
  const stride = Math.max(1, Math.floor(pts.length / want));
  const samples = pts.filter((_, i) => i % stride === 0);
  console.log(`取样点 ${samples.length} 个（每 ~${SAMPLE_EVERY_KM}km），每类目 ${samples.length} 次请求\n`);

  for (const { label, types, radiusM } of CATEGORIES) {
    const startedAt = Date.now();
    let hitPoints = 0;
    let total = 0;
    const examples: string[] = [];
    for (const at of samples) {
      const r = await client.around({ at, types, radiusM, limit: 3 });
      if (r.length === 0) continue;
      hitPoints += 1;
      total += r.length;
      if (examples.length < 3 && r[0]) examples.push(`${r[0].name}[${r[0].typecode}]`);
    }
    console.log(
      `${label.padEnd(12)} r=${String(radiusM).padStart(5)}m  ` +
        `命中 ${hitPoints}/${samples.length} 点 · ${total} 条 · ${Date.now() - startedAt}ms\n` +
        `${" ".repeat(14)}例：${examples.join(" / ") || "（无）"}`,
    );
  }

  console.log(
    "\n注意：命中数是**直线半径内**的 POI 数，不等于可达。" +
      "高速段命中的餐饮多在下道后的镇上，接进产品前要按 F-18-08 的质量门槛筛。",
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
