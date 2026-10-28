/**
 * 时间轴布局（FL-29 F-29-02/10）。
 *
 * # 布局算法单独成模块
 *
 * 并行 + 挂起 + 流式三者叠在一起容易画成一团。
 * "哪条放第几行、每条从哪到哪"从渲染里拆出来，成为可单测的纯函数，
 * 并行画得对不对由测试而不是目测保证。
 */

export interface TraceEvent {
  kind: string;
  at: number;
  turnId?: string;
  data: Record<string, unknown>;
}

export interface Lane {
  /** 泳道标题：Agent 名，或"编排"。 */
  label: string;
  bars: Bar[];
}

export interface Bar {
  kind: "branch" | "interrupt" | "point" | "span";
  label: string;
  /** 相对起点的百分比，直接用于 CSS。 */
  leftPct: number;
  widthPct: number;
  startedAt: number;
  endedAt: number;
  /** 失败/降级要能一眼看见（F-29-08：呈现层不做过滤）。 */
  tone: "normal" | "warn" | "danger";
  detail?: string;
}

export interface TimelineLayout {
  lanes: Lane[];
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

/** 短于这个的空白不单独画：属于采集抖动（时间仍计在 selfMs / tail 里）。 */
const GAP_MIN_MS = 200;

/** 点事件在时间轴上没有宽度，给一个最小可见宽度，否则看不见。 */
const POINT_WIDTH_PCT = 0.6;

const POINT_LABELS: Record<string, string> = {
  turn_start: "开始",
  intent: "意图四要素",
  risk: "风险边界门",
  route: "路由决策",
  agent_session: "Agent 会话",
  merge: "汇聚",
  tool_call: "工具调用",
  agent_output: "模型产出",
  context: "上下文装载",
  guard: "安全裁决",
  resume: "恢复",
  cancel: "取消",
  turn_end: "结束",
};

function toneOf(e: TraceEvent): Bar["tone"] {
  const d = e.data;
  if (e.kind === "span") {
    if (d.status === "failed") return "danger";
    // 取消≠失败（服务端 SpanStatus 的注释）：「提交即收工」掐掉的流是设计内的
    // 正常路径，不画红；超时/打断导致的取消仍要醒目，所以按原因分。
    if (d.status === "cancelled") return d.detail === "submitted" ? "normal" : "warn";
    return "normal";
  }
  if (e.kind === "guard" && d.decision === "deny") return "danger";
  if (e.kind === "guard" && d.decision === "confirm") return "warn";
  // 风险边界门（AC-11-7）：`deny` 这一轮到此为止；`unknown` 是门失效，
  // 不是"没风险"，必须醒目，否则单路设计下的 fail-open 无从察觉。
  if (e.kind === "risk" && d.decision === "deny") return "danger";
  if (e.kind === "risk" && d.category === "unknown") return "warn";
  if (e.kind === "cancel") return "warn";
  if (e.kind === "branch" && d.status && d.status !== "ok") return "danger";
  // mock 数据要标出来，区分真实数据与模拟数据。
  if (e.kind === "tool_call" && (d.source as { kind?: string })?.kind === "mock") return "warn";
  // 模型产出：失败的那条要醒目；取消是掐流不是坏，按常态画。
  if (e.kind === "agent_output" && d.status === "failed") return "danger";
  if (e.kind === "merge" && d.personalized === false) return "warn";
  // 体检：还有没修掉的 blocker 或预算耗尽 → 警示；全过是常态。
  if (e.kind === "audit" && ((typeof d.blockers === "number" && d.blockers > 0) || d.budgetExhausted === true)) return "warn";
  return "normal";
}

function detailOf(e: TraceEvent): string | undefined {
  const d = e.data;
  switch (e.kind) {
    case "route":
      return typeof d.reason === "string" ? `${String(d.agent)}：${d.reason}` : String(d.agent ?? "");
    case "tool_call":
      return `${String(d.name ?? "?")}（${(d.source as { kind?: string })?.kind ?? "?"}）`;
    case "guard":
      return `${String(d.decision ?? "")} ${String(d.reason ?? "")}`.trim();
    case "merge":
      return d.personalized === undefined
        ? undefined
        : d.personalized
          ? "两路齐备，可作个性化结论"
          : `降级为通用回答${Array.isArray(d.caveats) ? `：${(d.caveats as string[]).join("；")}` : ""}`;
    case "intent":
      return typeof d.goal === "string" ? d.goal : undefined;
    case "audit":
      // "验了几项、修了几处、还剩几条要看"：回放页据此判断这份方案是否经过验证。
      return typeof d.passed === "number"
        ? `已验 ${d.passed} 项 · 修 ${Number(d.repaired ?? 0)} 处 · 剩 blocker ${Number(d.blockers ?? 0)} · 验不了 ${Number(d.unverifiable ?? 0)}${d.rounds ? ` · ${String(d.rounds)} 轮` : ""}${d.budgetExhausted ? " · 预算耗尽" : ""}`
        : undefined;
    case "risk":
      // 判定与处置一起显示：只写"拒"看不出凭哪一类拒的，而事后判断
      // 这道门是否判宽需要这个信息（同 route 的 reason）。
      return typeof d.category === "string" ? `${d.category} → ${String(d.decision ?? "?")}` : undefined;
    default:
      return undefined;
  }
}

/**
 * 把事件流排成泳道。
 *
 * 分道规则：有 agent 的进各自泳道，其余归"编排"。
 * "并行是不是真的"直接体现为两条泳道上的条是否在横向重叠。
 */
export function layout(events: readonly TraceEvent[]): TimelineLayout {
  if (events.length === 0) {
    return { lanes: [], startedAt: 0, endedAt: 0, durationMs: 0 };
  }

  // 分跳耗时（F-44-04）：画成有宽度的条，与 branch 同一套布局，
  // 用来表达"这一跳花了多久"。
  const spans = events
    .filter((e) => e.kind === "span")
    .map((e) => ({
      e,
      name: String(e.data.name ?? "span"),
      startedAt: Number(e.data.startedAt ?? e.at),
      endedAt: Number(e.data.endedAt ?? e.at),
    }))
    .filter((s) => Number.isFinite(s.startedAt) && Number.isFinite(s.endedAt));

  const branches = events.filter((e) => e.kind === "branch");
  const branchSpans = branches
    .map((e) => ({
      e,
      startedAt: Number(e.data.startedAt ?? e.at),
      endedAt: Number(e.data.endedAt ?? e.at),
    }))
    .filter((b) => Number.isFinite(b.startedAt) && Number.isFinite(b.endedAt));

  // 挂起段：interrupt 到同 id 的 resume。没等到 resume 的画到轴末端，
  // 区分"还挂着"和"已恢复"。
  const interrupts: Array<{ id: string; startedAt: number; endedAt: number; open: boolean }> = [];
  const openMap = new Map<string, number>();
  for (const e of events) {
    const id = e.data.interruptId;
    if (typeof id !== "string") continue;
    if (e.kind === "interrupt") openMap.set(id, e.at);
    if (e.kind === "resume" && openMap.has(id)) {
      interrupts.push({ id, startedAt: openMap.get(id)!, endedAt: e.at, open: false });
      openMap.delete(id);
    }
  }

  const allTimes = [
    ...events.map((e) => e.at),
    ...branchSpans.flatMap((b) => [b.startedAt, b.endedAt]),
    // span 的起点可能早于它自己的落库时刻（`at` 记的是结束），漏掉它轴会从中间开始。
    ...spans.flatMap((s) => [s.startedAt, s.endedAt]),
  ];
  const startedAt = Math.min(...allTimes);
  let endedAt = Math.max(...allTimes);
  for (const [, at] of openMap) endedAt = Math.max(endedAt, at);
  for (const [id, at] of openMap) interrupts.push({ id, startedAt: at, endedAt, open: true });

  // 全部事件同一时刻时避免除零：退化成一条极短的轴，而不是 NaN。
  const durationMs = Math.max(1, endedAt - startedAt);
  const pct = (t: number): number => ((t - startedAt) / durationMs) * 100;

  const laneMap = new Map<string, Bar[]>();
  const push = (lane: string, bar: Bar): void => {
    const arr = laneMap.get(lane) ?? [];
    arr.push(bar);
    laneMap.set(lane, arr);
  };

  for (const b of branchSpans) {
    const agent = String(b.e.data.agent ?? "分支");
    push(agent, {
      kind: "branch",
      label: agent,
      leftPct: pct(b.startedAt),
      widthPct: Math.max(POINT_WIDTH_PCT, pct(b.endedAt) - pct(b.startedAt)),
      startedAt: b.startedAt,
      endedAt: b.endedAt,
      tone: toneOf(b.e),
      detail: typeof b.e.data.status === "string" ? String(b.e.data.status) : undefined,
    });
  }

  for (const i of interrupts) {
    push("人工确认", {
      kind: "interrupt",
      label: i.open ? "挂起中（未恢复）" : "挂起",
      leftPct: pct(i.startedAt),
      widthPct: Math.max(POINT_WIDTH_PCT, pct(i.endedAt) - pct(i.startedAt)),
      startedAt: i.startedAt,
      endedAt: i.endedAt,
      // 挂着没恢复是要看见的状态，不是正常态。
      tone: i.open ? "danger" : "warn",
      detail: i.open ? "至今未恢复" : `${i.endedAt - i.startedAt}ms`,
    });
  }

  for (const s of spans) {
    // `node.*` 是编排层自己的节点，归"编排"道；其余按 agent 分道，
    // 这样"用车分支的 RAG 慢"与"编排慢"在视觉上就是两条不同的线。
    const agent = s.name.startsWith("node.")
      ? "编排"
      : typeof s.e.data.agent === "string" && s.e.data.agent
        ? s.e.data.agent
        : "编排";
    push(agent, {
      kind: "span",
      label: s.name,
      leftPct: pct(s.startedAt),
      widthPct: Math.max(POINT_WIDTH_PCT, pct(s.endedAt) - pct(s.startedAt)),
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      tone: toneOf(s.e),
      detail: `${Math.max(0, s.endedAt - s.startedAt)}ms${s.e.data.detail ? ` · ${String(s.e.data.detail)}` : ""}`,
    });
  }

  for (const e of events) {
    if (e.kind === "branch" || e.kind === "interrupt" || e.kind === "resume" || e.kind === "span")
      continue;
    const agent = typeof e.data.agent === "string" ? e.data.agent : "编排";
    push(agent, {
      kind: "point",
      label: POINT_LABELS[e.kind] ?? e.kind,
      leftPct: pct(e.at),
      widthPct: POINT_WIDTH_PCT,
      startedAt: e.at,
      endedAt: e.at,
      tone: toneOf(e),
      detail: detailOf(e),
    });
  }

  // "编排"固定排最前，其余按首次出现时间——读者的视线从编排开始往下走。
  const lanes = [...laneMap.entries()]
    .map(([label, bars]) => ({ label, bars: bars.sort((a, b) => a.startedAt - b.startedAt) }))
    .sort((a, b) => {
      if (a.label === "编排") return -1;
      if (b.label === "编排") return 1;
      return a.bars[0].startedAt - b.bars[0].startedAt;
    });

  return { lanes, startedAt, endedAt, durationMs };
}

// ── 分跳耗时（F-44-04）─────────────────────────────────────────
//
// 瀑布图回答"发生的顺序"，这张表回答"该优化哪一跳"。
// 同样拆成纯函数：占比算错、并行重复计数、TTFT 与总时长混在一起，
// 在瀑布图上都无法目测发现。

export interface HopRow {
  /** 形如 `llm.trip` / `tool.ragflow_retrieve` / `node.answer`。 */
  name: string;
  /** 同名多次调用的耗时之和。 */
  totalMs: number;
  count: number;
  /** 最慢的那一次。与 `totalMs` 一起看才知道是"调用太多次"还是"单次太慢"。 */
  maxMs: number;
  /** 占本轮总时长百分比。并行时各跳之和会超过 100%，属预期。 */
  pct: number;
  failed: number;
}

export interface HopBreakdown {
  /** 本轮总时长（时间轴窗口）。 */
  totalMs: number;
  /**
   * 端上首字延迟：从本轮开始到应答节点吐出第一个字。
   *
   * 这是用户感知等待的主要来源，与总时长是两件事：
   * 意图理解、路由、检索全都发生在它之前。null 表示本轮没有可识别的应答 TTFT。
   */
  firstTokenMs: number | null;
  /**
   * 外部调用按耗时倒排，"该优化哪一跳"看这张。
   *
   * 不含 `node.*`：节点是容器，它的耗时天然大于内部任何一跳，
   * 混在一起排序时第一行永远是某个 `node.*`，而那一行不可行动。
   */
  rows: HopRow[];
  /** 节点视角，同样倒排。与 `rows` 分开看才知道差值在哪（见 `orchestrationMs`）。 */
  nodeRows: HopRow[];
  /**
   * 编排层自身开销 = `node.*` 覆盖的时间 − 其内部外部调用并集覆盖的时间。
   *
   * 用并集而不是求和：并行分支里两次 LLM 调用同时在跑，求和会把它们重复减掉，
   * 得出负数后被夹成 0，掩盖编排自身的开销。
   */
  orchestrationMs: number;
  hasSpans: boolean;
}

/** `x.ttft` 是同一次调用的前缀度量，不是独立的一跳；计入会重复计算。 */
function isTtft(name: string): boolean {
  return name.endsWith(".ttft");
}

/** 合并区间后的总覆盖时长。 */
/**
 * 把 `[from,to)` 里没被任何区间盖住的那几段挑出来（见 `FlowGap`）。
 *
 * 短于 `minMs` 的不给：毫秒级的缝隙是采集抖动，
 * 它们的时间仍然如实计在 `selfMs` 与 `tail` 里。
 */
function gapsIn(
  from: number,
  to: number,
  covered: Array<{ s: number; e: number }>,
  minMs: number,
): Array<{ s: number; e: number }> {
  /*
   * 零宽事件不算覆盖。`sidecar.filler` 之流是点事件（0ms），
   * 不参与占用时间，计入会把一段连续的空白切成多段（读起来像多次独立的思考）。
   */
  const sorted = covered.filter((c) => c.e > c.s).sort((a, b) => a.s - b.s);
  const out: Array<{ s: number; e: number }> = [];
  let cursor = from;
  for (const it of sorted) {
    if (it.s > cursor && it.s - cursor >= minMs) out.push({ s: cursor, e: it.s });
    cursor = Math.max(cursor, it.e);
  }
  if (to > cursor && to - cursor >= minMs) out.push({ s: cursor, e: to });
  return out;
}

function unionMs(intervals: Array<{ s: number; e: number }>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a.s - b.s);
  let total = 0;
  let curS = sorted[0].s;
  let curE = sorted[0].e;
  for (const it of sorted.slice(1)) {
    if (it.s > curE) {
      total += curE - curS;
      curS = it.s;
      curE = it.e;
    } else if (it.e > curE) {
      curE = it.e;
    }
  }
  return total + (curE - curS);
}

