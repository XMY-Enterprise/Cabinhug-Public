/**
 * graph/state —— 图状态 schema。
 *
 * 图状态即 ①Working 短期任务状态（§7①）：跨轮上下文的唯一承载。
 * 对话历史表（PG）不回灌模型；模型看到的历史来自这里。
 * 状态必须完全可序列化（FL-11 F-11-02 / FL-14 约束）——
 * 不得放函数、连接句柄、流对象、AbortController：检查点落 PG 时无法序列化。
 *
 * 后加的字段一律可选，保证旧检查点仍可读。
 */

import { Annotation } from "@langchain/langgraph";

import type { CompanionConstraint } from "./companions";
import type { TripPlanDaySnapshot, TripPlanSnapshot } from "@cabinhug/shared";
import type { ChatTurnMessage } from "../llm";
import type { ConsultationState } from "./subgraphs/service";
import type { RiskCategory, RiskDecision } from "../guard/risk-policy";
import type { PhotoInput, PhotoObservationState } from "./vision";
import type { Capability, DiagnosisReport } from "@cabinhug/shared";
import type { VideoInput } from "./media";

/**
 * 意图理解的四要素（§4.2、FL-11 F-11-01）。
 *
 * 它不是分类结果。US-11 的失败样例："带我妈去黄山"被归为"出行规划"后，
 * "我妈"携带的时长约束丢失，方案表面正常，实际不适合带老人出行。
 * 所以 `constraints` 是这个结构里最重要的字段，不是附属信息。
 */
/** 车主点名的交通方式。与 `TripPlanState.transit.recommended` 同一套取值。 */
export type TransitMode = "drive" | "train" | "flight";

/** 出险的事故类型。五型与 `claim_checklist` 的分叉一一对应。 */
export type AccidentType = "single_vehicle" | "two_party" | "injury" | "battery_or_fire" | "charging_pile";

/**
 * 一次出险咨询里已经说清的事实。见下面 `claimFacts` 通道的注释。
 * `updatedAt` 只为排查用——"这个数是哪一轮说的"在轨迹里要看得见。
 */
export interface ClaimFactsState {
  estimatedLossCny?: number;
  accidentType?: AccidentType;
  updatedAt: string;
}

