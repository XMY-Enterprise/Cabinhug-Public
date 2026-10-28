/**
 * 路由决策（FL-11 F-11-04/07）。
 *
 * 【为什么是规则不是模型】职责切分（F-11-10）：语言理解在 pi 侧 Agent，
 * 编排决策在图。图节点里再问一次模型"这该走哪个 Agent"是把同一个判断做两遍，
 * 两次结论不一致时没有裁决者；路由错误只表现为"答非所问"，用户不会指出是路由错了。
 *
 * 决策与依据都要落库（F-11-07）：没有埋点就无法归因。
 *
 * # 按证据强度打分，而不是首个命中（F-03）
 *
 * 首个命中即返回时，一条弱证据（一个 `去` 字）能压过另一条强证据（`保养`），
 * 只因为它排在前面：「后天上午十点去做保养」会被 `去[一-龥]{2,}` 当成目的地判进出行。
 * 现在按证据强度打分、取最高分，顺序只在同分时作为兜底。
 *
 * # 用户原话的权重高于意图释义
 *
 * context 是模型写的一段话，常出现"可能存在故障""涉及维修"这类词；与原话等权时，
 * 「我的车续航掉得厉害」会被 context 里的"故障"拽到售后，并失去 ownership 的检索。
 * 权重为原话 ×3、goal ×2、constraints ×2、context ×1：
 * context 只能在原话本身没有信号时起作用。
 */

import type { Intent, RouteDecision } from "./state";
// 判据只有一份：与确认路径共用同一个规则表。
import {
  arriveIntent,
  wantsCancel,
  wantsCommit,
  wantsDepart,
  wantsNavEnd,
} from "./subgraphs/itinerary";
import { ROUTE_TARGETS } from "./intent";
import { REPAIR_BOOKING_REFINE } from "./subgraphs/repair-booking";

/** 已接线的目标；其余子图仍是空壳，路由不指向它们。 */
export type RouteTarget =
  | "trip"
  | "ownership"
  | "service"
  | "buying"
  | "testDrive"
  | "cabin"
  | "itinerary"
  | "general";

/** 图节点名。路由目标到节点的映射在 `branchFor` 里，不散落在图装配处。 */
export type BranchNode =
  | "tripFanout"
  | "ownershipDual"
  | "buyingCatalog"
  | "testDriveFlow"
  | "cabinCompanion"
  | "itineraryPlan"
  | "answer";

/**
 * 路由目标 → 图节点。
 *
 * 单独导出是为了能被断言：漏接一条边（例如 `service` 没接到 `ownershipDual`）时，
 * 售后拿不到 repair-kb 的内容，回答却看起来正常；直接调 `runOwnershipDualPath` 的单测
 * 会绕过这条边。判定放在这里，测试才落在映射这一层。
 *
 * `ownership` 与 `service` 共用一个节点：节点内部按 `ctx.agent` 切知识库
 * （说明书 / 维修库），判断形状是同一个——"我这车 X 正不正常"。
 */
export function branchFor(route: { agent?: string } | undefined): BranchNode {
  // 出行一律进行程规划节点。`trip` 是旧值（历史检查点里还会有），一并映过来。
  if (route?.agent === "itinerary" || route?.agent === "trip") return "itineraryPlan";
  if (route?.agent === "ownership" || route?.agent === "service") return "ownershipDual";
  // 购车与座舱各有自己的节点，不与用车共用：
  // 购车没有第二路（车还没买），座舱没有知识库。
  // 套用双路只会多出一句"未能读取你的用车数据"，在这两个语境里没有意义。
  if (route?.agent === "buying") return "buyingCatalog";
  // 试驾是多步引导 + 有副作用的下单，与购车顾问的单路检索分开。
  // 节点名与状态字段不同名：LangGraph 的 channel 与 node 共用命名空间，
  // 撞名会在 compile 时抛 "already being used as a state attribute"（buyingCatalog/buyingPlan 同理）。
  if (route?.agent === "testDrive") return "testDriveFlow";
  if (route?.agent === "cabin") return "cabinCompanion";
  return "answer";
}

// ── 证据表 ──────────────────────────────────────────────────

interface Signal {
  re: RegExp;
  /** 证据强度。strong=3：这个词出现基本就定性了；weak=1：需要同类证据叠加。 */
  weight: number;
  /** 进 reason 的人话——回放页要能看懂"为什么判到这里"。 */
  label: string;
}

interface Rule {
  target: Exclude<RouteTarget, "general">;
  signals: readonly Signal[];
  /** 同分时的优先级，小的赢。 */
  priority: number;
}