export function hopBreakdown(events: readonly TraceEvent[]): HopBreakdown {
  const spans = events
    .filter((e) => e.kind === "span")
    .map((e) => ({
      name: String(e.data.name ?? "span"),
      startedAt: Number(e.data.startedAt ?? e.at),
      endedAt: Number(e.data.endedAt ?? e.at),
      status: String(e.data.status ?? "ok"),
    }))
    .filter((s) => Number.isFinite(s.startedAt) && Number.isFinite(s.endedAt));

  if (spans.length === 0) {
    return {
      totalMs: 0,
      firstTokenMs: null,
      rows: [],
      nodeRows: [],
      orchestrationMs: 0,
      hasSpans: false,
    };
  }

  const view = layout(events);
  const totalMs = view.durationMs;

  const hops = spans.filter((s) => !isTtft(s.name));

  const aggregate = (subset: typeof hops): HopRow[] => {
    const byName = new Map<string, HopRow>();
    for (const s of subset) {
      const ms = Math.max(0, s.endedAt - s.startedAt);
      const row = byName.get(s.name) ?? {
        name: s.name,
        totalMs: 0,
        count: 0,
        maxMs: 0,
        pct: 0,
        failed: 0,
      };
      row.totalMs += ms;
      row.count += 1;
      row.maxMs = Math.max(row.maxMs, ms);
      if (s.status === "failed") row.failed += 1;
      byName.set(s.name, row);
    }
    return [...byName.values()]
      .map((r) => ({ ...r, pct: totalMs > 0 ? (r.totalMs / totalMs) * 100 : 0 }))
      .sort((a, b) => b.totalMs - a.totalMs);
  };

  const isNode = (name: string): boolean => name.startsWith("node.");
  const rows = aggregate(hops.filter((s) => !isNode(s.name)));
  const nodeRows = aggregate(hops.filter((s) => isNode(s.name)));

  // 端上首字：应答节点区间内最早结束的那条 ttft。
  // 不取全局最早：意图抽取的 TTFT 更早，但不产生用户可见的字。
  const answerNode = spans.find((s) => s.name === "node.answer");
  const ttfts = spans.filter((s) => isTtft(s.name));
  const answerTtft = (
    answerNode
      ? ttfts.filter((t) => t.startedAt >= answerNode.startedAt && t.endedAt <= answerNode.endedAt)
      : ttfts
  ).sort((a, b) => a.endedAt - b.endedAt)[0];
  const firstTokenMs = answerTtft ? answerTtft.endedAt - view.startedAt : null;

  const nodeUnion = unionMs(
    hops.filter((s) => isNode(s.name)).map((s) => ({ s: s.startedAt, e: s.endedAt })),
  );
  const innerUnion = unionMs(
    hops.filter((s) => !isNode(s.name)).map((s) => ({ s: s.startedAt, e: s.endedAt })),
  );

  return {
    totalMs,
    firstTokenMs,
    rows,
    nodeRows,
    orchestrationMs: Math.max(0, nodeUnion - innerUnion),
    hasSpans: true,
  };
}

