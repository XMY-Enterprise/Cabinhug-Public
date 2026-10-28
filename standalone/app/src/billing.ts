/**
 * 费用明细页的纯函数（ACR-066）：原始键 → 中文名、金额与 token 的写法。
 *
 * 网关回的是原始键（Agent 名、审核层、高德接口族），中文名在这里映射：它只是显示，
 * 不进契约，换个说法不必动网关。认不出的键原样显示，不猜。
 */
import type { BillingRange, BillingService } from "@cabinhug/shared";

export const RANGE_LABEL: Record<BillingRange, string> = { today: "今天", "7d": "近 7 天", "30d": "近 30 天" };

/** 与 runtime `canonicalAgent()` 同一条规矩：会话后缀不区分 Agent。 */
function canonicalAgent(raw: string): string {
  return raw.replace(/-(task|intent|voice)$/, "");
}

const AGENT_LABEL: Record<string, string> = {
  supervisor: "总调度（理解意图）",
  trip: "行程规划",
  itinerary: "行程规划",
  "trip-plan": "行程规划",
  "tour-plan": "行程编排",
  "trip-review": "行程体检",
  drive: "驾车路线",
  hotel: "住宿",
  tour: "游玩",
  transit: "公共交通",
  ownership: "补能评估",
  nav: "导航规划",
  title: "会话标题",
  "sidecar-filler": "等待时的提示语",
  "dual-probe": "双路检索",
  answer: "回答表述",
  general: "闲聊",
};

export function agentLabel(raw: string): string {
  const canon = canonicalAgent(raw);
  // 导览的三条分支（停车与到达 / 必玩点 / 休憩）各记一个 Agent 名，合称景点导览。
  if (canon === "guide" || canon.startsWith("guide-")) return "景点导览";
  return AGENT_LABEL[canon] ?? raw;
}

const LAYER_LABEL: Record<string, string> = {
  input_moderation: "输入审核（你说的话）",
  output_moderation: "输出审核（助手的回答）",
};

const FAMILY_LABEL: Record<string, string> = {
  place: "地点搜索",
  geocode: "地址转坐标",
  regeo: "坐标转地址",
  district: "行政区查询",
  direction: "路线规划",
  transit: "公交规划",
  weather: "天气",
  other: "其它",
};

/** 明细表一行的名字：按卡片的服务决定查哪张表。 */
export function rowLabel(serviceId: string, key: string): string {
  if (serviceId === "aliyun") return LAYER_LABEL[key] ?? key;
  if (serviceId === "amap") return FAMILY_LABEL[key] ?? key;
  return agentLabel(key);
}

/** 金额：不到一分钱的写「不到 ¥0.01」，免得一屏 ¥0.00 像是没花钱。 */
export function formatMoney(n: number | undefined, currency = "CNY"): string {
  if (n === undefined) return "—";
  const sign = currency === "CNY" ? "¥" : `${currency} `;
  if (n > 0 && n < 0.01) return `不到 ${sign}0.01`;
  return `${sign}${n.toFixed(2)}`;
}

export function formatTokens(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** 高德额度的用量占比，给进度条与警示色用。 */
export function quotaRatio(s: BillingService): number | undefined {
  if (!s.quota || s.quota.limit <= 0) return undefined;
  return Math.min(1, s.quota.used / s.quota.limit);
}

/** 余额那一格的写法：有数写数，没有就写为什么没有。 */
export function balanceText(s: BillingService): string | undefined {
  const b = s.balance;
  if (!b) return undefined;
  if (b.status === "ok") return b.amount === undefined ? "接口没给数字" : formatMoney(b.amount, b.currency);
  return b.status === "unconfigured" ? "未配置" : "查询失败";
}