const s = (re: RegExp, weight: number, label: string): Signal => ({ re, weight, label });

const RULES: readonly Rule[] = [
  {
    // 多天行程：优先级压过 trip——「4天行程」两个规则都会命中，
    // 同分时必须归多天（trip 的 fan-out 解不了"住哪/逐天玩什么"）。
    target: "itinerary",
    priority: 0,
    signals: [
      // 「后天」「今天」不能误伤：量词必须是数字或汉字数——`后/今/明` 都不在集合里。
      /*
       * 通用量词只认「天」。「日」不放进来：`8月15日` `15日出发` 里的「日」是日期，
       * 正则无法可靠区分（`(?<!月)` 仍能从「5日」起匹配）。
       * 「日」的多天说法一律锚在「游/晚/玩/行程」上，见下一条。
       */
      s(/(\d+|[两三四五六七])天(?![气冷热])/, 3, "多天行程"),
      // 「玩4天」「玩三天」都要接住——阿拉伯数字与汉字数同权。单靠上面那条只有 9 分，
      // 会被 trip 的「行程词+去某地」15 分压过；两条信号叠加（18 分）才足以归多天。
      /*
       * 口语里的多日说法（「两日一晚」「三日游」等）。漏判时请求会进单程 fan-out，
       * 那条链路没有 hotel 与 tour 分支，酒店与景点都不会被查询。
       */
      s(
        /(三天两夜|两天一夜|几日游|多日游|[两三四五六七\d]+日[一二两三四五\d]+晚|[两三四五六七\d]+日(游|行程)|住[一两三几\d]晚|玩[几两三四五六七\d]+[天日])/,
        3,
        "多日游说法",
      ),
      s(/(每天.{0,6}(行程|安排|玩)|逐天|第[一二三四五12345]天.{0,4}(去|玩|安排))/, 2, "逐天安排"),
      /*
       * 「去某地玩」也归这里，哪怕只有一天。
       *
       * 判据是诉求形态而不是天数：「周末游」「去嘉定玩」要的是"去哪儿玩、
       * 玩什么"，而 trip 那条链路解的是"分几段开、中间在哪歇"——它的产物里
       * 没有目的地字段，站点是服务区，也没有确认落库。
       *
       * 分数 3：与"多天"同权，足以压过 trip 的行程词，但单纯问路不受影响——
       * 「去嘉定怎么走」不命中（没有玩/游/度假这类词），仍归 trip。
       */
      s(/(周末游|一日游|当天游|去[一-龥]{2,}(玩|游玩|逛|度假|露营))/, 3, "去某地玩（含单日）"),
    ],
  },
  {
    /*
     * 出行兜底：目标是 itinerary 不是 trip。
     * 路由层不区分单程与多天——那是行程规划 Agent 内部按诉求选分支的事，
     * 不靠数天数在路由上分叉（数错了会换到一条没有对应能力的链路）。
     */
    target: "itinerary",
    priority: 1,
    signals: [
      s(/(行程|路线|自驾|导航去|沿途|服务区|途经)/, 3, "行程规划词"),
      s(/(出发|几点走|返程|当天往返|过夜)/, 3, "出发/返程"),
      // 车机端替车主发的两句固定开头：「调整行程 <id>：…」与「【行程提醒】…」。
      s(/(^\s*调整行程\s|^\s*【行程提醒】)/, 3, "端上发来的调整/提醒"),
      // `去 + 地名` 只在没有被后面的动词接管时算数。
      // 「去做保养」「去修车」「去 4S 店」里的「去」是"去做事"，不是目的地。
      s(/去(?!做|办|修|保养|换|看看|问问|一下)[一-龥]{2,}(玩|旅游|自驾|露营|度假)?/, 2, "去某地"),
      s(/(长途|旅行|露营|自驾游|周边游)/, 2, "长途出行"),
      s(/(充电站|充电桩|加油站)/, 1, "沿途补给"),
    ],
  },
  {
    // 售后：带着症状或周期去查的那一类，对应 repair-kb。
    target: "service",
    priority: 2,
    signals: [
      s(/(异响|漏油|漏水|冒烟|抖动|打不着|启动不了|熄火)/, 3, "故障症状"),
      // 灯的说法很多：「警告灯」「故障灯」「亮了个黄灯」「红灯闪」——
      // 匹配"颜色/位置 + 灯"而不是几个固定词组。
      s(/(报警|仪表盘|[黄红]灯|警告灯|故障灯|亮灯|指示灯)/, 3, "报警/指示灯"),
      s(/(维修|修车|4S|三包|索赔|质保|保修)/, 3, "维修与质保"),
      // 保养族归售后：保养手册在 repair-kb 不在 vehicle-manuals（内部开发指引 数据集判据）。
      // 判到 ownership 会去搜说明书，那里没有保养周期表，回答会缺少出处。
      s(/(保养|机油|机滤|空滤|刹车片|保养周期|多少公里换|工时费)/, 3, "保养与周期"),
      s(/(故障|毛病|问题严重吗|要不要紧)/, 1, "笼统的故障描述"),
      /*
       * 出险与理赔。「保险」按问法分家：buying 那条认的是测算语义
       * （多少 / 怎么算 / 包含），这条认的是出险语义（走不走 / 划算 / 报案 / 材料 / 权益）。
       * 两条正则互斥，「保险一年多少」仍归 buying；权重 2 与那条对等。
       */
      s(
        /(走不走|要不要走|划不划算|划算|值不值).{0,6}(保险|车险)|走保险|(保险|车险).{0,8}(划算|划不划算|值不值|材料|流程|送.{0,3}次|救援|权益|涨|上浮)|(出险|报案|定损|拒赔|理赔)|权益/,
        2,
        "出险与理赔",
      ),
    ],
  },
  {
    target: "buying",
    priority: 3,
    signals: [
      // 「买什么车」「买台什么样的车」——买与车之间常隔着几个字。
      s(/(买.{0,6}车|购车|选车|换车)/, 3, "买车/选车"),
      s(/(落地价|裸车价|置换|首付|分期|贷款|优惠多少)/, 3, "价格与金融"),
      /*
       * 配置比较。权重 2，不是 3。
       *
       * 三分意味着"这个词出现基本就定性了"，而"配置"两个字没有那么硬：
       * 「这车配置挺高的」是闲聊，「座椅配置怎么调」是用车助手。
       * 所以这条信号要求比较语义与配置词共现，而不是单个名词；
       * 否则「顶配和低配差多少」「六座的贵多少」这类问法会落到 general。
       */
      s(
        /(配置|版本|顶配|低配|高配|入门版|[两三四五六七]座版?).{0,8}(差在哪|差多少|区别|对比|怎么选|选哪|哪个好|贵多少|值不值|多花)|(哪几个|有哪些|几个)(配置|版本)/,
        2,
        "配置/版本比较",
      ),
      /*
       * 「长续航版值不值多花两万」里的"续航"会命中用车助手的"续航与能耗"（9 分），
       * 把请求带去翻一辆还没买的车的说明书。"我这车续航掉得快"仍须归用车助手，
       * 所以不从 ownership 删"续航"，而是靠购买语义与配置名共现把这类问法归到购车。
       */
      s(
        /(长续航|全轮驱动|后轮驱动|四驱版|两驱版).{0,10}(值不值|多花|贵多少|划算|加钱|要不要上)/,
        3,
        "配置的购买取舍",
      ),
      /*
       * 车险与用车成本的测算：「保险一年多少」「五年下来一共花多少」要能路由到
       * `insurance_quote` / `cost_calc` 所在的购车节点。
       *
       * 权重同样是 2：单个"保险"两个字不该定性（"我的车险到期了"是另一回事），
       * 要求它与测算语义共现。
       */
      s(
        /(保险|车险|保费).{0,8}(多少|贵不贵|怎么算|包含|包括|哪些|一年|分项)|(交强险|三者险|车损险|座位险)/,
        2,
        "车险测算",
      ),
      s(/(五年|三年|几年).{0,4}(成本|花多少|费用)|用车成本|养车成本|持有成本/, 2, "用车成本测算"),
      // 「试驾」归 testDrive，不在这里：它是一条带下单动作的独立流程，
      // 落进单路检索会拿不到门店与时段。
      s(/(哪款|值不值|对比一下|推荐.{0,4}车|配置怎么选)/, 2, "选型比较"),
    ],
  },
  {
    /*
     * 试驾预约。优先级排在 buying 之前——
     * "约个试驾"里往往同时带着车型词，两边都会命中，而试驾是更具体的那个。
     */
    target: "testDrive",
    priority: 2.5,
    signals: [
      s(/(试驾|试乘|试一试车|开一开)/, 3, "试驾"),
      s(/(约|预约|安排).{0,6}(试驾|试乘)/, 3, "约试驾"),
      /*
       * 门店词只给 2 分（原话里 6 分）。它低于售后的"修车"（9 分），
       * 所以「哪家店能修车」照旧归售后。
       *
       * 这里不设"时间偏好"信号（周六/上午/有没有空）：`MIN_SCORE = 3`，
       * 权重 1 的信号在原话里正好是 3 分，单独就能过线，会把「周六上午有没有空」
       * 这种任何语境都可能出现的话拽进试驾。选时段靠 `hasActiveTestDrive` 粘性承接。
       */
      s(/(哪家店|门店|体验店|展厅|4S店)/, 2, "门店"),
    ],
  },
  {
    // 座舱陪伴：车里那些与车无关的话。优先级最低——
    // 「无聊」「随便聊聊」这类词在任何一句话里都可能出现，
    // 让它压过续航或故障就是把一次求助当成闲聊。
    target: "cabin",
    priority: 5,
    signals: [
      s(/(讲个笑话|聊聊天|陪我聊|说说话|解闷|无聊|困了|提神|犯困)/, 3, "陪伴与解闷"),
      s(/(放首歌|放点音乐|来点音乐|听什么|推荐点什么听)/, 3, "车内娱乐"),
      s(/(路上没意思|还有多久到|堵得慌)/, 1, "路途情绪"),
      /*
       * ── 座舱设置指令 ──
       * 带动作语义才计分："空调调到 23 度"是设置，归座舱；
       * "空调怎么用"是咨询，归用车（ownership 的"手册与功能"3 分照旧赢）。
       * 温度信号要求数字在场，正是为了让咨询句一分拿不到。
       */
      s(/(空调|温度).{0,8}\d{1,2}(?:\.\d)?\s*度|调到\s*\d{1,2}(?:\.\d)?\s*度/, 4, "座舱设置：温度"),
      s(/座椅.{0,4}(加热|通风|按摩)|(打开|开|关掉?|关闭).{0,4}(加热|通风|按摩)/, 4, "座舱设置：座椅"),
      s(/氛围灯|车内灯光/, 3, "座舱设置：灯光"),
      s(/儿歌|放.{0,4}(音乐|播客|电台|广播)|音量/, 3, "座舱设置：媒体"),
      // 传输控制：这些句子里没有媒体名词（"下一首"不含"歌"也不含"音乐"），
      // 上面那条召不回来；离线/fake 路径下缺这条会落 general。
      s(/下一首|上一首|换一首|换首|再放一首|别放了|停一下|暂停|继续放|接着放|循环|随机播放/, 4, "座舱设置：播放控制"),
      s(/香氛|儿童锁|屏幕锁|后排屏/, 3, "座舱设置：香氛与儿童模式"),
      s(/(副驾|主驾|后排).{0,3}(是|坐着?|带)/, 4, "座舱设置：乘坐声明（谁坐哪）"),
    ],
  },
  {
    // 用车咨询：日常"这个功能怎么用"，对应 vehicle-manuals。
    target: "ownership",
    priority: 4,
    signals: [
      s(/(续航|掉电|电池|馈电|能耗|油耗|费电)/, 3, "续航与能耗"),
      s(/(说明书|使用手册|车主手册|怎么用|怎么设置|在哪打开|功能)/, 3, "手册与功能"),
      s(/(胎压|轮胎|充电限值|充多少|空调|座椅|车机|钥匙)/, 2, "日常用车部件"),
      // 口语化的"我的车"：`我这车` `咱这车` 都要接住，不只认书面语的 `这辆车`。
      s(/((我|咱)?这[辆台]?车|我的车|我车|自己的车)/, 1, "指向自己的车"),
    ],
  },
];