export interface Intent {
  goal: string;
  /**
   * 故障症状的四个判定（ADR-012）：只在 route 是 service / ownership 且原话描述了症状时由模型给，
   * 没说到的字段不给。`assessRisk` 的输入就是它们（`warningLight` 另由观察层从代码判）；
   * 编排层不从 constraints 或原话里解析"随速度加剧""一直响"这些说法——说法无法穷举，由模型判定。
   */
  symptom?: {
    safetyCritical?: boolean;
    worsensWithSpeedOrBraking?: boolean;
    persistent?: boolean;
    warningLight?: boolean;
  };
  /** 硬约束（同行者、时间窗、预算…）。丢掉约束的分类等于没有理解。 */
  constraints: string[];
  context: string;
  /** 风险边界的自由文本说明——给人看的归因，进轨迹。判定用下面那一栏。 */
  riskBoundary: string;
  /**
   * 风险边界的枚举判定（AC-11-7）。由 LLM 在意图理解里给出，处置表在
   * `guard/risk-policy.ts`。`riskBoundary` 那一栏是散文，代码判不了；这一栏才是判据。
   *
   * 可选是为了旧检查点：旧检查点里没有它，读出来是 undefined。`riskDecision()` 把 undefined 当
   * `unknown` 处理——放行并告警，不当作"无风险"。
   */
  riskCategory?: RiskCategory;
  /**
   * 这一轮顺带要办的事，取值是一张封闭候选表（见 `intent.ts` 的 `SECONDARY_INTENTS`）。
   *
   * 与 `action` 的分工：`action` 是"对行程草案的处置"，一轮只有一个；这一栏是
   * 别的领域里"要不要顺手做某件事"的门，可以同时有几个，也可以一个都没有。
   *
   * # 为什么要有它
   *
   * 留档、保养推算、维修记录预取这些门若用正则表判（「记录 / 留档 / 记下」「保养 / 机油 / 首保」），
   * 判据是字面的而人的说法不是，例如「坐飞机出发」会被当成要导航。
   *
   * 不给每个场景加一栏：那样 schema 会随场景线性变长，而绝大多数轮次用不到其中任何一个。
   * 一栏数组、封闭候选，模型填起来自然，下游各取所需。
   */
  secondaryIntents?: string[];
  /**
   * 出险咨询的两个事实（ADR-012）：车主口述的估损金额（元）与事故类型。
   * 由意图层从原话里给，编排层不用正则解析"两千块"——`claim_advisor` 拿它算走不走保险，
   * `claim_checklist` 拿它选材料清单。没说就缺席，缺席时下游退到报价单 / 单方事故并说明。
   */
  estimatedLossCny?: number;
  accidentType?: AccidentType;
  /**
   * 这一轮原话里新提、当前草案还没体现的要求（ADR-010）。
   *
   * 是 `constraints` 的子集，语义不同：`constraints` 是全量快照（每轮把一直生效的老要求
   * 重抄一遍，下游要拿全量去排），`newAsks` 是增量。不能用两轮 `constraints` 做集合差去推它——
   * 那是两次独立 LLM 调用各自的复述，措辞会漂移，差集不可靠。
   */
  newAsks?: string[];
  /**
   * 这一轮是接着改手上那份行程（`refine`），还是另起一趟（`new`）——ADR-010。
   *
   * 只看"状态里有没有行程"会把新的一趟当成细化轮：新行程沿用旧行程的酒店与车程，
   * 任务的 base 挂着旧行程的 id，确认时会原地覆盖旧行程。
   * 只有模型同时拿到原话和已确认行程清单，所以由它判定。
   *
   * 缺席按 `refine` 走。
   */
  planScope?: "new" | "refine";
  /**
   * 上一轮问过"取消哪一份"时，车主这句话指的是第几份（1 起）或 `"all"`。
   *
   * 由 LLM 给，正则只作兜底——与 `action` 同一条规则（见本文件 `Intent.action` 与
   * `intent.ts` 文件头）。追问文案允许车主说目的地或出发日期，字面判据只认序号和「全部」，
   * 认不出「从上海到张家港的行程」「九月二十五号的行程」「南通那趟」「中秋那次」这类开放说法。
   *
   * 候选列表由编排层送进 probe（ADR-010），没送就没有这一栏。
   */
  cancelPick?: number | "all";
  /**
   * 这一轮要去的目的地，只在 route=itinerary 时有。
   *
   * 用途只有一个：让编排层在 fan-out 一开始就并行预取目的地亮点（`destination_highlights`），
   * 而不是等 tour 排完再由它自己去搜——tour 是 fan-out 里最长的一条腿，亮点搜索会继续拉长它。
   * 没有这一栏就不预取，narration 少一句风味，主页卡片仍由确认后的后台补算给出，不影响功能。
   */
  destinations?: string[];
  /**
   * 车主明确说出来的交通方式（ADR-012），只在他真的说了时才有。
   *
   * # 为什么必须由模型给
   *
   * `assembleTransit` 的推荐是一张固定的优先级表（短途自驾 → 有高铁走高铁 → 才是飞机），
   * 不参考车主的表态：车主明确说"坐飞机"时，只要 transit 分支返回了车次，仍会推荐火车。
   * 这一栏把"他已经说了什么"送进那个判断（ADR-010）。
   *
   * 与 `constraints` 的分工同 `tripLimits`：那里是给人看的原话，这一栏是给代码用的枚举，
   * 不要再从 constraints 的文本里解析一遍——「坐飞机」「飞过去」「不自驾」「走高铁」
   * 的说法无法穷举，由模型判定。
   */
  transitMode?: TransitMode;
  /**
   * 车主明确说出来的行程数量约束（ADR-012），只在 route=itinerary 时有。
   *
   * 由 LLM 给，不从 `constraints` 的文本里再解析一遍：用正则从文本捞总天数时，
   * 「三日行程」这类说法不匹配，`requestedDays` 取不到，「够不够天」的检查会整项跳过，
   * 只排了一天的方案也能走到确认与落库。
   *
   * 模型已经读懂的东西不要再用正则解回来——压成文本再解析会丢信息。
   */
  tripLimits?: {
    /** 这趟总共几天。 */
    days?: number;
    /** 单段连续行车上限（分钟）。模型按小时说，`parseIntent` 换算并归一到分钟。 */
    maxLegMinutes?: number;
    /** 到达时续航余量下限（百分比）。 */
    minRangeMarginPct?: number;
  };
  /**
   * 这一轮该交给谁。由 LLM 在意图理解里给出，取值见 `ROUTE_TARGETS`。
   *
   * 模型没给、或给了候选表外的值时是 undefined——那时 `decideRoute` 退回规则表兜底
   * （离线/fake 路径不跑意图节点，也走同一条兜底）。
   */
  route?: string;
  /**
   * 顺带的副任务（ACR-023，F-11-06）：这一轮里另外要办的、不同领域的事。
   *
   * 只有 LLM 给——规则表与粘性规则不产生副路由，也没有正则兜底（§4.5：判据是字面的而人的说法不是）。
   * 每项的 `route` 取值同 `ROUTE_TARGETS`、不得等于主 `route`、不得是 general；`goal` 是意图层改写的一句规范说法，
   * 必须自带地点与对象（「在杭州预约一次保养」）：副 lane 与主 lane 并行、看不到主 lane 本轮的产出，地点只能从这里来。
   * 按 N 设计，上限 `MAX_SIDE_TASKS`（intent.ts）；可选是为了旧检查点。
   */
  sideTasks?: SideTask[];
  /**
   * 对已有行程草案的处置：`commit` / `cancel` / `cancel_all` / `none`，
   * 取值见 `PLAN_ACTIONS`。同样由 LLM 给，没给时退回 `itinerary.ts` 的正则兜底。
   *
   * 与 `route` 是两回事：route 说"交给谁"，action 说"要它干什么"。
   * 「帮我创建该行程」两者都要——route=itinerary 且 action=commit；
   * 只判出前者的表现是又规划一轮，弹窗始终不出现。
   */
  action?: string;
  /**
   * 车主这一轮提到的具体时间点，已标准化。
   *
   * # 为什么这一栏必须由 LLM 给
   *
   * 时间说法无法用正则穷举：「下午三点」（12 小时制 + 中文数字）、「上午」是否含 11 点、
   * 「八月十七十点」（不带「号」字，贪婪匹配会吞成 `十七十`）。
   * 判据是字面的，而人的说法不是；意图节点能读懂这些说法，这一栏把它标准化后交给下游。
   *
   * 与 `action` 同样处理：试驾选时段的正则保留为兜底——意图节点降级时仍要认得出「14号10点」。
   *
   * # 模型给不出就留空
   *
   * 不让模型猜：猜出来的日期会去过滤真实时段表，过滤出空集的表现是
   * "你选的那个时段不存在"，排查方向不会指向这里。
   */
  when?: {
    /** `YYYY-MM-DD`；只说了「十七号」没说月份时给 `--DD`。 */
    date?: string;
    /** 24 小时制整点 0~23。「下午三点」是 15 不是 3。 */
    hour?: number;
  };
  /** 解析失败时的降级标记——理解层挂了不该把正常对话堵死（与 §8.2 input fail-open 同源）。 */
  degraded?: boolean;
}

