/**
 * 高德开放平台客户端（§5 工具表「地图 API」）。
 *
 * # 配置经注入，不在这里读取
 *
 * 与 `ragflow.ts` 同一条规矩：`enterprise/backend/shared/tools` 不读环境变量、不连数据库，
 * 它要能脱离 Agent 与 LLM 直接单测（AC-34-4）。key 由装配层
 * （`agent-runtime` 启动时）经 `setAmapClient` 注入；未注入即"未接入"。
 *
 * # 高德的失败不在 HTTP 状态码里
 *
 * 它一律返回 200，靠 `status:"0"` + `infocode` 表达失败。若按"200 即成功"处理，
 * 限流会被当成正常空结果，key 填错会被当成"这条路查不到"。因此本文件只有
 * `ok()` 一个出口，所有响应都必须过它，并按 infocode 分成可重试与不可重试两类：
 * 限流/QPS 类重试有意义，key 非法与参数错重试无效。
 *
 * # 两把 key 不能互换
 *
 * Web 服务（REST，本文件用的）与 Web 端（JS API，前端用的）是两种应用类型。
 * 拿错会得到 `10009 USERKEY_PLAT_NOMATCH`。
 */

import {
  amapFamilyOf,
  amapKeyFingerprint,
  beijingDay,
  createMemoryAmapLedger,
  parseAmapDailyBudget,
  sumByFamily,
  type AmapApiFamily,
  type AmapDailyBudget,
  type AmapOutcome,
  type AmapRetiredInfo,
  type AmapUsageLedger,
} from "./amap-ledger";
import { ToolError } from "./external";
import { recordWait } from "./wait-meter";

/** 经纬度。高德全程用 GCJ-02，不做坐标系转换：转换错误比不转换更难排查。 */
export interface LngLat {
  lat: number;
  lon: number;
}

export interface AmapPlace extends LngLat {
  name: string;
  adcode: string;
  city: string;
}

/**
 * 行政区（`/v3/config/district`）。`adcode` 是唯一没有歧义的 region 入参。
 *
 * 中文地名当 region 传给 place/text 时，高德只认它自己的行政区名，
 * 认不出来时不报错，忽略 `city_limit` 按全国搜（见 `textSearch` 的注释与
 * 内部文档）。adcode 要么是一个行政区，要么不是。
 */
export interface AmapRegion {
  adcode: string;
  /** 高德给的规范名，如「杭州市」。 */
  name: string;
  /** 只收这三级；街道/乡镇级不足以当限定范围（「西溪」是街道，不是「西溪湿地那一片」）。 */
  level: "province" | "city" | "district";
}

/**
 * 一个区县（`/v3/config/district` 的 `subdistrict=1` 子项）。
 * `center` 是高德给的区县中心，只用来排"离市中心多远"，不当作任何景点的坐标。
 */
export interface AmapDistrict extends LngLat {
  adcode: string;
  /** 规范名，如「余杭区」「淳安县」。 */
  name: string;
}

/** 逆地理结果，只取天气与展示要用的几项。 */
export interface AmapRegeo {
  adcode: string;
  city: string;
  district: string;
  formatted: string;
}

/** 高德预报的一天（`extensions=all` 的 `casts[]`）。 */
export interface AmapCast {
  date: string;
  dayWeather: string;
  nightWeather: string;
  dayTempC: number | null;
  nightTempC: number | null;
  dayWind: string;
  dayPower: string;
}

export interface AmapForecast {
  city: string;
  adcode: string;
  reportTime: string;
  casts: AmapCast[];
}

export interface AmapStep {
  instruction: string;
  /**
   * 导航的辅助动作（`show_fields` 含 `navi` 才有），如「到达途经地」「到达目的地」。
   *
   * 它是带途经点的规划里唯一的分段标记：高德把整条路的 steps
   * 拉平返回，`route` / `path` / `step` 三层都没有途经点边界字段，只有这里会在经过
   * 每个途经点的那一步写「到达途经地」。靠它切 steps，就能从一次请求里拿到逐段时长。
   */
  assistantAction?: string;
  /** 米 */
  distanceM: number;
  /** 秒 */
  durationS: number;
  /** 该段折线的点序列（`show_fields=polyline` 才有） */
  points: LngLat[];
  /**
   * 这一步里的路况分段（`show_fields=tmcs`）：高德按路段给「畅通 / 缓行 / 拥堵 / 严重拥堵 / 未知」，
   * 各段长度不等，所以判整条路的路况要按里程加权，不能数段数（`trip-leg.ts`）。
   * 没有这个字段的夹具 → 空数组，消费方按"没有路况"处理，不当成畅通。
   */
  tmcs: AmapTmc[];
}

export interface AmapTmc {
  /** 高德原文：畅通 / 缓行 / 拥堵 / 严重拥堵 / 未知。 */
  status: string;
  /** 米 */
  distanceM: number;
}

export interface AmapPath {
  distanceM: number;
  durationS: number;
  tollYuan: number;
  /** 收费路段里程（米，`cost.toll_distance`）。高速几乎都收费，用它的占比判「高速为主」还是「城市道路」。 */
  tollDistanceM: number;
  trafficLights: number;
  steps: AmapStep[];
}

export interface AmapPoi extends LngLat {
  id: string;
  name: string;
  type: string;
  typecode: string;
  address: string;
  cityName: string;
  /** 距检索中心的米数 */
  distanceM: number | null;
}

/**
 * 文本搜索 POI（v5/place/text，`show_fields=business`）。
 *
 * `rating` 是真实数据；没有价格字段：`business.cost` 在酒店类目恒空，
 * 不建这个字段，模型就没有地方把房价编进来。
 */
export interface AmapTextPoi extends AmapPoi {
  /** 高德评分（如 "4.7"）；接口没给就是 undefined，不猜。 */
  rating?: string;
  /** 省（`pname`），如「浙江省」。 */
  province: string;
  /** 区县（`adname`），如「西湖区」。 */
  district: string;
  /** 命中点所在区县的 adcode——`cityLimit` 的验证材料，见 textSearch。 */
  adcode: string;
}

/** 跨城公交方案里的一段火车（v3/direction/transit/integrated 的 railway 段）。 */
export interface AmapTrainLeg {
  /** 车次，如 "G1305(上海虹桥-广州南)"。 */
  no: string;
  /** 类别（G/D/K…），接口的 trip 字段。 */
  trip: string;
  /** 行车分钟数。 */
  durationMin: number;
  /** 各席别票价（元）。接口没给席别名，只给价——如实只存价。 */
  prices: number[];
}

/** 一条跨城方案：总时长 + 总票价 + 火车段序列（可能中转多段）。 */
export interface AmapTransit {
  durationMin: number;
  /** 整套方案票价（元），接口的 cost。 */
  costYuan: number | null;
  trains: AmapTrainLeg[];
}

