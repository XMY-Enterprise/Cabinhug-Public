/**
 * 档案页的视图类型。
 *
 * 契约真相源在服务端（`@cabinhug/memory` 的 `VehicleProfile`）；端上不 import
 * 服务端包，这里是视图侧的读形状：只列页面用到的字段，多余字段忽略。
 */

export interface VehicleView {
  vin: string;
  model: string;
  modelYear: number;
  purchasedAt: number;
  odometerKm: number;
  maintenanceIntervalKm?: number;
  energyType?: "bev" | "phev" | "icev";
  /**
   * 本人对这辆车的角色（AC-55-3）。列表 = 拥有的 ∪ 被授权的，
   * 端上据此区分"我的车"与"使用中·车主某某"，并决定要不要渲染管理入口。
   * 可选：服务端未接授权查询时缺席，按 owner 处理。
   */
  myRole?: "owner" | "driver" | "passenger";
  maintenance: Array<{ at: number; odometerKm: number; items: string; source: string }>;
  /**
   * `resolution` 是服务端留档时写的处置摘要；问诊留档的那条以固定前缀
   * `【低风险】` / `【中风险】` / `【高风险】` 开头（`service.ts` 的 `RISK_LABEL`）。主页卡按前缀取等级，
   * 比对的是服务端自己写的字面，不是模型输出。
   */
  repairs: Array<{ at: number; odometerKm: number; symptom: string; source: string; resolution?: string }>;
  /** 保养推算（服务端 forecastMaintenance 计算随档案带出；建档响应里可能缺席）。 */
  forecast?: {
    remainingKm: number;
    /** 网关端点拿不到⑥日均里程 → 恒缺席；有值才显示时间。 */
    etaDays?: number;
    basis: string[];
    degraded: boolean;
  };
  /**
   * 这辆车的车型关联到哪些知识库资料。
   * 字段缺席表示网关没接知识库，与"这一款没有资料"不同。
   */
  knowledge?: {
    state: "live" | "stale" | "unavailable";
    links: Array<{ dataset: string; datasetName: string; documents: string[] }>;
    reason?: string;
  };
}

/**
 * 关联关系一行文案，三态：有资料列出来、没资料明说、读不到说读不到。
 * 读不到不能写成没资料。
 */
export function knowledgeLine(k: VehicleView["knowledge"]): string {
  if (!k || k.state === "unavailable") {
    return `知识库：暂时读不到覆盖情况${k?.reason ? `（${k.reason}）` : ""}`;
  }
  const stale = k.state === "stale" ? "（可能不是最新）" : "";
  if (k.links.length === 0) return `知识库：暂无这一款的资料${stale}`;
  return `知识库${stale}：${k.links.map((l) => `${l.datasetName} ${l.documents.length} 篇`).join("、")}`;
}

/** 占位 VIN 判据——与网关 `PENDING_VIN_PREFIX` 一致；据此显示"补充 VIN"提示。 */
export function isPendingVin(vin: string): boolean {
  return vin.startsWith("PEND-");
}

export const ENERGY_LABEL: Record<NonNullable<VehicleView["energyType"]>, string> = {
  bev: "纯电",
  phev: "插电混动",
  icev: "燃油",
};

/** 列表数据的四态。offline ≠ empty：取不到数据时不能显示"还没有车辆"。 */
export type VehicleListState =
  | { kind: "loading" }
  | { kind: "offline"; reason: string }
  | { kind: "empty" }
  | { kind: "ready"; vehicles: VehicleView[] };

// ── 常用人员（F-46-11）────────────────────────────────────────

export type MemberRole = "driver" | "passenger";

export const MEMBER_ROLE_LABEL: Record<MemberRole, string> = {
  driver: "常驾",
  passenger: "常乘",
};

export type MemberAgeBand = "adult" | "senior" | "child";

export const AGE_BAND_LABEL: Record<MemberAgeBand, string> = {
  adult: "成人",
  senior: "老人",
  child: "儿童",
};

/**
 * 出行硬约束词表，与服务端 `@cabinhug/shared` 的 `MEMBER_NEEDS` 同源。
 * 端上不 import 服务端包，所以这里是它的视图侧副本：
 * key 必须逐字一致，否则提交会被网关按"未知词表项"拒掉。
 */
export const MEMBER_NEEDS: ReadonlyArray<{ key: string; label: string }> = [
  { key: "motion_sickness", label: "晕车" },
  { key: "restroom", label: "需卫生间" },
  { key: "child_seat", label: "儿童安全座椅" },
  { key: "mobility", label: "腿脚不便" },
  { key: "fatigue", label: "易疲劳" },
];

export const NEED_LABEL = new Map(MEMBER_NEEDS.map((n) => [n.key, n.label]));

