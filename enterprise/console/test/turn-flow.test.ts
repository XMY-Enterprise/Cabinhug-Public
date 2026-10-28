/**
 * 一轮执行流的模型推导（F-44-04）。
 *
 * 这些断言针对画出来看似合理、实际错误的情况：
 * 阶段少了一个、并行被画成串行、子调用挂错了父阶段、自身开销被并行重复扣。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildFlow,
  cancelLabel,
  flowLabel,
  hopBreakdown,
  layout,
  type TraceEvent,
} from "../src/pages/trace/timeline";
import { gapLabel, shownWaitMs, waitLevel, waitText } from "../src/pages/trace/TurnFlow";

const T0 = 1_700_000_000_000;

function span(name: string, offsetMs: number, durationMs: number, extra: Record<string, unknown> = {}): TraceEvent {
  const startedAt = T0 + offsetMs;
  const endedAt = startedAt + durationMs;
  return {
    kind: "span",
    at: endedAt,
    turnId: "t1",
    data: { name, startedAt, endedAt, durationMs, status: "ok", ...extra },
  };
}

/**
 * 一轮用车问答：
 *   guard.input      [0,258)     ← 图执行之前，不属于任何节点
 *   thread.resolve   [258,263)
 *   node.ownershipDual [263,663) 内含并行的 ragflow [270,650) 与 usage_profile [270,460)
 *   node.answer      [663,1463)  内含 llm.ownership [670,1460)（ttft 在 +860）
 */
const TURN: TraceEvent[] = [
  span("guard.input", 0, 258, { detail: "allow" }),
  span("thread.resolve", 258, 5, { detail: "pg" }),
  span("node.ownershipDual", 263, 400),
  span("tool.ragflow_retrieve", 270, 380, { agent: "ownership" }),
  span("tool.usage_profile", 270, 190, { agent: "ownership" }),
  span("node.answer", 663, 800),
  span("llm.ownership", 670, 790, { agent: "ownership" }),
  span("llm.ownership.ttft", 670, 197, { agent: "ownership" }),
];

describe("执行流模型", () => {
  const flow = buildFlow(TURN);

  it("阶段判据是「没被别的 span 包住」，不是 node. 前缀", () => {
    // 按前缀切会漏掉 guard.input 与 thread.resolve：它们发生在图执行之前，
    // 不属于任何节点，但确实是链路上的两跳，且 guard.input 常是最大的一跳。
    assert.deepEqual(
      flow.stages.map((s) => s.name),
      ["guard.input", "thread.resolve", "node.ownershipDual", "node.answer"],
    );
  });

  it("阶段按时间先后排，流程图靠这个顺序表达先后", () => {
    const starts = flow.stages.map((s) => s.startedAt);
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  });

  it("子调用挂在包住它的那个阶段下，不是挂在最近的一个", () => {
    const dual = flow.stages.find((s) => s.name === "node.ownershipDual")!;
    assert.deepEqual(
      dual.children.map((c) => c.name).sort(),
      ["tool.ragflow_retrieve", "tool.usage_profile"],
    );
    // `node.answer` 里只有那一次模型调用且几乎等长 → 被当作穿透层折掉，
    // 但归属信息保留在 `collapsedFrom`（见「阶段末尾」那组）。
    const answer = flow.stages.find((s) => s.name === "node.answer")!;
    assert.equal(answer.collapsedFrom, "llm.ownership");
  });

  it("并行被标出来：两条同时在跑，耗时不能相加", () => {
    const dual = flow.stages.find((s) => s.name === "node.ownershipDual")!;
    assert.ok(dual.children.every((c) => c.parallel), "双路检索是并发的，两条都该标");
    // 只有一条子调用时不该标并行。用工具做样本：工具是叶子，不会触发穿透层折叠。
    const single = buildFlow([span("node.ownershipDual", 0, 400), span("tool.x", 10, 380)]);
    assert.equal(single.stages[0].children[0].parallel, false, "只有一条时不该标并行");
  });

  it("ttft 不进流程图：它是同一次调用的前缀，画出来会变成两个框", () => {
    const names = flow.stages.flatMap((s) => [s.name, ...s.children.map((c) => c.name)]);
    assert.ok(!names.some((n) => n.endsWith(".ttft")));
  });

  it("阶段自身开销按子调用并集算，并行不重复扣", () => {
    // node.ownershipDual 400ms，子调用并集 = [270,650) = 380ms（不是 380+190=570）
    const dual = flow.stages.find((s) => s.name === "node.ownershipDual")!;
    assert.equal(dual.selfMs, 20, "求和的话会得负数再被夹成 0，正好把编排开销藏起来");
  });

  it("没有子调用的阶段，自身开销就是它自己", () => {
    const guard = flow.stages.find((s) => s.name === "guard.input")!;
    assert.deepEqual(guard.children, []);
    assert.equal(guard.selfMs, 258);
  });

  it("子调用带相对偏移，并行关系可按位置画出来", () => {
    const dual = flow.stages.find((s) => s.name === "node.ownershipDual")!;
    for (const c of dual.children) assert.equal(c.offsetMs, 7, "270 - 263");
  });

  it("失败状态传到阶段与子调用上（失败常常正是最慢那一跳）", () => {
    const f = buildFlow([
      span("node.ownershipDual", 0, 5010),
      span("tool.ragflow_retrieve", 5, 5000, { status: "failed", detail: "timeout" }),
    ]);
    const stage = f.stages[0];
    assert.equal(stage.children[0].status, "failed");
    assert.equal(stage.children[0].detail, "timeout");
  });

  it("首字延迟与耗时表同源，不各算一遍", () => {
    // 670 + 197 = 867，减去时间轴起点 0 → 867
    assert.equal(flow.firstTokenMs, 867);
  });

  it("没有 span 的老轮次返回空 stages，不抛错", () => {
    const f = buildFlow([{ kind: "route", at: T0, data: { agent: "trip" } }]);
    assert.deepEqual(f.stages, []);
  });
});