// ── 一轮的执行流 ─────────────────────────────────────────────
//
// 瀑布图与耗时表回答"哪一跳慢"；执行流回答"它是怎么流过去的"：
// 先审核还是先解析意图、检索是在应答之前还是之中、哪两跳是并排跑的。
// 这里算出图的模型：谁套着谁、谁和谁并行、每一段各自多久。渲染只是把它摆出来。
//
// 不用 React Flow（`pages/workflow` 在用）：那边画的是静态架构图，
// 节点集合是声明好的。这里的节点集合来自一次真实执行，形状每轮都不同，
// 且要放进抽屉里滚动阅读，带平移缩放的画布不适合这个位置。

/** 与服务端 `SpanStatus` 对齐：`cancelled` 是被掐的流，不是坏掉的调用。 */
export type FlowStatus = "ok" | "failed" | "cancelled";

export interface FlowChild {
  name: string;
  durationMs: number;
  status: FlowStatus;
  detail?: string;
  agent?: string;
  /**
   * 与同一阶段内另一个子调用真正并排在跑。
   *
   * 判据是"区间有交集且互不包含"。只看有交集的话，
   * `acp.session_new` 套在 `llm.supervisor-intent` 里也会被标成并行，
   * 而那是嵌套不是并行，会让人以为可以把两段时间分开优化。
   */
  parallel: boolean;
  /** 相对所属阶段的起始偏移，用于把并行关系画出来。 */
  offsetMs: number;
  /** 嵌套深度（阶段的直接子调用为 0）。缩进画出来才看得出谁在谁里面。 */
  depth: number;
  /**
   * 这一跳里排我们自己的限速队的那部分毫秒（服务端 `SpanData.waitMs`）。
   *
   * 与总时长分开画：fan-out 起跑时多个高德请求同时发出，闸门限速下
   * 一跳的耗时有相当部分是在本地排队而非上游计算（例如闸门 350ms/桶 2 时，
   * `tool.spot_search` 记为 4770ms，其中上游只算了一部分）。
   * 两者的处置相反：等上游只能等，排自己的队是并发策略，调得动。
   *
   * `undefined` 是"这一轮跑在埋点之前"，`0` 是"真的没排队"，两者不能混着画。
   */
  waitMs?: number;
}

