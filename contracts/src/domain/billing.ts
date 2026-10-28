/**
 * 单机版「费用明细」的回包（ACR-066，`GET /v1/billing`）。
 *
 * 单机版是 BYOK：模型、审核、地图都是车主自己的账号，钱由车主自己付。这里给的是两类数字，口径不同、
 * 不互相推算（与控制台财务页同一条纪律）：
 *   - 用量与花费估算：我们自己记的账（`llm_usage` 的单价估算、审核记录条数、高德额度台账），
 *     只能说「至少花了这么多」，不能拿去对账单；
 *   - 余额：供应商接口现查的数字，口径由对方定义。
 * 没有单价的服务（阿里云审核按次、高德在免费额度内）不给花费，界面显示「—」，不编一个数。
 */

export type BillingRange = "today" | "7d" | "30d";

export const BILLING_RANGES: readonly BillingRange[] = ["today", "7d", "30d"];

/** 供应商账户余额（现查，网关缓存 60 秒）。 */
export interface BillingBalance {
  status: "ok" | "unconfigured" | "failed";
  /** 可用余额；status ≠ ok 时没有。 */
  amount?: number;
  currency?: string;
  /** 为什么是这个状态（未配置哪个变量、对方回了什么错）。 */
  note?: string;
  /** 供应商控制台：数字不够时一键过去看账单。 */
  consoleUrl: string;
}

/** 卡片下面明细表的一行：模型按 Agent 拆、审核按层拆、地图按接口族拆。 */
export interface BillingRow {
  /** 原始键（Agent 名 / 审核层 / 接口族）；中文名由界面映射。 */
  key: string;
  calls: number;
  promptTokens?: number;
  completionTokens?: number;
  /** 花费估算（元）；没有单价的服务不给。 */
  costEstimate?: number;
}

export interface BillingService {
  /** `deepseek` / `aliyun` / `amap`，以及其它出现在用量账里的模型 provider。 */
  id: string;
  label: string;
  /** 一句话：这家在本机管什么。 */
  role: string;
  /** 本期调用次数。 */
  calls: number;
  /** 本期花费估算（元）。没有单价的服务不给。 */
  costEstimate?: number;
  /** 日额度：已用 / 上限（高德）。只按北京日记，不随时间段变。 */
  quota?: { used: number; limit: number; day: string };
  balance?: BillingBalance;
  /** 口径说明：数字从哪来、有什么不含在内。 */
  note?: string;
  rows: BillingRow[];
}

export interface OwnerBillingSummary {
  range: BillingRange;
  /** 统计窗口（ISO）。`today` 从北京时间当天零点起。 */
  since: string;
  until: string;
  generatedAt: string;
  /** 各服务花费估算之和（元）。 */
  totalCostEstimate: number;
  /**
   * 后台任务（导览预采集、导航规划）的用量是否计入。它们不挂在任何会话下，
   * 只有本机只有一个账号时才能确定是车主的；多于一个账号时不计入，也不分摊。
   */
  background: "included" | "excluded";
  services: BillingService[];
}
