/**
 * 三张图共用的画法与坐标。
 *
 * # 单独成模块
 *
 * 会话页的逐轮流经图与演示大屏的实时流经图都要画同一张主链路。
 * 共用一份坐标与配色，保持同一套视觉语言，避免多份副本漂移。
 *
 * # 手写坐标而不是自动布局
 *
 * 自动布局会在每次加节点时把整张图重排，打乱读者记住的位置；
 * 这张图的读者反复核对同一处结构，位置稳定比排得漂亮重要。
 */

import { MarkerType, Position, type Edge, type Node } from "reactflow";

import type { NodeKind, WorkflowEdge, WorkflowNode } from "./graph-model";

/** 颜色只区分职责类别，不区分具体节点，控制颜色种数。 */
export const KIND_STYLE: Record<NodeKind, { background: string; color: string }> = {
  entry: { background: "#1f2328", color: "#fff" },
  orchestration: { background: "#0969da", color: "#fff" },
  agent: { background: "#8250df", color: "#fff" },
  // 直连模型与 pi Agent 必须分色：两者都"是个模型在说话"，
  // 但一个有工具表、有 prompt 文件、有独立进程，另一个都没有。
  // 同色会让人以为 -voice 那条路也能调工具。
  llm: { background: "#6e40c9", color: "#fff" },
  guard: { background: "#cf222e", color: "#fff" },
  tool: { background: "#1a7f37", color: "#fff" },
  sidecar: { background: "#bf8700", color: "#fff" },
  exit: { background: "#1f2328", color: "#fff" },
};

export interface Point {
  x: number;
  y: number;
}

/** 边标签的世界坐标布局：偏移会随 React Flow 缩放一起缩放。 */
export interface EdgeLabelLayout {
  offsetX: number;
  offsetY: number;
  lines: readonly string[];
}

export interface FlowEdgeData {
  labelLayout?: EdgeLabelLayout;
}

/**
 * 把长标签拆成适合 SVG 多行显示的短行。
 *
 * 斜杠和双竖线是工具/并行语义的分隔符，保留在上一行末尾，读者仍能看出
 * 每个工具名属于同一组；没有结构化分隔符的短中文标签保持单行。
 */
export function splitEdgeLabel(label: string | undefined): readonly string[] {
  if (!label) return [];
  const normalized = label
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  if (!normalized) return [];
  const existingLines = normalized.split("\n");
  if (existingLines.length > 1) return existingLines;

  const parts = normalized.split(/\s*(\/|‖)\s*/);
  if (parts.length < 3 || normalized.length <= 12) return [normalized];

  const lines: string[] = [];
  let current = "";
  for (const part of parts) {
    if (!part) continue;
    if (part === "/" || part === "‖") {
      current = `${current.trim()} ${part}`.trim();
      lines.push(current);
      current = "";
    } else {
      current = current ? `${current} ${part}` : part;
    }
  }
  if (current) lines.push(current.trim());
  return lines.length > 1 ? lines : [normalized];
}

/**
 * 主链路坐标。
 *
 * `riskGate` 与 `dispatch` 之间留了 190px：那一段上要落两条条件边的标签
 * （"硬禁：拒绝话术直接下发" / "其余"），挤在一起时看不出哪条通向哪。
 *
 * 同理 `dispatch` 与分支列之间的 320px 是给六条路由标签的，不是留白。
 */
