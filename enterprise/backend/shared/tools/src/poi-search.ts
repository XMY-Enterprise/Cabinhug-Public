/**
 * `poi_search` —— 城市内 POI 文本搜索：酒店与景点。
 *
 * # 为它服务的问题
 *
 * 「广州 4 天带娃，住哪、玩哪」这类问题需要住宿与游玩地点的数据源，
 * 路线/补能/天气工具覆盖不到。本工具走高德 place/text，名称/位置/评分是真实数据。
 *
 * # 结构性没有价格字段
 *
 * 高德开放平台的 `business.cost` 在酒店类目恒空，房价不走开放平台。
 * 所以出参不存在价格字段：与 `refuel.fuelLevelUnknown` 同一手法，模型没有地方把房价编进来。
 * 估价是表述层的事（按档次给区间并标注"估算"），不是本工具的事。
 *
 * # city_limit 恒为 true
 *
 * 不限市时搜「广州 酒店」会排出周边区县的公寓旅店。这里固定为 true，不做成参数，
 * 避免某个分支关掉它后推荐出隔壁市的酒店。
 */

import { classifyAmapPoi, type PoiKind } from "@cabinhug/shared";
import { getAmapClient, type AmapTextPoi } from "./amap";
import { defineExternalTool, ToolError, type ExternalTool } from "./external";

/**
 * 高德 POI 类目码。用类目不用关键字，关键字会混进房产中介。
 *
 * parking / charging_station / gas_station 服务景区到达面的"停哪儿/哪充电/哪加油"，
 * 实测 `150900` 召回真实车场（含索道停车场），`011100` 召回真实充电站。
 */
const TYPES_BY_CATEGORY = {
  hotel: "100000",
  /*
   * 风景名胜(110000) + 科教文化服务(140000)。
   * 博物馆等室内馆多归在 140000，只给 110000 时只能召回名字带"博物馆"、恰好被归成景区的点，
   * 雨天备选会挑错馆。加上 140000 后纯景区查询的结果不变。
   */
  attraction: "110000|140000",
  parking: "150900",
  charging_station: "011100",
  gas_station: "010100",
} as const;

/** 纯类目搜索在部分城市返回稀疏，keywords 缺省时按类目补中文词（见 real()）。 */
const DEFAULT_KEYWORDS: Record<PoiCategory, string> = {
  hotel: "酒店",
  attraction: "景点",
  parking: "停车场",
  charging_station: "充电站",
  gas_station: "加油站",
};

export type PoiCategory = keyof typeof TYPES_BY_CATEGORY;

export interface PoiSearchArgs {
  /** 目标城市（中文名，如「广州」）。 */
  city: string;
  /** 追加关键词（如「亲子」「珠江新城」）；缺省只按类目搜。 */
  keywords?: string;
  /** 类别。钉死类别的实例（spot_search / hotel_search）入参里没有它，由工厂选项决定。 */
  category?: PoiCategory;
  /** 返回条数上限，默认 8。 */
  limit?: number;
}

export interface PoiCandidate {
  id: string;
  name: string;
  address: string;
  lat: number;
  lon: number;
  /** 高德评分（真实数据）；没有就是 undefined，不猜。 */
  rating?: string;
  /**
   * 所在区县（高德 `adname`）。Plan 层用它给每天起片区名（簇内成员的众数）。
   * 没有就缺省，不按地址猜。
   */
  district?: string;
}

export interface PoiSearchResult {
  city: string;
  category: PoiCategory;
  candidates: PoiCandidate[];
  /** 恒定声明：本工具没有价格数据。表述层引用酒店时必须自带"估算"标注。 */
  priceNotice: string;
}

export const PRICE_NOTICE =
  "本结果不含任何价格数据（高德开放平台不提供房价/票价）。" +
  "向用户提及花费时只能给经验估算区间，并明确说明是估算、以实际平台为准。";

export interface PoiSearchBackend {
  textSearch(
    params: { keywords: string; region: string; types: string; limit: number },
    signal?: AbortSignal,
  ): Promise<AmapTextPoi[]>;
}