describe("阶段标签", () => {
  it("已知阶段给人话", () => {
    assert.equal(flowLabel("guard.input"), "输入内容审核");
    assert.equal(flowLabel("node.answer"), "应答生成");
  });

  it("llm./tool. 按前缀拼", () => {
    assert.equal(flowLabel("llm.ownership"), "模型调用 ownership");
    assert.equal(flowLabel("tool.ragflow_retrieve"), "工具 ragflow_retrieve");
  });

  it("不认识的原样返回：显示 node.xxx，不编造中文名", () => {
    assert.equal(flowLabel("node.somethingNew"), "node.somethingNew");
  });
});

describe("毫秒分辨率把容器与被包含者压成同一区间", () => {
  /**
   * 样本：`node.understand [+196,+5448]` 与 `llm.supervisor-intent [+196,+5448]`
   * 区间完全相同，节点里除了那次模型调用几乎没有别的事，前后各不到 1ms。
   *
   * 若要求「严格更宽」才算包含，两边互不包含、都成为顶层阶段，页面上出现两个
   * 耗时与子项都相同的框；且结果随毫秒取整时有时无（差 1ms 即正常）。
   */
  const IDENTICAL: TraceEvent[] = [
    span("node.understand", 196, 5252),
    span("llm.supervisor-intent", 196, 5252),
    span("acp.session_new", 196, 1607),
    span("llm.supervisor-intent.ttft", 196, 4577),
  ];

  const flow = buildFlow(IDENTICAL);

  it("区间完全相同时也判得出包含：只剩一个阶段，不是两个", () => {
    assert.deepEqual(flow.stages.map((s) => s.name), ["node.understand"]);
  });

  it("模型调用被折进该阶段，而不是与它并列成另一个阶段", () => {
    // 上一条守 stages.length === 1（不裂成两个框）。
    // 这里验证：那次调用与节点几乎等长，属于穿透层，折掉但留名。
    assert.equal(flow.stages[0].collapsedFrom, "llm.supervisor-intent");
    assert.deepEqual(flow.stages[0].children.map((c) => c.name), ["acp.session_new"]);
  });

  it("节点本身没有额外开销：它的时长就是那次调用的时长", () => {
    // 折叠后 selfMs 含被折叠调用自身的时间，因此这里断言节点时长等于调用时长：
    // 节点没在那次调用之外多花时间。
    const stage = flow.stages[0];
    assert.equal(stage.durationMs, 5252, "节点时长 = 被折叠的那次调用时长");
    assert.equal(stage.tail.kind, "llm");
    // 余量被拆成「吐字」与「无埋点覆盖」，而不是笼统的一个数：
    assert.equal(stage.tail.textMs, 5252 - 4577, "总时长 − 首 token");
    assert.equal(stage.tail.uncoveredMs, stage.selfMs - stage.tail.textMs!);
  });

  it("同名同区间不互相认作父级（不绕成环）", () => {
    const f = buildFlow([span("tool.x", 0, 100), span("tool.x", 0, 100)]);
    assert.equal(f.stages.length, 2, "判不出上下级时并列，总好过丢一条或死循环");
  });
});