export interface AmapClient {
  /**
   * 地名 → 行政区（`/v3/config/district`）。认不出来（或只到街道级）就是 undefined。
   *
   * 带进程内缓存：行政区划是静态数据，一次会话里同一个词不该反复问。
   */
  resolveRegion(name: string, signal?: AbortSignal): Promise<AmapRegion | undefined>;
  /**
   * 城市 → 它下面的区县（`/v3/config/district`，`subdistrict=1`；Plan 层按区县分次搜景点用）。
   *
   * 城市级搜「景点」只回市中心附近的 20 条（实测杭州 20 条全在上城 / 西湖 / 钱江新城），
   * 良渚、千岛湖等远郊景点不在其中，
   * 按区县分次搜才有地理分布。认不出这个名字（或它不是省 / 市级）
   * 返回空数组，不猜；带进程内缓存，同一个城市一次会话里只问一次。
   */
  listDistricts(name: string, signal?: AbortSignal): Promise<AmapDistrict[]>;
  /**
   * POI 文本搜索（v5/place/text）。
   *
   * `cityLimit` 恒传 true 的责任在调用方（poi_search 工具）：
   * 不限市时排序会偏到城市外围（如「广州 酒店」排到增城的公寓），结果不可用。
   */
  textSearch(
    params: { keywords: string; region: string; types?: string; cityLimit?: boolean; limit?: number },
    signal?: AbortSignal,
  ): Promise<AmapTextPoi[]>;
  /**
   * 跨城公交规划（v3/direction/transit/integrated），只保留含火车段的方案。
   *
   * 该接口的 segment 类型只有 bus/entrance/exit/railway/taxi/walking，不含航班
   * （实测沪→乌鲁木齐只回 41h 火车）。
   */
  transitIntegrated(
    params: { origin: LngLat; destination: LngLat; city: string; cityd: string; strategy?: number },
    signal?: AbortSignal,
  ): Promise<AmapTransit[]>;
  /** 地名 → 坐标（v3/geocode/geo）。取第一条，多义地名由调用方给 `city` 收敛。 */
  geocode(address: string, city?: string, signal?: AbortSignal): Promise<AmapPlace>;
  /** 坐标 → adcode（v3/geocode/regeo）。带进程内缓存，见 `regeoCacheKey`。 */
  regeo(at: LngLat, signal?: AbortSignal): Promise<AmapRegeo>;
  /** 城市预报（v3/weather，`extensions=all`）：今天起 4 天，再远没有。 */
  forecast(adcode: string, signal?: AbortSignal): Promise<AmapForecast>;
  /**
   * 驾车路径规划（v5/direction/driving）。
   *
   * `strategy` 是高德的算路策略码：`32` 默认推荐、`34` 高速优先、`35` 不走高速、`36` 少收费。
   * 不传 = 请求串里没有这个参数。取值的枚举与语义在 `map-route.ts` 的 `AMAP_STRATEGY`，
   * 这里只透传数字——客户端不该知道"省钱"是哪一档。
   */
  driving(
    params: {
      origin: LngLat;
      destination: LngLat;
      waypoints?: LngLat[];
      strategy?: number;
      /**
       * 多要一段导航字段（`show_fields` 加 `navi`），用来按「到达途经地」切分段时长。
       * 默认不要：其余调用方用不到它，请求串不变。
       */
      withNavi?: boolean;
    },
    signal?: AbortSignal,
  ): Promise<AmapPath>;
  /** 周边 POI（v5/place/around）。 */
  around(
    params: { at: LngLat; types: string; radiusM: number; limit?: number },
    signal?: AbortSignal,
  ): Promise<AmapPoi[]>;
}

/** 途经点边界的语义标记（高德导航字段）。整条路里唯一的分段依据，见 `splitLegMinutes`。 */
export const AMAP_WAYPOINT_MARK = "到达途经地";
/** 终点标记。最后一段以它收尾；缺了也按"走到末尾"处理。 */
export const AMAP_DESTINATION_MARK = "到达目的地";

/**
 * 把一次带途经点的驾车规划切成逐段时长（分钟）。
 *
 * # 分段依据
 *
 * `route` / `path` / `step` 三层都没有途经点边界字段
 * （`route` 只有 `origin/destination/taxi_cost/paths`，`paths` 是备选路线不是分段，
 * `steps` 是拉平的导航指令）。唯一的边界信号是 `navi.assistant_action` 在经过每个
 * 途经点的那一步写「到达途经地」。实测一趟三段的行程切出 480 / 288 / 636 秒，
 * 合计 1404 秒，等于整条路时长。
 *
 * # 对不上就整个不要
 *
 * 标记数 ≠ 途经点数时返回 `undefined`，调用方退回"一段一个请求"。
 * 半套分段会把剩余时长全算进最后一段，数值错误且无从察觉。
 *
 * @param expectedLegs 期望切出几段（点数 - 1）
 */
export function splitLegMinutes(
  steps: ReadonlyArray<{ durationS: number; assistantAction?: string }>,
  expectedLegs: number,
): number[] | undefined {
  if (expectedLegs < 1 || steps.length === 0) return undefined;
  const legs: number[] = [];
  let acc = 0;
  for (const s of steps) {
    acc += s.durationS;
    if (s.assistantAction === AMAP_WAYPOINT_MARK || s.assistantAction === AMAP_DESTINATION_MARK) {
      legs.push(acc);
      acc = 0;
    }
  }
  // 末尾还有余量（没有「到达目的地」标记）时补成最后一段。
  if (acc > 0) legs.push(acc);
  if (legs.length !== expectedLegs) return undefined;
  return legs.map((s) => Math.round(s / 60));
}

const BASE = "https://restapi.amap.com";

/**
 * 同一把 key 的发车闸门（令牌桶）。
 *
 * 限速必须在客户端里而不在调用点：坐标回填、逐日车程与 `map-route` 并发找服务区
 * 互相不知道对方此刻在不在发，同一秒叠起来就超限，被拒的请求随机、难以复现。
 * 闸门装在唯一的出口 `get()` 上，所有调用都排队，调用点不必各自限速。
 *
 * 闸门按发车时刻计时，请求在途的时间叠进间隔里，不串行支付"先等待再等响应"两段时间。
 *
 * ## 两个参数均为实测标定
 *
 * 一、发车间隔（真 key，12 个点串行）：
 *
 * | 打法 | 墙钟 | 实测 QPS | 报限 |
 * |---|---|---|---|
 * | 串行等待（睡 350ms 再等响应） | 6664ms | 1.80 | 0 |
 * | 定速发车 350ms（不等上一个回来） | 4226ms | 2.84 | 0 |
 * | 定速发车 250ms | 3026ms | 3.97 | **2** |
 *
 * 二、桶容量——用确认路径的真实工作负载（南通 3 天 / 12 个点 / 17 次请求）
 * 逐个测得，每轮之间闲 12 秒：
 *
 * | 桶容量 | 全程 | 报限 |
 * |---|---|---|
 * | 1 | 5762ms | 0 |
 * | **2** | **5388ms** | **0** ← 取这个，重复三轮 4345/4355/4349ms 全 0 |
 * | 3 | 5966ms | 2（第 1052ms、2644ms 各一次 10021） |
 * | 4 | 5380ms | 2 |
 * | 6 | 4742ms | 2（第 577ms 就被拒） |
 *
 * 容量给大反而更慢：3 起开始报限，而报限要退避 1 秒再重试，损失的时间多于抢到的。
 *
 * 容量留 2 而不是 1，是给 `map-route` 那种「两个端点一把地理编码」留一发，
 * 它本来是并发且安全的，没必要压成纯定速。
 *
 * ## 作用范围
 *
 * 这是进程内的闸门。agent-runtime 与 worker 各建一个客户端、各有一个桶，
 * 而配额是同一把 key 的。worker 的行程复核跑在 cron 上、量很小，所以这里不引入
 * 跨进程协调——要协调就得把令牌放进 Redis，那是另一个决策。
 */
const AMAP_MIN_GAP_MS = 350;
const AMAP_BURST = 2;
/**
 * 排队封顶。取 6 秒是因为打高德那几个工具的预算是 8 秒
 * （`spot_search`/`hotel_search`/`poi_search`/`map_route` 的 `timeoutMs`）——
 * 留 2 秒给请求本身和上层善后，好过等到预算耗尽抛一句笼统的「超时」。
 */
const AMAP_MAX_QUEUE_MS = 6_000;

/**
 * key 池最多几把。`AMAP_SERVER_KEY`、`AMAP_SERVER_KEY_2` … `AMAP_SERVER_KEY_10`。
 *
 * 上限是给配置注册表与 `.env.example` 的：两处都要逐条声明（`guardValues.get` 只认注册表里的键，
 * `check:env-example` 要求每条都在模板里），所以需要上限。10 把 = 10 个高德账号；
 * 需要更多时只改这一个数，注册表与模板由同一个清单生成。
 */
export const AMAP_KEY_MAX = 10;

/**
 * 高德 key 的环境变量名，按账号一个，顺序即车道顺序。
 *
 * agent-runtime 装配、worker 装配与 probe 都从这里取，读法统一为 `resolveAmapKeys`。
 * 某个进程漏配一把 key 不报错，只表现为该进程少一条车道、比别的服务慢。
 *
 * 由 `AMAP_KEY_MAX` 生成，注册表（`amapServerKeyDefs`）与 `.env.example` 都按它来。
 */
