/**
 * 测评报告的共享渲染。
 *
 * # 报告是测评口径，不是测试日志
 *
 * 受众不同：报告的读者要知道「什么模型、什么档位、哪个数据集、
 * n/N 多少、指标怎么读」，盯终端的人才需要逐 case 的 ✅/❌ 进度行。因此：
 *  - 进度行只属于 stdout，报告正文不出现 ✅/❌（report.test.ts 有机器守卫）；
 *  - 失败以「case 明细」呈现：id、原话、失败原因，供分析用，不是执行记录；
 *  - 头部是运行元数据表，首屏即说明数字的适用范围
 *    （抽样运行不声明 n/N 时，5 条的通过率会被误读为 86 条的结论）。
 *
 * # 只渲染，不算数
 *
 * 渲染函数都是纯函数（数据进、markdown 字符串出，零 IO、零统计）。
 * 指标的计算留在各 runner 既有的统计代码里，渲染层不重算，
 * 避免同一个数字出现第二个真相源。
 */

import { type Score, scoreRate, totalScore } from "./score";

export interface RunMeta {
  /** 测评名（报告 H1），如「核心场景评估（eval:scenarios）」。 */
  name: string;
  /** 档位描述，如「fake（确定性）」「real（真实 LLM）+ 审核层已接入」。 */
  tier: string;
  /** 本次作答的模型：fake 档就是 `fake`，real 档是实际模型 id。 */
  model: string;
  /** 数据集全量条数。 */
  total: number;
  /** 本次选中条数（全量运行时等于 total）。 */
  selected: number;
  /** 运行时间（ISO）。 */
  at: string;
  /** 忠实还原本次调用的复跑命令。 */
  command: string;
}

/** 报告头部：H1 + 元数据表；抽样运行（selected < total）时带一条显眼的范围声明。 */
export function runMeta(m: RunMeta): string {
  const sampled = m.selected < m.total;
  const lines = [
    `# ${m.name}`,
    "",
    ...(sampled
      ? [
          `> ⚠ **抽样运行（${m.selected}/${m.total}）**：本报告的通过率/拦截率只覆盖本次选中的条目，`,
          "> 不代表数据集全量基线；小分母下单个 case 的波动会被放大。",
          "",
        ]
      : []),
    "| 项 | 值 |",
    "|---|---|",
    `| 档位 | ${m.tier} |`,
    `| 模型 | \`${m.model}\` |`,
    `| 数据集 | ${m.total} 条 |`,
    `| 本次选中 | ${m.selected} 条${sampled ? `（抽样 ${m.selected}/${m.total}）` : "（全量）"} |`,
    `| 运行时间 | ${m.at} |`,
    `| 复跑 | \`${m.command}\` |`,
    "",
  ];
  return lines.join("\n");
}