/** 一件顺带的副任务：交给谁 + 一句自带地点的规范说法（ACR-023）。 */
export interface SideTask {
  route: string;
  goal: string;
}

/** 路由决策与依据（F-11-07：路由错误只表现为"答非所问"，没有埋点就无法归因）。 */
export interface RouteDecision {
  agent: string;
  reason: string;
  /**
   * 副路由（ACR-023）：与主路由同源——同一次意图理解给出，`decideRoute` 只在 LLM 路由生效时透传。
   * 规则表兜底、粘性规则路径下恒为空：那两条路没有模型的判断，不该凭空长出第二件事。
   */
  secondary?: SideTask[];
  /**
   * 本轮因哪项能力关闭而收口（ACR-056）。在场时 `agent` 已改为 general，`answer` 只下发固定话术。
   * 每轮由 `dispatch` 重新给出，不跨轮残留。
   */
  closedBy?: Capability;
}

/**
 * 一条 lane 跑完的结果（ACR-023 分叉—汇合）。主 lane 写 `primaryLane`，副 lane 写 `sideLanes[本节点名]`。
 *
 * `patch` 用结构化写法不引用图类型：图状态要能序列化进检查点（与 `BuyingPlanState` 同一取向）。
 * `join` 节点按 `compound.ts` 的 `joinLanes` 把它们汇进主状态——lane 自己不直接写 `agentResults` / `tripPlan` 这些通道，
 * 否则同 superstep 并行的两条 lane 会在 last-write reducer 上互相覆盖。
 */
export interface LaneResult {
  lane: "primary" | "side";
  /** 图节点名（`branchFor` 的返回值，副 lane 记的是主节点名，副节点名由 `sideNodeOf` 推）。 */
  node: string;
  /** 路由目标（主 lane 是 `route.agent`，副 lane 是 `SideTask.route`）。 */
  agent: string;
  goal?: string;
  status: "ok" | "failed" | "skipped";
  patch: Record<string, unknown>;
  startedAt: number;
  endedAt: number;
  error?: string;
}

/**
 * 风险边界判定与处置（AC-11-7）。策略表在 `guard/risk-policy.ts`。
 *
 * 与 `RouteDecision` 同形：判定与依据一起存，否则回放时看得到"被拒了"
 * 却看不出"凭哪一类拒的"，而这一栏正是要用来判断门是不是判宽了。
 */
export interface RiskVerdict {
  category: RiskCategory;
  decision: RiskDecision;
}

/** 待澄清取消的候选。 */
export interface PendingCancelState {
  /** 候选行程，顺序与助手念出来的编号一致——"第二个"要能对上。 */
  candidates: Array<{ planId: string; label: string }>;
  /** 问出这个问题的轮次；只为排查时能对上，不参与判定。 */
  askedTurnId: string;
}