export const AMAP_KEY_ENV_NAMES: readonly string[] = Array.from({ length: AMAP_KEY_MAX }, (_, i) =>
  i === 0 ? "AMAP_SERVER_KEY" : `AMAP_SERVER_KEY_${i + 1}`,
);

/** 一把已配置的 key：来自哪个变量、值、指纹（台账与日志只用指纹）。 */
export interface AmapKeySource {
  name: string;
  key: string;
  fp: string;
}

/**
 * 从任意取值函数里把 key 池读出来——agent-runtime 传 `guardValues.get`、worker 传 `process.env`、probe 传 `.env` 的读法。
 *
 * - 按清单顺序取非空值，空位允许跳过（去掉 `_2` 不必把 `_3` 挪上来）；
 * - 按值去重：同一把 key 配两次会让预算与 QPS 都被算成两倍，只留第一个，warn 点名两个变量名。
 */
export function resolveAmapKeys(
  get: (name: string) => string | undefined,
  warn: (msg: string) => void = (m) => console.warn(m),
): AmapKeySource[] {
  const out: AmapKeySource[] = [];
  const seen = new Map<string, string>();
  for (const name of AMAP_KEY_ENV_NAMES) {
    const key = get(name)?.trim();
    if (!key) continue;
    const dup = seen.get(key);
    if (dup) {
      warn(`[amap] ${name} 与 ${dup} 是同一把 key——只按一条车道算，重复的那条忽略`);
      continue;
    }
    seen.set(key, name);
    out.push({ name, key, fp: amapKeyFingerprint(key) });
  }
  return out;
}

/** 本地闸门自己判的「排不过来」，与高德回的限流码区分开。 */
export const AMAP_LOCAL_QUEUE_CODE = "local_queue";

/**
 * 挑车道时的偏好：预算路由。
 *
 * `eligible` 划出"还在软顶内"的车道，`rank` 在其中排"用量占比"——越低越先。
 * 候选为空（所有 key 都到软顶）时闸门退回全部活车道并调 `onFallback`：预算是路由偏好，
 * 不是拒绝服务，计数偏差不应造成故障；10044 仍是最后一道。
 */
export interface AmapLanePreference {
  eligible(lane: number): boolean;
  rank(lane: number): number;
  onFallback?(): void;
}

interface AmapRateGate {
  /**
   * 取一张发车票，返回用第几把 key 发。拿到才准发。
   * 排队超过 `maxQueueMs` 会抛 `AMAP_LOCAL_QUEUE_CODE`，快速失败而不是等到工具超时。
   * 所有车道都退役了会抛 `AMAP_ALL_LANES_RETIRED_CODE`（不可重试）。
   * 带 `prefer` 时在偏好里挑（见 `AmapLanePreference`）；不带时挑令牌最多的。
   */
  take(signal?: AbortSignal, prefer?: AmapLanePreference): Promise<number>;
  /**
   * 让一条车道退役（这把 key 今天的日调用量用尽了）。返回还有没有活着的车道。
   *
   * 日配额按 key 算、当天不会恢复，继续向它发请求只会失败。
   * `at` 是退役时刻（缺省当前）；已退役的车道再次 `retire` 是探活又撞了 10044——保留原退役时刻，
   * 只把下一次探活往后推一个周期。退役本身进程内，持久化与跨进程同步由客户端经台账做。
   */
  retire(lane: number, at?: number): boolean;
  /** 一条退役车道再次可用（探活成功，或台账里别的进程已把它复活）。 */
  revive(lane: number): void;
  /** 退役中的车道返回退役时刻；活车道返回 undefined。 */
  retiredSince(lane: number): number | undefined;
}

/**
 * 退役车道多久放一发探活。高德日配额的重置点不是 00:00，也没有余量查询，
 * 只能发请求探测是否恢复；一小时一发，一天最多 24 次无效请求。
 */
export const AMAP_REVIVE_PROBE_MS = 3_600_000;

/** 所有账号的日调用量都用尽——本地判的，与高德回的 10003 / 10044 区分开。 */
export const AMAP_ALL_LANES_RETIRED_CODE = "all_lanes_retired";

/**
 * 发车闸门。每把 key 一条车道，各有各的桶。
 *
 * 按 key 分桶：限流码 `10021` 的定义是「账号使用某个服务接口 QPS 超出限制」
 * （10029/10020 才是按 Key 的）。同账号下再加 key 无用，另一个账号的 key 是另一份额度，
 * 两条车道各限各的。合起来的持续速率是 `车道数 / minGapMs`。
 *
 * 排队仍是一条 FIFO：先到先得，只是到了队头之后挑当下最空的那条车道。
 * 各车道各排各的队会让先到的请求等在满车道上，而旁边的车道空着。
 */