describe("嵌套不等于并行", () => {
  /**
   * `acp.session_new` 套在 `llm.supervisor-intent` 里：有交集，但不是并排在跑。
   *
   * 节点刻意比那次调用长出一截（5252 vs 4000），以避开穿透层折叠：
   * 本组验的是深度与并行语义。
   */
  const NESTED: TraceEvent[] = [
    span("node.understand", 0, 5252),
    span("llm.supervisor-intent", 0, 4000),
    span("acp.session_new", 0, 1607),
  ];

  const children = buildFlow(NESTED).stages[0].children;

  it("被包含的那条不标并行，否则会被读成两段时间能分开优化", () => {
    for (const c of children) {
      assert.equal(c.parallel, false, `${c.name} 是嵌套关系，不该标并行`);
    }
  });

  it("嵌套深度可用于缩进，平铺会被读成两件并列的事", () => {
    const llm = children.find((c) => c.name === "llm.supervisor-intent")!;
    const acp = children.find((c) => c.name === "acp.session_new")!;
    assert.equal(llm.depth, 0);
    assert.equal(acp.depth, 1, "它在 llm 里面，再往里一层");
  });

  it("容器排在被它包着的那条之前，缩进才读得通", () => {
    assert.ok(
      children.findIndex((c) => c.name === "llm.supervisor-intent") <
        children.findIndex((c) => c.name === "acp.session_new"),
    );
  });

  it("真并行仍然标出来：同起点、互不包含的两条", () => {
    const f = buildFlow([
      span("node.tripFanout", 0, 700),
      span("tool.weather", 10, 615),
      span("tool.weather", 10, 550),
    ]);
    assert.ok(f.stages[0].children.every((c) => c.parallel));
  });
});

describe("并行分支不得互相认领子调用", () => {
  /**
   * 样本：出行 fan-out 两条分支并行，`llm.trip-task` 跑到 121s（触及 ACP 的 120s 超时），
   * `llm.ownership-task` 只有 38s。前者在区间上包住后者的思考段；只按区间判定时，
   * `think.ownership-task` 会同时挂在两条分支下，「模型思考合计」随之翻倍。
   *
   * 层级判据区分不了（两者确实不同层，llm ⊃ think），靠 agent 名区分。
   */
  const FANOUT: TraceEvent[] = [
    span("node.tripFanout", 0, 60005),
    span("llm.trip-task", 1, 121775, { agent: "trip-task" }),
    span("llm.ownership-task", 2, 37984, { agent: "ownership-task" }),
    span("think.trip-task", 2683, 9192, { agent: "trip-task" }),
    span("think.ownership-task", 2686, 8491, { agent: "ownership-task" }),
  ];

  const flow = buildFlow(FANOUT);

  it("各分支的思考只挂在自己那条调用下", () => {
    const byName = new Map(
      flow.stages.flatMap((s) => [
        [s.name, s.children.map((c) => c.name)] as const,
        ...s.children.map((c) => [c.name, [] as string[]] as const),
      ]),
    );
    const trip = flow.stages
      .flatMap((s) => (s.name === "llm.trip-task" ? s.children : []))
      .map((c) => c.name);
    assert.ok(!trip.includes("think.ownership-task"), "出行分支不该认领用车分支的思考");
    assert.ok(byName.size > 0);
  });

  it("思考总时长不因此翻倍", () => {
    const all = flow.stages.flatMap((s) => s.children).filter((c) => c.name.startsWith("think."));
    const uniq = new Set(all.map((c) => `${c.name}@${c.offsetMs}`));
    assert.equal(all.length, uniq.size, "同一段思考被算了两次，占比就会虚高");
  });

  it("同 agent 时照常判父子，这条规则不挡正常嵌套", () => {
    // 同样让节点长出一截（1000 vs 800），避开穿透层折叠：本条验的是父子判定。
    const f = buildFlow([
      span("node.answer", 0, 1000),
      span("llm.ownership", 1, 800, { agent: "ownership" }),
      span("think.ownership", 5, 500, { agent: "ownership" }),
    ]);
    const llm = f.stages[0].children.find((c) => c.name === "llm.ownership")!;
    assert.equal(llm.depth, 0);
    const think = f.stages[0].children.find((c) => c.name === "think.ownership")!;
    assert.equal(think.depth, 1, "同 agent 的思考仍要挂在它的调用下");
  });

  it("容器没有 agent 时不受影响（node.* 不带 agent）", () => {
    const f = buildFlow([span("node.answer", 0, 100), span("tool.x", 5, 50, { agent: "trip" })]);
    assert.deepEqual(f.stages[0].children.map((c) => c.name), ["tool.x"]);
  });
});

