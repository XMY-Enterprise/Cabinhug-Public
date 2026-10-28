/**
 * 五个镜头共用的输入形状与口径常量。
 *
 * # "一轮编码后的样子"拍平成一个类型
 *
 * `research_codings` 是一行一码（多标签多行）。五个镜头要的都是"这一轮是什么"，
 * 拼装逻辑只写一份，避免各页面对同一件事给出不一致的数。
 *
 * # 算法版本进 inputsHash
 *
 * 改任何聚合规则必须升 `LENS_ALGO_VERSION`，否则旧快照会被当成新的复用，
 * 表现为"改了口径但图没变"且 `computedAt` 不变。
 */

import { createHash } from "node:crypto";

/**
 * 聚合算法版本。改任何一个镜头的算法都要升它。
 *
 * v1：证据矩阵 n/N + 方向 ±3pp；IPA 提及代理 + Wilson 区间；
 * 情绪 × 任务含 mixed/uncertain 独立计数；分群 k=5 z-score；趋势按周分桶。
 * v2：整行"不可交付"从"有任意一轮硬禁"改成过半才算（见 `UNDELIVERABLE_ROW_SHARE`）。
 * v3：证据矩阵的兜底桶 `other` 不参与十行排名，排完后单独接在最后
 * （见 `CATCH_ALL_NEED_PAIN`）。
 */
export const LENS_ALGO_VERSION = "lens-v3";

/** 方向判定的死区：近 90 天 vs 前 90 天，±3 个百分点内算持平。 */
export const DIRECTION_DEADBAND_PP = 0.03;

/**
 * 一轮编码后的样子。五个镜头都吃它。
 *
 * `resolved` 是启发式：无追问 / 无打断 / 无拦截。
 * 口径必须原样写进快照，否则页面上的"表现度"会被读成"答对率"。
 */
export interface CodedTurn {
  unitId: string;
  turnId: string | null;
  vin: string | null;
  occurredAt: number;
  scene: string | null;
  /** 多选轴，一轮可能有 1–3 个。 */
  needPains: string[];
  job: string | null;
  emotion: string | null;
  /** 0–3；没有情绪轴或解析不出时 null。 */
  emotionIntensity: number | null;
  polarity: string | null;
  deliverability: string | null;
  /** 这一轮"算解决了"——见上文，是启发式不是判定。 */
  resolved: boolean;
}

/** 口径说明，逐字进快照。改这里等于改口径，要同时升 `LENS_ALGO_VERSION`。 */
export const BASIS_NOTES = {
  performance: "表现度 = 该轮无追问、无打断、无拦截（启发式：同会话 5 分钟内同 route 再来一轮算追问）",
  importance: "重要度 = 提及代理（该码命中轮次 / 窗口内总轮次）",
  denominators: "分母是该场景下的去重轮次。一轮可归多个需求码，因此各行之和会大于总轮次",
} as const;

/** 码 → 展示名。取自 codebook 的 label，调用方从 codebook 里取。 */
export type LabelMap = Record<string, string>;

export const labelOf = (labels: LabelMap, code: string): string => labels[code] ?? code;

/**
 * `inputsHash`：保证同输入同输出。
 *
 * 取材必须覆盖所有会改变结果的东西：合同、窗口、codebook 版本、
 * 参与的单元 id（排序后）、编码行数、算法版本。漏掉任何一项，
 * 该项变化时会复用旧快照。
 */
export function inputsHashOf(input: {
  contractId: string;
  windowFrom: number;
  windowTo: number;
  codebookVersion: string;
  unitIds: readonly string[];
  codingRows: number;
}): string {
  const ids = [...input.unitIds].sort().join(",");
  return createHash("sha256")
    .update(
      [
        input.contractId,
        String(input.windowFrom),
        String(input.windowTo),
        input.codebookVersion,
        LENS_ALGO_VERSION,
        String(input.codingRows),
        ids,
      ].join("\n"),
    )
    .digest("hex");
}

/** 去重轮次。一个单元一轮；`turnId` 缺席时退回 unitId（行为单元不进话语分母）。 */
export function distinctTurns(turns: readonly CodedTurn[]): number {
  return new Set(turns.map((t) => t.turnId ?? t.unitId)).size;
}

/** 这一批覆盖多少台车——小单元抑制看它。 */
export function distinctVehicles(turns: readonly CodedTurn[]): number {
  return new Set(turns.map((t) => t.vin).filter((v): v is string => v !== null)).size;
}

/**
 * Wilson 置信区间（95%）。
 *
 * 不用正态近似：n 很小时（研究面常态）正态近似会给出负下界，误差棒穿过 0 轴。
 */
export function wilson(successes: number, total: number): { lo: number; hi: number } {
  if (total === 0) return { lo: 0, hi: 0 };
  const z = 1.96;
  const p = successes / total;
  const d = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return { lo: Math.max(0, (centre - spread) / d), hi: Math.min(1, (centre + spread) / d) };
}

/** 方向：近半窗 vs 前半窗的提及率变化。 */
export function directionOf(recentRate: number, priorRate: number): "up" | "down" | "flat" {
  const delta = recentRate - priorRate;
  if (Math.abs(delta) < DIRECTION_DEADBAND_PP) return "flat";
  return delta > 0 ? "up" : "down";
}
