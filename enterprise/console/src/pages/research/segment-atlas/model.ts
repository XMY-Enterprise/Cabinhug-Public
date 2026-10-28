/**
 * 人群分群图谱的视图模型。纯函数。
 *
 * # 抑制态呈现为按规则留白，而非加载失败
 *
 * 卡片、群名与规模仍显示：群的存在不需保密，需保密的是成员及其行为。
 * 因此六行清空、外部验证清空，并用一句原话说明阈值与理由。
 *
 * # `minCell` 只能调大
 *
 * 界面上数字输入的下限是 `RESEARCH_MIN_CELL_VEHICLES`。
 * 允许调小会绕过小单元抑制，因此夹到下限，由单测固定。
 */

export interface SegmentRowsRaw {
  task: string;
  constraint: string;
  alternative: string;
  value: string;
  behavior: string;
  reach: { value: number; kind: "measured" | "estimated" };
}

export interface SegmentAtlasData {
  method: string;
  segments: Array<{
    id?: string;
    name?: string;
    size?: number;
    pct?: number;
    status?: "draft" | "validated" | "suppressed";
    rows?: SegmentRowsRaw;
    externalValidation?: { metric: string; value: number; n: number; verdict: string } | null;
    tags?: string[];
    suppressed?: boolean;
    reason?: string;
  }>;
  similarity: Array<{ a: string; b: string; score: number }>;
  suppressed: Array<{ key: string; reason: string; vehicles: number }>;
}

/**
 * 界面上那个数字输入的下限，与服务端 `RESEARCH_MIN_CELL_VEHICLES`
 * / `@cabinhug/research` 的 `DEFAULT_MIN_CELL_VEHICLES` 同值。
 *
 * 控制台按边界不依赖研究库，因此这里是第二份字面量，改下限须同时改两处。
 * 它只作下限：硬抑制发生在算快照时，本页调大只是进一步收紧显示。
 */
export const MIN_CELL_FLOOR = 10;

/** 抑制卡的原话（Brief 指定，逐字）。 */
export const SUPPRESSED_NOTE =
  "样本 %d 台，低于最小群体阈值 %t 台。为避免小单元再识别，不显示明细。需要 ≥%t 台或改用更粗的分群粒度。";

export function suppressedNote(vehicles: number, threshold: number): string {
  return SUPPRESSED_NOTE.replaceAll("%d", String(vehicles)).replaceAll("%t", String(threshold));
}

export interface SegmentCard {
  id: string;
  name: string;
  size: number;
  pct: number;
  status: "draft" | "validated" | "suppressed";
  statusLabel: string;
  /** 抑制卡：六行为空，只有一句原话。 */
  kind: "normal" | "suppressed";
  note?: string;
  rows: SegmentRowsRaw | null;
  /** 外部验证列：验了用哪个变量、没验就说没验。 */
  externalText: string;
  externalOk: boolean;
  tags: string[];
}

export interface AtlasNode {
  id: string;
  name: string;
  size: number;
  /** 圆面积 ∝ 群大小 → 半径 ∝ √size。 */
  r: number;
  /** 抑制群画虚线灰圈。 */
  dashed: boolean;
}

export interface SegmentAtlasView {
  method: string;
  cards: SegmentCard[];
  nodes: AtlasNode[];
  edges: Array<{ a: string; b: string; score: number; label: string }>;
}

/**
 * 关系图最多画几条边。五个群有十条两两组合，全画会难以辨认；
 * 只画最强的几条，其余见对比表。
 */
export const MAX_EDGES = 5;

const STATUS_LABEL: Record<string, string> = { validated: "已验证", draft: "draft", suppressed: "样本不足" };

/** 关系图圆半径。面积正比于群大小，最小 14px 保证小群仍可点。 */
export function radiusOf(size: number, maxSize: number, maxR = 44): number {
  if (maxSize <= 0) return 14;
  return Math.max(14, Math.round(maxR * Math.sqrt(size / maxSize)));
}

/**
 * 快照 → 图谱视图。
 *
 * `threshold` 有两个作用：填入抑制卡原话里的阈值，以及再收紧一层显示。
 * 快照已按服务端阈值抑制过一遍，页面调大只会让更多群变成抑制态，
 * 不会让已抑制的群露出明细（`clampMinCell` 保证它不小于下限）。
 */
export function segmentAtlasView(data: SegmentAtlasData, threshold: number): SegmentAtlasView {
  const suppressedBy = new Map(data.suppressed.map((s) => [s.key, s]));

  const cards: SegmentCard[] = data.segments.map((s) => {
    const id = String(s.id ?? "");
    const size = s.size ?? 0;
    const isSuppressed = s.status === "suppressed" || size < threshold;
    const sup = suppressedBy.get(id);
    const ev = s.externalValidation;

    return {
      id,
      name: String(s.name ?? id),
      size,
      pct: s.pct ?? 0,
      // 因阈值调大而被抑制的群，状态同步改为抑制，避免 draft 标签配空明细。
      status: isSuppressed ? "suppressed" : (s.status ?? "draft"),
      statusLabel: isSuppressed ? STATUS_LABEL.suppressed : (STATUS_LABEL[s.status ?? "draft"] ?? "draft"),
      kind: isSuppressed ? "suppressed" : "normal",
      note: isSuppressed ? suppressedNote(sup?.vehicles ?? size, threshold) : undefined,
      // 抑制卡六行清空，保留明细等于未抑制。
      rows: isSuppressed ? null : (s.rows ?? null),
      externalText: isSuppressed
        ? ""
        : ev
          ? ev.verdict === "validated"
            ? `${ev.metric} ${ev.value.toFixed(2)}（n=${ev.n}）`
            : `未验证 —— ${ev.metric} 与全体差异不足`
          : "未验证 —— 缺可区分的外部变量",
      externalOk: !isSuppressed && ev?.verdict === "validated",
      tags: isSuppressed ? [] : (s.tags ?? []),
    };
  });

  // 已验证 → draft → 抑制：后两类排表尾压暗。
  const rank: Record<string, number> = { validated: 0, draft: 1, suppressed: 2 };
  cards.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || b.size - a.size);

  const maxSize = Math.max(0, ...cards.map((c) => c.size));

  return {
    method: data.method,
    cards,
    nodes: cards.map((c) => ({
      id: c.id,
      name: c.name,
      size: c.size,
      r: radiusOf(c.size, maxSize),
      dashed: c.kind === "suppressed",
    })),
    /*
     * 相似度是标准化行为质心的余弦，可以是负数（实测 seg-3 × seg-4 = −0.67），
     * 百分比形式没有意义，因此原样给两位小数，并只画最强的几条。
     * 这里只排序不计算，分数原样来自快照。
     */
    edges: [...data.similarity]
      .sort((x, y) => y.score - x.score)
      .slice(0, MAX_EDGES)
      .map((e) => ({ ...e, label: e.score.toFixed(2) })),
  };
}

/** `minCell` 输入：只能调大，小于配置下限一律夹到下限。 */
export function clampMinCell(input: number, floor: number): number {
  if (!Number.isFinite(input)) return floor;
  return Math.max(floor, Math.round(input));
}