/**
 * 阶段末尾那两行"剩下的时间去哪了"。
 *
 * # 分两行而不是一行"其余 xxxms"
 *
 * 阶段扣掉子调用后的余量不全是生成文本：例如应答阶段 30816ms 余约 4100ms，
 * 其中 `llm.trip` 首 token 在 29963ms，吐字只有 852ms，另外约 3300ms 没有埋点覆盖。
 * 合成一行会把未覆盖的时间算成生成时间。
 */
export interface FlowTail {
  /**
   * 吐字时间 = 调用总时长 − 首 token，是量出来的，不是减出来的余数。
   * 该阶段不是一次 LLM 调用（或没有 ttft）时为 null。
   */
  textMs: number | null;
  /** 扣掉全部子调用与吐字之后，仍然没有任何埋点覆盖的部分。 */
  uncoveredMs: number;
  /** `uncovered` 该怎么读：LLM 调用里是 prefill/框架开销，图节点里是编排自身开销。 */
  kind: "llm" | "node";
}

/**
 * 某一次调用内部没有任何下级调用在跑的一段。
 *
 * # 画出位置，而不只在末尾记总数
 *
 * 一次 LLM 调用里下级调用往往只占小部分（例如 `llm.tour-task` 19.96 秒中只有 6.2 秒），
 * 其余 13.7 秒分布在首 token 前（1.8 秒）、两轮之间（2.2 秒）与收尾生成（9.5 秒）。
 * 末尾 `tail` 只给阶段这一层的
 * 总账与细分，不说明这些时间在哪；画出空白段才能回答"这一轮慢在哪"。
 *
 * # 每一层都要算，不能只算阶段这一层
 *
 * 行程规划 fan-out 的形状是 `node.itineraryPlan ⊃ llm.*-task ⊃ tool.*`：
 * 四条分支几乎铺满了节点，阶段这一层没有空白，
 * 空白都在 `llm.*-task` 里面。
 */
