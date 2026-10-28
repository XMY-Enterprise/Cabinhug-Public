/**
 * ④⑥ 数据新鲜度判定（FL-53 F-53-02，架构文档 §7「不衰减 ≠ 永远可信」）。
 *
 * # 判定目标：是否向车主询问
 *
 * ⑥ 侧的可用性判定（`usage-telemetry/summary.ts` 的 `MAX_STALE_DAYS` /
 * `MIN_SAMPLE` → `usable:false`）回答"能否据此下个性化结论"，倾向不答。
 * 本模块回答"是否向车主问一句"，倾向少问。
 *
 * 两者语义相反，取值不可互相复用：14 天没流水即不下结论是安全的，
 * 14 天没流水即询问会很快耗尽打扰预算。本模块自带一套阈值，
 * 三项各自独立（架构文档 §13-20）：
 *
 *  - ④ 当前里程按增长速率失真：年行驶六万公里的车，一个月不上报就差五千；
 *  - ④ 上次保养日期按周期失真：半年内不变属正常；
 *  - ⑥ 行程流水是持续观测，断流本身就是信号。
 *
 * # 三态
 *
 * `unknown` 独立成态，不折叠进 `fresh` 或 `stale`：
 * 折进 fresh，存量车（时刻为空）永远不会被问；折进 stale，
 * 存量车会在上线当天全部被判陈旧、全部触发补录询问。
 *
 * ④ 与 ⑥ 对"没有数据"的处理不对称，因为两者的空含义不同：
 *  - ④ 的 `odometerAt === undefined` 表示没记录该值的时刻（存量行回填），判 `unknown`；
 *  - ⑥ 的"一条流水都没有"是确实观测到的空，判 `stale`。
 *
 * # 阈值取值未定（§13-20）
 *
 * 默认值是保守值（倾向少问），不是实测结论。定案前调用方经
 * `resolveFreshnessThresholds` 传入覆盖值。
 */

/** 可被判定的三项事实。 */
export type FreshnessItem = "odometer" | "lastService" | "usageTrips";

export type FreshnessVerdict = "fresh" | "stale" | "unknown";

export interface FreshnessThresholds {
  /** ④ 当前里程多久没前进算陈旧。 */
  odometerDays: number;
  /** ④ 上次保养记录多久没更新算陈旧。 */
  lastServiceDays: number;
  /** ⑥ 最后一条行程流水多久之前算陈旧。 */
  usageTripsDays: number;
}

/**
 * 保守默认值，无实测依据（架构文档 §13-20）。
 *
 * 取值理由：
 *  - `odometerDays: 60` —— 比 ⑥ 的 `MAX_STALE_DAYS`(14) 宽四倍。对高里程车主
 *    两个月约一万公里，询问足够及时；对低频车主不构成打扰。
 *  - `lastServiceDays: 240` —— 常见保养周期是半年到一年，半年内没有新记录属正常，
 *    约八个月仍无记录才询问。
 *  - `usageTripsDays: 45` —— 比 `MAX_STALE_DAYS` 宽三倍。⑥ 的断流无法补录
 *    （见 `suggested`），只用于说明缺什么，不用于催问，取值可以宽。
 *
 * 不要把这些数字复制到别处；需要调整时传 overrides。
 */
export const DEFAULT_FRESHNESS_THRESHOLDS: Readonly<FreshnessThresholds> = Object.freeze({
  odometerDays: 60,
  lastServiceDays: 240,
  usageTripsDays: 45,
});

export interface FreshnessInput {
  /** ④ 里程最后一次前进的时刻（epoch ms）。缺失 ⇒ `unknown`，不等于很久以前。 */
  odometerAt?: number;
  /** ④ 最近一条保养记录的时刻（epoch ms）。缺失 ⇒ `unknown`（从未记录过保养）。 */
  lastServiceAt?: number;
  /**
   * ⑥ 最后一条行程流水距今多少天，直接取 `usage-telemetry/summary.ts` 算好的值
   * （一条流水都没有时为 `Number.POSITIVE_INFINITY`）。本模块不重算第二份。
   */
  usageStaleDays: number;
}

export interface FreshnessFinding {
  item: FreshnessItem;
  /** 该事实的时刻（epoch ms）；`unknown` 或无流水时缺席。 */
  lastAt?: number;
  /**
   * 距今天数，只在算得出有限值时才有：`unknown` 缺席，
   * ⑥ 一条流水都没有时也缺席（此时看 `reason` 与 `verdict`）。
   *
   * 不放 `Infinity`：本结构经 `data_freshness` 工具以 JSON 交给模型，
   * 而 `JSON.stringify(Infinity)` 是 `null`，会与"字段未知"无法区分。
   */
  staleDays?: number;
  verdict: FreshnessVerdict;
  /** 可直接用于降级话术的具体原因，不用笼统的"数据不足"。 */
  reason: string;
  /** 本次判定用的阈值，随结果带出，便于回答"按什么标准判的"。 */
  thresholdDays: number;
}

