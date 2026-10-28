/**
 * 主题聚类。
 *
 * # 聚类对象是"同一个需求码内的嵌入"，不是全语料
 *
 * 对全语料聚类，第一刀几乎必然是已知的"场景"。先按 `need_pain` 码切、再在码内
 * 按嵌入聚，得到的是"同一个痛点下的不同说法"，这是 codebook 尚未覆盖的粒度。
 *
 * # 反例成员进 counter_unit_ids，不进 member_unit_ids
 *
 * 主题必须保留反例成员（`research_themes` 的设计）。当作普通成员会让"证据量"虚高，
 * 丢掉则会让主题在任何图上都显得证据充分，因此单独一列。
 */

import { kmeans } from "./segments";

/** 一条参与聚类的单元。 */
export interface ThemeCandidate {
  unitId: string;
  needPainCode: string;
  /** `polarity === 'counter-example'`。 */
  isCounter: boolean;
  text: string;
  embedding: number[];
}

export interface ThemeCluster {
  needPainCode: string;
  /** 簇内序号，拼 id 用。 */
  index: number;
  memberUnitIds: string[];
  counterUnitIds: string[];
  centroid: number[];
  /** 离质心最近的 5 条，喂给 Namer。 */
  examples: string[];
  counterExamples: string[];
}

/** 一个码下少于它就不再细分——3 条话分不出两种说法。 */
export const MIN_CLUSTER_INPUT = 6;

/** 码内簇数上限。POC 车队规模下超过 4 只会切出噪声。 */
export const MAX_CLUSTERS_PER_CODE = 4;

function distance(a: readonly number[], b: readonly number[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i += 1) d += (a[i] - b[i]) ** 2;
  return Math.sqrt(d);
}

/**
 * 簇数：按候选条数定，不做肘部法。
 *
 * 车队规模下肘部图接近直线，选出的 k 更多反映随机种子而不是数据结构，
 * 且不确定（同一份数据两次可能得到不同 k，违反 `inputsHash` 的不变量）。
 */
export function clusterCountFor(n: number): number {
  if (n < MIN_CLUSTER_INPUT) return 1;
  return Math.min(MAX_CLUSTERS_PER_CODE, Math.max(2, Math.round(Math.sqrt(n / 4))));
}

export function buildThemeClusters(candidates: readonly ThemeCandidate[]): ThemeCluster[] {
  const byCode = new Map<string, ThemeCandidate[]>();
  for (const c of candidates) {
    if (c.needPainCode === "none") continue;
    const list = byCode.get(c.needPainCode) ?? [];
    list.push(c);
    byCode.set(c.needPainCode, list);
  }

  const out: ThemeCluster[] = [];
  // 码序固定：同输入必同输出（Map 的插入序随数据变，显式排序才稳）。
  for (const code of [...byCode.keys()].sort()) {
    const list = [...(byCode.get(code) ?? [])].sort((a, b) => a.unitId.localeCompare(b.unitId));
    const k = clusterCountFor(list.length);
    const { assignments, centroids } = kmeans(
      list.map((c) => c.embedding),
      k,
    );

    for (let j = 0; j < centroids.length; j += 1) {
      const members = list.filter((_, i) => assignments[i] === j);
      if (members.length === 0) continue;
      const centroid = centroids[j];
      const byNearest = [...members].sort((a, b) => distance(a.embedding, centroid) - distance(b.embedding, centroid));

      out.push({
        needPainCode: code,
        index: j,
        // 反例成员不进 member_unit_ids（见文件头）。
        memberUnitIds: members.filter((m) => !m.isCounter).map((m) => m.unitId),
        counterUnitIds: members.filter((m) => m.isCounter).map((m) => m.unitId),
        centroid,
        examples: byNearest.filter((m) => !m.isCounter).slice(0, 5).map((m) => m.text),
        counterExamples: byNearest.filter((m) => m.isCounter).slice(0, 2).map((m) => m.text),
      });
    }
  }
  return out;
}