export const POS: Record<string, Point> = {
  start: { x: 0, y: 300 },
  // 200 而不是 150：方框统一 170 宽，150 时它与 START 重叠 20px。
  understand: { x: 200, y: 300 },
  /*
   * 看图节点在 START 与 understand 之间是串行的一跳（START→看图→understand，
   * 没有 START→understand 的直连边）。它不与 understand 并排挤在主线上（那要把右边整条链
   * 平移 200px），而是垂到主线下方，两条边一去一回都"往右"，读起来仍是前进而不是环。
   * 没照片的轮次它直通，图上灰着不亮。
   */
  observeAttachments: { x: 100, y: 470 },
  /*
   * 抽取会话夹在 understand 与 riskGate 中间，不是吊在下游节点正上方。
   *
   * 它有进有出（进：发起抽取；出：四要素回图状态供风险门与路由取用）。
   * 吊在正上方时两条边里必有一条要往回绕，而这张图上只有"往右"是前进，
   * 回绕的边会被读成环。
   */
  "supervisor-intent": { x: 355, y: 130 },
  riskGate: { x: 520, y: 300 },
  // 硬禁那一支就地收口，不画一条横跨全图连回右端 END 的边（见 deny-end 的说明）。
  "deny-end": { x: 880, y: 480 },
  dispatch: { x: 880, y: 300 },
  // 五个路由分支排一列，出行在最上：它是唯一还会继续 fan-out 的那个。
  itineraryPlan: { x: 1200, y: 30 },
  ownershipDual: { x: 1200, y: 300 },
  buyingCatalog: { x: 1200, y: 390 },
  testDriveFlow: { x: 1200, y: 480 },
  cabinCompanion: { x: 1200, y: 570 },
  /*
   * 副 lane 节点（ACR-023）排在主分支列右侧同一高度区间：它们与主分支同 superstep 并行，
   * 画在同一带上才读得出"并排跑"；不进 -task 那一列（那是行程 fan-out 的五支）。
   *
   * 只有第一个上移到 268，其余四个保持 80 的行距。
   *
   * `sideItineraryPlan` 是这一列唯一有两行正文的，字号 16 时它有 97px 高，
   * 80 的行距会压住下面那个方框。不整列拉开行距：整列下移会把
   * 这一列推进边标签最密的那条走廊，被方框遮挡的标签增多（实测 14 张 → 18 张）。
   * 向上借 32px 没有代价：上面的 `-task` 那一列整列也抬 24px 即可让开。
   */
  sideItineraryPlan: { x: 1440, y: 268 },
  sideOwnershipDual: { x: 1440, y: 380 },
  sideBuyingCatalog: { x: 1440, y: 460 },
  sideTestDriveFlow: { x: 1440, y: 540 },
  sideCabinCompanion: { x: 1440, y: 620 },
  /*
   * 出行的五条分支贴着 itineraryPlan 右侧展开，整列上抬 24px：
   * 末尾的 `ownership-task` 是两行的（"用车助手 Agent（续航 / 补能）"），
   * 字号 16 时它有 68px 高，落点 210 会伸到 278，压住上移后的
   * `sideItineraryPlan`。70 的行距不变，只调整整列落点。
   */
  "drive-task": { x: 1470, y: -94 },
  "hotel-task": { x: 1470, y: -24 },
  "tour-task": { x: 1470, y: 46 },
  "transit-task": { x: 1470, y: 116 },
  "ownership-task": { x: 1470, y: 186 },
  /*
   * 座舱的单支分支排在右下角的空档里，不进 -task 那一列：
   * 那一列是出行 fan-out 的五支，混进去会读成"座舱也是并行分支之一"。
   */
  "cabin-task": { x: 1690, y: 620 },
  /*
   * 工具层与权限门排在分支列正下方，不排在它右侧。
   *
   * 放右侧时它们正好压在"分支 → 应答"那条主干上：九条汇聚边要绕过两个方框，
   * 边标签叠成一团，遮挡主干。
   */
  tools: { x: 1220, y: 760 },
  guard: { x: 1490, y: 760 },
  // 汇合点在主副两列之后、应答之前；应答与它的两种说法整体右移一格。
  join: { x: 1670, y: 300 },
  answer: { x: 1900, y: 300 },
  // 应答的两种说法上下分开，END 仍在中线上：它是图的终点。
  narrator: { x: 2140, y: 150 },
  "answer-agent": { x: 2140, y: 430 },
  end: { x: 2380, y: 300 },
  /*
   * HTTP 触发的两条子图排在左下角，与 START 同一列、在硬禁收口的下方：
   * 它们与主链路没有任何一条边相连（validateGraph 断言从 START 不可达），
   * 摆在分支列旁边会读成"路由的第七个去向"。左下角的空档正好够两条子图，
   * 右边止于 790，离 dispatch（880）还有一段，不与硬禁收口那条边冲突。
   */
  "entry-http": { x: 0, y: 620 },
  navPlan: { x: 340, y: 560 },
  "nav-task": { x: 620, y: 560 },
  guideBrief: { x: 340, y: 760 },
  "guide-access-task": { x: 620, y: 690 },
  "guide-spots-task": { x: 620, y: 760 },
  "guide-comfort-task": { x: 620, y: 830 },
};