describe("fan-out 的归属：子调用要跟对分支", () => {
  /**
   * 样本形状：四条分支在同一毫秒起跑，各自建一个 ACP 会话、各自调工具。
   *
   * 两条规则，都关系到「这一步是谁做的」：
   *
   * 一、`tool.*` / `think.*` 记的是规范名（`tour`），`llm.*` 记的是带后缀的
   * 会话名（`tour-task`）。字面比较不相等时，每个工具都被判成不属于任何分支、
   * 全部平铺到阶段层，看不出哪几次调用属于哪条分支。归属比较前先剥后缀。
   *
   * 二、平铺排序（同起点长的在前）会把四条 `llm.*-task` 先排完，四条
   * `acp.session_new` 才跟上，四个会话创建于是全显示在最后那条分支下面，
   * 缩进正确而归属读错。每条子调用须紧跟自己的父分支。
   */
  const FANOUT: TraceEvent[] = [
    span("node.itineraryPlan", 0, 51535),
    span("llm.tour-task", 3, 51532, { agent: "tour-task" }),
    span("llm.drive-task", 3, 25486, { agent: "drive-task" }),
    span("llm.hotel-task", 3, 17402, { agent: "hotel-task" }),
    span("llm.transit-task", 3, 6679, { agent: "transit-task" }),
    span("acp.session_new", 3, 576, { agent: "tour-task" }),
    span("acp.session_new", 3, 555, { agent: "transit-task" }),
    span("acp.session_new", 3, 543, { agent: "drive-task" }),
    span("acp.session_new", 3, 526, { agent: "hotel-task" }),
    // 工具侧是规范名，没有 -task 后缀
    span("tool.poi_search", 1000, 188, { agent: "tour" }),
    span("tool.poi_search", 1200, 964, { agent: "hotel" }),
    span("tool.transit_route", 1000, 1228, { agent: "transit" }),
  ];

  const children = buildFlow(FANOUT).stages[0].children;
  const at = (i: number) => `${children[i].name}@${children[i].agent}`;

  it("工具挂到自己那条分支下：规范名与会话名剥后缀后再比", () => {
    const tourPoi = children.find((c) => c.name === "tool.poi_search" && c.agent === "tour")!;
    const hotelPoi = children.find((c) => c.name === "tool.poi_search" && c.agent === "hotel")!;
    assert.equal(tourPoi.depth, 1, "平铺到 depth 0 就等于说它不属于任何分支");
    assert.equal(hotelPoi.depth, 1);
  });

  it("每条子调用紧跟自己的父分支，不是四条分支排完再排四个会话", () => {
    assert.deepEqual(
      children.map((_, i) => at(i)),
      [
        "llm.tour-task@tour-task",
        "acp.session_new@tour-task",
        "tool.poi_search@tour",
        "llm.drive-task@drive-task",
        "acp.session_new@drive-task",
        "llm.hotel-task@hotel-task",
        "acp.session_new@hotel-task",
        "tool.poi_search@hotel",
        "llm.transit-task@transit-task",
        "acp.session_new@transit-task",
        "tool.transit_route@transit",
      ],
    );
  });

  it("四条分支仍是兄弟（depth 0），不因为时长差被判成嵌套", () => {
    const branches = children.filter((c) => c.name.startsWith("llm."));
    assert.equal(branches.length, 4);
    assert.ok(branches.every((c) => c.depth === 0));
    assert.ok(branches.every((c) => c.parallel), "同一毫秒起跑，四条都该标并行");
  });

  it("子调用不标成与自己父分支并行：嵌套不是并排在跑", () => {
    const tourAcp = children.find((c) => c.name === "acp.session_new" && c.agent === "tour-task")!;
    // 它只被 llm.tour-task 包住；与别的分支虽有时间交集，但那是别人的会话创建，
    // 同层兄弟之间才谈得上并行。
    assert.equal(tourAcp.depth, 1);
  });
});