export const GraphState = Annotation.Root({
  /** 会话内消息序列（user/assistant 交替），reducer 追加。 */
  messages: Annotation<ChatTurnMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),

  /** 本轮意图四要素；每轮覆盖（不累积——它描述的是"这一轮要什么"）。 */
  intent: Annotation<Intent | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 本轮风险边界判定；每轮覆盖（与 intent/route 同语义）。
   *
   * `deny` 时这一轮到此为止——`riskGate` 之后不再有节点跑。
   */
  risk: Annotation<RiskVerdict | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /** 本轮路由决策；每轮覆盖。 */
  route: Annotation<RouteDecision | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 本轮各 Agent 分支的结果（F-13-09：下游只读状态，不重新问 Agent）。
   *
   * 每轮覆盖，不跨轮累积——与 `intent`/`route` 同语义。
   * 累积时，前几轮的求解结果会在后面的轮次被当作"编排层已完成的求解"注入上下文，
   * 模型据此作答而不再调用工具（smoke:acp 的"工具确实被执行"断言覆盖这一点）。
   * 一轮之内的多分支汇聚由 `mergeBranches` 在节点内完成，不依赖 reducer 累积。
   */
  /*
   * ── 座舱不在图状态里保存座位、待确认偏好与本轮覆盖 ───────────────
   *
   * 座舱是 A 型：谁坐哪进 `cabin_apply_preferences` 的入参；
   * 确认时序归权限门（确认前不落库由它保证，不需要草案状态位）；
   * 本轮覆盖只作用于这一次，模型看着上下文直接下发即可。
   */
  agentResults: Annotation<Record<string, string>>({
    reducer: (_left, right) => right,
    default: () => ({}),
  }),

  /**
   * 本轮有分支彻底没跑成（超时/失败/没交结构化字段）。
   *
   * # 它与 `missing` 不是一回事，不合并
   *
   * `missing` 里有两类东西，对应两种不同的处置：
   *  - "查了但没有"（`unmetAsks`：问的日期超出预报覆盖）——再问一次也是同样结果，
   *    应答如实说"这次没查到"。
   *  - "根本没跑完"（分支超时/失败）——应答那一侧还有工具，还有机会补。
   *
   * 分不开时，分支全部超时的轮次会走无工具的表述路径，只能逐条报告"没拿到"；
   * 而 ACP 那条路上的应答模型可以自己调工具补回一部分。
   *
   * 每轮覆盖，与 `agentResults` 同语义。
   */
  solverDegraded: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => false,
  }),

  /**
   * 多天行程草案（设计定稿 内部文档）。
   *
   * # 与 `agentResults` 的关键差别：跨轮存活
   *
   * `agentResults` 每轮覆盖清空——那是"本轮求解结果"。行程草案是"进行中的方案"：
   * 第 1 轮出骨架、第 2 轮说「第一天再细化」时它必须还在，否则细化轮只能从
   * 对话历史里猜，而意图理解不应每轮重新推导历史（见 route.ts `MIN_SCORE`）。
   *
   * reducer 右值覆盖：itinerary 轮写整份更新后的 plan；其它节点不写它，
   * LangGraph 对未返回的 channel 保留旧值——跨轮存活由此而来，不需要特殊 reducer。
   * 过期跟随 thread 24h 轮换（检查点一起作废），不另建过期机制。
   *
   * 在 `CABINHUG_CONTEXT_LAYER=tasks` 档下不再写入（ACR-036 §4.9）：
   * 跨轮的行程状态在按 `userId × kind` 的 `working_tasks` 里，形状真相源是
   * `@cabinhug/shared` 的 `TaskState`。这一栏只读旧检查点作迁入种子，
   * 声明与 reducer 保留——库里仍有切档前的检查点，删通道会让它们读取时抛错。
   * `off` / `inject` 两档照旧读写（逐级可退的那两档）。
   */
  tripPlan: Annotation<TripPlanState | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 出行需求澄清门问过没有（ACR-039）。跨轮存活，与 `tripPlan` 同机制。
   *
   * 骨架轮缺目的地或天数时，itinerary 节点不排、只让应答问一句；这一栏记"问过了"，
   * 同一会话只问一次——第二次仍缺就不再澄清、直接排（fail-open 兜底），
   * 不会把车主卡在问答里。问的时候把已经知道的那一半（目的地或天数）存在这里：
   * 答复轮意图层常常只给他刚说的那个数（「两天」），上一轮的目的地不重抄——
   * 编排层从这里补，只补它上一轮已经给过的，不推断新的（ADR-012）。
   * 用过一次就清回 `{ asked: true }`，避免旧值串到下一趟。
   *
   * `tasks` 档的包装层剥 `tripPlan` / `pendingCancel` 时不剥它：它不是行程状态，是会话级的"问过没有"。
   * 旧检查点没有它，读出来是 undefined，按"没问过"处理。
   */
  tripClarify: Annotation<TripClarifyState | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 待澄清的取消。跨轮存活，与 `tripPlan` 同机制。
   *
   * # 为什么必须有它
   *
   * 名下有多份已确认行程时，取消要问"取消哪一份"，问了就得记住问过：
   * 否则下一轮车主答「确认」时没有上下文表明上一句是个问题，
   * 「确认」既不是取消指涉也不是确认指涉，会被判成规划请求送进 fan-out。
   *
   * 存的是候选的 planId 与一句话描述：下一轮据此认「全部」「第二个」「确认」。
   * 一轮用完即清（`itineraryNode` 处理后写 undefined），不影响后面的对话。
   *
   * 在 `tasks` 档下同样不再写入（与 `tripPlan` 一致），状态在 `TaskState.pending`：
   * 提问与回答之间隔着一轮，车主可能换到另一个端上答，挂在会话上的问题接不住那种回答。
   */
  pendingCancel: Annotation<PendingCancelState | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 这一次出险咨询里已经说清的事实：估损金额与事故类型。跨轮存活。
   *
   * # 为什么不能只读本轮 intent
   *
   * 第一句「划痕走保险划算吗，大概两千块」之后，第二句「那要准备什么材料」里没有任何数字，
   * 意图层不给这两栏；只读本轮时，材料清单会退回缺省的单方事故，并再问一遍车主刚说过的事故类型。
   *
   * # 为什么是图状态而不是 working_tasks
   *
   * 估损与事故类型是一次对话内的事：车主问完材料就走了，不需要跨会话接着办。
   * `working_tasks` 是跨会话任务（预约、行程）的机制，为理赔咨询开一个 `TaskKind`
   * 等于给一个不存在的生命周期建模。随线程检查点存活、会话轮换后清掉即可。
   *
   * reducer 是逐字段合并不是整体替换：车主这一轮只更正事故类型时，
   * 上一轮说的估损还得在。
   */
  claimFacts: Annotation<ClaimFactsState | undefined>({
    reducer: (left, right) => {
      if (!right) return left;
      return { ...(left ?? {}), ...right, updatedAt: right.updatedAt };
    },
    default: () => undefined,
  }),

  /**
   * 最近一次售后问诊（F-20-13）。跨轮存活，与 `tripPlan` 同机制：
   * 问诊发生在第 N 轮，"帮我记录下来"发生在第 N+1 轮——每轮清空就没有可留档的对象。
   * service 问诊轮写入，answer 轮补回答摘要，留档成功置 `archived`；
   * 其余节点不写它，LangGraph 保留旧值。过期随 thread 24h 轮换。
   */
  consultation: Annotation<ConsultationState | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 拍照问诊的结构化报告（F-20-06 / F-20-09）。跨轮存活，与 `consultation` 同机制：
   * 问诊轮由 answer 节点覆盖写入，非问诊轮不写（LangGraph 保留旧值）；端上经 `/internal/diagnosis` 只读。
   * 追问轮次与问过的题从上一份累计。只由主图的 answer 节点写，不进任何 lane 白名单。
   */
  diagnosis: Annotation<DiagnosisReport | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 本轮绑定的图片（F-09-06）。每轮覆盖、不跨轮——照片只属于问它的那一轮。
   * 只有 `observeAttachments` 节点读它；图片字节不进任何 LLM 文本上下文。
   */
  photoInput: Annotation<PhotoInput[] | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 观察层的产物：受控观察 + 手册图标匹配（或「未能对上」）+ 补拍指引。
   * 每轮覆盖。`intent` 只拿它的一行摘要，`ownershipDual` 把它拼成【图片观察】段。
   */
  photoObservation: Annotation<PhotoObservationState | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 本轮的视频：网关派生好的帧序图 + 分段转写，每轮覆盖。
   * 不进观察层；`ownershipDual` 拼成【视频】段，`answer` 把帧序图作为图片交给表述模型。
   */
  videoInput: Annotation<VideoInput | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 最近一次五年成本测算（F-15-05）。跨轮存活，与 `tripPlan` 同机制。
   *
   * 用于「改一个假设重算」：车主说"我一年跑 3 万公里"时，
   * 要在上一轮那份假设上只覆盖 annualKm，车价、能源、年限原样保留。
   * 每轮清空的话，重算就得重新问一遍车价。
   */
  costPlan: Annotation<CostPlanState | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 最近一次车型候选收敛（F-15-14）。跨轮存活，与 `costPlan` 同机制。
   *
   * 用途是让购车功能页读得到它：`agentResults` 每轮覆盖，
   * 而且应答节点跑完之后它里面装的是助手回复而不是候选结构
   * （`answerNode` 的返回值会把 `agentResults[agent]` 覆盖成 `full`）。
   * 页面在用户切过去的那一刻要能显示上一轮比过的那几款车，不能要求他重问一遍。
   */
  buyingPlan: Annotation<BuyingPlanState | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 最近一次配置比较（F-47-08）。跨轮存活，与 `buyingPlan` 同机制。
   *
   * 与 `buyingPlan` 分开：那是车型级收敛，这是配置级比较。
   * 合并的话，只问配置的一轮会把上一轮的候选收敛结论覆盖掉。
   */
  trimPlan: Annotation<TrimPlanState | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 最近一次贷款测算（F-48-01）。跨轮存活，与 `costPlan` 同机制。
   *
   * 与 `costPlan` 分开存：一个是买车的钱怎么付，一个是用车的钱花多少。
   * 合在一起会让两边的假设表纠缠——改一个"年行驶里程"不该动到月供。
   */
  loanPlan: Annotation<LoanPlanState | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 最近一次保费估算（F-48-06）。跨轮存活，与 `loanPlan` 同机制。
   *
   * 它同时是「同一轮里保险数字口径唯一」（AC-48-7）的载体：
   * 成本测算要用分项合计当首年保险时，从这里取。
   */
  insurancePlan: Annotation<InsurancePlanState | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 试驾预约的进行中状态。跨轮存活，与 `tripPlan` 同机制。
   *
   * 「查店 → 选店 → 查时段 → 选时段 → 确认」跨好几轮，
   * 选中的门店与时段必须还在——每轮清空就只能从对话历史里猜，
   * 而意图理解不应每轮重新推导历史（见 route.ts `MIN_SCORE`）。
   */
  testDrivePlan: Annotation<TestDrivePlanState | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 维修预约的进行中状态。跨轮存活，与 `testDrivePlan` 同机制、
   * 同一条理由：「查站 → 选站 → 对时段 → 联系方式 → 确认」跨好几轮，
   * 每轮清空就只能从对话历史里猜。
   */
  repairBookingPlan: Annotation<RepairBookingPlanState | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 本轮由常用人员档案带入的硬约束（F-46-10）。
   *
   * 与 `intent` 同频、每轮覆盖：它是"这一轮提到了谁"的结果，跨轮保留会让
   * 上一轮的同行人一直跟着。约束文本已经并进 `intent.constraints`（下游求解认那一份），
   * 这个 channel 存的是出处——应答层要能说"单段不超过 90 分钟是因为妈妈晕车"。
   */
  companionConstraints: Annotation<CompanionConstraint[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),

  /**
   * 主 lane 的结果（ACR-023）。每轮由 `dispatch` 清空，`join` 读。
   * last-write：一轮只有一条主 lane。
   */
  primaryLane: Annotation<LaneResult | undefined>({
    reducer: (_left, right) => right,
    default: () => undefined,
  }),

  /**
   * 副 lane 的结果，按副节点名键控（`sideOwnershipDual` …）。
   *
   * 这是 ACR-023 新增通道里唯一一个不是 last-write 的：多个副节点在同一个 superstep 各写自己的键，
   * last-write 会让后落的覆盖先落的。更新为 `null` 即清空（`dispatch` 每轮发一次）。
   */
  sideLanes: Annotation<Record<string, LaneResult>, Record<string, LaneResult> | null>({
    reducer: (left, right) => (right === null ? {} : { ...left, ...right }),
    default: () => ({}),
  }),

  /**
   * 副任务的求解文本，键 = Agent 名（与 `agentResults` 同口径，由 `join` 从各副 lane 的 patch 改道而来）。
   * 主副分两个通道是为了同 superstep 不撞 last-write；`answer` 的 `composeSolved` 主取 `agentResults`、副取这里。
   */
  sideResults: Annotation<Record<string, string>>({
    reducer: (_left, right) => right,
    default: () => ({}),
  }),
});