// ── 打分 ────────────────────────────────────────────────────

/**
 * 各字段的权重：用户原话最可信，模型写的 context 最弱。
 *
 * `gate` 决定这个字段能否把一条规则送过门槛（见 `MIN_SCORE`）。
 * `context` 是唯一的 `gate: false`——理由在 `MIN_SCORE` 那段。
 */
const FIELD_WEIGHTS: ReadonlyArray<{
  pick: (i: Intent, t: string) => string;
  factor: number;
  gate: boolean;
}> = [
  { pick: (_i, t) => t, factor: 3, gate: true },
  { pick: (i) => i.goal, factor: 2, gate: true },
  { pick: (i) => i.constraints.join(" "), factor: 2, gate: true },
  { pick: (i) => i.context, factor: 1, gate: false },
];

interface Scored {
  rule: Rule;
  /** 总分：含 context。用来在已过门槛的规则之间排序。 */
  score: number;
  /** 门槛分：只含原话 / goal / constraints。用来判断够不够格。 */
  gateScore: number;
  labels: string[];
}

function scoreRule(rule: Rule, intent: Intent, userText: string): Scored {
  let score = 0;
  let gateScore = 0;
  const labels = new Set<string>();
  for (const sig of rule.signals) {
    for (const field of FIELD_WEIGHTS) {
      const text = field.pick(intent, userText);
      if (text && sig.re.test(text)) {
        const points = sig.weight * field.factor;
        score += points;
        if (field.gate) gateScore += points;
        labels.add(sig.label);
        break; // 同一个信号在多个字段里重复出现不叠加——那只是同一条证据被复述了
      }
    }
  }
  return { rule, score, gateScore, labels: [...labels] };
}

