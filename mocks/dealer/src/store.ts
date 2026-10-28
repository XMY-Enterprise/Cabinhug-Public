/**
 * 种子数据加载与查询。
 *
 * 这里的函数不做补全与猜测：查不到就是查不到。
 * 上游（`enterprise/backend/shared/tools` 的四个工具）据此如实告诉模型"没有"，
 * 模型无法编出种子里没有的门店。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

export type StoreType = "experience" | "service";

export interface Store {
  storeId: string;
  name: string;
  type: StoreType;
  city: string;
  district: string;
  address: string;
  lat: number;
  lon: number;
  models: string[];
}

export interface Trim {
  trim: string;
  /** 人民币指导价。缺省表示本系统没有人民币报价（如 Cybertruck），不是 0。 */
  priceCny?: number;
  rangeKm: number;
  seats: number;
}

export interface ModelDef {
  model: string;
  trims: Trim[];
}

function load<T>(file: string, key: string): T[] {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, file), "utf8")) as Record<string, unknown>;
  const rows = raw[key];
  if (!Array.isArray(rows) || rows.length === 0) {
    // 空种子能启动但查不到任何东西，启动时即报错，与正常启动区分开。
    throw new Error(`[mock-dealer] ${file} 的 ${key} 为空——种子没加载成功`);
  }
  return rows as T[];
}

export const STORES: Store[] = load<Store>("stores.json", "stores");
export const MODELS: ModelDef[] = load<ModelDef>("models.json", "models");

// ── 任意城市 + 区 ─────────────────────────────────────────────
//
// 种子只有四个城市十家店，车主可能说任何地方。种子外一律零命中时，
// 助手只能反复说"这个城市没有门店"。
//
// 因此种子之外按 (城市, 区) 现合成门店，受三条约束：
//
//  1. 种子优先：命中种子就返回种子，合成只补空缺。
//  2. 确定性：同一个 (城市, 区) 永远得到同一个 storeId、同一个店名，
//     否则第一轮看到的店第二轮查不到。
//  3. storeId 自带来源：id 里编进城市与区，`findStore` 不需要注册表，
//     进程重启后旧 id 仍可解析。
//
// 合成门店仍是模拟数据：每个响应都带 `provenance: "simulated"`。

/** 合成 id 的前缀。种子 id 不使用该前缀，两者不会冲突。 */
const SYNTH_PREFIX = "gen";

/** 十六进制编码：只含 `[0-9a-f]`，不与 `slotId` 的 `_` 分隔符冲突。 */
const encodePlace = (city: string, district: string): string =>
  Buffer.from(`${city}|${district}`, "utf8").toString("hex");

function decodePlace(hex: string): { city: string; district: string } | undefined {
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) return undefined;
  const [city, district] = Buffer.from(hex, "hex").toString("utf8").split("|");
  return city ? { city, district: district ?? "" } : undefined;
}

/** 去掉行政区通名，留下可读的核心（`南山区` → `南山`）。 */
const districtCore = (d: string): string => d.replace(/(新区|城区|区|县|市)$/, "") || d;

/**
 * 合成门店的坐标。
 *
 * 不是真实地理位置，只为 `near` 排序提供稳定值。
 * 本仓链路不传 `near`（子图只传 city/district），该近似不影响已接线的行为；
 * 带 `near` 的调用方不会因坐标为 `undefined` 而出错。
 */
function synthCoord(key: string): { lat: number; lon: number } {
  const h = Buffer.from(key, "utf8").reduce((a, b) => (a * 31 + b) >>> 0, 7);
  return {
    lat: Math.round((18 + (h % 3500) / 100) * 1e4) / 1e4,
    lon: Math.round((75 + ((h >>> 8) % 5000) / 100) * 1e4) / 1e4,
  };
}

/** 合成一家店。`type` 决定是体验店还是服务中心。 */
function synthesizeStore(city: string, district: string, type: StoreType): Store {
  const core = district ? districtCore(district) : "";
  const suffix = type === "service" ? "服务中心" : "体验店";
  return {
    storeId: `${SYNTH_PREFIX}-${encodePlace(city, district)}-${type === "service" ? "svc" : "exp"}`,
    name: `${city}${core}${suffix}`,
    type,
    city,
    district: district || "市区",
    // 合成门店没有真实门牌号，不编造号码，标注"（模拟地址）"。
    address: `${city}${core}（模拟地址）`,
    ...synthCoord(`${city}|${district}|${type}`),
    // 合成店提供全部车型：车主问哪款都能预约。
    models: MODELS.map((m) => m.model),
  };
}