export function createAmapRateGate(
  lanes: number,
  minGapMs: number,
  burst: number,
  opts: {
    /** 排队封顶。超过就抛错，不再等。<=0 表示不封顶。 */
    maxQueueMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    /** 退役车道的探活间隔，缺省 `AMAP_REVIVE_PROBE_MS`；<=0 表示永不探活（退役到进程结束）。 */
    reviveProbeMs?: number;
  } = {},
): AmapRateGate {
  const now = opts.now ?? (() => Date.now());
  const reviveProbeMs = opts.reviveProbeMs ?? AMAP_REVIVE_PROBE_MS;
  /**
   * 退役的车道（日配额用尽）→ 退役时刻与上一次探活时刻。两条分支共用：不设闸时也得能换 key。
   * 探活不是额外请求：到点了就让这条车道当一次候选，被挑中的是一个本来就要发的请求。
   */
  const retired = new Map<number, { at: number; lastProbeAt: number }>();
  function retire(lane: number, at: number = now()): boolean {
    if (lane >= 0 && lane < lanes) {
      const cur = retired.get(lane);
      if (cur) cur.lastProbeAt = at;
      else retired.set(lane, { at, lastProbeAt: at });
    }
    return retired.size < Math.max(1, lanes);
  }
  function revive(lane: number): void {
    retired.delete(lane);
  }
  function retiredSince(lane: number): number | undefined {
    return retired.get(lane)?.at;
  }
  /** 取到票的车道若是退役中的，这一发就是它这一轮的探活——下一轮再等一个周期。 */
  function chosen(lane: number, t: number): number {
    const r = retired.get(lane);
    if (r) r.lastProbeAt = t;
    return lane;
  }
  function allRetired(): never {
    throw new ToolError(
      "amap",
      "upstream",
      `${lanes} 个高德账号今日调用量都已用尽——今天不会恢复，别再重试`,
      false,
      AMAP_ALL_LANES_RETIRED_CODE,
    );
  }
  /**
   * 活车道里按偏好收窄候选。没有偏好 → 全部活车道；有偏好但一条都不合格 → 退回全部活车道并通报。
   * 两条分支（设闸 / 不设闸）共用，挑法只能有一份。
   *
   * 到了探活时刻的退役车道优先：它只有这一发机会（取票即推后一个周期），若与活车道
   * 同等比较令牌与预算占比，用光配额的 key 永远排在最后、无法被探活。
   */
  function candidates(prefer: AmapLanePreference | undefined, t: number): number[] {
    const alive: number[] = [];
    const probes: number[] = [];
    for (let i = 0; i < Math.max(1, lanes); i += 1) {
      const r = retired.get(i);
      if (!r) alive.push(i);
      else if (reviveProbeMs > 0 && t - r.lastProbeAt >= reviveProbeMs) probes.push(i);
    }
    if (probes.length > 0) return probes;
    if (!prefer || alive.length === 0) return alive;
    const preferred = alive.filter((l) => prefer.eligible(l));
    if (preferred.length > 0) return preferred;
    prefer.onFallback?.();
    return alive;
  }
  /** 有偏好时 rank 低者先、同 rank 令牌多者先；无偏好时只看令牌。 */
  function better(a: number, b: number, prefer: AmapLanePreference | undefined, tokens: readonly number[]): boolean {
    if (prefer) {
      const ra = prefer.rank(a);
      const rb = prefer.rank(b);
      if (ra !== rb) return ra < rb;
    }
    return tokens[a]! > tokens[b]!;
  }

  // minGapMs<=0 表示不设闸（单测：注入了 fetch 的客户端不打真网络）。
  if (minGapMs <= 0 || lanes < 1) {
    return {
      take: async (_signal, prefer) => {
        const t = now();
        const cand = candidates(prefer, t);
        if (cand.length === 0) return allRetired();
        if (!prefer) return chosen(cand[0]!, t);
        let best = cand[0]!;
        for (const l of cand) if (prefer.rank(l) < prefer.rank(best)) best = l;
        return chosen(best, t);
      },
      retire,
      revive,
      retiredSince,
    };
  }
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxQueueMs = opts.maxQueueMs ?? 0;
  const perTokenMs = minGapMs;
  const cap = Math.max(1, burst);
  /** 每条车道一份余量。同速回血，所以可以一起补。 */
  const tokens = new Array<number>(lanes).fill(cap);
  let lastRefill = now();
  /*
   * 排成一条链：同时进来的请求必须依次取票。若各自读余量再各自扣减，
   * 并发请求会同时看到"还有 2 张"并一起发出。
   */
  let tail: Promise<void> = Promise.resolve();

  async function acquire(enteredAt: number, signal?: AbortSignal, prefer?: AmapLanePreference): Promise<number> {
    for (;;) {
      if (signal?.aborted) throw new ToolError("amap", "upstream", "请求已取消", false);
      const t = now();
      const gained = (t - lastRefill) / perTokenMs;
      lastRefill = t;
      // 退役的车道照样回血（同一个时钟），只是选车道时跳过它。
      for (let i = 0; i < lanes; i += 1) tokens[i] = Math.min(cap, tokens[i]! + gained);
      const cand = candidates(prefer, t);
      if (cand.length === 0) return allRetired();
      /*
       * 有票的车道里挑最好的（预算占比最低 → 令牌最多）；一张票都没有时，等令牌最多的那条回血——
       * 等的时间只取决于令牌，与预算无关。
       */
      let best = -1;
      let soonest = cand[0]!;
      for (const i of cand) {
        if (tokens[i]! > tokens[soonest]!) soonest = i;
        if (tokens[i]! >= 1 && (best < 0 || better(i, best, prefer, tokens))) best = i;
      }
      if (best >= 0) {
        tokens[best] = tokens[best]! - 1;
        return chosen(best, t);
      }
      best = soonest;
      const waitMs = Math.ceil((1 - tokens[best]!) * perTokenMs);
      /*
       * 排队封顶：工具的 8 秒预算耗尽后只会得到笼统的「超时」，无法区分上游慢
       * 与本地闸门排队（实测 `map_route` 的 5.3 秒里 5.0 秒在排队）。
       * 提前抛一个明确的错，编排层还有时间换个说法继续。
       */
      if (maxQueueMs > 0 && t - enteredAt + waitMs > maxQueueMs) {
        throw new ToolError(
          "amap",
          "timeout",
          `本地限速排队 ${t - enteredAt}ms 后还要等 ${waitMs}ms，超过封顶 ${maxQueueMs}ms——不是高德慢，是闸门排不过来`,
          true,
          AMAP_LOCAL_QUEUE_CODE,
        );
      }
      await sleep(waitMs);
    }
  }

  return {
    take(signal, prefer) {
      const enteredAt = now();
      const mine = tail.then(() => acquire(enteredAt, signal, prefer));
      // 前一个取票失败（取消 / 排队封顶）不该把后面全带走。
      tail = mine.then(
        () => undefined,
        () => undefined,
      );
      return mine;
    },
    retire,
    revive,
    retiredSince,
  };
}

/**
 * 值得重试的 infocode：限流、并发超限、引擎临时异常。
 *
 * 配额用尽（10003 日调用量超限）不在其中：当天重试无效，
 * 它应冒到上层变成"今天的地图额度用完了"。
 */
/**
 * 被限流的 infocode。单独成一族，不和别的可重试错误混在一起。
 *
 * 调用方的 `catch` 必须区分「被限流」与「高德说没有这个地方」：若把限流当成「查不到」，
 * 按「不标不猜」纪律不落坐标，HUD 上会缺点且没有报错。两者走两条路：
 *
 * - 被限流：这个地方是存在的，只是这一刻没问到 → 退避重试，仍失败不进负缓存、
 *   计入「失败」上报，下次同名还要再试。
 * - 查不到：高德明确说没有 → 进缓存，不标不猜，不用再问第二次。
 */
const RATE_LIMIT_INFOCODES = new Set([
  "10004", // ACCESS_TOO_FREQUENT
  "10014", // QPS 超限（日承载量）
  "10015", // 批量并发超限
  "10020", // 服务并发超限
  "10021", // QPS 超限
  "10022", // 并发量超限
  "10023", // 单模块并发超限
  "10029", // 触发短时封禁
]);

/** 值得重试但不是限流的：超时与引擎偶发异常。 */
const TRANSIENT_INFOCODES = new Set([
  "10019", // 服务响应超时
  "20800", // 规划路线时无法找到（偶发）
  "30000", // 引擎返回数据异常
  "30001",
  "30002",
  "30003",
]);

/**
 * 判断这次失败是否被限流。
 *
 * 判据只看结构化的 `code`，不看 message：message 是给人看的文案，会随措辞漂移。
 */
export function isRateLimited(err: unknown): boolean {
  if (!(err instanceof ToolError) || err.code === undefined) return false;
  // 本地闸门排不过来与高德限流同类，处置也一样：加额度或少发。
  return err.code === AMAP_LOCAL_QUEUE_CODE || RATE_LIMIT_INFOCODES.has(err.code);
}

/**
 * 这把 key 当日配额用尽的 infocode。与限流不同：限流等一下就好，日配额当天不会恢复。
 *
 * 文档只写了 10003，实际返回的是 `10044`（`USER_DAILY_QUERY_OVER_LIMIT`），
 * 且重置点不是北京时间 00:00（实测次日 09:55 仍返回 10044）。
 * 处置是换一把别的账号的 key（车道退役，见 `createAmapRateGate`），不是重试。
 */
const DAILY_QUOTA_INFOCODES = new Set([
  "10003", // 今日调用量已达上限
  "10044", // USER_DAILY_QUERY_OVER_LIMIT
]);

/** 判断这次失败是否为这把 key 的日配额用尽。只看结构化的 `code`，理由同 `isRateLimited`。 */
export function isDailyQuotaExhausted(err: unknown): boolean {
  return err instanceof ToolError && err.code !== undefined && DAILY_QUOTA_INFOCODES.has(err.code);
}

/** 常见错配 infocode 的说明文字，随错误信息一起给出，排查时不必查高德文档。 */
const EXPLAIN: Record<string, string> = {
  "10001": "key 不正确或已过期",
  "10003": "今日调用量已达上限（配额用尽，重试无用）",
  "10044": "这把 key 今日调用量已达上限（换别的账号的 key；重试无用）",
  "10008": "MD5 安全码未通过验证",
  "10009": "key 与服务平台不匹配——服务端要用「Web 服务」类型的 key，不能用 Web 端(JS API) 的",
  "10012": "权限不足，该 key 未开通此服务",
  "20000": "请求参数非法",
  "20003": "请求可能存在异常，被高德拒绝",
};

interface AmapResponse {
  status?: string;
  info?: string;
  infocode?: string;
}

