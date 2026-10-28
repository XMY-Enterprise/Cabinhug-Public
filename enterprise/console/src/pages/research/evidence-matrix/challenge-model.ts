/**
 * 挑战记录与追问的判定。纯函数，不画界面。
 *
 * # verdict 四态各有措辞，没有默认兜底
 *
 * 不用 `default:` 分支，否则第五种取值会被静默显示成"未知"或某一既有档。
 * 这里用穷举表 + `VERDICTS` 白名单，表外取值走 `unknownVerdict()`，
 * 并在界面上明示它是表外的，以便发现。
 *
 * # 「还能追问几次」不是「还剩几次调用」
 *
 * 上限约束的是同一张卡被追问的次数（3），不是工具步数（8，`CHALLENGE_MAX_STEPS`）。
 * 两个上限不在同一层，因此这里只数 `payload.angle` 非空的记录，
 * 与服务端 `isFollowUp` 同一条判据。
 */

import type { ChallengeRecord } from "../../../api/research-challenge";

/** 同一张卡最多追问几次。与服务端 `FOLLOW_UP_MAX_ROUNDS` 同一个值。 */
export const FOLLOW_UP_MAX_ROUNDS = 3;

/** 追问框的字数上限，与规则筛的 `MAX_INPUT_CHARS` 同值，超出时服务端拒绝。 */
export const MAX_ANGLE_CHARS = 500;

export type VerdictKind = "holds" | "weakened" | "refuted" | "inconclusive";

export const VERDICTS: readonly VerdictKind[] = ["holds", "weakened", "refuted", "inconclusive"];

export interface VerdictView {
  kind: string;
  label: string;
  /** 这个判决意味着要做什么，而不是复述它的英文名。 */
  meaning: string;
  /** 样式档：`ok` / `warn` / `bad` / `dim`。 */
  tone: "ok" | "warn" | "bad" | "dim";
  /** 表外的取值。界面须明示，不能静默显示成别的档。 */
  unknown?: true;
}

const TABLE: Record<VerdictKind, Omit<VerdictView, "kind">> = {
  holds: {
    label: "站得住",
    // holds 的价值在于"认真找过"，措辞点出查找手段。
    meaning: "带着四个只读工具找过反例，没找到能推翻它的证据",
    tone: "ok",
  },
  weakened: {
    label: "被削弱",
    meaning: "找到了与它矛盾的证据，结论还在但边界要收窄",
    tone: "warn",
  },
  refuted: {
    label: "被推翻",
    // refuted 不会自动把卡降级，降级与升级一样是人工决定。
    meaning: "证据不支持这个结论。卡片不会因此自动降级——降级是人工决定",
    tone: "bad",
  },
  inconclusive: {
    label: "没查清",
    /*
     * inconclusive 容易被误读成 holds。"没查完"不是"查过了没问题"，
     * 措辞须说明这一区别。
     */
    meaning: "工具步数用满了还没查清楚。这不等于它没问题，只等于这一轮没问出来",
    tone: "dim",
  },
};

/** 表外的取值。不并进任何一档，保证模型返回的新取值可被发现。 */
const unknownVerdict = (kind: string): VerdictView => ({
  kind,
  label: kind,
  meaning: "这个判决不在四态里（holds / weakened / refuted / inconclusive）——界面没有对应的措辞，回去核对 challengeSchema",
  tone: "dim",
  unknown: true,
});

export function verdictOf(kind: string): VerdictView {
  return VERDICTS.includes(kind as VerdictKind)
    ? { kind, ...TABLE[kind as VerdictKind] }
    : unknownVerdict(kind);
}

/**
 * 三类挑战的中文名。表外的取值原样显示，不换成"其他"，
 * 保证模型返回的新 kind 可被发现。
 */
const KIND_LABEL: Record<string, string> = {
  "counter-evidence": "反例",
  "alternative-explanation": "替代解释",
  sensitivity: "敏感性",
};