describe("取消≠失败（展示层）", () => {
  /**
   * 样本形状：行程 fan-out 三条分支各自经 submit 交出结论后，fanout 主动掐掉
   * 剩余的流（提交即收工）。服务端记 `cancelled` + detail 原因，
   * 展示层不把它画成失败。
   */
  const CANCELLED: TraceEvent[] = [
    span("node.itineraryPlan", 0, 26000),
    span("llm.drive-task", 10, 25486, { agent: "drive-task", status: "cancelled", detail: "submitted" }),
    span("llm.hotel-task", 12, 17402, { agent: "hotel-task", status: "cancelled", detail: "submitted" }),
    span("llm.timeout-task", 14, 6000, { agent: "timeout-task", status: "cancelled", detail: "timeout" }),
    span("llm.broken-task", 16, 900, { agent: "broken-task", status: "failed" }),
  ];

  const flow = buildFlow(CANCELLED);
  const children = flow.stages[0].children;

  it("cancelled 原样传到子调用上，不折成 failed 也不折成 ok", () => {
    const drive = children.find((c) => c.name === "llm.drive-task")!;
    assert.equal(drive.status, "cancelled");
    assert.equal(drive.detail, "submitted");
    assert.equal(children.find((c) => c.name === "llm.broken-task")!.status, "failed");
  });

  it("阶段本身是 cancelled 时状态与原因都带出来（超时后活得比节点长的那条就是这种）", () => {
    const f = buildFlow([
      span("llm.trip-task", 0, 121000, { agent: "trip-task", status: "cancelled", detail: "timeout" }),
    ]);
    assert.equal(f.stages[0].status, "cancelled");
    assert.equal(f.stages[0].detail, "timeout");
  });

  it("瀑布图上提交收工画常态、其余取消画警示、失败才画红", () => {
    const bars = layout(CANCELLED).lanes.flatMap((l) => l.bars);
    const toneOf = (name: string) => bars.find((b) => b.label === name)!.tone;
    assert.equal(toneOf("llm.drive-task"), "normal", "设计内的快乐路径不该看起来像事故");
    assert.equal(toneOf("llm.timeout-task"), "warn", "超时导致的取消要能一眼看见");
    assert.equal(toneOf("llm.broken-task"), "danger");
  });

  it("耗时表的失败计数不含 cancelled，失败率不虚高", () => {
    const rows = hopBreakdown(CANCELLED).rows;
    const failedOf = (name: string) => rows.find((r) => r.name === name)!.failed;
    assert.equal(failedOf("llm.drive-task"), 0);
    assert.equal(failedOf("llm.broken-task"), 1);
  });

  it("老轨迹（status 只有 ok/failed）逐字不变", () => {
    const f = buildFlow(TURN);
    assert.ok(f.stages.every((s) => s.status === "ok"));
  });
});

describe("取消标签", () => {
  it("提交即收工不叫「已取消」，避免被当成故障排查", () => {
    assert.equal(cancelLabel("submitted"), "提交即收工");
  });

  it("超时与其它原因如实标注", () => {
    assert.equal(cancelLabel("timeout"), "已取消·分支超时");
    assert.equal(cancelLabel("cancelled"), "已取消·cancelled");
    assert.equal(cancelLabel(undefined), "已取消");
  });
});

