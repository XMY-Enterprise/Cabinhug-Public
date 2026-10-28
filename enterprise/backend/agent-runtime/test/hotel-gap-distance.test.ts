/**
 * [F-13-05] 住宿与景点的距离判据。
 *
 * 按坐标量距离，不比两个分支各自写的中文片区标签：片区标签与真实距离几乎不相关
 * （实测 0.24 km 判为缺口、6.65 km 判为覆盖）。本文件的坐标取自 poi_search 的实测返回。
 *
 * 缺省档有骨架，片区与坐标一开始就在 hotel 的 prompt 里，缺住宿由修复轮的 `rerun:hotel` 接。
 * 这里只测距离本身与阈值；挂载段按最近距离挑候选用的是同一份 `hotelGapKm`。
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { hotelGapKm, kmBetween, HOTEL_GAP_KM_DEFAULT } from "../src/graph/subgraphs/itinerary";
import { lookupPoiCoord, recordPoiCoords, resetPoiCoords, sweepPoiCoords } from "../src/poi-coords";

/*
 * 南通三天行程里 poi_search 原样返回的坐标，登记簿按命中自己的 name 入账。
 *
 * 以「南通濠河风景名胜区」为关键词单点查询时，高德返回 45 公里外如皋的水绘园（ADR-008）。
 * 登记簿按命中自己的名字入账，该条记为「水绘园」，不会冒充濠河。
 */
const 博物苑 = { lat: 32.011296, lon: 120.869839 };
const 狼山 = { lat: 31.948766, lon: 120.88776 };
const 唐闸 = { lat: 32.06107, lon: 120.802273 };
const 全季濠河 = { lat: 32.011413, lon: 120.872412 };
const 如家狼山 = { lat: 31.967216, lon: 120.885439 };

describe("[F-13-05] 住宿距离判据", () => {
  it("kmBetween 与实测对得上：博物苑到濠河全季 0.24km、狼山到如家 2.06km", () => {
    assert.ok(Math.abs(kmBetween(博物苑, 全季濠河) - 0.24) < 0.05);
    assert.ok(Math.abs(kmBetween(狼山, 如家狼山) - 2.06) < 0.05);
  });

  it("真的远（唐闸离最近候选 8.6km）超过缺省阈值", () => {
    assert.ok(kmBetween(唐闸, 全季濠河) > HOTEL_GAP_KM_DEFAULT, "两家候选里更近的那家也超过 8km");
    assert.ok(kmBetween(唐闸, 如家狼山) > HOTEL_GAP_KM_DEFAULT);
  });

  it("阈值可配，缺省 8km（标定见 HOTEL_GAP_KM_DEFAULT 的说明）", () => {
    assert.equal(HOTEL_GAP_KM_DEFAULT, 8);
    assert.equal(hotelGapKm({} as NodeJS.ProcessEnv), 8);
    assert.equal(hotelGapKm({ CABINHUG_HOTEL_GAP_KM: "3" } as never), 3);
    assert.equal(hotelGapKm({ CABINHUG_HOTEL_GAP_KM: "0" } as never), 8, "0 与负数当没配");
    assert.equal(hotelGapKm({ CABINHUG_HOTEL_GAP_KM: "abc" } as never), 8);
  });
});

describe("[F-13-05] poi_search 坐标登记簿", () => {
  beforeEach(() => resetPoiCoords());

  it("记下来就查得到，名字前后空白不影响", () => {
    recordPoiCoords({ sessionId: "s", turnId: "t" }, [{ name: "唐闸古镇", lat: 32.05, lon: 120.82 }]);
    assert.deepEqual(lookupPoiCoord("s", "t", " 唐闸古镇 "), { lat: 32.05, lon: 120.82 });
  });

  it("turnId 缺失不记：归不了轮的坐标无法读取", () => {
    recordPoiCoords({ sessionId: "s" }, [{ name: "x", lat: 1, lon: 2 }]);
    assert.equal(lookupPoiCoord("s", "t", "x"), undefined);
  });

  it("同名先写的赢：别的分支用另一个城市查到的同名点不顶掉它（ADR-008 同名异地）", () => {
    recordPoiCoords({ sessionId: "s", turnId: "t" }, [{ name: "文峰塔", lat: 32.0, lon: 120.9 }]);
    recordPoiCoords({ sessionId: "s", turnId: "t" }, [{ name: "文峰塔", lat: 36.1, lon: 114.4 }]);
    assert.deepEqual(lookupPoiCoord("s", "t", "文峰塔"), { lat: 32.0, lon: 120.9 });
  });

  it("非法坐标不入簿", () => {
    recordPoiCoords({ sessionId: "s", turnId: "t" }, [
      { name: "坏点", lat: Number.NaN, lon: 120 },
      { name: "", lat: 1, lon: 2 },
    ]);
    assert.equal(lookupPoiCoord("s", "t", "坏点"), undefined);
  });

  it("轮结束清理，不跨轮串味", () => {
    recordPoiCoords({ sessionId: "s", turnId: "t1" }, [{ name: "x", lat: 1, lon: 2 }]);
    sweepPoiCoords("s", "t1");
    assert.equal(lookupPoiCoord("s", "t1", "x"), undefined);
  });
});