/** 旁路那张图：一条线，没有分支路由，所以排成横的一串。 */
export const SIDECAR_POS: Record<string, Point> = {
  turn: { x: 0, y: 60 },
  spanSink: { x: 0, y: 210 },
  pair: { x: 250, y: 135 },
  silence: { x: 480, y: 135 },
  l0: { x: 710, y: 45 },
  l1: { x: 710, y: 225 },
  outputGuard: { x: 940, y: 135 },
  filler: { x: 1170, y: 135 },
};

/**
 * 唤醒入口：采集到判定是一条直线，判定之后四散。
 *
 * `windows` 与 `dismiss` 一上一下离中线远一点：
 * `classify → handoff`（带指令直达）那条要横穿这一段，
 * 它们贴着中线时会压住这条主干，而"一句直达"是这张图的重点。
 */
export const WAKE_POS: Record<string, Point> = {
  micSwitch: { x: 0, y: 140 },
  ptt: { x: 0, y: 320 },
  capture: { x: 230, y: 140 },
  vad: { x: 460, y: 140 },
  ttsMute: { x: 690, y: 140 },
  transcribeOnly: { x: 920, y: 140 },
  classify: { x: 1150, y: 140 },
  windows: { x: 1400, y: -40 },
  dismiss: { x: 1400, y: 420 },
  handoff: { x: 1680, y: 140 },
  discard: { x: 1680, y: 340 },
};

/** 把一整张图的坐标整体平移：总链路复用细节图的排布，不另抄一份。 */
function shift(pos: Record<string, Point>, dx: number, dy: number): Record<string, Point> {
  return Object.fromEntries(Object.entries(pos).map(([k, v]) => [k, { x: v.x + dx, y: v.y + dy }]));
}

/**
 * 总链路：主链路照原样摆在中带，旁路整条压在它下面，两条跨链路各自贴边。
 *
 * # 坐标也是组合出来的
 *
 * `shift(POS, …)` / `shift(SIDECAR_POS, …)`：细节图调了位置，总图跟着动，
 * 不会与细节图不一致。
 *
 * # 旁路压在下面而不是并排
 *
 * 旁路与主链路在时间上完全重叠（它并行于整个 turn）。左右并排会读成
 * "先主链路后旁路"；上下叠放才读得出"同时在跑"。
 */
const MAIN_DX = 700;
const SIDECAR_DY = 1150;

export const TOTAL_POS: Record<string, Point> = {
  // 进图之前：入口与网关在最左。
  "entry-voice": { x: 0, y: 120 },
  "entry-touch": { x: 0, y: 300 },
  gw: { x: 250, y: 210 },
  // 主链路整体右移，给上面那三个让位。
  ...shift(POS, MAIN_DX, 0),
  // 旁路整条压在主链路下面；`turn` 与 `spanSink` 是共享设施，单独摆到主链路左侧，
  // 因为轮次边界在图执行之前（registerPair 在 run() 里，invoke 之前）。
  ...shift(SIDECAR_POS, MAIN_DX + 200, SIDECAR_DY),
  turn: { x: 480, y: 480 },
  spanSink: { x: 480, y: 700 },
  /*
   * 收口的三个竖着叠而不是横着排。
   *
   * 横排时它们给整张图又加了 1200px 宽，而这张图的可读性瓶颈是宽高比：
   * 容器不到 1000px 宽，图每宽 1000px，默认缩放就掉一档。
   * 竖排后三个都落在同一列，宽度只多 500px。
   */
  toolProgress: { x: 3300, y: 640 },
  titlePath: { x: 3300, y: 100 },
  client: { x: 3560, y: 370 },
  console: { x: 1400, y: 1000 },
};

