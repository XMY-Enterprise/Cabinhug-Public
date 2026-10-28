/**
 * 预置数据自身的不变量。
 *
 * VIN 标准把字母 I/O/Q 排除在外（与 1/0 易混），`isValidVin` 判含这些字母的 VIN 非法。
 * 预置 VIN 非法时，对演示车的任何档案写入（口头补录、问诊留档、里程推进）
 * 在校验那一步被挡下，不报错、日志也无异常。
 *
 * 因此这里断言"预置数据能被系统接受"，而不是"字符串等于某个值"。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { isValidVin } from "../../../enterprise/backend/shared/memory/src/vehicle-store";
import { bindSeedCabin, buildTrips } from "./demo-seed";

// 字面量从源文件读取：demo-seed.ts 拉 `@cabinhug/db`，而脚本目录不是 workspace 成员，
// 在 `test:infra` 下按值 import 会 MODULE_NOT_FOUND。断言对象就是文件里写着的 VIN。
const SRC = readFileSync(path.join(import.meta.dirname, "demo-seed.ts"), "utf8");
const literal = (name: string): string => {
  const m = new RegExp(`${name} = "([^"]+)"`).exec(SRC);
  assert.ok(m, `demo-seed.ts 里找不到 ${name} 的字面量——改了写法就同步改这里`);
  return m[1];
};
const DEMO_VIN_PREFIX = literal("DEMO_VIN_PREFIX");
const seedVins = (): string[] => [literal("VIN_EV"), literal("VIN_ICE")];

describe("demo:seed 的 VIN 必须过得了系统自己的校验", () => {
  it("每个预置 VIN 都 `isValidVin`，否则演示车的档案写入全部失败", () => {
    const vins = seedVins();
    assert.ok(vins.length > 0, "一个预置 VIN 都没有，这条用例就失去意义了");
    for (const vin of vins) {
      assert.equal(isValidVin(vin), true, `${vin} 过不了 isValidVin`);
    }
  });

  it("不含字母 I / O / Q（与 1/0 易混，VIN 标准排除）", () => {
    for (const vin of seedVins()) {
      assert.equal(/[IOQ]/.test(vin), false, `${vin} 里有 I/O/Q`);
    }
  });

  it("reset 的前缀必须真的是 VIN 的前缀，否则清不掉自己造的数据", () => {
    for (const vin of seedVins()) {
      assert.ok(vin.startsWith(DEMO_VIN_PREFIX), `${vin} 不以 ${DEMO_VIN_PREFIX} 开头`);
    }
    assert.equal(/[IOQ]/.test(DEMO_VIN_PREFIX), false, "前缀自己也不能有 I/O/Q");
  });
});

/**
 * 预置里程不覆盖用户自己录的数。
 *
 * `vehicleUpsertPayload` 是绕过仓储层的裸 upsert，不经 `advanceOdometerWithin` 的
 * "只前进"约束；`update` 若带 `odometerKm`，每次 `demo:seed`（评测前会跑）
 * 都会把用户录入的里程静默写回预置值。
 *
 * 同一段还守 `odometerAt`：新建时不写时刻，新鲜度体检恒判 `unknown`，
 * 助手会对预置车每一轮都追问里程。
 *
 * 断言读源文件而不是调函数，理由同上：demo-seed.ts 拉 `@cabinhug/db`。
 */
describe("demo:seed 不覆盖用户录进去的里程", () => {
  const body = (): string => {
    const start = SRC.indexOf("export function vehicleUpsertPayload");
    assert.ok(start > 0, "找不到 vehicleUpsertPayload——改了函数名就同步改这里");
    const end = SRC.indexOf("\nfunction maintenance", start);
    return SRC.slice(start, end > start ? end : undefined);
  };
  const section = (label: string): string => {
    const src = body();
    const i = src.indexOf(`${label}:`);
    assert.ok(i > 0, `载荷里没有 ${label}`);
    // 到下一个顶层键为止；`update` 是最后一个，切到函数尾。
    const rest = src.slice(i);
    const next = rest.indexOf("\n    update:", 1);
    return next > 0 ? rest.slice(0, next) : rest;
  };

  it("`update` 里没有 odometerKm：已存在的车不碰里程", () => {
    assert.equal(
      /odometerKm/.test(section("update")),
      false,
      "update 带上里程 = 每跑一次 seed 就把用户改过的数写回预置值",
    );
  });

  it("`create` 里有 odometerAt：不写时刻，新鲜度体检恒判 unknown", () => {
    assert.match(section("create"), /odometerAt/);
  });

  it("里程确实被从 `...rest` 里摘了出来（不是靠 update 覆盖顺序碰巧生效）", () => {
    assert.match(body(), /const \{[^}]*odometerKm[^}]*\.\.\.rest\s*\}\s*=\s*v/);
  });
});

