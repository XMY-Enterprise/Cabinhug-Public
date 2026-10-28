/**
 * 能力条的决策逻辑。纯函数，没有 React。
 *
 * # 与组件分离
 *
 * 这里有一条需逐条断言的规则（G1 的界面落点：被抑制的格上零按钮），
 * 以及一条常调整的规则（露几个、谁进 `⋯`）。独立成纯函数后可直接断言，
 * 不依赖对样式敏感的渲染快照。
 */

import {
  capabilitiesFor,
  type Capability,
  type SelectionKind,
  type SelectionScope,
} from "@cabinhug/research/capabilities";

/**
 * 主区最多露几个主动词，其余进 `⋯`。
 *
 * 产品决策是"一次只露 2–3 个"。取 3，使普通格上除「归纳这一格」「找反例」外
 * 还能露出第三常用的「换个阈值还成立吗」。
 */
export const RAIL_PRIMARY_MAX = 3;

/** 三层的图标与耗时预期。图标在按钮内，不另起一列。 */
export const TIER_ICON: Record<Capability["tier"], string> = {
  lookup: "🔍",
  write: "✎",
  dialog: "💬",
};

export const TIER_HINT: Record<Capability["tier"], string> = {
  lookup: "即点即出，不调模型",
  write: "要跑 10–60 秒，会烧 token",
  dialog: "多轮对话",
};

/**
 * 哪几条能力已经实现。
 *
 * 这是一张前端常量表：后端的能力目录（`@cabinhug/research` 的 `CAPABILITIES`）
 * 没有 `status` 字段。新能力在后端落地时须同步更新此表，否则按钮保持禁用。
 *
 * `console/test/capability-rail.test.ts` 读取 `research-runtime` 的 `WORKORDER_OF`
 * 与分发分支，与本表不一致时失败。
 */
export const IMPLEMENTED: ReadonlySet<string> = new Set(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "c11", "c12"]);

/**
 * 这条能力在这个范围上做不到，与"还没做"不同。
 *
 * C4 的能力目录把它开在整列上，而分群切分按主题做、主题只按需求码切、
 * 不带场景维度；一整列横跨全部需求码，现有工具无法回答。服务端对这种请求
 * 回 400 `scope_not_supported`，因此界面上这个按钮禁用。
 *
 * 不从 `capabilitiesFor` 里删掉 `col`：删掉会让整列落进"什么都不渲染"的分支，
 * 读者看不到这条能力及其缺席原因。写在这里，原因显示在按钮的 title 上。
 */
const UNSUPPORTED: Readonly<Record<string, Partial<Record<SelectionKind, string>>>> = {
  c4: { col: "整列答不了：分群切分按主题做，而主题只按需求码切、不带场景——请点具体的格或整行" },
};

/** 未实现的能力归哪张单。与 `research-runtime` 的 `WORKORDER_OF` 是同一张表（同上，由测试对账）。 */
export const WORKORDER_OF: Readonly<Record<string, string>> = {
  c1: "M85-06",
  c2: "M85-05",
  c3: "M85-05",
  c4: "M85-05",
  c5: "M85-05",
  c6: "M85-07",
  c7: "M85-07",
  c8: "M85-08",
  c9: "M85-03",
};

export interface RailButton {
  id: string;
  key: string;
  label: string;
  icon: string;
  tier: Capability["tier"];
  disabled: boolean;
  /** 鼠标悬停说明。禁用时点名工单号，启用时说耗时预期。 */
  title: string;
}

export type RailModel =
  | {
      /**
       * G1 的界面落点：被抑制的格与行上一个按钮都不渲染。
       *
       * 判据是 `suppressedReason !== null`，而不是"能力列表为空"。
       * 两者当前等价但语义不同：列表为空也可能是这个范围没有适用的能力，
       * 应显示不同的文案。
       */
      kind: "suppressed";
      note: string;
    }
  | { kind: "empty" }
  | { kind: "rail"; primary: RailButton[]; overflow: RailButton[] };

/** 抑制态那句文案。逐字写在这里，组件只渲染。 */
export const SUPPRESSED_NOTE = "样本不足的格没有可用能力";

const buttonOf = (c: Capability, kind: SelectionKind): RailButton => {
  const unsupported = UNSUPPORTED[c.id]?.[kind];
  const done = IMPLEMENTED.has(c.id);
  const title = unsupported ?? (done ? TIER_HINT[c.tier] : `还没做：由施工单 ${WORKORDER_OF[c.id] ?? "待定"} 落地`);
  return {
    id: c.id,
    key: c.key,
    label: c.title,
    icon: TIER_ICON[c.tier],
    tier: c.tier,
    disabled: !done || unsupported !== undefined,
    title,
  };
};

/**
 * 这一刻的能力条长什么样。
 *
 * 未实现的能力照样渲染但禁用：不渲染会让读者不知道这一页应有这些能力，
 * 可点则会返回 501 技术错误码。
 */
export function railModel(scope: SelectionScope | null, suppressedReason: string | null): RailModel {
  if (suppressedReason !== null) return { kind: "suppressed", note: SUPPRESSED_NOTE };
  if (!scope) return { kind: "empty" };

  const all = capabilitiesFor(scope);
  if (all.length === 0) return { kind: "empty" };

  /*
   * 排序：能点的排前面。
   *
   * 可用的能力优先占据主区，避免主区全是禁用按钮而可用项被挤进 `⋯`。
   * 排序随 `IMPLEMENTED` 自动变化，新实现的能力自动前移。
   */
  const buttons = all.map((c) => buttonOf(c, scope.kind));
  const usable = buttons.filter((b) => !b.disabled);
  const rest = buttons.filter((b) => b.disabled);
  const ordered = [...usable, ...rest];

  return {
    kind: "rail",
    primary: ordered.slice(0, RAIL_PRIMARY_MAX),
    overflow: ordered.slice(RAIL_PRIMARY_MAX),
  };
}