export interface MemberView {
  id: string;
  vin: string;
  displayName: string;
  relation?: string;
  roles: MemberRole[];
  ageBand?: MemberAgeBand;
  needs: string[];
  note?: string;
}

/** 与车辆列表同样的四态。offline ≠ empty：读不到名单不能显示"还没有常用人员"。 */
export type MemberListState =
  | { kind: "loading" }
  | { kind: "offline"; reason: string }
  | { kind: "empty" }
  | { kind: "ready"; members: MemberView[] };

// ── ⑥用车画像 / 按人画像 / ③偏好 ─────────────────────────────
//
// 形状与车机端 `clients/cockpit/src/features/ownership/types.ts` 保持一致，
// 保证同一个"样本不足"在两端说法相同。

export interface UsageSummaryView {
  windowDays: number;
  avgDailyKm: number;
  commonChargeHours: number[];
  dominantRoadType?: string;
  sampleSize: number;
  staleDays: number | null;
  derivation: string[];
}

export interface UsageProfileView {
  summary: UsageSummaryView;
  verdict: { usable: boolean; reason?: string };
  fetched: number;
}

/**
 * 画像五态。`unconfigured` 与 `unusable` 必须分开：
 * 前者是"我们没接上"，后者是"你的数据还不够"。
 * 合并会把系统故障说成用户开得太少。
 */
export type UsageState =
  | { kind: "loading" }
  | { kind: "offline"; reason: string }
  | { kind: "unconfigured"; reason: string }
  | { kind: "unusable"; reason: string; sampleSize: number }
  | { kind: "ready"; profile: UsageProfileView };

export interface MemberUsageView {
  kind: "driver" | "companion";
  /** `vehicle` = 回落到整车口径，必须在界面上说明。 */
  scope?: "member" | "vehicle";
  summary: Partial<UsageSummaryView> & {
    sampleSize: number;
    staleDays: number | null;
    commonHours?: number[];
  };
  verdict: { usable: boolean; reason?: string };
}

export type MemberUsageState =
  | { kind: "loading" }
  | { kind: "offline"; reason: string }
  | { kind: "unconfigured"; reason: string }
  | { kind: "unusable"; reason: string; sampleSize: number }
  | { kind: "ready"; usage: MemberUsageView };

export interface PreferenceView {
  id?: string;
  content: string;
  domain?: string;
}

/** `offline` 也承载 Mem0 的 degraded：这次没查到不代表没有。 */
export type PreferenceState =
  | { kind: "loading" }
  | { kind: "offline"; reason: string }
  | { kind: "unconfigured"; reason: string }
  | { kind: "empty" }
  | { kind: "ready"; preferences: PreferenceView[] };

const ROAD_LABEL: Record<string, string> = {
  city: "城市道路为主",
  highway: "高速为主",
  mixed: "城市与高速混合",
};

export function roadTypeLabel(t: string | undefined): string | undefined {
  return t ? (ROAD_LABEL[t] ?? t) : undefined;
}

/** `[19,20,21]` → `19:00–21:00`；不连续则逐个列出。 */
export function chargeHoursLabel(hours: number[]): string | undefined {
  if (hours.length === 0) return undefined;
  const s = [...hours].sort((a, b) => a - b);
  const contiguous = s.every((h, i) => i === 0 || h === s[i - 1]! + 1);
  const fmt = (h: number) => `${String(h).padStart(2, "0")}:00`;
  return contiguous && s.length > 1 ? `${fmt(s[0]!)}–${fmt(s.at(-1)!)}` : s.map(fmt).join("、");
}

/** VIN 掩码（定稿 `LS6•••••8921`）。占位 VIN 不走这里，它不渲染。 */
export function maskVin(vin: string): string {
  return vin.length <= 7 ? vin : `${vin.slice(0, 3)}•••••${vin.slice(-4)}`;
}

/**
 * 车辆成员授权（F-55-07）。
 *
 * 与 `MemberView`（影子成员档案）不同：那边是"车上常有谁"（可以没有账号，
 * 有称呼/关系/出行约束）；这边是"谁能登录用这辆车"（必须有账号，只有角色）。
 * 两块 UI 分开摆，因为生命周期独立：删档案不撤授权，撤授权不删档案。
 */
export interface GrantView {
  userId: string;
  /** 账号自设的称呼，不是车主给家人起的叫法（那是他人 PII，F-46-13）。 */
  displayName?: string;
  role: "owner" | "driver" | "passenger";
}

/** 同样的四态。offline ≠ empty：读不到名单不等于这辆车没分享给任何人。 */
export type GrantListState =
  | { kind: "loading" }
  | { kind: "offline"; reason: string }
  | { kind: "empty" }
  | { kind: "ready"; grants: GrantView[] };

export const GRANT_ROLE_LABEL: Record<GrantView["role"], string> = {
  owner: "车主",
  driver: "驾驶",
  passenger: "乘坐",
};