/**
 * 低于此分不算命中。只看门槛分（原话 / goal / constraints），不看 context。
 *
 * # 为什么 context 不能参与"够不够格"
 *
 * 仅把 context 降权到 ×1 不够：权重 3 的强信号只出现在 context 里时，3 × 1 = 3 = 门槛，
 * 一条就能过线。意图理解常把上一轮的历史写进 context（如「此前正在规划去上海的行程」），
 * 于是一句「离我最近的停车场在哪里呀」会被判成出行规划。
 *
 * 那段历史按 `内部文档` 属于 ①Working（多轮槽位），
 * 存在 pi session 与图状态里，不该由意图理解每轮重新推导，也不该参与路由。
 *
 * context 保留"选哪一个"的作用（仍计入 `score` 用于排序）——
 * "此前提到要带老人"这类背景应在两条规则势均力敌时起作用，
 * 但不能单独把一个请求路由到任何地方。回归用例见 route.test.ts 末尾。
 */
const MIN_SCORE = 3;

/**
 * 细化指涉：会话里有进行中的行程草案时，这些说法指的是"改那份草案"。
 *
 * 导出可断言（与 branchFor 同一个理由）。判据是规则表不是模型（F-11-10）：
 * 粘错的症状只是"答非所问"，用户不会指出是路由错了。
 */
