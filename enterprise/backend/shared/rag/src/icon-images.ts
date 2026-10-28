/**
 * 手册图标目录里那一条的定位：`车型串 + symbol_id` → 图片字节，与原文说明。
 *
 * 原文说明供观察卡显示「这盏灯是什么意思」，它与图片同在 `<目录名>-indicators.md` 里。
 * 两路放在同一模块，共用下面「车型串 → 目录名」的映射与同一份缓存。
 *
 * # 不按字符串猜目录名
 *
 * 车型串是 `"Tesla Model 3/Y"`，目录名是 `tesla-model3`。斜杠、空格、大小写、多车型合写之间
 * 没有通用规则。唯一可靠的桥是目录里那份
 * `<目录名>-indicators.md` 的 `vehicle:` 行：它声明这份目录写的是哪款车，`kb:icons` 建索引时
 * 用的也是同一条约定（`--images` 缺省值就是把 `-indicators.md` 去掉当目录名）。
 *
 * # 取不到必须安静
 *
 * 容器形态下 `data/` 不在镜像里。root 不存在、目录里没有 md、md 里没有 `vehicle:` 行、图片文件缺失，
 * 四种情况都返回 null。上层（`decideMatch`）收到 null 就跳过成对核验、结果标 `verified: false`，
 * 下游照旧说「疑似」。降级的方向是少说话，不是说错话，所以这里不抛异常、不打日志。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parseIconCatalog } from "./icon-catalog";

export interface IconImageResolverOptions {
  /** 图标根目录，形如 `<仓库>/data/kb-src/icons`。 */
  root: string;
  /** 注入用（单测不落盘）。抛错等同于"读不到"。 */
  readFile?: (path: string) => Buffer;
  readDir?: (path: string) => string[];
}

export interface IconImageResolver {
  (vehicleModel: string, symbolId: string): Buffer | null;
  /** 解析到的「车型串 → 目录名」映射，启动日志用来说清这台机器上核验会不会发生。 */
  vehicles(): string[];
  /**
   * 恰好只有一款车时返回它，否则 null。
   *
   * 调用方拿不到车型串时（档案里没登记车型）用它兜底——这与召回侧「索引里只有一款车」是同一条前提。
   * 有多款车却不知道是哪款时必须返回 null：拿别的车的图去核验，模型会答 different，
   * 表现为有图却总对不上，比不核验更难排查。
   */
  soleVehicle(): string | null;
  /**
   * 目录里这一条的「原文说明」；没有这一条、或这台机器上没有 `data/` 时返回 null。
   *
   * `vehicleModel` 传 `undefined` 时退到 `soleVehicle()`——与 `decideMatch` 那边拿不到车型串时
   * 同一条前提。多款车却不知道是哪款时不猜：宁可少一行说明，也不把一款车的说明
   * 挂到别的车的灯上。
   */
  meaning(vehicleModel: string | undefined, symbolId: string): string | null;
}

const VEHICLE_LINE = /^\s*vehicle:\s*(.+?)\s*$/m;
const SAFE_ID = /^[a-z0-9_]+$/;

export function createIconImageResolver(opts: IconImageResolverOptions): IconImageResolver {
  const readFile = opts.readFile ?? ((p: string) => readFileSync(p));
  const readDir = opts.readDir ?? ((p: string) => readdirSync(p));

  /** 车型串 → 目录名；null 表示扫过了但什么都没有（这个结论同样缓存，不每次重扫）。 */
  let dirs: Map<string, string> | null = null;
  const images = new Map<string, Buffer | null>();

  function scan(): Map<string, string> {
    if (dirs) return dirs;
    const found = new Map<string, string>();
    let names: string[] = [];
    try {
      names = readDir(opts.root);
    } catch {
      dirs = found;
      return found;
    }
    for (const n of names) {
      if (!n.endsWith("-indicators.md")) continue;
      let md = "";
      try {
        md = readFile(join(opts.root, n)).toString("utf8");
      } catch {
        continue;
      }
      const m = VEHICLE_LINE.exec(md);
      if (!m) continue;
      found.set(m[1], n.slice(0, -"-indicators.md".length));
    }
    dirs = found;
    return found;
  }

  const resolver = ((vehicleModel: string, symbolId: string): Buffer | null => {
    if (!SAFE_ID.test(symbolId)) return null;
    const dir = scan().get(vehicleModel);
    if (!dir) return null;
    const key = `${dir}/${symbolId}`;
    const hit = images.get(key);
    if (hit !== undefined) return hit;
    let bytes: Buffer | null = null;
    try {
      bytes = readFile(join(opts.root, dir, `${symbolId}.png`));
    } catch {
      bytes = null;
    }
    images.set(key, bytes);
    return bytes;
  }) as IconImageResolver;

  resolver.vehicles = () => [...scan().keys()];
  resolver.soleVehicle = () => {
    const v = [...scan().keys()];
    return v.length === 1 ? v[0] : null;
  };

  /** 目录名 → `symbol_id` → 原文说明；解析过一次就缓存（解析失败也缓存成空表，不每次重试）。 */
  const meanings = new Map<string, Map<string, string>>();
  const meaningsOf = (dir: string): Map<string, string> => {
    const hit = meanings.get(dir);
    if (hit) return hit;
    const table = new Map<string, string>();
    try {
      const md = readFile(join(opts.root, `${dir}-indicators.md`)).toString("utf8");
      // 解析出的 `errors` 这里不管：图片那一路同样不管，目录的体检是 `kb:icons` 建索引时做的。
      for (const e of parseIconCatalog(md).entries) {
        // `deprecated` 的条目不进索引也不参与匹配，这里同样跳过：它的说明没有手册出处。
        if (e.descriptorSource === "deprecated") continue;
        if (e.description) table.set(e.symbolId, e.description);
      }
    } catch {
      // 读不到 / 解析不了都等同于"这台机器上没有说明"，与图片那一路一样安静降级。
    }
    meanings.set(dir, table);
    return table;
  };

  resolver.meaning = (vehicleModel, symbolId) => {
    if (!SAFE_ID.test(symbolId)) return null;
    const model = vehicleModel || resolver.soleVehicle();
    if (!model) return null;
    const dir = scan().get(model);
    return dir ? meaningsOf(dir).get(symbolId) ?? null : null;
  };
  return resolver;
}