/**
 * 长途行程的落点不能取决于播种那天是周几。
 *
 * 这份预置数据里只有长途那一段带 `observedRangeKm`，它是 ⑥ 实测满电续航唯一的来源。
 * 若按 `d % 14 < 2` 选长途日（相差 14 天即同一星期几），七天里有五天播种生成不出长途：
 * `trips` 照样有记录，
 * 但 `observedRangeKm` 全空，行程规划会回答"没有可用的实测续航数据"。
 */
describe("预置流水：实测续航不依赖播种日是周几", () => {
  // 周日~周六各播一次。取 2026-09-06 起的连续七天，覆盖全部七个星期几。
  const days = [...Array(7)].map((_, i) => new Date(2026, 8, 6 + i, 12, 0, 0).getTime());

  it("七个星期几播种，每一份都有带实测续航的长途行程", () => {
    for (const now of days) {
      const withRange = buildTrips(now).filter((t) => t.observedRangeKm !== undefined);
      assert.ok(
        withRange.length >= 3,
        `${new Date(now).toDateString()} 播种只得到 ${withRange.length} 条实测续航行程——` +
          "长途的落点又和星期几绑上了",
      );
    }
  });

  it("长途一律落在周六，且隔周一次（不是靠多生成几条凑数）", () => {
    for (const now of days) {
      const longs = buildTrips(now).filter((t) => t.observedRangeKm !== undefined);
      for (const t of longs) {
        assert.equal(new Date(t.startedAt).getDay(), 6, "长途应当在周六");
      }
      // 45 天里最多四个隔周窗口。
      assert.ok(longs.length <= 4, `隔周一次最多 4 条，实得 ${longs.length}`);
    }
  });

  it("实测续航的取值落在正常衰减区间（418~452），不是 0 也不是编出来的整数档", () => {
    for (const t of buildTrips(days[0]!)) {
      if (t.observedRangeKm === undefined) continue;
      assert.ok(t.observedRangeKm >= 418 && t.observedRangeKm <= 452, `越界：${t.observedRangeKm}`);
    }
  });
});

describe("demo:seed 给默认演示车绑车机", () => {
  // 绑定若只靠人在档案页手动触发，重灌数据后演示车即为未绑定，而 mock-cabin、网关与日志
  // 都无异常；因此由 seed 负责绑定。
  it("绑上了 → ok，detail 里带车机侧 id，便于对照 mock 里的车辆", async () => {
    const r = await bindSeedCabin({ bind: async () => ({ vehicleId: "VEH-000007", rebuilt: false }) as never }, "DEM00SEED0M0DELY1");
    assert.equal(r.ok, true);
    assert.match(r.detail, /DEM00SEED0M0DELY1 → VEH-000007/);
    assert.doesNotMatch(r.detail, /重建/);
  });

  it("车机侧重建过要在 detail 里说明：旧 id 已悬空，需与 mock 的状态文件对照", async () => {
    const r = await bindSeedCabin({ bind: async () => ({ vehicleId: "VEH-000008", rebuilt: true }) as never }, "DEM00SEED0M0DELY1");
    assert.match(r.detail, /重建/);
  });

  it("绑不上必须是 ok:false，不静默失败", async () => {
    const r = await bindSeedCabin({ bind: async () => { throw new Error("fetch failed"); } }, "DEM00SEED0M0DELY1");
    assert.equal(r.ok, false);
    assert.match(r.detail, /fetch failed/);
  });

  it("seed 的执行序列里真的有这一步，且只绑默认车（迈锐宝留着演「未绑定 → 绑定」）", () => {
    assert.match(SRC, /seedPostgres\(now\)\), \.\.\.\(await seedCabinBinding\(\)\)/);
    const body = SRC.slice(SRC.indexOf("async function seedCabinBinding"));
    assert.match(body.slice(0, body.indexOf("\nasync function seedMemory")), /VIN_EV\)/);
    assert.doesNotMatch(body.slice(0, body.indexOf("\nasync function seedMemory")), /VIN_ICE/);
  });
});