describe("阶段末尾：吐字是量出来的，不是减出来的", () => {
  /**
   * 样本形状：`node.answer` 30816ms 底下只有一个 `llm.trip` 30815ms。
   * 那一行不带信息，只把真正的子调用往里推一层缩进，因此折掉。
   *
   * 折完剩约 4100ms，不能整个记成「生成文本」：`llm.trip` 的首 token 在 29963ms，
   * 真正吐字只有 852ms，另外约 3300ms 是没有任何埋点覆盖的空白。
   */
  const ANSWER: TraceEvent[] = [
    span("node.answer", 0, 30816),
    span("llm.trip", 0, 30815, { agent: "trip" }),
    span("llm.trip.ttft", 0, 29963, { agent: "trip" }),
    span("acp.session_new", 1, 1610, { agent: "trip" }),
    span("think.trip", 1700, 17339, { agent: "trip" }),
    span("tool.map_route", 19100, 113, { agent: "trip" }),
    span("think.trip", 19250, 290, { agent: "trip" }),
    span("tool.weather", 19600, 408, { agent: "trip" }),
    span("think.trip", 20100, 6925, { agent: "trip" }),
  ];

  const stage = buildFlow(ANSWER).stages[0];

  it("穿透层被折掉：node.answer 底下几乎等长的 llm.trip 不占一行", () => {
    assert.ok(!stage.children.some((c) => c.name === "llm.trip"));
    assert.equal(stage.collapsedFrom, "llm.trip", "折掉了但要留名，否则「谁答的」跟着丢");
  });

  it("被折叠层的孩子提上来，不再多一层缩进", () => {
    assert.deepEqual(
      stage.children.map((c) => c.name),
      ["acp.session_new", "think.trip", "tool.map_route", "think.trip", "tool.weather", "think.trip"],
    );
    assert.ok(stage.children.every((c) => c.depth === 0));
  });

  it("生成文本 = 总时长 − 首 token，不是扣完子调用的余数", () => {
    assert.equal(stage.tail.textMs, 30815 - 29963, "852ms");
    assert.notEqual(stage.tail.textMs, stage.selfMs, "余数是 4100 量级，两者不是一回事");
  });

  it("余下的部分单独一行，且说明它是 prefill/框架而不是生成", () => {
    assert.equal(stage.tail.kind, "llm");
    assert.equal(stage.tail.uncoveredMs, stage.selfMs - stage.tail.textMs!);
    assert.ok(stage.tail.uncoveredMs > 3000, `实测约 3279ms，实际 ${stage.tail.uncoveredMs}`);
  });

  it("没有 ttft 时如实给 null，不拿余数冒充吐字", () => {
    const f = buildFlow([span("node.answer", 0, 1000), span("llm.x", 0, 999, { agent: "x" })]);
    assert.equal(f.stages[0].tail.textMs, null);
  });

  it("两条并行分支的阶段不折叠，否则看不出是并行", () => {
    const f = buildFlow([
      span("node.tripFanout", 0, 38361),
      span("llm.trip-task", 1, 30294, { agent: "trip-task" }),
      span("llm.ownership-task", 2, 38358, { agent: "ownership-task" }),
    ]);
    assert.equal(f.stages[0].collapsedFrom, undefined);
    assert.equal(f.stages[0].children.length, 2);
  });

  it("非 LLM 阶段的余量仍叫「编排自身开销」", () => {
    const f = buildFlow([span("guard.input", 0, 224, { detail: "allow" })]);
    assert.equal(f.stages[0].tail.kind, "node");
    assert.equal(f.stages[0].tail.textMs, null);
    assert.equal(f.stages[0].tail.uncoveredMs, 224);
  });
});

/**
 * 行程规划 fan-out 的样本形状（节点 20022ms ⊃ 四条分支 ⊃ 各自的工具）。
 *
 * 这里只留 tour 一条：19961ms 的分支里三次景点搜索互相重叠、总共只占 5.5 秒，
 * 剩下 13 秒多分成三段空白：首 token 之前 2.7 秒、两轮之间 2.2 秒、
 * 结尾写三天 JSON 10.1 秒。空白是耗时大头，且位于第二层：
 * 节点那一层被分支铺满，没有空白。
 */
const TOUR_TURN: TraceEvent[] = [
  span("node.itineraryPlan", 0, 20022),
  // 同批还有别的分支，所以节点这一层不会被折叠成一次 LLM 调用。
  span("llm.drive-task", 25, 14377, { agent: "drive-task" }),
  span("tool.map_route", 1300, 5593, { agent: "drive" }),
  span("llm.tour-task", 30, 19961, { agent: "tour-task" }),
  span("llm.tour-task.ttft", 30, 1760, { agent: "tour-task" }),
  span("tool.spot_search", 2730, 4770, { agent: "tour", detail: "西湖" }),
  span("tool.spot_search", 2930, 3100, { agent: "tour", detail: "灵隐" }),
  span("tool.spot_search", 3030, 2400, { agent: "tour", detail: "宋城" }),
  // 点事件（0ms）落在收尾那段空白中间，与 `sidecar.filler` 的插入位置一致。
  span("sidecar.filler", 14000, 0, { agent: "tour" }),
  span("tool.plan_audit", 9730, 60, { agent: "tour" }),
  span("tool.weather", 9830, 30, { agent: "tour" }),
];