/**
 * 多天行程草案。字段语义见设计文档；名字（spots/hotel.name）必须来自 poi_search。
 *
 * 形状真相源在 `@cabinhug/shared`（`TripPlanSnapshot`）——网关返回给座舱的
 * 与图状态里的是同一份契约。status 含 `confirmed` / `cancelled` 两态（确认路径写入）。
 *
 * `committedPlanId` 是图状态私有的增量：确认落库后的行 id，
 * 细化轮经 structuredClone 保留——「行程取消掉」靠它判断 PG 里有没有要置位的行
 * （确认→细化→取消的路径上 status 已回 refining，光看 status 会漏掉 PG 那一行，
 * HUD 会一直挂着一份用户已经不要了的行程）。
 * 它不进落库快照：`trip_plan_commit` 的 zod 是 strip 模式，多余键自然剥掉。
 */
/** 见 `GraphState.tripClarify`。 */
export interface TripClarifyState {
  asked: boolean;
  /** 问的时候已经知道的目的地（只在问"玩几天"时有）。 */
  destinations?: string[];
  /** 问的时候已经知道的天数（只在问"去哪儿"时有）。 */
  days?: number;
}

export type TripPlanState = TripPlanSnapshot & {
  committedPlanId?: string;
  /**
   * 生成这一版草案时实际用到的约束（会话内，不落库——zod 是 strip 模式，进不了 `trip_plans.plan`）。
   *
   * 用途只有一个：确认时和这一轮的约束做集合差，把车主这一轮才提出、草案还没体现的要求
   * 列到确认弹窗上。例如「就这样定了，我们是走自驾」：只读 action 的确认路径
   * 会把高铁那一版直接落库，而"自驾"这条新要求被忽略。
   */
  builtWith?: string[];
};