export const REFINE_PATTERNS =
  // 确认/取消话术（就按这个|定了吧|拍板|可以预订|敲定|取消|不去了|作废）同样是"对这份草案表态"：
  // 不粘的话「可以预订了」会掉进 general、
  // 「行程取消掉」会被 trip 的行程词拽进单程 fan-out（见下面 override 的说明）。
  /(第[一二三四五六七1234567]天|细化|再详细|详细(一)?点|换.{0,3}(酒店|地方|景点)|改成|加(个|一天|几个)|删掉|少安排|住宿|预算|行程里|方案里|就这样定|就这么定|就按这个|定了吧|就这个了|拍板|可以预订|敲定|取消|不去了|作废|太赶了|松一点)/;

/** 行程指涉（比细化更弱）：全规则不过门槛时，含这些词才粘——「你好」不粘。 */
const ITINERARY_HINT = /(行程|计划|安排|酒店|住|玩|路线|那天|哪天)/;

/**
 * 一条强信号在原话里的得分（3×3）。粘性不越过它：会话里有行程草案时用户说
 * 「车子有异响」，故障词以强信号过门槛，必须正常改道——换话题优先于粘。
 */
const STICKY_OVERRIDE = 9;

/**
 * 改成本假设的说法（成本粘性判据）。
 *
 * 判得比行程的细化指涉窄得多：这里只认"某个假设改成某个值"这一种句式，
 * 因为粘错的代价不对称——行程粘错只是多查一次，成本粘错会让一句闲聊
 * 触发一次带总额的测算，而那个总额他没要过、却会记住。
 */
const COST_REFINE = /((?:一年|每年|年).{0,4}(?:跑|开|行驶).{0,2}\d|电价.{0,4}\d|油价.{0,4}\d|保养.{0,6}\d{3}|(?:开|持有|用)\s*[\d一二两三四五六七八九]\s*年|重(?:新)?算|再算(?:一次|一遍)?)/;

/**
 * 选门店 / 选时段 / 补联系方式的说法（试驾粘性判据）。
 *
 * 判得比行程细化窄：这些词单独出现时本来就没什么别的含义
 * （"第二家"、"周六上午那个"、"我姓林 138…"），
 * 而粘错的代价是把一句闲聊推进一条带下单动作的流程。
 */
const TEST_DRIVE_REFINE =
  /(第[一二三123]\s*[家个]|那家|这家|就它|就这家|[上下]午|周[一二三四五六日天]|\d{1,2}\s*[号日点]|我姓[一-龥]|1[3-9]\d{9}|换个店|换一家|换个时[间段])/;