describe("空白段", () => {
  const stage = buildFlow(TOUR_TURN).stages[0]!;
  const gaps = stage.rows.flatMap((r) => (r.gap ? [r.gap] : []));

  it("空白要说在哪，不只说有多少", () => {
    // 只在末尾记两个总数（tail）时，图上看不出这一轮慢在哪；空白须按位置画出。
    assert.deepEqual(
      gaps.map((g) => [g.offsetMs, g.durationMs]),
      // 顺序与 rows 一致：按树前序，一条分支连着它自己的空白，
      // 不把两条分支的空白按墙钟交叉排（那样会被读成一条分支在等另一条）。
      [
        [25, 1275], // drive：首 token 之前
        [6893, 7509], // drive：拿到路线之后一路写到收工
        [30, 2700], // tour：建会话 + 首 token + 发出第一轮调用
        [7500, 2230], // tour：收到搜索结果之后、发下一轮之前
        [9860, 10131], // tour：结尾，在写那份三天 JSON
      ],
    );
  });

  it("空白逐层计算，不只算阶段那一层", () => {
    // fan-out 节点被分支铺满（30ms 的头尾都不到阈值），阶段这一层一条空白都没有；
    // 要找的十几秒全在 `llm.tour-task` 里面，深度也得跟着它。
    assert.deepEqual(gaps.map((g) => g.depth), [1, 1, 1, 1, 1]);
    assert.deepEqual(gaps.map((g) => g.kind), ["llm", "llm", "llm", "llm", "llm"]);
    // 阶段这一层只剩首尾 56ms——tail 那两行看不见分支内部的十几秒。
    assert.equal(stage.selfMs, 56);
  });

  it("只有最后一段算「在写最终输出」", () => {
    // 中间那段是收到工具结果后的思考，和收尾吐字不是一回事；
    // 两者都叫"生成"会让人以为这一轮写了三次最终答案。
    assert.deepEqual(gaps.map((g) => g.trailing), [false, true, false, false, true]);
    assert.equal(gapLabel(gaps[2]!), "模型在想（无工具在跑）");
    assert.equal(gapLabel(gaps[4]!), "模型在写最终输出");
    assert.equal(gapLabel({ ...gaps[4]!, kind: "node" }), "编排自身（无子调用）");
  });

  it("空白插在它该在的位置上，不是堆在末尾", () => {
    // 第一段空白排在三次搜索之前。
    assert.deepEqual(
      stage.rows.map((r) => (r.gap ? `空白${r.gap.durationMs}` : r.child.name)),
      [
        "llm.drive-task",
        "空白1275",
        "tool.map_route",
        "空白7509",
        "llm.tour-task",
        "空白2700",
        "tool.spot_search",
        "tool.spot_search",
        "tool.spot_search",
        "空白2230",
        "tool.plan_audit",
        "tool.weather",
        "空白10131",
        // 点事件排在它所在的那段空白之后：它不切断空白，也就不再插在中间。
        "sidecar.filler",
      ],
    );
    // rows 与 children 共享同一批对象，不是两份数据。
    assert.deepEqual(
      stage.rows.flatMap((r) => (r.child ? [r.child] : [])),
      stage.children,
    );
  });

  it("零宽的点事件不切断空白", () => {
    // 点事件不占时间；若切断空白，收尾连续写三天 JSON 的那一段会被拆成几行，
    // 被读成「想了几次」。
    assert.deepEqual(gaps.map((g) => g.durationMs).filter((ms) => ms > 9000), [10131]);
  });

  it("毫秒级的缝隙不进图", () => {
    // 三次搜索之间差着几十上百毫秒的起止，那是采集抖动不是"模型在想"。
    // 画出来会把一行摊成七行噪音，而它们的时间仍如实计在 selfMs / tail 里。
    assert.deepEqual(gaps.filter((g) => g.durationMs < 200), []);
  });

  it("叶子调用不画空白", () => {
    // 整段都是空白等于没有信息，却会给每个叶子（guard.input、tool.* 之流）
    // 凭空多出一条灰条。
    const bare = buildFlow([span("guard.input", 0, 258, { detail: "allow" })]).stages[0]!;
    assert.deepEqual(bare.children, []);
    assert.deepEqual(bare.rows, []);
    const leaves = TOUR_TURN.map((e) => String(e.data.name));
    assert.ok(leaves.includes("tool.weather")); // 叶子确实在这一轮里
    assert.deepEqual(gaps.filter((g) => g.depth > 1), []);
  });
});