/**
 * 一次候选收敛的完整快照。结构由 `subgraphs/buying.ts` 定义，
 * 这里用结构化写法而不是 import 那边的类型：图状态要能被序列化进检查点，
 * 与子图的类型演进解耦（同 `CostPlanState` 的取向）。
 */
export interface BuyingPlanState {
  candidates: BuyingCandidateSnapshot[];
  eliminated: BuyingCandidateSnapshot[];
  universe: { model: string; documents: string[] }[];
  constraints: Record<string, unknown>;
  unclassifiedDocs: number;
  at: number;
}

export interface BuyingCandidateSnapshot {
  model: string;
  specs: { label: string; value: string; source: BuyingSourceSnapshot }[];
  guidePrice?: { amount: number; trim: string; source: BuyingSourceSnapshot };
  eliminatedBy?: { dimension: string; reason: string }[];
  /** 配置级事实。拿不到报价系统时缺省，判定回落到车型级。 */
  trimSpecs?: { trim: string; priceCny?: number; rangeKm?: number; seats?: number }[];
  /** 让这台车通过硬约束的是哪几个配置——「六座来自 Model Y L」靠它。 */
  matchedTrims?: string[];
}

/**
 * 一次贷款测算的快照（F-48-01）。
 *
 * `breakdown` 的结构由 `enterprise/backend/shared/tools` 的 `LoanBreakdown` 定义，这里用结构化写法
 * 而不是 import 它——图状态要能序列化进检查点，与工具的类型演进解耦（同 `CostPlanState`）。
 */