export interface FlowGap {
  /**
   * 相对所属阶段起点的偏移（不是相对它所在的那次调用），
   * 与 `FlowChild.offsetMs` 同一基准，渲染层因此对两者用同一套定位算法。
   */
  offsetMs: number;
  durationMs: number;
  /** 是不是所在调用的最后一段：LLM 调用的收尾空白是在输出最终那段文本。 */
  trailing: boolean;
  /** 所在调用的种类：决定这一行该叫"模型在想"还是"编排自身"。 */
  kind: "llm" | "node";
  /** 与同层子调用一致的缩进深度。 */
  depth: number;
}

/**
 * 渲染顺序上的一行：一次子调用，或一段空白。
 *
 * `FlowStage.children` 说的是内容（谁调了谁），`rows` 说的是怎么读：
 * 同一批 `FlowChild` 对象按前序排好，空白按时间插在它该在的位置上。
 * 两者共享对象，不是两份数据。
 */
export type FlowRow = { child: FlowChild; gap?: undefined } | { gap: FlowGap; child?: undefined };

export interface FlowStage {
  /** 原始 span 名（`node.answer` / `guard.input`）。 */
  name: string;
  /** 人话标签。 */
  label: string;
  durationMs: number;
  startedAt: number;
  status: FlowStatus;
  /** 结构性原因（取消时是 submitted / timeout / …）。 */
  detail?: string;
  children: FlowChild[];
  /** 阶段时长减去子调用并集。`tail` 是它的细分，两者不冲突。 */
  selfMs: number;
  /**
   * 子调用与空白按时间归并成的一列，渲染直接照着它排。
   *
   * 空白不单列一段：它长在子调用之间，按时间归并才能看出空白在哪、有多长。
   */
  rows: FlowRow[];
  tail: FlowTail;
  /** 被折叠掉的那次 LLM 调用的名字（见 `PASSTHROUGH_RATIO`）；没折叠时为 undefined。 */
  collapsedFrom?: string;
}

export interface TurnFlow {
  stages: FlowStage[];
  totalMs: number;
  firstTokenMs: number | null;
}

/** 人话标签。查不到就退回原名（如 `node.xxx`），不编造中文。 */
const FLOW_LABELS: Record<string, string> = {
  "guard.input": "输入内容审核",
  "guard.action": "动作权限门",
  "thread.resolve": "会话上下文解析",
  "acp.connect": "ACP 连接建立",
  "acp.session_new": "ACP 会话创建",
  "node.understand": "意图理解",
  "node.dispatch": "路由决策",
  // 已从图里摘除，历史轨迹里仍有，保留以便阅读旧回放。
  "node.tripFanout": "出行并行 fan-out（已下线）",
  "node.itineraryPlan": "行程规划 fan-out",
  "node.ownershipDual": "用车双路检索",
  "node.buyingCatalog": "购车车型检索",
  "node.testDriveFlow": "试驾预约",
  "node.cabinCompanion": "座舱偏好读取",
  // 副 lane 与汇合（ACR-023）：同一批节点函数经 lane("side") 注册的第二份，与主分支同 superstep 并行。
  "node.sideItineraryPlan": "副 lane · 行程规划",
  "node.sideOwnershipDual": "副 lane · 用车 / 售后",
  "node.sideBuyingCatalog": "副 lane · 购车",
  "node.sideTestDriveFlow": "副 lane · 试驾预约",
  "node.sideCabinCompanion": "副 lane · 座舱",
  "node.join": "汇合（主原样 · 副改道）",
  "node.answer": "应答生成",
};

/**
 * 取消状态的人话标签，按原因分（原因来自 fanout 的 `abort(reason)`）。
 *
 * 「提交即收工」不是事故：分支已经交出结论，剩下的收尾轮被主动掐掉是省时间的
 * 设计，不写成「已取消」以免被误读为故障。
 */
export function cancelLabel(detail?: string): string {
  if (detail === "submitted") return "提交即收工";
  if (detail === "timeout") return "已取消·分支超时";
  return detail ? `已取消·${detail}` : "已取消";
}

