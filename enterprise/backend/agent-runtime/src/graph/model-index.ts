/**
 * 车型索引：子图之外的共享事实表。
 *
 * # 不放在子图里
 *
 * 购车与试驾都要用它，而 `check:arch` 的 crosstalk 规则禁止子图互相 import
 * （§11：子 Agent 协作永远经过编排层）。放在这里两边都能引，且只维护一份，
 * 语料加了新车型时两条路同时认得。
 */

/**
 * 车型索引。
 *
 * # 用途
 *
 * `car_catalog` 返回的 chunk 只有原文与文档名。把哪条挂到哪款车上，
 * 需要知道当前语料里有哪几款车，这个知识属于子图，不属于工具。
 *
 * # `energy` / `bodyType` 写在索引里，不从原文抽
 *
 * 它们是这几款车稳定不变的分类事实（Model 3 不会变成插混）；从 chunk 里抽会被
 * "Model Y 手册里提了一句燃油车对比"这类内容误导，导致按能源类型淘汰错车。
 * 语料增加新车型时这张表要同步扩；不在表里的车型不进候选，而不是被猜测。
 */
/**
 * 一个配置（trim）。
 *
 * # 这里没有价格、续航、座位
 *
 * 那三样跟着 `dealer_pricing` 走（结构化、随语料更新，是价格的权威源）。
 * 在这里再存一份会漂移，导致顾问报价与门店报价不一致。
 *
 * 本表只回答命名问题：这个语料里有哪几个配置、用户嘴里那个词指的是哪一个。
 */
export interface TrimEntry {
  /** 规范配置名，与 `mocks/dealer/data/models.json` 的 `trim` 逐字一致。 */
  trim: string;
  /** 用户与文档里可能的写法。归一时取匹配到的最长别名，见 `resolveTrim`。 */
  aliases: string[];
}

interface ModelEntry {
  model: string;
  aliases: string[];
  docPatterns: RegExp[];
  energy: "bev" | "phev" | "icev";
  bodyType: "suv" | "sedan" | "pickup";
  /** 指导价所用币种。非 CNY 时不参与预算淘汰，不换算汇率。 */
  priceCurrency: "CNY" | "USD";
  /**
   * 该车型在当前语料里的配置。
   *
   * 空数组表示"这款车没有配置级的资料"，它不进配置比较，而不是被猜一个出来。
   * 迈锐宝属于这种情况（报价系统的种子里没有它）。
   */
  trims: readonly TrimEntry[];
}

export const KNOWN_MODELS: readonly ModelEntry[] = [
  {
    model: "Model 3",
    aliases: ["Model 3", "Model3", "model 3", "特斯拉 Model 3"],
    docPatterns: [/model_?3/i, /tesla_m3/i],
    energy: "bev",
    bodyType: "sedan",
    priceCurrency: "CNY",
    trims: [
      { trim: "后轮驱动版", aliases: ["后轮驱动版", "后驱版", "后驱", "标准版", "RWD"] },
      {
        trim: "长续航后轮驱动版",
        aliases: ["长续航后轮驱动版", "长续航后驱版", "长续航后驱", "Long Range RWD"],
      },
      {
        trim: "长续航全轮驱动版",
        aliases: [
          "长续航全轮驱动版",
          "长续航全驱版",
          "长续航全驱",
          "长续航四驱",
          "Long Range AWD",
        ],
      },
    ],
  },
  {
    model: "Model Y",
    aliases: ["Model Y", "ModelY", "model y", "特斯拉 Model Y"],
    docPatterns: [/model_?y/i, /tesla_my/i],
    energy: "bev",
    bodyType: "suv",
    priceCurrency: "CNY",
    trims: [
      { trim: "后轮驱动版", aliases: ["后轮驱动版", "后驱版", "后驱", "标准版", "RWD"] },
      {
        trim: "长续航后轮驱动版",
        aliases: ["长续航后轮驱动版", "长续航后驱版", "长续航后驱", "Long Range RWD"],
      },
      {
        trim: "长续航全轮驱动版",
        aliases: [
          "长续航全轮驱动版",
          "长续航全驱版",
          "长续航全驱",
          "长续航四驱",
          "Long Range AWD",
        ],
      },
      // 「六座」是这一个配置的属性，不是 Model Y 的属性（F-47-07）。
      // 放进别名，让"Model Y 六座多少钱"落到具体配置上，报的是这个配置的价格。
      { trim: "Model Y L", aliases: ["Model Y L", "ModelY L", "六座版", "六座"] },
    ],
  },
  {
    model: "Cybertruck",
    aliases: ["Cybertruck", "赛博皮卡"],
    docPatterns: [/cybertruck/i, /tesla_ct/i],
    energy: "bev",
    bodyType: "pickup",
    // 选配表是美元价，不换算：汇率一变换算值就错，却仍带着正确的出处。
    priceCurrency: "USD",
    trims: [
      { trim: "全轮驱动版", aliases: ["全轮驱动版", "全驱版", "全驱", "AWD"] },
      { trim: "Cyberbeast", aliases: ["Cyberbeast", "赛博兽", "野兽版"] },
    ],
  },
  {
    model: "迈锐宝",
    aliases: ["迈锐宝", "Malibu"],
    docPatterns: [/迈锐宝/, /malibu/i],
    energy: "icev",
    bodyType: "sedan",
    priceCurrency: "CNY",
    // 报价系统的种子里没有迈锐宝，它没有配置级资料。
    // 空数组让它不进配置比较，不编造配置。
    trims: [],
  },
];