export interface LoanPlanState {
  breakdown: {
    vehiclePrice: number;
    downPayment: number;
    downPaymentRatio: number;
    principal: number;
    months: number;
    /** `source` 一律非空：不存在无标注的利率。 */
    annualRate: { low: number; high: number; source: "user" | "assumed" };
    equalInstallment: {
      monthlyPayment: { low: number; high: number };
      totalInterest: { low: number; high: number };
      totalPayment: { low: number; high: number };
    };
    equalPrincipal: {
      firstMonthPayment: { low: number; high: number };
      lastMonthPayment: { low: number; high: number };
      totalInterest: { low: number; high: number };
      totalPayment: { low: number; high: number };
    };
    cashVsLoan: { extraInterest: { low: number; high: number }; cashKept: number; note: string };
    notes: string[];
  };
  model: string;
  priceSource: { document: string; trim: string; kind: string };
  /** 车主自己转述了免息方案。系统从不主动声称任何品牌有免息。 */
  interestFreeClaimed: boolean;
  at: number;
}

/**
 * 一次保费估算的快照（F-48-06）。
 *
 * 与 `LoanPlanState` 同样用结构化写法而不是 import 工具层的类型——
 * 图状态要能序列化进检查点。
 */
export interface InsurancePlanState {
  quote: {
    items: { key: string; label: string; amount: { low: number; high: number }; note?: string }[];
    /** `usable: false` 时不存在——给了，车主记住的就是那个数。 */
    total?: { low: number; high: number };
    usable: boolean;
    assumptions: {
      compulsory: { low: number; high: number; source: "user" | "assumed" };
      damageRate: { low: number; high: number; source: "user" | "assumed" };
      passengerPerSeat: { low: number; high: number; source: "user" | "assumed" };
      coefficientsEffectiveFrom: string;
    };
    notes: string[];
  };
  model: string;
  priceSource: { document: string; trim: string; kind: string };
  at: number;
}

/**
 * 一次配置比较的快照（F-47-08）。跨轮存活，与 `buyingPlan` 同机制。
 *
 * 与 `buyingPlan` 分开存而不是塞进去：那一份是车型级收敛的结果（哪几台进候选、
 * 哪台被什么淘汰），这一份是配置级的比较（哪个配置对哪个、差在哪）。
 * 合在一起的话，只问配置的那一轮会把上一轮的候选收敛结论一起覆盖掉。
 */