export function flowLabel(name: string): string {
  if (FLOW_LABELS[name]) return FLOW_LABELS[name];
  // `think.*` 是叶子（见 containerRank）：它与工具调用交替发生，不是谁套着谁。
  if (name.startsWith("think.")) return `模型思考 ${name.slice(6)}`;
  if (name.startsWith("llm.")) return `模型调用 ${name.slice(4)}`;
  if (name.startsWith("tool.")) return `工具 ${name.slice(5)}`;
  return name;
}

interface RawSpan {
  name: string;
  startedAt: number;
  endedAt: number;
  status: FlowStatus;
  detail?: string;
  agent?: string;
  /** 见 `FlowChild.waitMs`。老轨迹没有这个字段 → undefined，不是 0。 */
  waitMs?: number;
}

function readSpans(events: readonly TraceEvent[]): RawSpan[] {
  return events
    .filter((e) => e.kind === "span")
    .map((e) => ({
      name: String(e.data.name ?? "span"),
      startedAt: Number(e.data.startedAt ?? e.at),
      endedAt: Number(e.data.endedAt ?? e.at),
      status:
        e.data.status === "failed"
          ? ("failed" as const)
          : e.data.status === "cancelled"
            ? ("cancelled" as const)
            : ("ok" as const),
      detail: typeof e.data.detail === "string" ? e.data.detail : undefined,
      agent: typeof e.data.agent === "string" ? e.data.agent : undefined,
      // 只认有限的数：服务端写 0 表示"没排队"，字段缺失表示"这一轮跑在埋点之前"。
      waitMs: Number.isFinite(e.data.waitMs) ? Number(e.data.waitMs) : undefined,
    }))
    .filter((s) => Number.isFinite(s.startedAt) && Number.isFinite(s.endedAt));
}

/**
 * 层级：谁在代码结构上可能包着谁。
 *
 * 这不是启发式，与埋点位置一一对应：
 *
 * | 层 | 谁 | 包着什么 |
 * |---|---|---|
 * | 3 | `node.*` | `withNodeSpan` 在装配处包住整个节点体，里面的一切都归它 |
 * | 2 | `llm.*` | `withLlmSpans` 包住一次调用；ACP 实现会在里面建会话 |
 * | 1 | `acp.*` | 连接与 `session/new`，自身不再套别的 |
 * | 0 | `tool.*` / `guard.*` / `thread.*` | 叶子。`invokeTool` 里面不会再冒出别的 span |
 */
function containerRank(name: string): number {
  if (name.startsWith("node.")) return 3;
  if (name.startsWith("llm.")) return 2;
  if (name.startsWith("acp.")) return 1;
  return 0;
}

/**
 * 规范名：剥掉 `-task` / `-intent` / `-voice`（与 runtime 的 `canonicalAgent()` 同一规则）。
 *
 * 两侧的 agent 名不同源，所以必须剥：`llm.*` 的 span 记的是会话维度的原名
 * （`tour-task`，后缀决定落到哪个 ACP 会话），而 `tool.*` / `think.*` 记的是
 * 规范名（`tour`）。字面比较时 `"tour-task" !== "tour"`，一次 fan-out 里
 * 的每个工具都会被判成"不属于任何分支"，全部平铺到阶段层。
 */
function canonicalAgent(agent: string | undefined): string | undefined {
  return agent?.replace(/-(task|intent|voice)$/, "");
}

/**
 * a 是否把 b 包住。先看种类层级，再看区间。
 *
 * # 只看区间不够
 *
 * 其一：`node.understand [+196,+5448]` 与 `llm.supervisor-intent [+196,+5448]`
 * 区间可以完全相同：节点里除了那次模型调用几乎没别的事，前后各不到 1ms，
 * 毫秒分辨率下塌成同一个区间。要求"严格更宽"的话两边互不包含、双双成为顶层阶段，
 * 且结果随毫秒取整时有时无。
 *
 * 其二：放宽成"区间包含即父子"又会把并发误判成嵌套：
 * 五次并行的 `tool.weather` 同时起跑，最长的那次区间上正好包住其余四次。
 *
 * 单靠时间戳分不清"A 调用了 B"和"A、B 同时起跑、B 先结束"。
 * 层级能分：`invokeTool` 是叶子，一次工具调用里不会再冒出另一次工具调用；
 * 两个 `llm.*` 也永远是兄弟（fan-out 的两个分支）。
 */
function contains(a: RawSpan, b: RawSpan): boolean {
  if (a === b) return false;
  // 同层永远是兄弟：两次 tool、两次 llm（fan-out 分支）都属于这种。
  if (containerRank(a.name) <= containerRank(b.name)) return false;
  /*
   * 分支不同就不可能是父子。并行分支中长的那条（如跑到 ACP 超时的 `llm.trip-task`）
   * 会在区间上包住另一条分支的思考段，使思考段同时挂在两个分支下、思考总时长翻倍。
   * 层级判据分不开这一类（llm ⊃ think），而 agent 名写在 span 上：
   * 一条分支的思考不可能属于另一条分支。
   *
   * 比的是规范名（见 `canonicalAgent`）：两侧写的不是同一种名字，
   * 字面比会把每个工具都踢出它自己的分支。
   */
  const aAgent = canonicalAgent(a.agent);
  const bAgent = canonicalAgent(b.agent);
  if (aAgent && bAgent && aAgent !== bAgent) return false;
  return a.startedAt <= b.startedAt && a.endedAt >= b.endedAt;
}