/**
 * 连接点。默认是"上进下出"（竖排图的约定），而这些图是横排的，
 * 不改的话每条边都要先向下绕再折回来。
 *
 * 只有工具层与权限门例外：它们在分支列正下方，边本来就是从上方落下来的。
 */
export const HANDLES: Record<string, Position> = { tools: Position.Top, guard: Position.Top };

type LabelLaneGroup =
  | "tools"
  | "guard"
  | "answer"
  | "answer-output"
  | "dispatch-bypass"
  | "cabin";

interface LabelLaneMember {
  index: number;
  edge: WorkflowEdge;
  group: LabelLaneGroup;
}

const TOOL_LABEL_X_OFFSET = 96;
const TOOL_LABEL_LANE_SPACING = 40;
const GUARD_LABEL_LANE_SPACING = 28;
const ANSWER_LABEL_LANE_SPACING = 28;
const ANSWER_LABEL_Y_BIAS = 10;
const DISPATCH_BYPASS_X_OFFSET = 48;
const CABIN_TOOL_LABEL_Y_OFFSET = 56;
const CABIN_TASK_LABEL_Y_OFFSET = -100;
const DIRECT_GUARD_LABEL_X_OFFSET = 120;
const TOOLS_GUARD_LABEL_Y_OFFSET = -62;
const ITINERARY_GUARD_LABEL_Y_OFFSET = 1;
const TEST_DRIVE_GUARD_LABEL_X_OFFSET = 40;
const TEST_DRIVE_GUARD_LABEL_Y_OFFSET = 90;
const ITINERARY_ANSWER_LABEL_X_OFFSET = -135;
const ANSWER_AGENT_LABEL_Y_OFFSET = -4;

/**
 * 躲开方框的最后一道偏移（世界坐标，叠加在上面那些通道偏移之上）。
 *
 * # 必要性
 *
 * React Flow 的节点层画在边层之后，所以任何落在方框上的边标签都会被盖掉，
 * 读出来的文字是错的（例如 `写 sideLanes[节点名]` 被 `汇合 join` 盖住左半边，
 * 只剩 `leLanes[节`）。这里把这些标签各自挪进旁边的空当。
 *
 * # 这些数是量出来的
 *
 * 取真实渲染的方框与标签包围盒，按「相交面积 ÷ 标签面积」找覆盖率最低的落点，
 * 并对偏移距离罚分：标签离它所描述的边太远就认不出是谁的了。方框按运行时
 * 最高的形态放大 22px 再算：节点会因为多一行 `▸ 此刻在这里 · 1234ms` 变高。
 *
 * # 改了图之后重算
 *
 * 动过 `POS`、节点字号或标签文案之后，这张表就过期了，不手调：
 * 量一遍真实包围盒重算，判据是"被盖 ≥15% 的标签为 0 张"。
 */
export const LABEL_CLEARANCE: Record<string, { dx?: number; dy?: number }> = {
  // 主链路旁路：整条沿 y=300 横穿，中点正好落在副 lane 第一格上
  "dispatch->answer": { dx: -120, dy: -80 },
  // 五条「副任务」：从 dispatch 横着拉到副 lane 列，中点压在主分支列上
  "dispatch->sideItineraryPlan": { dy: -70 },
  "dispatch->sideOwnershipDual": { dy: -130 },
  "dispatch->sideBuyingCatalog": { dx: -110 },
  "dispatch->sideTestDriveFlow": { dx: -110 },
  "dispatch->sideCabinCompanion": { dx: -110, dy: 10 },
  // 工具名：主分支列与副 lane 列之间只有 70px，容不下一张工具名标签
  "itineraryPlan->tools": { dx: -90, dy: -130 },
  "ownershipDual->tools": { dx: 290 },
  "buyingCatalog->tools": { dx: 190, dy: -40 },
  "testDriveFlow->tools": { dx: -40, dy: 40 },
  "cabinCompanion->tools": { dy: 140 },
  "cabinCompanion->cabin-task": { dy: 160 },
  // 权限门走廊
  "tools->guard": { dy: 20 },
  "itineraryPlan->guard": { dx: 110, dy: 80 },
  // 汇合与应答：join 与 answer 之间只有 60px
  "ownershipDual->join": { dx: -160, dy: -130 },
  "sideItineraryPlan->join": { dx: 80, dy: -100 },
  "join->answer": { dy: -100 },
  "answer->narrator": { dx: -40, dy: -10 },
  "answer->answer-agent": { dx: 60, dy: -10 },
  // 左下角那两条子图
  "navPlan->nav-task": { dy: -80 },
};