export interface AmapClientOptions {
  /**
   * 高德 Web 服务 key。
   *
   * 给一组表示多个账号的 key：QPS 是按账号算的（`10021`），所以多一个账号
   * 就是多一份额度，闸门给每把 key 一条独立车道（见 `createAmapRateGate`）。
   * 同一个账号下的多把 key 共用同一份 QPS，放进来只会让闸门高估容量并撞上 10021。
   */
  key: string | readonly string[];
  /** 注入 fetch 便于单测；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /**
   * 发车闸门的最小间隔（毫秒）与脉冲容量，缺省按实测标定（见 `AMAP_MIN_GAP_MS` 上面那两张表）。
   *
   * 给了 `fetchImpl` 时缺省是 0（不设闸）：注入 fetch 的客户端不打真网络，
   * 闸门只会让每条用例多等 350ms。闸门跟着真 fetch 走，这条规则由
   * `amap-rate-gate.test.ts` 两头钉住（全局 fetch 那条必须被限，注入那条必须不被限）。
   */
  minGapMs?: number;
  burst?: number;
  /** 排队封顶（毫秒），缺省 `AMAP_MAX_QUEUE_MS`。传 0 表示不封顶。 */
  maxQueueMs?: number;
  /**
   * 用量台账。缺省进程内一本（`createMemoryAmapLedger`）；生产由装配层注入 Redis 版，
   * 三个进程记同一份账。取票不等它——挑车道读的是客户端里的镜像，见 `amap-ledger.ts` 文件头。
   */
  ledger?: AmapUsageLedger;
  /**
   * 各接口族的日预算，缺省 `AMAP_DEFAULT_DAILY_BUDGET`。一把 key 某族到 `AMAP_SOFT_CEILING` 就不再接该族请求；
   * 全部到顶时退回按占比最低发并 warn。传 `{}` 表示全部不设限（只按令牌挑车道）。
   */
  budget?: AmapDailyBudget;
  /** 时钟注入（单测）。台账的日界与镜像刷新都按它。 */
  now?: () => number;
  /** 退役车道的探活间隔，缺省 `AMAP_REVIVE_PROBE_MS`；<=0 永不探活。 */
  reviveProbeMs?: number;
}

/**
 * 缺省日预算：只给搜索一族。
 *
 * `450` 为实测值：三把 key 各自累计约 450 次 `/v5/place/text` 后返回 10044
 * （`USER_DAILY_QUERY_OVER_LIMIT`），同期 `/v3/config/district` 正常。其余族没有撞顶数据，
 * 不设限，以免无依据的预算让路由偏向。有实测数据后再补充，或用 `AMAP_DAILY_BUDGET` 覆盖。
 */
export const AMAP_DEFAULT_DAILY_BUDGET: AmapDailyBudget = { place: 450 };
/** 软顶：到预算的九成就不再往这把 key 上发该族请求。留一成给镜像的滞后与 probe / 财务页的探针。 */
export const AMAP_SOFT_CEILING = 0.9;

/**
 * `AMAP_DAILY_BUDGET` → 生效的日预算。没配就用缺省的 450，配了就按配的来。
 *
 * 装配层不能直接传 `parseAmapDailyBudget(raw)`：没配时它返回 `{}`，
 * 而 `{}` 在 `createAmapClient` 里表示"显式不设限"，缺省的 450 就不会生效。
 * 要真正不设限写 `AMAP_DAILY_BUDGET=place=0`。
 */
export function amapBudgetFromEnv(raw: string | undefined, warn?: (msg: string) => void): AmapDailyBudget {
  if (!raw?.trim()) return AMAP_DEFAULT_DAILY_BUDGET;
  return parseAmapDailyBudget(raw, warn);
}
/** 镜像多久向台账对齐一次别的进程记的账（退役表也随这一拍同步）。 */
export const AMAP_LEDGER_REFRESH_MS = 30_000;
/**
 * 本进程刚退役的车道，台账里暂时还没有它——`retire` 是异步落地的。这段宽限期内
 * "台账里没有"不算"别的进程把它复活了"，否则会把自己刚退的车道又拉回来。
 */
export const AMAP_RETIRE_SYNC_GRACE_MS = 60_000;