export interface RouteOptions {
  /** 图状态里有进行中的 tripPlan（行程粘性判据的开关）。 */
  hasActiveTripPlan?: boolean;
  /**
   * 会话里挂着一个「取消哪一份」的追问。
   *
   * 有它时这一轮无条件回行程节点：车主的回答（「第二个」「全部」「确认」）
   * 本身都不是行程指涉，按分数判会判到别处，追问就接不住。
   */
  hasPendingCancel?: boolean;
  /**
   * 图状态里有上一轮的成本测算。
   *
   * 没有这条，「我一年跑3万公里」在第二轮会掉进 general，`runCostEstimate` 的重算逻辑
   * 跑不到；直接调子图函数的单测会绕过这条边，测不出来。
   */
  hasActiveCostPlan?: boolean;
  /**
   * 图状态里有进行中的试驾预约。
   *
   * 没有这条，「第二家」「周六上午那个」这类只有指代没有试驾词的话会掉进 general，
   * 而选店选时段全靠它们。与成本粘性同样收窄：只认选择类句式。
   */
  hasActiveTestDrive?: boolean;
  /**
   * 图状态里有进行中的维修预约。
   *
   * 与试驾粘性同一形状同一保守度：「就第一家」「上午 9 点那个」只有指代没有
   * 维修词，不粘会掉进 general，而选站选时段全靠它们。
   */
  hasActiveRepairBooking?: boolean;
}

/**
 * 附了仪表照片的轮，路由的两道守卫（纯函数，`routeNode` 调）。
 *
 *  1. 落到 general → ownership：照片本身就是「我这车 X 正不正常」的证据，通用应答没有双路答不了。
 *  2. 落到 service 且车主没在要修车 / 预约 / 留档 → ownership：
 *     指示灯的解释在车主手册，维修知识库里没有；按「警示灯亮 → service」判走会去翻保养手册。
 *     文字轮的「警示灯亮了要紧吗」仍归 service——那条规则是给没有照片的症状描述定的，这里只管带照片的。
 *
 *  3. 读出了车机警报列表 → service：逐条代码的官方解释在维修知识库，见下。
 *
 * 视频不在这里：它没有「对上手册图标」这一说，视频的 general → ownership 那条留在 routeNode。
 */
export function guardRouteForPhoto(
  route: RouteDecision,
  photo: { readable: boolean; symbols: number; alerts?: number } | undefined,
  /** 车主这一轮是不是明确在要修车 / 预约 / 留档——是的话不动，售后那条链路要接着走。 */
  wantsService: boolean,
): RouteDecision {
  if (!photo || !photo.readable) return route;
  /*
   * 警报页优先判：车机「警报」列表拍下来的那种照片，逐条代码的含义与措施在
   * 官方警报代码表里，那份语料在维修知识库（`repair-kb`，与故障码表同类）。
   * 这条排在图标那条之前——两者同时成立时（截图里既有仪表灯又弹了警报）以警报为准：
   * 车主专门去点开警报页拍照，问的就是那几条，不是旁边亮着的近光灯。
   */
  if ((photo.alerts ?? 0) > 0 && route.agent !== "service") {
    return { ...route, agent: "service", reason: `${route.reason}；照片是车机警报列表，代码表在维修知识库→售后双路（M80-10）` };
  }
  if (route.agent === "general") {
    return { ...route, agent: "ownership", reason: `${route.reason}；附了仪表照片→用车双路（M71-04）` };
  }
  if (route.agent === "service" && photo.symbols > 0 && (photo.alerts ?? 0) === 0 && !wantsService) {
    return { ...route, agent: "ownership", reason: `${route.reason}；照片认出仪表符号，解释在车主手册→用车双路（M80-09）` };
  }
  return route;
}