/** 这条记录是不是追问产生的。判据与服务端 `isFollowUp` 逐字相同。 */
export const isFollowUp = (r: ChallengeRecord): boolean =>
  typeof r.payload?.angle === "string" && r.payload.angle.trim().length > 0;

/**
 * 追问过几轮。
 *
 * 一轮追问会写多条记录（`challengeSchema` 允许一次返回 1–6 条，实测一次写入 3 条），
 * 因此按轮计数而不是按记录条数，否则一次追问可能耗尽全部额度。
 * 与服务端 `followUpRounds` 同一条口径。
 */
export const followUpRounds = (records: readonly ChallengeRecord[]): number => {
  const rounds = new Set<string>();
  for (const r of records) {
    if (!isFollowUp(r)) continue;
    // 一次点击对应一个 runId。老记录没有 runId 时退回 angle，同一轮内 angle 相同。
    rounds.add(r.payload!.runId ? `run:${r.payload!.runId}` : `angle:${r.payload!.angle!.trim()}`);
  }
  return rounds.size;
};

export interface ChallengeRow {
  id: string;
  /** 挑的是哪一类：反例 / 替代解释 / 敏感性。这一列没有"追问"这一类。 */
  kind: string;
  verdict: VerdictView;
  /** 模型给的一句话摘要。缺失时如实说明，不用 verdict 的措辞代替。 */
  summary: string;
  /** 走了几步工具循环。`null` 表示这条记录没有记录步数（老记录）。 */
  steps: number | null;
  /** 追问的角度。非 null 即这条是追问产生的。 */
  angle: string | null;
  /** 矛盾证据单元数。0 与「没查」不同，因此恒给数字。 */
  contradicted: number;
  createdBy: string;
}

export function challengeRows(records: readonly ChallengeRecord[]): ChallengeRow[] {
  return records.map((r) => ({
    id: r.id,
    kind: KIND_LABEL[r.kind] ?? r.kind,
    verdict: verdictOf(r.verdict),
    summary: r.payload?.summary?.trim() || "（这条记录没有摘要）",
    steps: typeof r.payload?.steps === "number" ? r.payload.steps : null,
    angle: isFollowUp(r) ? r.payload!.angle!.trim() : null,
    contradicted: r.contradictedUnitIds?.length ?? 0,
    createdBy: r.createdBy,
  }));
}

export interface FollowUpState {
  used: number;
  remaining: number;
  /** 还能不能问。到顶时为 false，输入框与按钮按此禁用。 */
  can: boolean;
  /** 当前状况的说明。到顶时说明为什么不再允许追问。 */
  note: string;
}

export function followUpState(records: readonly ChallengeRecord[]): FollowUpState {
  const used = followUpRounds(records);
  const remaining = Math.max(0, FOLLOW_UP_MAX_ROUNDS - used);
  return {
    used,
    remaining,
    can: remaining > 0,
    note:
      remaining > 0
        ? `还能追问 ${remaining} 次（同一张卡最多 ${FOLLOW_UP_MAX_ROUNDS} 次）`
        : /*
           * 到顶时说明设这个上限的原因，而不只是"次数用完了"，
           * 引导用户重写卡片而非寻找放开限制的办法。
           */
          `这张卡已经追问过 ${FOLLOW_UP_MAX_ROUNDS} 次。再问下去多半不是证据不够，而是这张卡本身该被重写`,
  };
}

/**
 * 这段追问文本发不发得出去。
 *
 * 前端只拦空与超长两样，不复制 9 条注入规则：两份规则表会漂移。
 * 服务端那一份（`@cabinhug/guardrails` 的规则筛）是唯一的判据。
 */
export function angleIssue(text: string): string | null {
  const t = text.trim();
  if (!t) return "追问要说清追的是什么";
  if (t.length > MAX_ANGLE_CHARS) return `追问请控制在 ${MAX_ANGLE_CHARS} 字以内（现在 ${t.length} 字）`;
  return null;
}