export interface FreshnessReport {
  items: FreshnessFinding[];
  /**
   * 建议向车主补录的项，已按价值排序。
   *
   * 永远不含 `usageTrips`：⑥ 的流水无法补录。口述不是观测，
   * 补录不得伪造 `trips` 记录（架构文档 §7 回填第 2 条 / AC-53-7）。
   */
  suggested: FreshnessItem[];
}

const DAY_MS = 86_400_000;

/**
 * 补录价值排序：上次保养日期 > 当前里程。
 *
 * 保养日期是推算的必要输入且车主答得上来（"上个月 12 号刚做的"）；
 * 里程还能被 ⑥ 的流水推进，不只靠询问获得。
 */
const SUGGEST_ORDER: readonly FreshnessItem[] = ["lastService", "odometer"];

/** 合并覆盖值。非有限值或非正数一律忽略，配置写坏时回落默认。 */
export function resolveFreshnessThresholds(
  overrides?: Partial<FreshnessThresholds>,
): FreshnessThresholds {
  const out = { ...DEFAULT_FRESHNESS_THRESHOLDS };
  for (const key of ["odometerDays", "lastServiceDays", "usageTripsDays"] as const) {
    const v = overrides?.[key];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[key] = v;
  }
  return out;
}

/**
 * 边界取 `staleDays > threshold` 才算陈旧，恰好等于阈值判 fresh。
 * 固定边界便于断言；选 fresh 与本模块少问的倾向一致。
 */
function judgeAge(
  item: FreshnessItem,
  at: number | undefined,
  thresholdDays: number,
  now: number,
  unknownReason: string,
): FreshnessFinding {
  if (at === undefined) {
    return { item, verdict: "unknown", reason: unknownReason, thresholdDays };
  }
  const staleDays = Math.max(0, (now - at) / DAY_MS);
  const stale = staleDays > thresholdDays;
  return {
    item,
    lastAt: at,
    staleDays,
    verdict: stale ? "stale" : "fresh",
    reason: stale
      ? `已经 ${Math.round(staleDays)} 天没更新（上限 ${thresholdDays} 天）`
      : `${Math.round(staleDays)} 天前更新过，还在 ${thresholdDays} 天以内`,
    thresholdDays,
  };
}

export function assessFreshness(
  input: FreshnessInput,
  thresholds: FreshnessThresholds,
  now: number,
): FreshnessReport {
  const odometer = judgeAge(
    "odometer",
    input.odometerAt,
    thresholds.odometerDays,
    now,
    // 存量行：值在、时刻不在。不知道 ≠ 很久以前。
    "档案里没记过这个里程是什么时候的",
  );
  const lastService = judgeAge(
    "lastService",
    input.lastServiceAt,
    thresholds.lastServiceDays,
    now,
    "档案里没有任何保养记录",
  );

  // ⑥：`staleDays` 由 summary.ts 给，一条流水都没有时是 Infinity。
  // 这一项不走 unknown："一条都没有"是确实观测到的空（见文件头）。
  const usageStale = input.usageStaleDays;
  const usageTrips: FreshnessFinding = !Number.isFinite(usageStale)
    ? {
        item: "usageTrips",
        // 不带 staleDays：Infinity 经 JSON 序列化后是 null，与"未知"无法区分（见字段注释）。
        verdict: "stale",
        reason: "还没有任何用车流水",
        thresholdDays: thresholds.usageTripsDays,
      }
    : {
        item: "usageTrips",
        lastAt: now - usageStale * DAY_MS,
        staleDays: usageStale,
        verdict: usageStale > thresholds.usageTripsDays ? "stale" : "fresh",
        reason:
          usageStale > thresholds.usageTripsDays
            ? `最后一条行程在 ${Math.round(usageStale)} 天前（上限 ${thresholds.usageTripsDays} 天）`
            : `最后一条行程在 ${Math.round(usageStale)} 天前，还在 ${thresholds.usageTripsDays} 天以内`,
        thresholdDays: thresholds.usageTripsDays,
      };

  const items = [odometer, lastService, usageTrips];
  const staleSet = new Set(items.filter((i) => i.verdict === "stale").map((i) => i.item));
  // unknown 也纳入建议：缺失的时刻可由车主补一句解决。
  const unknownSet = new Set(items.filter((i) => i.verdict === "unknown").map((i) => i.item));
  const suggested = SUGGEST_ORDER.filter((i) => staleSet.has(i) || unknownSet.has(i));

  return { items, suggested };
}