export function decideRoute(intent: Intent, userText: string, opts?: RouteOptions): RouteDecision {
  /*
   * ── 路由由意图理解那一步的 LLM 给 ─────────────────
   *
   * 规则表只作兜底：正则的判据是字面的，而人的说法不是——
   * 「两日一晚游」和「两天一夜」语义相同、正则不同，漏一个就整条链路走错，
   * 且表现为"没找到"而不是报错。
   *
   * 仍然保留规则表，因为有两种情形拿不到模型的判断：
   *   · 离线 / `CABINHUG_LLM=fake` / `enableIntent:false` —— 意图节点不跑；
   *   · 模型没给 route，或给了候选表外的值（`parseIntent` 会把它丢掉）。
   * 那时要有确定性行为。
   *
   * 取消/确认这类生命周期动作仍在下面用规则兜住，不交给模型：
   * 它们有副作用，判错的代价是"批了没执行"或"执行了没批"。
   */
  // 候选表在这里再验一遍：`parseIntent` 已经滤过，但类型上 route 是 string，
  // 少了这道守卫，一个表外的值会被原样传给 branchFor 静默落到通用应答。
  if (
    intent.route &&
    intent.route !== "general" &&
    (ROUTE_TARGETS as readonly string[]).includes(intent.route)
  ) {
    return {
      agent: intent.route,
      reason: "意图理解给出的路由（LLM）",
      // 副路由与主路由同源（ACR-023）：只在这条 LLM 路径上透传；下面的规则表与粘性规则没有模型的判断，恒不带。
      ...(intent.sideTasks?.length ? { secondary: intent.sideTasks } : {}),
    };
  }

  const scored = RULES.map((r) => scoreRule(r, intent, userText))
    // 过门槛只看 gateScore（不含 context），排序用 score（含 context）——
    // context 能在两条规则之间分高下，但不能单独把请求路由到任何地方。
    .filter((x) => x.gateScore >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.rule.priority - b.rule.priority);

  let top = scored[0];

  /*
   * 特化压制：itinerary 不是 trip 的对手，是它的特化——
   * 多天请求必然带着行程词，trip 的信号（行程/出发/去某地/长途）会全数命中并
   * 靠意图释义叠分（如「玩四天…安排行程和酒店」itinerary 18 分、trip 23 分），
   * 而单程 fan-out 没有酒店分支。
   * 判据：两者都过门槛、且多天证据达到"原话强信号"量级（≥9）→ 特化者赢。
   * 只在原话/goal 里证据充足时压制；多天词只在 context 里弱现（<9）不触发。
   */
  const itin = scored.find((x) => x.rule.target === "itinerary");
  if (top?.rule.target === "trip" && itin && itin.gateScore >= 9) {
    top = itin;
  }

  /*
   * 特化压制之二：试驾不是出行。
   *
   * 「帮我约这个周六上午去深圳南山特斯拉中心试驾 Model Y」里的"去某地" 6 分会让
   * trip 与 buying 打平、trip 以优先级胜出，请求落到没有试驾下单能力的链路。
   *
   * 判据与 itinerary 压 trip 同形：两者都过门槛，且试驾证据达到"原话强信号"量级
   * （3 分 × 原话 ×3 = 9），特化者赢。门店/时段那两条弱信号凑不到 9，
   * 所以「哪家店能修车」不会被拽过来。
   */
  const td = scored.find((x) => x.rule.target === "testDrive");
  if (top && top.rule.target !== "testDrive" && td && td.gateScore >= 9) {
    top = td;
  }

  /*
   * 取消指涉一律走 itinerary，不看粘性、不看分数。
   *
   * 取消是对已有行程的处置，不是新的规划请求。下面那条粘性只在
   * `hasActiveTripPlan`（会话里有草案）时存在——行程确认落库后，
   * 换个会话或重启之后图状态里就没有它了，
   * 「取消上海到广州的行程」会以 9 分的行程词判进 trip → 单程 fan-out，
   * 而那条链路里没有取消逻辑。
   *
   * 粘性里的 `top.rule.target !== "trip"` 只覆盖"草案还在会话中"的情形，这里覆盖其余情形。
   */
  if (wantsCancel(userText, intent)) {
    return { agent: "itinerary", reason: "取消指涉：对已有行程的处置，交给行程节点（不看粘性）" };
  }

  /*
   * 出发 / 结束导航 / 到站一律走 itinerary，与取消同因同形。
   *
   * 「出发」是 trip 的 3 分强证据词，不拦的话新会话里说「出发」会被判进单程 fan-out，
   * 而那条链路里没有导航逻辑。
   *
   * 误判风险由 `DEPART_AS_PLAN` 兜：带规划内容的「出发去广州玩三天」不算
   * 出发指令——那条否决项正是为这条路由规则设的。
   */
  if (arriveIntent(userText)) {
    return { agent: "itinerary", reason: "到站报告：端上跟车层发来的，交给行程节点播报" };
  }
  if (wantsNavEnd(userText, intent) || wantsDepart(userText, intent)) {
    return { agent: "itinerary", reason: "出发/结束导航：对已有行程的处置，交给行程节点（不看粘性）" };
  }

  /*
   * 确认指涉 + 会话里有草案 ⇒ 回行程节点。
   *
   * 与取消同因，但多一个前提：确认必须有东西可确认。
   * 「行程定了」里的"行程"是 trip 的强信号，按分数判会进单程 fan-out，
   * 而那条链路没有确认落库。
   *
   * 没有草案时不拦：那时"确认"没有对象，拽进多天链路只会凭空跑一轮规划。
   */
  if (opts?.hasActiveTripPlan && wantsCommit(userText, intent)) {
    return { agent: "itinerary", reason: "确认指涉：把会话里的草案定下来，交给行程节点" };
  }

  /*
   * 挂着追问就回行程节点，排在所有评分之前：
   * 「第二个」「确认」这类回答没有任何行程词，按分数判会被判去别处，追问就接不住。
   * 节点那边认不出回答时会把问题再问一遍，不会误动数据。
   */
  if (opts?.hasPendingCancel) {
    return { agent: "itinerary", reason: "会话里挂着「取消哪一份」的追问，本轮回行程节点接答案" };
  }

  // ── 粘性：只在"会话里有活跃行程草案"时才存在这条路径 ──
  if (opts?.hasActiveTripPlan && top?.rule.target !== "itinerary") {
    const refine = REFINE_PATTERNS.test(userText);
    // 其它规则以强信号过门槛 → 用户在换话题，不粘（「第二天顺路做个保养」归售后）。
    //
    // trip 除外：行程词是 trip 的强信号，而对草案表态的话几乎必然带行程词——
    // 「行程取消掉」9 分会压过粘性，被推进没有取消逻辑的单程 fan-out。
    // trip 与 itinerary 同族，行程词不构成"换话题"；
    // 真正的新单程请求（"明天去杭州怎么走"）不命中细化指涉，照旧走 trip。
    const overridden =
      top !== undefined && top.gateScore >= STICKY_OVERRIDE && top.rule.target !== "trip";
    if (refine && !overridden) {
      return {
        agent: "itinerary",
        reason: `粘性：会话有进行中的行程草案，命中细化指涉${top ? `（压过 ${top.rule.target}(${top.gateScore})）` : ""}`,
      };
    }
    if (!top && ITINERARY_HINT.test(userText)) {
      return { agent: "itinerary", reason: "粘性：会话有进行中的行程草案，原话含行程指涉且未命中其它规则" };
    }
  }

  /*
   * 粘性：试驾进行中时，选店/选时段的指代要粘回来。
   *
   * 排在成本粘性之前，因为它更具体（"第二家"在成本语境里没有意义）。
   * 与其它两条粘性同样只在无人过门槛时兜底——任何强信号都视作换话题，
   * "第二家店的保养多少钱"该归售后。
   */
  if (opts?.hasActiveTestDrive && !top && TEST_DRIVE_REFINE.test(userText)) {
    return { agent: "testDrive", reason: "粘性：会话有进行中的试驾预约，原话在选门店或时段" };
  }

  // ── 粘性：维修预约进行中时，选站/选时段/补联系方式要粘回售后 ──
  //
  // 与试驾同一形状：只在无人过门槛时兜底，判据从子图导入，与子图共用同一份正则。
  if (opts?.hasActiveRepairBooking && !top && REPAIR_BOOKING_REFINE.test(userText)) {
    return { agent: "service", reason: "粘性：会话有进行中的维修预约，原话在选站或选时段" };
  }

  // ── 粘性：会话里有上一轮的成本测算时，「我一年跑3万公里」要粘回购车 ──
  //
  // 与行程粘性同一形状，但更保守：
  //  · 只在没有任何规则过门槛时才粘（`!top`）——任何强信号都视作换话题；
  //  · 只认"改某个假设"的句式，不认泛指涉。
  // 粘错的代价是给出一个他没要过的总额，所以宁可漏、不可多。
  if (opts?.hasActiveCostPlan && !top && COST_REFINE.test(userText)) {
    return { agent: "buying", reason: "粘性：会话有上一轮成本测算，原话在改计算假设" };
  }

  if (!top) {
    return {
      agent: "general",
      reason: intent.degraded
        ? "意图解析降级，未命中任何专项规则，走通用应答"
        : "未命中专项规则，走通用应答",
    };
  }

  // 依据要具体到"凭哪几条证据"，并在存在势均力敌的次选时说出来——
  // 回放时"为什么判到这里"和"差点判到哪里"同样重要（F-11-07）。
  const runnerUp = scored[1];
  const close = runnerUp && top.score - runnerUp.score <= 2 ? `；次选 ${runnerUp.rule.target}(${runnerUp.score})` : "";
  // context 出了多少力要写出来：它不参与过门槛，但参与排序——
  // 当两条规则靠它分出高下时，回放要能看见是它起的作用（F-11-07）。
  const ctx = top.score > top.gateScore ? `，其中 context 贡献 ${top.score - top.gateScore}` : "";
  return {
    agent: top.rule.target,
    reason: `命中${top.labels.join("、")}（得分 ${top.score}${ctx}${close}）`,
  };
}