export function entryOf(model: string): ModelEntry | undefined {
  return KNOWN_MODELS.find((m) => m.model === model);
}

/** 该车型在当前语料里的配置。车型不认识、或它没有配置级资料，都返回空数组。 */
export function trimsOf(model: string): readonly TrimEntry[] {
  return entryOf(model)?.trims ?? [];
}

/**
 * 把一段文字里的配置说法归一到事实表里的配置名。
 *
 * # 取匹配到的最长别名，不是第一个命中的
 *
 * 「长续航后轮驱动版」里包含「后轮驱动版」，取第一个命中会依赖数组顺序，
 * 重排别名时会把长续航版的问题按标准版回答（价格差 2.4 万）且不报错。
 *
 * # 两个配置以同样长度命中就是归不了
 *
 * 归不了返回 `undefined`，不猜，与 `resolveModel` 的原文兜底"只有恰好命中一款才算"一致。
 * 猜错会拿 A 配置的参数回答 B 配置的问题，且带着正确的出处。
 */
export function resolveTrim(model: string, text: string): string | undefined {
  const haystack = text.toLowerCase();
  let best: { trim: string; length: number } | undefined;
  let ambiguous = false;

  for (const t of trimsOf(model)) {
    for (const alias of t.aliases) {
      if (!haystack.includes(alias.toLowerCase())) continue;
      if (best === undefined || alias.length > best.length) {
        best = { trim: t.trim, length: alias.length };
        ambiguous = false;
      } else if (alias.length === best.length && t.trim !== best.trim) {
        ambiguous = true;
      }
    }
  }

  return ambiguous ? undefined : best?.trim;
}

/**
 * 整车价的最低位数门槛。
 *
 * 取 5 万：选配表里"高级车载娱乐服务 1 年包 118"这种三位数不是车价，
 * 而在售新车不会低于它。它只是第一道筛，拦住 FSD 选装包的是
 * `isVehicleRow` 的第二条判据与 `vehiclePriceFloor` 的第三条。
 */
export const MIN_VEHICLE_PRICE_CNY = 50_000;

/**
 * 这一行是一台车，还是一个选装包。
 *
 * 选配表里 `$APF2 | 特斯拉辅助驾驶 | 64,000` 比整车便宜，"取最低价"会把 FSD 选装包
 * 当成车价，整份五年成本随之算错。
 *
 * 购车与配置比较都会把"名称 | 价格"的表格行成批摊开，判据只在这里维护一份，
 * 避免两份判据漂移后把选装包当成车。
 *
 * 判据：价格够大 + 配置名里必须出现车型名。
 */
export function isVehicleRow(model: string, rowName: string, amount: number): boolean {
  if (!Number.isFinite(amount) || amount < MIN_VEHICLE_PRICE_CNY) return false;
  const aliases = entryOf(model)?.aliases ?? [model];
  return aliases.some((a) => rowName.toLowerCase().includes(a.toLowerCase()));
}

/**
 * 整车价的下界：报价系统里该车型最低配的人民币价。
 *
 * 拿不到就没有下界（返回 `undefined`），不臆造：凭空的下界会把本该在列的行判成选装包。
 */
export function vehiclePriceFloor(
  pricedTrims: readonly { priceCny?: number }[] | undefined,
): number | undefined {
  const prices = (pricedTrims ?? [])
    .map((t) => t.priceCny)
    .filter((p): p is number => typeof p === "number" && Number.isFinite(p));
  return prices.length > 0 ? Math.min(...prices) : undefined;
}

/** 第三条判据的可断言形态：低于下界的"整车价"一定不是整车（有下界时才判）。 */
export function isBelowVehiclePriceFloor(amount: number, floor: number | undefined): boolean {
  return floor !== undefined && amount < floor;
}

/** 无人民币报价时对外说的那句话。措辞集中一处。 */
export const NO_CNY_PRICE_NOTE = "本系统无人民币报价";

/**
 * 这个车型有没有人民币指导价可用。
 *
 * 两种"没有"分开说，因为它们的下一步不同：
 *  - 币种就不是人民币（Cybertruck 的选配表是美元价）→ 不换算，这是设计；
 *  - 报价系统里这一款全部缺 `priceCny` → 是数据没有。
 *
 * `pricedTrims` 不传时只判币种——事实表本身不知道报价系统里有什么。
 */
export function cnyPriceAvailability(
  model: string,
  pricedTrims?: readonly { priceCny?: number }[],
): { available: boolean; note?: string } {
  const entry = entryOf(model);
  if (!entry) {
    return { available: false, note: `${NO_CNY_PRICE_NOTE}——「${model}」不在车型索引里` };
  }
  if (entry.priceCurrency !== "CNY") {
    return {
      available: false,
      note: `${NO_CNY_PRICE_NOTE}——该车型选配表是 ${entry.priceCurrency} 价，本仓不换算汇率`,
    };
  }
  if (pricedTrims !== undefined && vehiclePriceFloor(pricedTrims) === undefined) {
    return { available: false, note: `${NO_CNY_PRICE_NOTE}——报价系统里这一款没有人民币价` };
  }
  return { available: true };
}
