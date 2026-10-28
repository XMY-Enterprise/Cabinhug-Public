/**
 * codebook → zod schema。
 *
 * # 从 YAML 生成，不手写
 *
 * 手写 zod 会让码表有两个真相源，且二者不一致时编译期不报错：YAML 加了码而
 * schema 没加时，模型返回的新码被 zod 以"invalid enum value"拒掉，难以追溯到根因。
 *
 * # 不用 `.optional()`
 *
 * 每一轴都必填。允许不填某一轴会让"没想好"与"认为是 none"无法区分：
 * 前者应进 `uncertain`，后者是一个真实的判断。
 */

import { z } from "zod";

import type { Codebook, CodebookAxis } from "../codebook/load";

/** 单条编码的公共形状：码 + 把握 + 依据。 */
function codeEntry(codeIds: [string, ...string[]]) {
  return z.object({
    code: z.enum(codeIds),
    /** 模型自报的把握。只用于排序与"要不要人工复核"，不进置信 C。 */
    confidence: z.number().min(0).max(1),
    /** 依据一句话。限长让模型给出判断而不是展开论证。 */
    rationale: z.string().max(60),
  });
}

function axisSchema(axis: CodebookAxis): z.ZodTypeAny {
  const ids = axis.codes.map((c) => c.id);
  if (ids.length === 0) throw new Error(`codebook_invalid: 轴 ${axis.id} 没有码`);
  const enumIds = ids as [string, ...string[]];

  if (axis.cardinality === "multi") {
    const max = axis.max ?? 3;
    // 多选轴：至少一个（"什么都不是"要显式选 none 那个码，不是空数组）。
    return z.array(codeEntry(enumIds)).min(1).max(max);
  }

  const single = codeEntry(enumIds);
  if (!axis.intensity) return single;
  // 情绪轴多一个 0–3 强度与可选的次可能码；一致率低的轴通常在这一列上有分歧。
  return single.extend({
    intensity: z.number().int().min(0).max(3),
    competing: z.enum(enumIds).nullable(),
  });
}

/** 一个证据单元的完整编码结果。 */
export function unitCodingSchema(book: Codebook): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {
    unitId: z.string().min(1),
    /** 模型明确表示拿不准；这些是 gold set 的首批候选。 */
    uncertain: z.boolean(),
  };
  for (const axis of book.axes) shape[axis.id] = axisSchema(axis);
  return z.object(shape);
}

/** 一批的结果。批 ≤ 20，schema 同样限定上界。 */
export function batchCodingSchema(book: Codebook): z.ZodTypeAny {
  return z.object({ codings: z.array(unitCodingSchema(book)).min(1).max(20) });
}

/** 一条落库行（对应 `research_codings` 的一行）。 */
export interface FlatCoding {
  unitId: string;
  axis: string;
  code: string;
  confidence: number;
  rationale: string;
  competingCode: string | null;
  uncertain: boolean;
}

type AxisValue =
  | { code: string; confidence: number; rationale: string; intensity?: number; competing?: string | null }
  | Array<{ code: string; confidence: number; rationale: string }>;

/**
 * 把一个单元的结果按轴展开成多行。多标签 = 多行（`research_codings` 的表设计）。
 *
 * 情绪强度落在 `rationale` 前缀里而不另开一列：只有一轴有强度，不为它改表。
 * 读取时按 `axis === 'emotion'` 解析，口径以此处为准。
 */
export function flatten(unit: Record<string, unknown>): FlatCoding[] {
  const unitId = String(unit.unitId ?? "");
  const uncertain = unit.uncertain === true;
  const out: FlatCoding[] = [];

  for (const [axis, value] of Object.entries(unit)) {
    if (axis === "unitId" || axis === "uncertain") continue;
    const v = value as AxisValue;
    if (Array.isArray(v)) {
      for (const item of v) {
        out.push({
          unitId, axis, code: item.code, confidence: item.confidence,
          rationale: item.rationale, competingCode: null, uncertain,
        });
      }
      continue;
    }
    const intensity = typeof v.intensity === "number" ? `[强度${v.intensity}] ` : "";
    out.push({
      unitId, axis, code: v.code, confidence: v.confidence,
      rationale: `${intensity}${v.rationale}`,
      competingCode: v.competing ?? null,
      uncertain,
    });
  }
  return out;
}