/**
 * 从一轮的轨迹推出执行流。
 *
 * # 阶段的判据是"没有被别的 span 包住"，不是名字前缀
 *
 * 按 `node.` 前缀切会漏掉 `guard.input` 与 `thread.resolve`：它们发生在图执行之前，
 * 不属于任何节点，但确实是链路上的两跳（`guard.input` 常常是最大的一跳）。
 * 用包含关系判定，新增 span 不需要改这里。
 */
/**
 * 子调用占到阶段这个比例以上，就认为它是"穿透层"：一个不带信息、
 * 只把真正的子调用往里推一层缩进的壳（`node.answer` 30816ms ⊃ `llm.trip` 30815ms）。
 */
const PASSTHROUGH_RATIO = 0.98;

export function buildFlow(events: readonly TraceEvent[]): TurnFlow {
  const all = readSpans(events);
  const hops = all.filter((s) => !isTtft(s.name));
  // `llm.x` → 它的首 token 耗时。ttft 不作为一跳（会重复计算），但要留着算吐字时间。
  const ttftOf = new Map<string, number>(
    all
      .filter((s) => isTtft(s.name))
      .map((s) => [s.name.replace(/\.ttft$/, ""), s.endedAt - s.startedAt]),
  );

  const view = layout(events);
  const stages: FlowStage[] = [];

  const outermost = hops.filter((s) => !hops.some((o) => contains(o, s)));
  // 同一时刻起跑时按"长的在前"，保证容器排在被包含者前面（虽然这里只取最外层）。
  outermost.sort((a, b) => a.startedAt - b.startedAt || b.endedAt - a.endedAt);

  /*
   * 每条子调用只归一个阶段：包住它的阶段里起得最晚的那个（最内层）。
   *
   * 阶段之间可能重叠：节点超时返回后，底下的 LLM 调用可能继续跑到 ACP 超时，
   * 成为与后续阶段重叠的独立阶段。只归一个阶段，避免子调用被重复计入。
   *
   * 挑最内层而不是最外层：最内层才是真正发起它的那一个。
   */
  const ownerOf = new Map<RawSpan, RawSpan>();
  for (const s of hops) {
    if (outermost.includes(s)) continue;
    let owner: RawSpan | undefined;
    for (const st of outermost) {
      if (!contains(st, s)) continue;
      if (!owner || st.startedAt > owner.startedAt) owner = st;
    }
    if (owner) ownerOf.set(s, owner);
  }

  for (const stage of outermost) {
    let inner = hops.filter((s) => ownerOf.get(s) === stage);
    const durationMs = Math.max(0, stage.endedAt - stage.startedAt);

    /*
     * 折叠"穿透层"：`node.answer` 30816ms 底下只有一个 `llm.trip` 30815ms，
     * 那一行不带任何信息，只是把真正的子调用往里推了一层缩进。
     * 折掉它，把它的孩子提上来，同时记住它是谁（`collapsedFrom`）
     * 与它的 ttft（下面算吐字时间要用）。
     */
    let llm = inner.find(
      (s) => containerRank(s.name) === 2 && s.endedAt - s.startedAt >= durationMs * PASSTHROUGH_RATIO,
    );
    let collapsedFrom: string | undefined;
    if (llm && inner.filter((s) => ownerOf.get(s) === stage && !contains(llm!, s)).length === 1) {
      collapsedFrom = llm.name;
      inner = inner.filter((s) => s !== llm);
    } else if (containerRank(stage.name) === 2) {
      // 阶段本身就是一次 LLM 调用（如超时后活得比节点长的那条分支）。
      llm = stage;
    } else {
      llm = undefined;
    }

    /*
     * 子调用按树前序排，不是按时间平铺。
     *
     * 多条分支在同一毫秒起跑时，平铺排序（同起点长的在前）会先排完全部
     * `llm.*-task`，再排全部 `acp.session_new`，后者全挤在最后那条分支下面。
     *
     * 先按包含关系连成树（父取最内层的那个容器，与阶段归属同一判据），
     * 再前序遍历：每条子调用紧跟在自己的父调用后面。
     * 树一定无环：`contains` 要求父的层级严格更高。
     */
    const parentOf = new Map<RawSpan, RawSpan | undefined>();
    for (const c of inner) {
      let parent: RawSpan | undefined;
      for (const o of inner) {
        if (!contains(o, c)) continue;
        // 起得更晚 = 更内层；同起点时取更短的那个（同样是更内层）。
        if (
          !parent ||
          o.startedAt > parent.startedAt ||
          (o.startedAt === parent.startedAt && o.endedAt < parent.endedAt)
        ) {
          parent = o;
        }
      }
      parentOf.set(c, parent);
    }

    /*
     * 前序遍历的同时把空白插进去（见 `FlowGap`）。
     *
     * 空白算的是这一层：父调用的区间减去它直接子调用的并集。
     * 每层各算各的：只算阶段那一层的话，fan-out 节点被四条分支铺满，没有空白。
     */
    const ordered: Array<{ span: RawSpan; depth: number } | { gap: FlowGap; depth: number }> = [];
    const walk = (parent: RawSpan | undefined, depth: number): void => {
      const siblings = inner
        .filter((c) => parentOf.get(c) === parent)
        // 兄弟之间仍按时间先后；同起点时长的在前。
        .sort((a, b) => a.startedAt - b.startedAt || b.endedAt - a.endedAt);
      // 一个下级调用都没有的那次调用不画空白：整段都是空白不带信息，
      // 还会给每个叶子（tool.*、guard.* 之流）多出一条灰条。
      if (siblings.length === 0) return;
      const from = parent?.startedAt ?? stage.startedAt;
      const to = parent?.endedAt ?? stage.endedAt;
      const holes = gapsIn(
        from,
        to,
        siblings.map((c) => ({ s: c.startedAt, e: c.endedAt })),
        GAP_MIN_MS,
      ).map((g) => ({
        // 基准是阶段起点，与子调用同一套定位算法。
        offsetMs: g.s - stage.startedAt,
        durationMs: g.e - g.s,
        trailing: g.e >= to,
        /*
         * 这一段该读成"模型在想"还是"编排在等"，取决于包着它的那次调用是谁。
         * 阶段这一层用 `llm` 而不是阶段名：穿透层被折叠之后
         * （`node.answer` ⊃ `llm.trip`），阶段名还写着 node，实际在跑的是那次模型调用。
         * 与末尾 `tail.kind` 同一个判据，两处说法保持一致。
         */
        kind: parent
          ? containerRank(parent.name) === 2
            ? ("llm" as const)
            : ("node" as const)
          : llm
            ? ("llm" as const)
            : ("node" as const),
        depth,
      }));
      // 归并：空白与子调用在时间上不重叠（空白就是从并集里挖出来的），比起点即可定序。
      const merged: Array<{ at: number; span?: RawSpan; gap?: FlowGap }> = [
        ...siblings.map((c) => ({ at: c.startedAt, span: c })),
        ...holes.map((g) => ({ at: stage.startedAt + g.offsetMs, gap: g })),
      ].sort((a, b) => a.at - b.at);
      for (const m of merged) {
        if (m.gap) {
          ordered.push({ gap: m.gap, depth });
          continue;
        }
        ordered.push({ span: m.span!, depth });
        walk(m.span!, depth + 1);
      }
    };
    walk(undefined, 0);

    const rows: FlowRow[] = [];
    const children: FlowChild[] = [];
    for (const row of ordered) {
      if ("gap" in row) {
        rows.push({ gap: row.gap });
        continue;
      }
      const { span: c, depth } = row;
      const child: FlowChild = {
        name: c.name,
        durationMs: Math.max(0, c.endedAt - c.startedAt),
        status: c.status,
        detail: c.detail,
        agent: c.agent,
        offsetMs: c.startedAt - stage.startedAt,
        /*
         * 夹到本跳时长以内：计量与计时是两处取的时间（闸门两侧 vs `invokeTool` 两端），
         * 理论上前者恒小于后者，但两处时钟读数之间隔着几行代码，
         * 不夹的话"等待"可能比它所在的条还长，溢出边界。
         */
        waitMs:
          c.waitMs === undefined
            ? undefined
            : Math.min(Math.max(0, c.waitMs), Math.max(0, c.endedAt - c.startedAt)),
        // 深度取自树本身，缩进因此与"谁紧跟着谁"永远一致。
        depth,
        // 有交集且互不包含才算并行：嵌套也有交集，但那不是并排在跑。
        parallel: inner.some(
          (o) =>
            o !== c &&
            c.startedAt < o.endedAt &&
            o.startedAt < c.endedAt &&
            !contains(o, c) &&
            !contains(c, o),
        ),
      };
      children.push(child);
      rows.push({ child });
    }

    const childUnion = unionMs(inner.map((c) => ({ s: c.startedAt, e: c.endedAt })));
    const selfMs = Math.max(0, durationMs - childUnion);
    // 吐字时间量出来：调用总时长 − 首 token。没有 ttft 就如实给 null。
    const ttft = llm ? ttftOf.get(llm.name) : undefined;
    const textMs = llm && ttft !== undefined ? Math.max(0, (llm.endedAt - llm.startedAt) - ttft) : null;

    stages.push({
      name: stage.name,
      label: flowLabel(stage.name),
      durationMs,
      startedAt: stage.startedAt,
      status: stage.status,
      detail: stage.detail,
      children,
      rows,
      selfMs,
      collapsedFrom,
      tail: {
        textMs,
        uncoveredMs: Math.max(0, selfMs - (textMs ?? 0)),
        kind: llm ? "llm" : "node",
      },
    });
  }

  // 首字延迟与耗时表同源，避免两处各算一遍算出两个数。
  const { firstTokenMs } = hopBreakdown(events);

  return { stages, totalMs: view.durationMs, firstTokenMs };
}

/**
 * 两条分支是否横向重叠，与服务端 `summarize` 用同一判据（区间有交集），
 * 保证页面与服务端对并行的结论一致。
 */
export function hasOverlap(layout: TimelineLayout): boolean {
  const bars = layout.lanes.flatMap((l) => l.bars).filter((b) => b.kind === "branch");
  for (let i = 0; i < bars.length; i += 1) {
    for (let j = i + 1; j < bars.length; j += 1) {
      if (bars[i].startedAt < bars[j].endedAt && bars[j].startedAt < bars[i].endedAt) return true;
    }
  }
  return false;
}