function labelLaneGroup(edge: WorkflowEdge): LabelLaneGroup | undefined {
  if (edge.to === "tools") return "tools";
  if (edge.to === "guard") return "guard";
  // 汇合走廊：主分支节点 → join（lane 的语义通道与直连 answer 时相同，终点是 join）。
  if (
    edge.to === "join" &&
    [
      "itineraryPlan",
      "ownershipDual",
      "buyingCatalog",
      "testDriveFlow",
      "cabinCompanion",
    ].includes(edge.from)
  ) {
    return "answer";
  }
  if (edge.from === "dispatch" && edge.to === "answer") {
    return "dispatch-bypass";
  }
  if (edge.to === "cabin-task") return "cabin";
  if (edge.from === "answer") return "answer-output";
  return undefined;
}

function laneOffset(position: number, count: number, spacing: number): number {
  return (position - (count - 1) / 2) * spacing;
}

/**
 * 为边标签按拓扑走廊分道，避免把标签从它所描述的边上推走。
 *
 * React Flow 的默认标签都在路径中心，工具/权限/应答汇聚时自然会堆在同一
 * 条走廊。这里仅对这些有明确语义的汇聚组分配有限 lane；普通短路由标签
 * 保持原位。偏移是世界坐标，缩放时与流程图同步，不依赖当前视口像素。
 *
 * 分完道再叠一层 `LABEL_CLEARANCE`（躲方框）。`clearance: false` 只给测试用：
 * 要单独量"通道本身稳不稳"，躲方框那一层会把同一条走廊里的 X 拆开。
 */