function createAmapPoiBackend(): PoiSearchBackend {
  return {
    textSearch(params, signal) {
      const amap = getAmapClient();
      if (!amap) throw new ToolError("poi_search", "unconfigured", "高德未接入（缺 AMAP_SERVER_KEY）", false);
      // city_limit 写死 true：见文件头。
      return amap.textSearch({ ...params, cityLimit: true }, signal);
    },
  };
}

/** Mock 三态的固定数据；每条名字都带「（模拟）」，防止被当真实推荐转述。 */
const MOCK_CANDIDATES: Record<PoiCategory, PoiCandidate[]> = {
  hotel: [
    { id: "mock-h1", name: "白天鹅宾馆（模拟）", address: "沙面南街1号", lat: 23.107, lon: 113.243, rating: "4.7", district: "荔湾区" },
    { id: "mock-h2", name: "广州花园酒店（模拟）", address: "环市东路368号", lat: 23.137, lon: 113.294, rating: "4.6", district: "越秀区" },
  ],
  attraction: [
    { id: "mock-a1", name: "广州塔（模拟）", address: "阅江西路222号", lat: 23.106, lon: 113.324, rating: "4.8", district: "海珠区" },
    { id: "mock-a2", name: "长隆野生动物世界（模拟）", address: "番禺区汉溪大道东", lat: 22.997, lon: 113.327, rating: "4.9", district: "番禺区" },
  ],
  parking: [
    { id: "mock-p1", name: "景区南门停车场（模拟）", address: "景区南入口旁", lat: 23.1, lon: 113.3 },
    { id: "mock-p2", name: "游客中心地面停车场（模拟）", address: "游客中心西侧", lat: 23.102, lon: 113.298 },
  ],
  charging_station: [
    { id: "mock-c1", name: "国网充电站(景区游客中心站)（模拟）", address: "游客中心停车场内", lat: 23.101, lon: 113.299 },
  ],
  gas_station: [
    { id: "mock-g1", name: "中石化景区路加油站（模拟）", address: "景区路与环山路交叉口", lat: 23.09, lon: 113.29 },
  ],
};

/**
 * 「这一轮查到过哪些点的坐标」的登记簿。
 *
 * # 用途
 *
 * 编排层判「hotel 的候选覆没覆盖第 N 天去的片区」时按坐标比距离，
 * 不比两个分支各自写的中文片区标签：同一片地方的标签写法不同，字符串对不上会触发无效追跳。
 *
 * 两个分支的名字都是从 `poi_search` 的返回里逐字取的（各自 prompt 的硬要求），
 * 返回里带着 lat/lon，但提交 schema 装不下。所以在结果离开工具时把 name → 坐标记下来，
 * 编排层判距离时直接查，零网络、零延迟。
 *
 * # 不在判定时重查
 *
 * `resolveTripPlanCoords` 每个点约 350ms（高德免费 key QPS=3），十个点约 4 秒，而追跳判定在关键路径上；
 * 跨城行程还要先猜城市限定，统一传一个城市会把另一城的点查偏。
 * 登记的坐标是各分支用它自己的城市查出来的，没有这个问题。
 *
 * # 边界
 *
 * 只记真实后端的返回（mock 的坐标是固定假值，记了会让离线档下的距离判定失真）。
 * 未注入时什么都不做：这是可选的旁路，主链路不依赖它。
 */
export interface PoiCoordSink {
  record(
    ctx: { sessionId: string; turnId?: string },
    hits: ReadonlyArray<{
      name: string;
      lat: number;
      lon: number;
      /** 命中 POI 自述的城市，是 `trustCoordHit` 的验证材料，复用坐标时用它再验一道。 */
      cityName?: string;
      /** 贴纸品类。带上它，确认轮才不用为了补品类把这个点重搜一遍。 */
      poiKind?: PoiKind;
    }>,
  ): void;
}

let poiCoordSink: PoiCoordSink | undefined;

/** 装配层注入（与 `setBranchSubmissionSink` 同一形态）。传 undefined 表示不记。 */
export function setPoiCoordSink(s: PoiCoordSink | undefined): void {
  poiCoordSink = s;
}