describe("排队时间", () => {
  // 样本形状：fan-out 起跑 1.3 秒内九个高德请求一起发出，闸门 350ms/桶 2，
  // 这一跳 4770ms 中大半是在本地闸门排队。
  const flow = buildFlow([
    span("llm.tour-task", 0, 8000, { agent: "tour-task" }),
    span("tool.spot_search", 700, 4770, { agent: "tour", waitMs: 2100 }),
    span("tool.weather", 5600, 94, { agent: "tour", waitMs: 0 }),
    span("tool.route_audit", 5700, 6, { agent: "tour" }), // 老轨迹：没有这个字段
  ]);
  const byName = new Map(flow.stages[0]!.children.map((c) => [c.name, c]));

  it("排队与在途分开：两者的处置相反", () => {
    // 等上游只能等；排自己的队是并发策略，调得动。
    assert.equal(byName.get("tool.spot_search")!.waitMs, 2100);
    assert.equal(byName.get("tool.spot_search")!.durationMs, 4770);
  });

  it("0 不是没量过", () => {
    // 服务端每条工具 span 都写 waitMs（含 0）。字段缺失表示这一轮早于该埋点，
    // 整条按在途画；两者不可混同，否则老轨迹会被读成「从来没排过队」。
    assert.equal(byName.get("tool.weather")!.waitMs, 0);
    assert.equal(byName.get("tool.route_audit")!.waitMs, undefined);
  });

  it("排队不许比这一跳还长", () => {
    // 计量与计时是两处取的时间（闸门两侧 vs invokeTool 两端），
    // 读数打架时画出来就是一截溢出边界的条。
    const over = buildFlow([
      span("llm.tour-task", 0, 8000, { agent: "tour-task" }),
      span("tool.spot_search", 700, 400, { agent: "tour", waitMs: 999 }),
    ]);
    assert.equal(over.stages[0]!.children[0]!.waitMs, 400);
  });
});

describe("排队时间：上图的门槛", () => {
  it("1ms 的「排队」不上图：那是取票过一次 promise 链，不是排队", () => {
    // 画出来是每条工具都挂一截无意义的浅色，反而把真排了两秒的那几条淹掉。
    // 数仍然如实落库（模型里还是 1），只是不画。
    assert.equal(shownWaitMs(1), 0);
    assert.equal(shownWaitMs(0), 0);
    assert.equal(shownWaitMs(undefined), 0);
    assert.equal(shownWaitMs(2100), 2100);
  });
});

describe("排队时间：严重程度分档", () => {
  it("档位切在 0.5 / 2 / 5 秒上", () => {
    // 一轮二三十条工具，排队从 6ms 到 5385ms 不等；分档着色让严重程度不读数字也能看出。
    assert.equal(waitLevel(499), "none");
    assert.equal(waitLevel(500), "mild");
    assert.equal(waitLevel(1999), "mild");
    assert.equal(waitLevel(2000), "heavy");
    assert.equal(waitLevel(4999), "heavy");
    assert.equal(waitLevel(5000), "severe");
  });

  it("没量过与没排队都不挂牌", () => {
    // 老轨迹（undefined）不能被画成"没排队"，但也不该挂一块写着 0 的牌子。
    assert.equal(waitLevel(undefined), "none");
    assert.equal(waitLevel(0), "none");
    // 1ms 是取票过一次 promise 链，不是排队（见 shownWaitMs）。
    assert.equal(waitLevel(1), "none");
  });

  it("秒级读数：`5385ms` 显示为 5.4s", () => {
    assert.equal(waitText(5385), "5.4s");
    assert.equal(waitText(2168), "2.2s");
    assert.equal(waitText(940), "940ms");
  });

  it("首波排队的那几条各归各档", () => {
    // transit_route 5385 / map_route 5350 / spot_search 3694 / hotel_search 1468。
    // 最堵的两条落在最高档上。
    assert.deepEqual(
      [5385, 5350, 3694, 1468, 6].map(waitLevel),
      ["severe", "severe", "heavy", "mild", "none"],
    );
  });
});