export interface TrimPlanState {
  models: string[];
  rows: { model: string; trim: string; priceCny?: number; rangeKm?: number; seats?: number }[];
  alignment: string;
  alignmentNote: string;
  pairs: {
    left: { model: string; trim: string };
    right: { model: string; trim: string };
    diffs: { field: string; label: string; left?: number; right?: number; delta?: number; note?: string }[];
    marginalPricePerKm?: number;
  }[];
  unpricedModels: { model: string; note: string }[];
  missingModels: string[];
  /** 被整车价下界挡掉的行。保留它们，避免静默截断被读成"覆盖了全部"。 */
  droppedRows: { model: string; trim: string; priceCny: number; reason: string }[];
  /** 配置说明的出处（来自 `car-catalog`）。检索不到就是空数组，不补。 */
  sources: BuyingSourceSnapshot[];
  at: number;
}

/** 可点开的出处。`snippet` 是原文片段不是摘要——摘要是系统写的，片段才可核对。 */
export interface BuyingSourceSnapshot {
  document: string;
  snippet: string;
  score: number;
}

/** 门店（来自 `dealer_stores`，不是模型编的）。 */
export interface TestDriveStore {
  storeId: string;
  name: string;
  district: string;
  address: string;
  distanceKm?: number;
}

/** 可预约时段（来自 `dealer_slots`）。`slotId` 带不可猜的签名后缀，编一个会被 404 拒掉。 */
export interface TestDriveSlot {
  slotId: string;
  startAt: string;
  endAt: string;
  remaining: number;
}

/**
 * 试驾预约的进行中状态。
 *
 * `status` 只是给上下文与测试看的路标，真正的推进判据是
 * `chosenStoreId` / `chosenSlotId` / `contact` 齐不齐——
 * 拿一个字符串当状态机唯一真相，改一处漏一处时它会与实际状态不符。
 */
/** 维修站。字段与 mock-repair 的 /stations 一致。 */
export interface RepairBookingStation {
  stationId: string;
  name: string;
  city: string;
  district: string;
}

/** 维修进厂窗口。remaining 来自维修站的容量减占用。 */
export interface RepairBookingSlot {
  slotId: string;
  startAt: string;
  remaining: number;
}

/**
 * 维修预约的进行中状态。形状照 `TestDrivePlanState`——
 * 同一条"明文不进图状态"的规则：`contactRef` 只有尾号，真号由工具层按
 * `memberId` 自己取（appointment 的档案路径）。
 */
export interface RepairBookingPlanState {
  /** 目标车辆。来自默认车档案；缺失时子图只引导建档、不下单。 */
  vin?: string;
  /** 预估维修项目（自由文本给维修站参考，不是防编面）。 */
  items: string;
  city?: string;
  stations: RepairBookingStation[];
  chosenStationId?: string;
  slots: RepairBookingSlot[];
  chosenSlotId?: string;
  /** 车主当场口述的联系方式。档案里查得到时不走这条——见 `contactRef`。 */
  contact?: { name: string; phone: string };
  contactRef?: { memberId: string; displayName: string; phoneTail: string };
  orderId?: string;
  status: "choosing_station" | "choosing_slot" | "confirming" | "booked" | "cancelled";
  at: number;
}

export interface TestDrivePlanState {
  model: string;
  trim?: string;
  city?: string;
  district?: string;
  stores: TestDriveStore[];
  chosenStoreId?: string;
  slots: TestDriveSlot[];
  chosenSlotId?: string;
  /** 车主当场口述的联系方式。档案里查得到时不走这条——见 `contactRef`。 */
  contact?: { name: string; phone: string; note?: string };
  /**
   * 档案里登记的联系方式。
   *
   * 只有后四位，明文留在库里，下单时由工具层按 `memberId` 自己取。
   * 图状态会进检查点、会被回放页读到，放明文会增加外泄路径。
   */
  contactRef?: { memberId: string; displayName: string; phoneTail: string };
  orderId?: string;
  status: "choosing_store" | "choosing_slot" | "confirming" | "booked" | "cancelled";
  at: number;
}

/**
 * 一次成本测算的完整快照。
 *
 * `priceSource` 必须留着：下一轮重算时要沿用同一个车价，而"这个车价哪来的"
 * 在重算轮同样要说得出——车主问"你按多少钱算的"时要能给出出处。
 */
export interface CostPlanState {
  /** `CostBreakdown`（`@cabinhug/tools`）。放宽成结构体避免图状态与工具版本耦合。 */
  breakdown: {
    years: number;
    items: Record<string, number>;
    total: number;
    perKm: number;
    assumptions: Record<string, number>;
    notes: string[];
  };
  model: string;
  energy: "bev" | "phev" | "icev";
  priceSource: { document: string; trim: string; kind: "user" | "dealer" | "catalog" };
  /** 本轮被覆盖的假设名。空数组＝这是第一次算。 */
  changed: string[];
  at: number;
}

export type TripPlanDay = TripPlanDaySnapshot;

export type GraphStateType = typeof GraphState.State;