export function createAmapClient({
  key,
  fetchImpl,
  minGapMs,
  burst,
  maxQueueMs,
  ledger: ledgerOpt,
  budget: budgetOpt,
  now: nowOpt,
  reviveProbeMs,
}: AmapClientOptions): AmapClient {
  const doFetch = fetchImpl ?? fetch;
  const keys = (typeof key === "string" ? [key] : key).map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) {
    throw new ToolError("amap", "unconfigured", "没有可用的高德 key", false);
  }
  const now = nowOpt ?? (() => Date.now());
  const gate = createAmapRateGate(
    keys.length,
    minGapMs ?? (fetchImpl ? 0 : AMAP_MIN_GAP_MS),
    burst ?? AMAP_BURST,
    { maxQueueMs: maxQueueMs ?? AMAP_MAX_QUEUE_MS, now, reviveProbeMs },
  );

  // ── 记账与预算路由 ─────────────────────────────
  const ledger = ledgerOpt ?? createMemoryAmapLedger();
  const budget = budgetOpt ?? AMAP_DEFAULT_DAILY_BUDGET;
  const fps = keys.map(amapKeyFingerprint);
  /** 用量镜像：lane → family → 今日次数。发出前 +1，`record` 回来后用总数校正，定期与台账全表对齐。 */
  let mirror: Array<Partial<Record<AmapApiFamily, number>>> = keys.map(() => ({}));
  let mirrorDay = beijingDay(now());
  let lastRefreshAt = 0;
  const lastBudgetWarnAt = new Map<AmapApiFamily, number>();

  function usageOf(lane: number, family: AmapApiFamily): number {
    return mirror[lane]?.[family] ?? 0;
  }
  /** 过了北京日界就清零——别让昨天的账把今天的车道挑偏。 */
  function rollDay(t: number): void {
    const day = beijingDay(t);
    if (day === mirrorDay) return;
    mirrorDay = day;
    mirror = keys.map(() => ({}));
  }
  /** 拉一次全表对齐别的进程记的账。失败只 warn：镜像旧一点，软顶那一成余量就是为它留的。 */
  function refreshMirror(t: number): void {
    lastRefreshAt = t;
    const day = mirrorDay;
    void ledger
      .snapshot(day)
      .then((snap) => {
        if (day !== mirrorDay) return;
        mirror = fps.map((fp) => sumByFamily(snap[fp]));
      })
      .catch((e: unknown) => console.warn("[amap] 用量台账刷新失败（镜像沿用本进程的计数）", e));
    syncRetiredFromLedger();
  }

  // ── 退役的持久化与跨进程同步 ─────────────────────
  const laneOfFp = new Map(fps.map((fp, lane) => [fp, lane] as const));
  /**
   * 台账里的退役表 → 闸门：别的进程退役的 key 本进程也不再发；台账里已经没有的、且退役超过宽限期的，
   * 是别的进程探活成功了，本进程跟着复活。启动时读一次、之后随镜像刷新每 30 s 一次，取票都不等它。
   */
  function applyRetired(table: Record<string, AmapRetiredInfo>, t: number): void {
    for (const [fp, info] of Object.entries(table)) {
      const lane = laneOfFp.get(fp);
      if (lane !== undefined && gate.retiredSince(lane) === undefined) gate.retire(lane, info.at);
    }
    for (let lane = 0; lane < keys.length; lane += 1) {
      const since = gate.retiredSince(lane);
      if (since === undefined || table[fps[lane]!] || t - since <= AMAP_RETIRE_SYNC_GRACE_MS) continue;
      gate.revive(lane);
      console.log(`[amap] 第 ${lane + 1}/${keys.length} 把 key（${fps[lane]}）按台账复活（别的进程探活成功）`);
    }
  }
  function syncRetiredFromLedger(): void {
    void ledger
      .retired()
      .then((table) => applyRetired(table, now()))
      .catch((e: unknown) => console.warn("[amap] 读台账退役表失败（只按本进程的退役）", e));
  }
  syncRetiredFromLedger();
  /** 探活成功：闸门与台账一起复活，并记录退役时长，作为配额重置窗口的观测数据。 */
  function revive(lane: number, since: number, t: number): void {
    gate.revive(lane);
    console.log(
      `[amap] 第 ${lane + 1}/${keys.length} 把 key（${fps[lane]}）复活：退役 ${((t - since) / 3_600_000).toFixed(1)} 小时后再次可用`,
    );
    void ledger.revive(fps[lane]!, t).catch((e: unknown) => console.warn("[amap] 台账写复活失败", e));
  }
  /**
   * 配额用尽：闸门退役 + 台账退役。探活又撞上的保留原退役时刻（`since`），只把下次探活往后推。
   * 返回还有没有活车道可换。
   */
  function retire(lane: number, since: number | undefined, family: AmapApiFamily, err: ToolError, t: number): boolean {
    const info: AmapRetiredInfo = { at: since ?? t, family, infocode: err.code ?? "" };
    void ledger.retire(fps[lane]!, info).catch((e: unknown) => console.warn("[amap] 台账写退役失败", e));
    console.warn(
      since === undefined
        ? `[amap] 第 ${lane + 1}/${keys.length} 把 key（${fps[lane]}）今日配额用尽，车道退役：${err.message}`
        : `[amap] 第 ${lane + 1}/${keys.length} 把 key（${fps[lane]}）探活仍配额用尽（已退役 ${((t - since) / 3_600_000).toFixed(1)} 小时），继续退役`,
    );
    return gate.retire(lane, t);
  }
  /** 记一次已发出的请求：镜像先 +1，台账回来后用总数校正。 */
  function account(lane: number, family: AmapApiFamily, outcome: AmapOutcome, t: number): void {
    const m = mirror[lane]!;
    m[family] = (m[family] ?? 0) + 1;
    void ledger
      .record(fps[lane]!, family, outcome, t)
      .then((total) => {
        if (beijingDay(t) !== mirrorDay) return;
        const cur = mirror[lane]!;
        if (Number.isFinite(total) && total > (cur[family] ?? 0)) cur[family] = total;
      })
      .catch((e: unknown) => console.warn("[amap] 用量台账记账失败（镜像已按本进程计数 +1）", e));
  }
  /** 该族有预算才有偏好；没有预算的族按"令牌最多"挑。 */
  function preferenceFor(family: AmapApiFamily, t: number): AmapLanePreference | undefined {
    const limit = budget[family];
    if (!limit || limit <= 0) return undefined;
    const soft = Math.ceil(limit * AMAP_SOFT_CEILING);
    return {
      eligible: (lane) => usageOf(lane, family) < soft,
      rank: (lane) => usageOf(lane, family) / limit,
      onFallback: () => {
        const last = lastBudgetWarnAt.get(family) ?? -Infinity;
        if (t - last < 60_000) return;
        lastBudgetWarnAt.set(family, t);
        console.warn(
          `[amap] ${family} 族 ${keys.length} 把 key 都到今日预算的 ${Math.round(AMAP_SOFT_CEILING * 100)}%（${limit}/把），` +
            "退回按占比最低发——预算数可能偏小，或该加 key",
        );
      },
    };
  }
  /** 一次响应的结局归类：只看结构化的 code，与 `isRateLimited` / `isDailyQuotaExhausted` 同一条判据。 */
  function outcomeOf(err: unknown): AmapOutcome {
    if (isDailyQuotaExhausted(err)) return "quota_exhausted";
    if (isRateLimited(err)) return "rate_limited";
    return "error";
  }
  // regeo 的结果按坐标网格缓存：沿途取样点常常落在同一个区里，
  // 一条 400 公里的路线不该打十几次重复的逆地理。
  const regeoCache = new Map<string, AmapRegeo>();
  // 行政区划是静态数据：同一个 region 词在一次会话里只该问一次（含"问不出来"）。
  const regionCache = new Map<string, AmapRegion | undefined>();
  const districtsCache = new Map<string, AmapDistrict[]>();

  async function get<T extends AmapResponse>(
    path: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = new URL(path, BASE);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    /*
     * 所有高德请求的唯一出口，闸门就装在这里（见 createAmapRateGate 的文件内注释）。
     *
     * 在闸门两侧取时间：这段是本地排队，不是上游在算。
     * 两者都计进 `tool.*` 的时长，处置却不同：上游慢只能等，
     * 本地排队可以调并发策略。计量本身是旁路的，
     * 没人计量时 `recordWait` 直接丢弃（见 wait-meter.ts）。
     */
    /*
     * 换 key 的循环：一把 key 的日配额用尽（10003 / 10044）就让那条车道退役、
     * 立刻换下一条再发同一个请求。至多发 `keys.length` 次；最后一条也退役时
     * 闸门自己抛 `AMAP_ALL_LANES_RETIRED_CODE`。别的失败一律原样冒出去。
     */
    const family = amapFamilyOf(path);
    for (;;) {
      const gateAt = Date.now();
      const t0 = now();
      rollDay(t0);
      if (t0 - lastRefreshAt >= AMAP_LEDGER_REFRESH_MS) refreshMirror(t0);
      // 用哪把 key 由闸门决定：它知道此刻哪个账号的额度最空、哪个已经退役；有预算的族再看今天用了几成。
      const lane = await gate.take(signal, preferenceFor(family, t0));
      // 闸门把退役车道交出来只有一种情况：到了探活时刻。这一发成了就复活，再 10044 就继续退役。
      const probeSince = gate.retiredSince(lane);
      recordWait(gateAt, Date.now());
      url.searchParams.set("key", keys[lane] ?? keys[0]!);
      let body: T;
      try {
        const res = await doFetch(url, { signal });
        if (!res.ok) {
          // 高德极少走到这里（它一律 200），真到了多半是网关问题 → 值得重试。
          throw new ToolError("amap", "upstream", `HTTP ${res.status}`, res.status >= 500);
        }
        body = (await res.json()) as T;
      } catch (err) {
        // 网络层就失败的也计一次：请求已经发出去，高德那边多半也记了。
        account(lane, family, "error", now());
        throw err;
      }
      try {
        const out = ok(body, path);
        const t = now();
        account(lane, family, "ok", t);
        if (probeSince !== undefined) revive(lane, probeSince, t);
        return out;
      } catch (err) {
        const t = now();
        account(lane, family, outcomeOf(err), t);
        if (!isDailyQuotaExhausted(err)) throw err;
        if (!retire(lane, probeSince, family, err as ToolError, t)) throw err;
      }
    }
  }

  /** 唯一出口：所有高德响应都必须过这里，不允许直接读 body。 */
  function ok<T extends AmapResponse>(body: T, path: string): T {
    const code = body.infocode ?? "";
    if (body.status === "1" && (code === "" || code === "10000")) return body;

    const explain = EXPLAIN[code];
    const detail = [`${path} 失败`, `infocode=${code || "?"}`, body.info, explain]
      .filter(Boolean)
      .join(" ");
    throw new ToolError(
      "amap",
      code === "10001" || code === "10009" || code === "10012" ? "unconfigured" : "upstream",
      detail,
      RATE_LIMIT_INFOCODES.has(code) || TRANSIENT_INFOCODES.has(code),
      code || undefined,
    );
  }

  /** 一次 district 查询，只收名字对得上的省/市/区。 */
  async function districtOf(name: string, signal?: AbortSignal): Promise<AmapRegion | undefined> {
    const body = await get<AmapResponse & { districts?: Array<Record<string, unknown>> }>(
      "/v3/config/district",
      { keywords: name, subdistrict: "0", extensions: "base" },
      signal,
    );
    /*
     * 同名多级时取最高一级（省 > 市 > 区县），同级取接口给的第一个。
     *
     * 例如 `keywords=西安` 高德先回辽源市西安区（220402）再回西安市（610100）；
     * 取第一个会把整份行程落到辽源，景点的坐标、片区、评分都自洽，只有城市是错的。
     * 裸地名作为目的地时是城市的可能性远大于某市的一个区。
     */
    const RANK: Record<AmapRegion["level"], number> = { province: 3, city: 2, district: 1 };
    let best: AmapRegion | undefined;
    for (const d of body.districts ?? []) {
      const level = textOf(d.level);
      if (level !== "province" && level !== "city" && level !== "district") continue;
      const adcode = textOf(d.adcode);
      const dn = textOf(d.name);
      if (!adcode || !dn) continue;
      // 接口对搜不到的词会回一堆模糊匹配（「西溪」回六个街道）——名字对不上就不算认出来。
      if (!nameOverlaps(name, dn)) continue;
      if (!best || RANK[level] > RANK[best.level]) best = { adcode, name: dn, level };
    }
    return best;
  }

  /*
   * 独立函数而不是只挂在返回对象上：`textSearch` 内部也要用它，而经 `this` 调用
   * 会在调用方解构（`const { textSearch } = client`）时丢失 `this`。
   */
  async function resolveRegionCached(
    name: string,
    signal?: AbortSignal,
  ): Promise<AmapRegion | undefined> {
    const key = name.trim();
    if (!key) return undefined;
    if (regionCache.has(key)) return regionCache.get(key);
    /*
     * 失败不吞：限流（10021）与"这个词不是行政区"是两回事，吞掉前者会让
     * 一次抖动导致整份行程都不标坐标。让它抛，交给调用方既有的重试
     * （`resolveTripPlanCoords` 隔 1s 再来一次）。
     */
    let hit = await districtOf(key, signal);
    /*
     * 认不出来时退到前两个字再试一次，且只收省/市级（「城市+片区」
     * 拼法：`上海嘉定` / `广州（演示）`）。
     *
     * 不收区县级：两字前缀容易撞上别的城市的区名（如「西湖」开头的片区会命中
     * 杭州西湖区），整份行程会被圈到另一个城市。城市/省级的两字前缀没有这个歧义。
     */
    if (!hit && key.length > 2) {
      const head = await districtOf(key.slice(0, 2), signal);
      if (head && head.level !== "district") hit = head;
    }
    regionCache.set(key, hit);
    return hit;
  }

  return {
    resolveRegion: resolveRegionCached,

    async listDistricts(name, signal) {
      const key = name.trim();
      if (!key) return [];
      const cached = districtsCache.get(key);
      if (cached) return cached;
      const body = await get<AmapResponse & { districts?: Array<Record<string, unknown>> }>(
        "/v3/config/district",
        { keywords: key, subdistrict: "1", extensions: "base" },
        signal,
      );
      let out: AmapDistrict[] = [];
      for (const d of body.districts ?? []) {
        const level = textOf(d.level);
        // 只认省 / 市级当父级：直辖市在高德是 province（上海市的子项直接就是区），普通城市是 city。
        if (level !== "province" && level !== "city") continue;
        const dn = textOf(d.name);
        // 与 districtOf 同一条：名字对不上就不算认出来（「西溪」那类模糊匹配一律不收）。
        if (!dn || !nameOverlaps(key, dn)) continue;
        const kids = (d.districts as Array<Record<string, unknown>> | undefined) ?? [];
        const pick = (lvl: string): AmapDistrict[] =>
          kids
            .filter((k) => textOf(k.level) === lvl)
            .map((k) => {
              const [lon, lat] = textOf(k.center).split(",").map(Number);
              return { adcode: textOf(k.adcode), name: textOf(k.name), lat: lat ?? NaN, lon: lon ?? NaN };
            })
            .filter((k) => k.adcode && k.name && Number.isFinite(k.lat) && Number.isFinite(k.lon));
        // 城市的子项是区县；省级父项（直辖市）的子项也是区县，而真正的省的子项是市——都按"下一级"收。
        out = pick("district");
        if (out.length === 0) out = pick("city");
        break;
      }
      districtsCache.set(key, out);
      return out;
    },

    async geocode(address, city, signal) {
      const body = await get<AmapResponse & { geocodes?: Array<Record<string, unknown>> }>(
        "/v3/geocode/geo",
        city ? { address, city } : { address },
        signal,
      );
      const first = body.geocodes?.[0];
      if (!first) {
        throw new ToolError("amap", "upstream", `地名解析不到坐标：${address}`, false);
      }
      const at = parseLngLat(String(first.location ?? ""));
      if (!at) {
        throw new ToolError("amap", "upstream", `地名解析返回的坐标不可读：${address}`, false);
      }
      return {
        ...at,
        name: textOf(first.formatted_address) || address,
        adcode: textOf(first.adcode),
        city: textOf(first.city) || textOf(first.province),
      };
    },

    async regeo(at, signal) {
      const cacheKey = regeoCacheKey(at);
      const hit = regeoCache.get(cacheKey);
      if (hit) return hit;

      const body = await get<AmapResponse & { regeocode?: Record<string, unknown> }>(
        "/v3/geocode/regeo",
        { location: `${round6(at.lon)},${round6(at.lat)}` },
        signal,
      );
      const comp = (body.regeocode?.addressComponent ?? {}) as Record<string, unknown>;
      const adcode = textOf(comp.adcode);
      if (!adcode) {
        throw new ToolError("amap", "upstream", `逆地理没有返回 adcode（${cacheKey}）`, false);
      }
      const value: AmapRegeo = {
        adcode,
        city: textOf(comp.city) || textOf(comp.province),
        district: textOf(comp.district),
        formatted: textOf(body.regeocode?.formatted_address),
      };
      regeoCache.set(cacheKey, value);
      return value;
    },

    async forecast(adcode, signal) {
      const body = await get<AmapResponse & { forecasts?: Array<Record<string, unknown>> }>(
        "/v3/weather/weatherInfo",
        { city: adcode, extensions: "all" },
        signal,
      );
      const f = body.forecasts?.[0];
      if (!f) {
        throw new ToolError("amap", "upstream", `没有 ${adcode} 的天气预报`, false);
      }
      const casts = ((f.casts ?? []) as Array<Record<string, unknown>>).map((c) => ({
        date: textOf(c.date),
        dayWeather: textOf(c.dayweather),
        nightWeather: textOf(c.nightweather),
        dayTempC: numOf(c.daytemp_float ?? c.daytemp),
        nightTempC: numOf(c.nighttemp_float ?? c.nighttemp),
        dayWind: textOf(c.daywind),
        dayPower: textOf(c.daypower),
      }));
      return {
        city: textOf(f.city),
        adcode: textOf(f.adcode) || adcode,
        reportTime: textOf(f.reporttime),
        casts,
      };
    },

    async driving({ origin, destination, waypoints, strategy, withNavi }, signal) {
      const params: Record<string, string> = {
        origin: fmt(origin),
        destination: fmt(destination),
        // tmcs 是分段路况（屏底状态栏的「道路情况」用它）；多要这一段不影响既有字段。
        // navi 只在按途经点切分段时要，默认不要，其余调用方的请求串不变。
        show_fields: withNavi ? "cost,polyline,tmcs,navi" : "cost,polyline,tmcs",
      };
      if (waypoints?.length) params.waypoints = waypoints.map(fmt).join(";");
      if (strategy !== undefined) params.strategy = String(strategy);

      const body = await get<AmapResponse & { route?: Record<string, unknown> }>(
        "/v5/direction/driving",
        params,
        signal,
      );
      const path = ((body.route?.paths ?? []) as Array<Record<string, unknown>>)[0];
      if (!path) {
        throw new ToolError("amap", "upstream", "路径规划没有返回可行路线", false);
      }
      const cost = (path.cost ?? {}) as Record<string, unknown>;
      const steps = ((path.steps ?? []) as Array<Record<string, unknown>>).map((s) => {
        const sc = (s.cost ?? {}) as Record<string, unknown>;
        const tmcs = ((s.tmcs ?? []) as Array<Record<string, unknown>>).map((t) => ({
          status: textOf(t.tmc_status) || "未知",
          distanceM: numOf(t.tmc_distance) ?? 0,
        }));
        const navi = (s.navi ?? {}) as Record<string, unknown>;
        const assistantAction = textOf(navi.assistant_action);
        return {
          instruction: textOf(s.instruction),
          distanceM: numOf(s.step_distance) ?? 0,
          durationS: numOf(sc.duration) ?? 0,
          points: parsePolyline(textOf(s.polyline)),
          tmcs,
          ...(assistantAction ? { assistantAction } : {}),
        };
      });
      return {
        distanceM: numOf(path.distance) ?? 0,
        durationS: numOf(cost.duration) ?? 0,
        tollYuan: numOf(cost.tolls) ?? 0,
        tollDistanceM: numOf(cost.toll_distance) ?? 0,
        trafficLights: numOf(cost.traffic_lights) ?? 0,
        steps,
      };
    },

    async around({ at, types, radiusM, limit }, signal) {
      const body = await get<AmapResponse & { pois?: Array<Record<string, unknown>> }>(
        "/v5/place/around",
        {
          location: fmt(at),
          types,
          radius: String(radiusM),
          page_size: String(Math.min(limit ?? 5, 25)),
        },
        signal,
      );
      const pois: AmapPoi[] = [];
      for (const p of (body.pois ?? []) as Array<Record<string, unknown>>) {
        const loc = parseLngLat(textOf(p.location));
        if (!loc) continue;
        pois.push({
          ...loc,
          id: textOf(p.id),
          name: textOf(p.name),
          type: textOf(p.type),
          typecode: textOf(p.typecode),
          address: textOf(p.address),
          cityName: textOf(p.cityname),
          distanceM: numOf(p.distance),
        });
      }
      return pois;
    },

    async textSearch({ keywords, region, types, cityLimit, limit }, signal) {
      const call = async (rg: string) => {
        const body = await get<AmapResponse & { pois?: Array<Record<string, unknown>> }>(
          "/v5/place/text",
          {
            keywords,
            region: rg,
            ...(types ? { types } : {}),
            ...(cityLimit ? { city_limit: "true" } : {}),
            show_fields: "business",
            page_size: String(Math.min(limit ?? 8, 25)),
          },
          signal,
        );
        return (body.pois ?? []) as Array<Record<string, unknown>>;
      };

      /*
       * `city_limit` 会静默失效（见 内部文档）。
       *
       * 高德只认它自己的行政区名。上游给的常常不是行政区：「上海嘉定」这种
       * 城市+片区的拼法、「普陀山」这种景区名、「西湖湖滨」「灵隐-之江」这种
       * 行程片区名——它解析不出来就忽略 city_limit 按全国搜，仍返回 status=1。
       *
       * 结果不是空，而是看起来正常的错数据。region 为片区名时的全国 top1：
       *   · `雷峰塔` → 河南省南阳市淅川县的雷峰塔（111.55, 32.82）；
       *   · `西溪国家湿地公园`（region=西溪）→ 江西省上饶市广丰区（118.19, 28.46）。
       * 两者都排在杭州那个正主前面，因为它们的名字更贴合关键词。
       *
       * 因此用两道硬判据：
       *
       *  1. 请求侧：region 先经 `/v3/config/district` 归一成 adcode 再发
       *     （adcode 要么是一个行政区、要么不是，没有"解析不出来"这种中间态）。
       *     归一不出来就不搜——`cityLimit` 是个承诺，兑现不了就返回空，
       *     而不是拿一份全国结果冒充。
       *  2. 命中侧：逐条比对 POI 自己的 `adcode` 前缀（省 2 位 / 市 4 位 / 区 6 位），
       *     拦下高德忽略 city_limit 时返回的范围外结果。
       *
       * `cityLimit` 为 false（如 route_audit 没拿到 city）时全国搜，不作承诺。
       */
      let raw: Array<Record<string, unknown>>;
      let scope: AmapRegion | undefined;
      if (cityLimit && region.trim()) {
        scope = await resolveRegionCached(region, signal);
        if (!scope) {
          console.warn(`[amap] region「${region}」不是高德认识的行政区，city_limit 无法兑现——不返回结果`);
          return [];
        }
        raw = await call(scope.adcode);
      } else {
        raw = await call(region);
      }

      const pois: AmapTextPoi[] = [];
      for (const p of raw) {
        if (scope && !underRegion(textOf(p.adcode), scope)) continue;
        const loc = parseLngLat(textOf(p.location));
        if (!loc) continue;
        const business = (p.business ?? {}) as Record<string, unknown>;
        const rating = textOf(business.rating);
        pois.push({
          ...loc,
          id: textOf(p.id),
          name: textOf(p.name),
          type: textOf(p.type),
          typecode: textOf(p.typecode),
          address: textOf(p.address),
          cityName: textOf(p.cityname),
          province: textOf(p.pname),
          district: textOf(p.adname),
          adcode: textOf(p.adcode),
          distanceM: numOf(p.distance),
          ...(rating ? { rating } : {}),
        });
      }
      return pois;
    },

    async transitIntegrated({ origin, destination, city, cityd, strategy }, signal) {
      const body = await get<
        AmapResponse & { route?: { transits?: Array<Record<string, unknown>> } }
      >(
        "/v3/direction/transit/integrated",
        {
          origin: fmt(origin),
          destination: fmt(destination),
          city,
          cityd,
          strategy: String(strategy ?? 0),
        },
        signal,
      );
      const out: AmapTransit[] = [];
      for (const t of body.route?.transits ?? []) {
        const trains: AmapTrainLeg[] = [];
        for (const seg of (t.segments ?? []) as Array<Record<string, unknown>>) {
          const rw = (seg.railway ?? {}) as Record<string, unknown>;
          const no = textOf(rw.name);
          if (!no) continue;
          const prices = ((rw.spaces ?? []) as Array<Record<string, unknown>>)
            .map((s) => numOf(s.cost))
            .filter((x): x is number => x !== null);
          trains.push({
            no,
            trip: textOf(rw.trip),
            durationMin: Math.round((numOf(rw.time) ?? 0) / 60),
            prices,
          });
        }
        // 只留含火车段的方案：纯公交/步行的跨城组合对"沪→广"这类问题没有意义。
        if (trains.length === 0) continue;
        out.push({
          durationMin: Math.round((numOf(t.duration) ?? 0) / 60),
          costYuan: numOf(t.cost),
          trains,
        });
      }
      return out;
    },
  };
}