/**
 * 同一套搜索后端出三个工具：
 *
 * | 工具 | 类别 | 给谁 |
 * |---|---|---|
 * | `poi_search` | 入参选 | guide-access（停车/充电/加油/景点都要）、supervisor |
 * | `spot_search` | 钉死 attraction | tour、guide-spots |
 * | `hotel_search` | 钉死 hotel | hotel |
 *
 * 拆成三个工具而不是在工具里按 agent 加闸：闸是"调了再拒"，还要付一次往返；
 * 拆开是"根本调不到"，谁能搜什么只由 ACL 决定，约束落在代码里而不是提示词里。
 * 否则 tour 分支可能把自己搜到的酒店当景点写进行程，与 hotel 分支的选择冲突。
 *
 * 三个实例走同一条 real()，坐标登记（PoiCoordSink）自动生效。
 */
export interface PoiSearchToolOptions {
  name?: string;
  /** 钉死类别：入参里的 category 被忽略，schema 侧也不会把它暴露给模型。 */
  fixedCategory?: PoiCategory;
}

export function createPoiSearchTool(
  backend: PoiSearchBackend,
  options: PoiSearchToolOptions = {},
): ExternalTool<PoiSearchArgs, PoiSearchResult> {
  const categoryOf = (args: PoiSearchArgs): PoiCategory => {
    const c = options.fixedCategory ?? args.category;
    if (!c) throw new ToolError(options.name ?? "poi_search", "invalid", "category 不能为空", false);
    return c;
  };
  return defineExternalTool<PoiSearchArgs, PoiSearchResult>({
    name: options.name ?? "poi_search",
    provider: "amap",
    // 只读查询 → §8.4 第三行自动放行，不经权限门。
    sensitive: false,
    timeoutMs: 8_000,
    retries: 2,

    real: async (args, ctx) => {
      const category = categoryOf(args);
      if (!args.city.trim()) {
        throw new ToolError(options.name ?? "poi_search", "invalid", "city 不能为空", false);
      }
      /*
       * region 原样透传，城市限定失效的纠偏在客户端（见 amap.ts 的 textSearch）。
       * 放在那一层是因为给行程点配坐标的 `resolveTripPlanCoords` 也走同一个方法。
       */
      const pois = await backend.textSearch(
        {
          // keywords 至少给类目中文，纯 types 搜索在部分城市返回稀疏。
          keywords: args.keywords?.trim() || DEFAULT_KEYWORDS[category],
          region: args.city,
          types: TYPES_BY_CATEGORY[category],
          limit: Math.min(args.limit ?? 20, 20),
        },
        ctx.signal,
      );

      // 登记坐标（见 PoiCoordSink）：只在真实后端这一条路上记，失败不影响查询结果。
      try {
        poiCoordSink?.record(
          ctx,
          // 城市与品类在这一次调用里已经拿到，记下不耗额外配额；
          // 不记的话确认轮为了补品类要把每个点重搜一遍（12 个点约 4.3 秒）。
          pois.map((p) => ({
            name: p.name,
            lat: p.lat,
            lon: p.lon,
            cityName: p.cityName,
            poiKind: classifyAmapPoi(p),
          })),
        );
      } catch {
        /* 旁路记账，失败不影响正常的搜索 */
      }

      return {
        city: args.city,
        category,
        candidates: pois.map((p) => ({
          id: p.id,
          name: p.name,
          address: p.address,
          lat: p.lat,
          lon: p.lon,
          ...(p.rating ? { rating: p.rating } : {}),
          ...(p.district ? { district: p.district } : {}),
        })),
        priceNotice: PRICE_NOTICE,
      };
    },

    mock: (args) => {
      const category = categoryOf(args);
      return { city: args.city, category, candidates: MOCK_CANDIDATES[category], priceNotice: PRICE_NOTICE };
    },
  });
}

export const poiSearchTool = createPoiSearchTool(createAmapPoiBackend());
export const spotSearchTool = createPoiSearchTool(createAmapPoiBackend(), { name: "spot_search", fixedCategory: "attraction" });
export const hotelSearchTool = createPoiSearchTool(createAmapPoiBackend(), { name: "hotel_search", fixedCategory: "hotel" });