export function planEdgeLabelLayouts(
  defs: readonly WorkflowEdge[],
  options?: { clearance?: boolean },
): Map<number, EdgeLabelLayout> {
  const groups = new Map<LabelLaneGroup, LabelLaneMember[]>();
  defs.forEach((edge, index) => {
    if (!edge.label) return;
    const group = labelLaneGroup(edge);
    if (!group) return;
    const members = groups.get(group) ?? [];
    members.push({ index, edge, group });
    groups.set(group, members);
  });

  const result = new Map<number, EdgeLabelLayout>();
  for (const members of groups.values()) {
    // 定义顺序本身就是稳定的语义顺序；不要依赖运行时事件到达顺序。
    members.forEach((member, position) => {
      const lines = splitEdgeLabel(member.edge.label);
      const spacing = member.group === "tools"
        ? TOOL_LABEL_LANE_SPACING
        : member.group === "guard" || member.group === "answer-output"
          ? GUARD_LABEL_LANE_SPACING
          : ANSWER_LABEL_LANE_SPACING;
      const offsetY = laneOffset(position, members.length, spacing);
      let offsetX = member.group === "tools"
        ? TOOL_LABEL_X_OFFSET
        : member.group === "dispatch-bypass"
          ? DISPATCH_BYPASS_X_OFFSET
          : 0;
      let adjustedOffsetY = offsetY + (member.group === "answer" ? ANSWER_LABEL_Y_BIAS : 0);

      // 这些是同一走廊里仍会相交的两条短边：给它们留出固定的阅读槽，
      // 但偏移保持在有限范围内，避免标签脱离所描述的连线。
      if (member.edge.from === "cabinCompanion" && member.edge.to === "tools") {
        adjustedOffsetY = CABIN_TOOL_LABEL_Y_OFFSET;
      }
      if (member.edge.from === "cabinCompanion" && member.edge.to === "cabin-task") {
        adjustedOffsetY = CABIN_TASK_LABEL_Y_OFFSET;
      }
      if (member.group === "guard" && member.edge.from === "tools") {
        adjustedOffsetY = TOOLS_GUARD_LABEL_Y_OFFSET;
        offsetX = DIRECT_GUARD_LABEL_X_OFFSET;
      }
      if (member.group === "guard" && member.edge.from === "itineraryPlan") {
        adjustedOffsetY = ITINERARY_GUARD_LABEL_Y_OFFSET;
      }
      if (member.group === "guard" && member.edge.from === "ownershipDual") {
        offsetX = DIRECT_GUARD_LABEL_X_OFFSET;
      }
      if (member.group === "guard" && member.edge.from === "testDriveFlow") {
        offsetX = TEST_DRIVE_GUARD_LABEL_X_OFFSET;
        adjustedOffsetY = TEST_DRIVE_GUARD_LABEL_Y_OFFSET;
      }
      if (member.group === "answer" && member.edge.from === "itineraryPlan") {
        offsetX = ITINERARY_ANSWER_LABEL_X_OFFSET;
      }
      if (member.group === "answer-output" && member.edge.to === "answer-agent") {
        adjustedOffsetY = ANSWER_AGENT_LABEL_Y_OFFSET;
      }
      result.set(member.index, {
        offsetX,
        offsetY: adjustedOffsetY,
        lines,
      });
    });
  }

  if (options?.clearance === false) return result;

  // 躲方框的偏移最后叠：上面是"同一条走廊里彼此让开"，这一步是"不压在方框上"。
  // 没有通道分组的边（路由旁路、副任务那五条）在这里才第一次拿到 layout，
  // 换行也在这里补，否则长标签仍是一行。
  defs.forEach((edge, index) => {
    if (!edge.label) return;
    const nudge = LABEL_CLEARANCE[`${edge.from}->${edge.to}`];
    if (!nudge) return;
    const base = result.get(index);
    result.set(index, {
      offsetX: (base?.offsetX ?? 0) + (nudge.dx ?? 0),
      offsetY: (base?.offsetY ?? 0) + (nudge.dy ?? 0),
      lines: base?.lines ?? splitEdgeLabel(edge.label),
    });
  });

  return result;
}

/** 三张图共用同一套画法，保持一套视觉语言。 */
export function toNodes(
  defs: readonly WorkflowNode[],
  pos: Record<string, Point>,
  /** 运行时投影：给每个方框叠一层"这一轮走没走到"。不传即纯结构图。
      `pulse` = 此刻停在这里的呼吸辉光（只给 current 节点，动效参数见 demo/design-spec.md）。 */
  decorate?: (n: WorkflowNode) => { dim?: boolean; accent?: string; suffix?: string; pulse?: boolean } | undefined,
): Node[] {
  return defs.map((n) => {
    const d = decorate?.(n);
    const nodeClassName = [
      d?.dim ? "flow-node-dim" : undefined,
      d?.pulse ? "flow-node-pulse" : undefined,
    ]
      .filter(Boolean)
      .join(" ");
    return {
      id: n.id,
      position: pos[n.id] ?? { x: 0, y: 0 },
      className: nodeClassName || undefined,
      data: { label: d?.suffix ? `${n.label}\n${d.suffix}` : n.label },
      sourcePosition: Position.Right,
      targetPosition: HANDLES[n.id] ?? Position.Left,
      style: {
        ...KIND_STYLE[n.kind],
        // 虚线框 = 不是 StateGraph 的一步（fan-out 分支 / 工具层 / 权限门）。
        // 它们发生在节点体内部；画成实线会让人以为 LangGraph 会路由到权限门，
        // 或以为存在 addNode("drive-task")。
        border: d?.accent
          ? `2px solid ${d.accent}`
          : n.graphNode
            ? "none"
            : "2px dashed rgba(255,255,255,.65)",
        borderRadius: 8,
        padding: 10,
        /*
         * 16 而不是 12：这张图在 fitView 之后看，屏幕上的字号是
         * `fontSize × 缩放`，而缩放由图宽 ÷ 容器宽决定。2550 的世界宽
         * 落进 1328px 的容器 = 0.5，12px 的标签在屏幕上只剩 6px。
         *
         * 只动字号不动宽度。字大了折行更多、方框更高，而高度这一侧有余量
         * （世界高 950，撑到 1120 才轮到高度决定缩放）；宽度没有：170 是
         * 坐标表所有横向间隙的基准，加宽 30px 等于把每一道间隙同时挪 30px，
         * 边标签压在方框上的面积会翻倍。要加宽就得连坐标表一起重排。
         */
        fontSize: 16,
        whiteSpace: "pre-line",
        width: 170,
        // 没走到的方框压暗而不是删掉：整张图必须还在，
        // 否则读者看到的是"这一轮的路径"而不是"这一轮在整张图上的位置"。
        // 不用整体透明度：透明节点会让 Background 的点阵穿透，文字也会变成灰雾。
        opacity: 1,
      },
      // 只读：不可拖、不可连、不可删。
      draggable: false,
      connectable: false,
      deletable: false,
    };
  });
}