/** 「总分 / 满分」块——报告首屏，紧跟元数据表；计分规则见 score.ts 文件头。 */
export function scoreBlock(rows: ReadonlyArray<Score>, opts: { total?: boolean } = {}): string {
  const all = opts.total ? [...rows, totalScore(rows)] : rows;
  const lines = [
    "## 总分",
    "",
    "> 每题 1 分：判定通过 / 拦住计 1，失败 / 漏拦计 0；**满分 = 本轮有判定的题数**，未判定的题不进满分（见备注）。",
    "> 与指标表的 M-P1 / M-R1 / M-M1 同一分母，只是换成一眼能读的形式。",
    "",
    "| 测评 | 总分 / 满分 | 得分率 | 备注 |",
    "|---|---|---|---|",
  ];
  for (const r of all) {
    const name = r.name === "合计" ? "**合计**" : r.name;
    const score = r.max === 0 ? "—" : `**${r.got} / ${r.max}**`;
    lines.push(`| ${name} | ${score} | ${scoreRate(r)} | ${r.note ?? "—"} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export interface FailureRow {
  id: string;
  /** 场景 / 攻击类别等归属标签。 */
  group: string;
  /** 用户原话。 */
  input: string;
  /** 失败原因，逐条。 */
  reasons: string[];
}

/**
 * 失败 case 明细——测评报告里的「case 分析」节，不是失败用例列表。
 * 空数组输出固定句，让"没有失败"是一个明确的陈述而不是一片空白。
 */
export function failureSection(rows: FailureRow[]): string {
  if (rows.length === 0) return "## 失败 case 明细\n\n本次运行无失败 case。\n";
  const lines = [`## 失败 case 明细（${rows.length} 条）`, ""];
  for (const r of rows) {
    lines.push(`### \`${r.id}\`（${r.group}）`, "", `原话：「${r.input}」`, "");
    for (const reason of r.reasons) lines.push(`- ${reason}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * 从 argv 忠实拼回复跑命令（含全部过滤参数原文，不手写模板）。
 *
 * 裸 `--` 要滤掉：`corepack pnpm X -- --resume` 里那个分隔符有时会原样进 argv，
 * 拼出来就是 `-- -- --resume`。复跑命令必须能被逐字复制执行。
 */
export function replayCommand(npmScript: string, argv: string[]): string {
  const args = argv.filter((a) => a.trim().length > 0 && a !== "--");
  return args.length ? `corepack pnpm ${npmScript} -- ${args.join(" ")}` : `corepack pnpm ${npmScript}`;
}

/**
 * 时延分位（§14 M-L1）：n ≥ 10 报 P50/P95；n < 10 退化为 null（调用方逐条列）。
 * 分位取最近秩（ceil(q·n) 的第 k 个，1 起）；样本小，不做插值。
 */
export function latencyPercentiles(ms: number[]): { p50: number; p95: number } | null {
  if (ms.length < 10) return null;
  const xs = [...ms].sort((a, b) => a - b);
  const at = (q: number): number => xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(q * xs.length) - 1))];
  return { p50: at(0.5), p95: at(0.95) };
}

// ── 指标结果总表 ─────────────────────────────

/**
 * 缺席的三种语义，不可合并成"—"。
 * 「本档位不适用」是设计使然（fake 档没有 real 才有的断言）；「未跑」是这次没测；
 * 「无法计算」是产物代次不符（metricsVersion 门）。三者对读者的含义完全不同：
 * 第一种无需行动，第二种去跑一次，第三种要重跑并检查产物来源。
 */
export const NA = "本档位不适用";
export const NOT_RUN = "未跑";
export const UNCOMPUTABLE = "无法计算";

export interface MetricRow {
  /** §14 的指标编号，如 M-P1。 */
  id: string;
  name: string;
  /** 本轮取值：比率写成「99%」、计数写成「4 条」、缺席用上面三个常量。 */
  value: string;
  /** 分母或口径，如「72/(72+19)」「n=90」。 */
  denom?: string;
  note?: string;
}

/**
 * 报告首屏的指标结果表。
 *
 * §14 里属于本测评的指标全部出现在这张表，读者不必在正文里翻找取值；
 * 取不到的写清是三种缺席里的哪一种，不省略、不留空。
 */
export function metricsTable(rows: MetricRow[]): string {
  const lines = [
    "## 指标结果",
    "",
    "> 指标定义与公式的权威源是架构文档 §14；本表只呈现本轮取值。",
    "> 缺席分三种，含义不同：**本档位不适用**（设计使然）/ **未跑**（这次没测）/ **无法计算**（产物代次不符）。",
    "",
    "| 指标 | 名称 | 本轮取值 | 分母 / 口径 |",
    "|---|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(`| \`${r.id}\` | ${r.name} | **${r.value}** | ${r.denom ?? "—"}${r.note ? `（${r.note}）` : ""} |`);
  }
  lines.push("");
  return lines.join("\n");
}

// ── 局限性与数字出处 ────────────────────────────

/** 已知缺陷：是什么 / 影响 / 去向。去向必填，与验收文档的技术债规则一致。 */
export interface KnownDefect {
  what: string;
  impact: string;
  next: string;
}

/** 不确定性条目：断言本身 + 它凭什么这么说（样本量 / 哪次对比 / 轮次）。 */
export interface Uncertainty {
  what: string;
  /** 依据：「n=8」「两轮对比 98 条」这类。没有依据的不确定性是猜测，不是限制。 */
  basis: string;
}

export interface Limitations {
  defects: KnownDefect[];
  /** 这批数字不适用于回答的问题（不是缺陷清单）。 */
  notApplicable: string[];
  uncertainty: Uncertainty[];
}

/**
 * 局限性与不适用场景：必填节，不接受"无"。
 *
 * 已知缺陷或不适用场景为空时抛错，不留静默通过的出口；本节按「挑剔的专家会批评什么」来写。
 * 漏写真实局限的代价高于多写保守说明。
 */
export function limitationsSection(l: Limitations): string {
  if (l.defects.length === 0) {
    throw new Error(
      "局限性节的「已知缺陷」为空——写之前先问：挑剔的专家会批评什么？想不出不等于没有，是没想。",
    );
  }
  if (l.notApplicable.length === 0) {
    throw new Error(
      "局限性节的「不适用于回答」为空——说不出不适用场景，等于声称这批数字放之四海而皆准。挑剔的专家会先批评这一点。",
    );
  }
  const lines = [
    "## 局限性与不适用场景",
    "",
    "**已知缺陷**",
    "",
    "| # | 缺陷 | 影响 | 去向 |",
    "|---|---|---|---|",
  ];
  l.defects.forEach((d, i) => lines.push(`| ${i + 1} | ${d.what} | ${d.impact} | ${d.next} |`));
  lines.push("", "**这批数字不适用于回答**", "");
  for (const s of l.notApplicable) lines.push(`- ${s}`);
  lines.push("", "**不确定性**", "");
  if (l.uncertainty.length === 0) {
    lines.push("- 本轮未量化跨运行方差（判定确定性来源于产物重放，非重复采样）。");
  } else {
    for (const u of l.uncertainty) lines.push(`- ${u.what}（依据：${u.basis}）`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * 数字出处附录。`source` 只写三种形状之一：产物路径 + 字段 / 命令 / commit。
 * 函数不校验形状（正则校验难以穷尽），约束由调用方遵守。
 */
export interface Provenance {
  figure: string;
  source: string;
}

export function provenanceSection(rows: Provenance[]): string {
  if (rows.length === 0) {
    return "## 数字出处\n\n本报告未引用需要外部核对的数字。\n";
  }
  const lines = ["## 数字出处", "", "| 数字 | 出处 |", "|---|---|"];
  for (const r of rows) lines.push(`| ${r.figure} | ${r.source} |`);
  lines.push("");
  return lines.join("\n");
}