/**
 * 城市/区名的合法性。
 *
 * 用于拦住上游的解析噪音：上游从原话里截地名，截歪时会传来「有没有」「的试驾」，
 * 而合成来者不拒，会产生「深圳有没有体验店」。此时返回零命中，让上游追问。
 */
const PLACE_RE = /^[一-龥]{2,6}$/;
const NOT_PLACE = /[的了吗呢啊吧哈嘛有没这那哪要想帮我你他是和跟就能可试驾店门车约看找]/;

export function isPlausiblePlace(name: string): boolean {
  return PLACE_RE.test(name) && !NOT_PLACE.test(name);
}

export function findStore(storeId: string): Store | undefined {
  const seeded = STORES.find((s) => s.storeId === storeId);
  if (seeded) return seeded;

  // 合成 id 就地还原，不查注册表：重启后已发出的 id 仍然有效。
  const m = new RegExp(`^${SYNTH_PREFIX}-([0-9a-f]+)-(exp|svc)$`).exec(storeId);
  if (!m) return undefined;
  const place = decodePlace(m[1]);
  if (!place) return undefined;
  return synthesizeStore(place.city, place.district, m[2] === "svc" ? "service" : "experience");
}

export function findModel(model: string): ModelDef | undefined {
  // 大小写与空格不敏感（"model y" / "ModelY" 都算）：车型名来自人工输入。
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  return MODELS.find((m) => norm(m.model) === norm(model));
}

/** 两点球面距离（km）。只用于排序，精度够。 */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10;
}

export interface StoreQuery {
  model: string;
  city?: string;
  district?: string;
  near?: { lat: number; lon: number };
  type?: StoreType;
}

/**
 * 按车型 + 地点找店。
 *
 * 零命中返回空数组，不是错误。零命中只发生在三种情况：
 * 车型不认识、没给城市、给的"城市"不像地名（见 `isPlausiblePlace`）。
 * 城市合法时至少有一家店，种子里没有就现合成。
 *
 * `city` / `district` 对种子用包含匹配：用户会说"南山"而不是"南山区"。
 */
export function searchStores(q: StoreQuery): Array<Store & { distanceKm?: number }> {
  const type = q.type ?? "experience";
  const modelDef = findModel(q.model);
  const canonical = modelDef?.model;
  // 车型不认识时不合成：合成一家"提供 Model Q 试驾"的店，等于确认了一款不存在的车。
  if (!canonical) return [];

  const pool = STORES.filter((s) => s.type === type && s.models.includes(canonical));
  const byCity = q.city
    ? pool.filter((s) => s.city.includes(q.city!) || q.city!.includes(s.city))
    : pool;
  const seeded = q.district
    ? byCity.filter((s) => s.district.includes(q.district!) || q.district!.includes(s.district))
    : byCity;

  /*
   * 四段，顺序即优先级：
   *
   *  ① 种子命中 → 用种子。深圳南山始终是种子店。
   *  ② 种子没命中但区名合法 → 合成这个区的店（「深圳龙华」「北京朝阳」）。
   *  ③ 区名不像地名（上游截歪了）→ 退回城市级的种子，不合成；
   *     否则「深圳有没有啊」会得到一家「深圳体验店（模拟地址）」，而深圳有种子店。
   *  ④ 城市也没有种子 → 合成城市级的一家。
   */
  let rows = seeded;
  if (rows.length === 0 && q.city && isPlausiblePlace(q.city)) {
    if (q.district && isPlausiblePlace(q.district)) rows = [synthesizeStore(q.city, q.district, type)];
    else if (byCity.length > 0) rows = byCity;
    else rows = [synthesizeStore(q.city, "", type)];
  }

  if (q.near) {
    const near = q.near;
    return rows
      .map((s) => ({ ...s, distanceKm: distanceKm(near, s) }))
      .sort((a, b) => a.distanceKm - b.distanceKm);
  }
  return rows;
}