// ── 注入点（与 setRagClient 同形态）─────────────────────────────

let client: AmapClient | undefined;

/** 装配层注入。传 undefined 表示未接入（离线 / 未配 AMAP_SERVER_KEY）。 */
export function setAmapClient(c: AmapClient | undefined): void {
  client = c;
}

export function getAmapClient(): AmapClient | undefined {
  return client;
}

// ── 小工具 ───────────────────────────────────────────────────

/** 高德要求 `lon,lat` 且最多 6 位小数；顺序反了不报错，只会返回错误地点的结果。 */
function fmt(at: LngLat): string {
  return `${round6(at.lon)},${round6(at.lat)}`;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * regeo 的缓存键：约 0.05° 网格（纬度方向 ~5.5km）。
 * 取样点密度远小于一个区，同区的点落进同一格即可复用。
 */
function regeoCacheKey(at: LngLat): string {
  return `${(Math.round(at.lat * 20) / 20).toFixed(2)},${(Math.round(at.lon * 20) / 20).toFixed(2)}`;
}

/**
 * 两个地名是否指同一处：一方包含另一方即可（「杭州」↔「杭州市」）。
 * 用在 district 接口的模糊匹配上——它对搜不到的词会回一堆不相干的行政区。
 */
function nameOverlaps(a: string, b: string): boolean {
  const na = a.replace(/\s+/g, "");
  const nb = b.replace(/\s+/g, "");
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

/**
 * POI 的 adcode 是否落在限定范围内。
 *
 * adcode 是 6 位分级编码（省 2 位 + 市 2 位 + 区 2 位），前缀相同即在范围内：
 * 330106（杭州西湖区）在 330100（杭州市）之下，118 开头的上饶不在。
 * 拿不到 adcode 的命中一律不收：没有证据就不能算通过（ADR-008）。
 */
function underRegion(adcode: string, scope: AmapRegion): boolean {
  if (!/^\d{6}$/.test(adcode)) return false;
  const width = scope.level === "province" ? 2 : scope.level === "city" ? 4 : 6;
  return adcode.slice(0, width) === scope.adcode.slice(0, width);
}

function parseLngLat(s: string): LngLat | null {
  const [lon, lat] = s.split(",").map(Number);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return { lat, lon };
}

function parsePolyline(s: string): LngLat[] {
  if (!s) return [];
  const out: LngLat[] = [];
  for (const pair of s.split(";")) {
    const p = parseLngLat(pair);
    if (p) out.push(p);
  }
  return out;
}

function textOf(v: unknown): string {
  // 高德把"没有值"表达成 `[]`（不是 null、不是空串）。String([]) 恰好得到 ""，
  // 但对象会得到 "[object Object]"，所以显式判一次。
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

function numOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