export function toEdges(
  defs: readonly WorkflowEdge[],
  prefix: string,
  /** `particle` = 光点沿边流动（只给"这一轮真正走过"且还在进行中的边；
      给没走的边加粒子属于不实表述，见 demo/design-spec.md）。 */
  decorate?: (e: WorkflowEdge) => { dim?: boolean; accent?: string; particle?: boolean } | undefined,
): Edge[] {
  const labelLayouts = planEdgeLabelLayouts(defs);
  return defs.map((e, i) => {
    const d = decorate?.(e);
    const labelLayout = labelLayouts.get(i);
    return {
      id: `${prefix}${i}`,
      source: e.from,
      target: e.to,
      label: e.label,
      data: labelLayout ? { labelLayout } : undefined,
      // 正交折线而不是默认贝塞尔：二十多条边里有大量同起点的扇出，
      // 贝塞尔会让它们在起点附近糊成一片，折线至少能看出各自去了哪。
      // particle 类型只是"smoothstep + 一颗沿路径跑的光点"，画法完全一致（ParticleEdge）。
      type: d?.particle ? "particle" : "smoothstep",
      // 条件边虚线、并行边加粗，两者语义不同：
      // 条件边是"走这条或那条"，并行边是"两条同时走"。
      animated: e.parallel === true,
      style: {
        // 三种线必须能直接区分（总链路图依赖这一点）：
        //   点线 `2 3` = 只读旁观（看，但不影响被看的一方）
        //   虚线 `5 4` = 条件边（走这条或那条）
        //   实线      = 控制流
        strokeDasharray: e.readonly ? "2 3" : e.conditional ? "5 4" : undefined,
        strokeWidth: d?.accent ? 3 : e.parallel ? 2.5 : e.readonly ? 1.2 : 1.5,
        ...(d?.accent ? { stroke: d.accent } : {}),
        opacity: d?.dim ? 0.32 : 1,
      },
      // 标签压在边上看不清，给不透明底衬。
      //
      // `labelStyle` 的字色必须显式给：reactflow 的默认边标签是深色字
      // （它假设浅色画布），而控制台是深色底，不给时文字不可见。
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 3,
      labelBgStyle: { fill: "var(--bg, #0f1115)", fillOpacity: 0.92 },
      // 字号与节点同理（见 toNodes）：fitView 之后 11px 到眼前只剩 5.5px。
      labelStyle: { fill: "var(--fg, #e6e8ec)", fontSize: 11, opacity: d?.dim ? 0.65 : 1 },
      markerEnd: { type: MarkerType.ArrowClosed },
    };
  });
}
