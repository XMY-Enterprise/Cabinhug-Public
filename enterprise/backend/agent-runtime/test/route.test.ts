/**
 * 路由判据测试集（F-03）。
 *
 * 用例取自真实对话里的说法。路由错误不报错、不变慢，只表现为答非所问，
 * 所以判据需要一份能跑的对照表。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { listForAgent, TOOL_REGISTRY } from "@cabinhug/tools";
import { summarizeAction } from "../src/tools-endpoint";
import { canonicalAgent } from "../src/acp-client/agent-prompt";
import { branchFor, decideRoute, guardRouteForPhoto } from "../src/graph/route";
import type { Intent } from "../src/graph/state";

const bare: Intent = { goal: "", constraints: [], context: "", riskBoundary: "" };
const withIntent = (p: Partial<Intent>): Intent => ({ ...bare, ...p });

function expectRoute(text: string, target: string, intent: Intent = bare): void {
  const r = decideRoute(intent, text);
  assert.equal(r.agent, target, `「${text}」应判 ${target}，实际 ${r.agent}（${r.reason}）`);
}

describe("「两日一晚」这类说法要判多天", () => {
  /*
   * 多天判据要认「日」，不只认「天/夜」。判成单程时链路里没有 hotel 与 tour 分支，
   * 酒店和景点都不会被查。
   */
  for (const t of ["两日一晚游", "三日游", "两日游", "三日行程", "带孩子玩两日", "两天一夜", "住一晚"]) {
    it(`「${t}」→ itinerary`, () => {
      expectRoute(t, "itinerary");
    });
  }

  it("车主那句原话（含口语赘词）→ itinerary", () => {
    expectRoute(
      "帮我把呃预约帮我整理个行程就是这个周末从上海静安到上海嘉定的两日一晚游主要是带六岁的小朋友一起玩我们要中间找个亲子的酒最好是一个亲子酒店然后呢还要找一个亲子乐园玩",
      "itinerary",
    );
  });

  /*
   * 反向护栏：日期不能被当成天数。
   * 「日」的多天说法一律锚在 游/晚/玩/行程 上，不进通用量词；
   * `(?<!月)` 排除不了日期，正则仍能从「8月15日」的「5日」起匹配。
   *
   * 单程与多天是同一路由目标 itinerary，所以断言看依据：
   * 「8月15日」命中"多天行程/多日游说法"就是判据坏了，哪怕最终路由碰巧是对的。
   */
  for (const t of ["8月15日出发去嘉定怎么走", "15日出发", "这个月15日的天气", "今日路况如何"]) {
    it(`「${t}」的依据里不该出现"多天/多日游"`, () => {
      const r = decideRoute(bare, t);
      assert.doesNotMatch(r.reason, /多天行程|多日游说法/, `日期被当成了天数：${r.reason}`);
    });
  }
});

describe("「去某地玩」归多天链路，哪怕只有一天", () => {
  /*
   * 只有多天链路能确认落库（确认判据、权限门、trip_plan_commit）。
   * 判据是诉求形态不是天数：要"去哪儿玩"的归 itinerary，要"怎么开过去"的归 trip。
   */
  for (const t of ["规划一次周末游，从上海静安出发到上海嘉定", "这周末去嘉定玩", "去嘉定一日游", "安排个周末游"]) {
    it(`「${t}」→ itinerary（能确认落库、能上主页）`, () => {
      expectRoute(t, "itinerary");
    });
  }
  // 反向：单纯问路/补能不受影响，仍走单程链路。
  for (const t of ["去嘉定怎么走", "沿途有没有充电站", "明天出发去嘉定，路上服务区在哪"]) {
    it(`「${t}」→ trip（问路不是去玩）`, () => {
      expectRoute(t, "itinerary");
    });
  }
});

describe("取消指涉不看粘性", () => {
  /*
   * 要取消的行程可能是上一次会话确认落库的，本会话没有草案、没有粘性。
   * 取消指涉必须直接交给行程节点，单程链路没有取消逻辑。
   */
  for (const t of [
    "我取消从上海到广州的行程",
    "取消上海到广州的行程",
    "帮我取消上海-广州的行程",
    "取消广州四天的行程",
    "行程取消掉",
    "广州那趟不去了",
  ]) {
    it(`「${t}」→ itinerary（不依赖会话里有没有草案）`, () => {
      expectRoute(t, "itinerary");
    });
  }

  it("规划诉求走出行链路（单程与多天同一目标）", () => {
    expectRoute("帮我规划去广州的行程", "itinerary");
  });

  it("部分取消仍是细化，不走取消：「取消第二天的行程」", () => {
    const r = decideRoute(bare, "取消第二天的行程");
    assert.notEqual(r.reason, "取消指涉：对已有行程的处置，交给行程节点（不看粘性）");
  });
});

describe("易判错的真实语句", () => {
  it("「我这车最近开空调总感觉制冷不太行」→ ownership（口语的「我这车」不能漏判成 general）", () => {
    expectRoute("我这车最近开空调总感觉制冷不太行", "ownership");
  });

  it("「后天上午十点去做保养」→ service（不被一个「去」字拽去做行程规划）", () => {
    expectRoute("后天上午十点去做保养", "service");
  });

  it("意图释义里的「故障」不该把续航问题拽走（原话权重高于 context）", () => {
    // LLM 写的 context 里带了"可能存在故障"；判给 service 会连 ownership 的检索一并失去。
    expectRoute(
      "我的车最近续航掉得厉害，正常吗？",
      "ownership",
      withIntent({
        goal: "确认续航下降是否属于正常衰减",
        context: "车主关注是否存在异常或故障，可能为纯电动车",
      }),
    );
  });

  it("「在日历里加一条：明天上午十点洗车」不该判成出行", () => {
    const r = decideRoute(bare, "在日历里加一条：明天上午十点洗车");
    assert.notEqual(r.agent, "itinerary");
  });
});

describe("出行", () => {
  for (const q of [
    "下周六想自驾从上海去黄山，帮我规划一下行程",
    "明天几点走比较好",
    "这条路线沿途有服务区吗",
    "带我妈和孩子开电车去黄山",
  ]) {
    it(`「${q}」→ trip`, () => expectRoute(q, "itinerary"));
  }

  it("出行优先于用车：「去黄山要充几次电」是行程问题", () => {
    expectRoute("明天去黄山要充几次电", "itinerary");
  });

  it("约束里的出行信息也算数", () => {
    expectRoute("帮个忙", "itinerary", withIntent({ constraints: ["下周要去黄山自驾，同行老人"] }));
  });
});

describe("售后（带着症状或周期去查的那一类）", () => {
  for (const q of [
    "刹车有异响",
    "仪表盘亮了个黄灯",
    "底下好像漏油",
    "去 4S 店能索赔吗",
    "该保养了吗",
    "多少公里换一次机油",
  ]) {
    it(`「${q}」→ service`, () => expectRoute(q, "service"));
  }

  it("保养归售后不归用车：保养手册在 repair-kb，判到 ownership 会去搜说明书", () => {
    // 说明书里没有保养周期表；搜错知识库不报错，只会答得很顺但没有出处。
    expectRoute("我的车保养周期是多久", "service");
  });

  it("症状 + 指向自己的车：症状证据更强", () => {
    expectRoute("我这辆车刹车有异响", "service");
  });
});

describe("购车", () => {
  for (const q of ["预算 20 万买什么车", "这两款车对比一下", "落地价大概多少", "想换车了，推荐几款"]) {
    it(`「${q}」→ buying`, () => expectRoute(q, "buying"));
  }
});

describe("配置比较判到购车", () => {
  /*
   * 配置比较的说法不止「配置怎么选」：证据表只认这一句时，下面前四句都落到 general。
   * 「长续航版值不值多花两万」里的"续航"
   * 命中用车助手 9 分，判错会去翻一辆车主还没买的车的说明书。
   */
  for (const q of [
    "Model Y 这几个配置差在哪",
    "顶配和低配差多少",
    "Model Y 有哪几个版本",
    "六座的贵多少",
    "长续航版值不值多花两万",
    "配置怎么选",
  ]) {
    it(`「${q}」→ buying`, () => expectRoute(q, "buying"));
  }
});

describe("车险与用车成本判到购车", () => {
  for (const q of [
    "保险一年多少",
    "车险都包含什么",
    "三者险买多少合适",
    "Model Y 五年下来一共花多少",
    "用车成本高吗",
  ]) {
    it(`「${q}」→ buying`, () => expectRoute(q, "buying"));
  }
  // 「保养」与「保险」只差一个字，而它是售后的地盘。
  for (const q of ["保养一次多少钱", "机油多久换一次"]) {
    it(`「${q}」仍 → service`, () => expectRoute(q, "service"));
  }
});

describe("出险与理赔判到售后：「保险」按问法分家", () => {
  /*
   * buying 那条认的是测算语义（多少 / 怎么算 / 包含），这条认的是出险语义
   * （走不走 / 划算 / 报案 / 材料 / 权益），两条正则互斥。
   * 「走保险明年会涨多少」两边各 6 分打平，靠 service 优先级更靠前赢：
   * 已经出了险的人问涨价，是售后不是买保险。
   */
  for (const q of [
    "这个划痕走保险划算吗，大概两千块",
    "出险了要准备什么材料",
    "报案有没有时限",
    "我的保险送几次救援",
    "我这车有什么权益",
    "走保险明年会涨多少",
  ]) {
    it(`「${q}」→ service`, () => expectRoute(q, "service"));
  }
});

describe("配置信号不许误伤用车与售后", () => {
  /*
   * 配置信号要求比较语义与配置词共现，以免误伤这几句。
   * 「我这车续航掉得快」是用车助手最常用的一类问题，"续航"不能从 ownership 里删，
   * 判据只能加在购买语义那一侧。
   */
  for (const [q, target] of [
    ["我这车续航掉得快", "ownership"],
    ["续航怎么这么低", "ownership"],
    ["这车配置挺高的", "ownership"],
    ["座椅配置怎么调", "ownership"],
    ["刹车片多少公里换", "service"],
    ["哪家店能修车", "service"],
    ["约个试驾", "testDrive"],
  ] as const) {
    it(`「${q}」仍 → ${target}`, () => expectRoute(q, target));
  }
});

describe("用车咨询（日常「这个功能怎么用」）", () => {
  for (const q of [
    "冬天续航掉得厉害正常吗",
    "胎压打多少",
    "说明书上怎么说",
    "这个车机怎么设置导航",
    "充电限值设多少合适",
  ]) {
    it(`「${q}」→ ownership`, () => expectRoute(q, "ownership"));
  }
});

describe("座舱陪伴（车里那些与车无关的话）", () => {
  for (const q of ["讲个笑话吧", "陪我聊聊天", "有点困了", "放首歌听听"]) {
    it(`「${q}」→ cabin`, () => expectRoute(q, "cabin"));
  }

  it("陪伴优先级最低：夹着「无聊」的求助仍然是求助", () => {
    // 「无聊」这类词在任何一句话里都可能出现，不能压过续航或故障这类求助。
    expectRoute("开着有点无聊，顺便问下我这车续航正常吗", "ownership");
    expectRoute("路上没意思，仪表盘刚才亮了个黄灯", "service");
  });
});

describe("兜底", () => {
  it("闲聊走通用应答", () => {
    expectRoute("你好", "general");
    expectRoute("今天几号", "general");
  });

  it("单条弱证据只出现在 context 里不足以定性", () => {
    // 模型释义时顺口提到「车」不该触发专项路由。
    const r = decideRoute(withIntent({ context: "用户在车里问了一个无关问题" }), "帮我算一下");
    assert.equal(r.agent, "general");
  });

  it("降级时说明是降级：排障时要能分清「没命中」与「没理解」", () => {
    const r = decideRoute(withIntent({ goal: "今天几号", degraded: true }), "今天几号");
    assert.equal(r.agent, "general");
    assert.match(r.reason, /降级/);
  });
});

describe("决策依据要能被回放看懂（F-11-07）", () => {
  it("reason 写明凭哪几条证据与得分", () => {
    const r = decideRoute(bare, "仪表盘亮了个黄灯");
    assert.match(r.reason, /报警\/指示灯/);
    assert.match(r.reason, /得分 \d+/);
  });

  it("势均力敌时把次选也说出来", () => {
    const r = decideRoute(bare, "我这车该保养了吗，顺便看看胎压");
    assert.match(r.reason, /次选/);
  });
});

describe("context 不参与「够不够格」，只参与「选哪一个」", () => {
  /**
   * 意图理解会把上一轮的历史写进 context（如「此前正在规划…去上海…的行程」）。
   * context 降权到 ×1 仍不够：权重 3 的强信号 3 × 1 = 3 = 门槛，一条就能过线。
   * 所以 context 只进总分，不进门槛分。
   *
   * 下面的用例覆盖全量轨迹（72 轮有原话可比）中受这条规则影响的全部三例，
   * 调权重时它们会显示动了什么。
   */

  it("只出现在 context 里的强信号不能单独过线：找停车场", () => {
    const r = decideRoute(
      withIntent({
        goal: "查询离车主当前位置最近的停车场位置",
        constraints: ["距离优先：要离得最近的停车场", "地点未指明，按当前位置就近查询"],
        context: "此前正在规划8月12日去上海海昌海洋公园奥特曼酒店的行程，天气已确认",
      }),
      "哈喽哈喽离我最近的停车场在哪里呀",
    );
    assert.equal(r.agent, "general", "找停车场不是行程规划——判成 trip 会拉起整套 fan-out");
  });

  it("陈述偏好不该被 context 推去双路检索", () => {
    const r = decideRoute(
      withIntent({
        goal: "建立/同步充电偏好",
        context: "车主此前询问过续航与充电相关话题",
      }),
      "我一般晚上十点以后在家充电，充到九成就拔",
    );
    assert.equal(r.agent, "general", "这是陈述不是提问，双路检索无事可做（偏好写入是另一条链路）");
  });

  it("⑥用车数据的问题该走 ownership，不被 context 推去维修库", () => {
    const r = decideRoute(
      withIntent({
        goal: "了解自己车辆最近一段时间的行驶频率/里程",
        context: "车主此前提到过保养周期与工单",
      }),
      "我这车最近开得多吗？",
    );
    assert.equal(r.agent, "ownership", "问的是用车数据，不是保养——context 里的「保养」不该定性");
  });

  it("context 仍然参与排序，只是不能单独定性", () => {
    // 原话里的信号命中后 `break`，同一条信号不会再去看 context；
    // 所以要让 context 真的加分，得用一条原话里没有的信号。
    // 这里：原话给「胎压」（日常用车部件 2×3=6）与「我这车」（1×3=3）过门槛，
    // context 里另给「续航」（续航与能耗 3×1=3）——它只进总分，不进门槛分。
    const r = decideRoute(
      withIntent({ context: "车主此前问过续航" }),
      "我这车胎压多少",
    );
    assert.equal(r.agent, "ownership");
    assert.match(r.reason, /context 贡献 3/, "context 起了作用就要说出来（F-11-07）");
  });

  it("原话里有的强信号照常过线：这条规则不挡正常路由", () => {
    // context 不进门槛分后，正常路径不受影响。
    for (const [text, expected] of [
      // 「三天」是多天行程：单程 fan-out 里没有酒店/逐天分支，用户问的住宿会丢。
      ["我想去黄山自驾三天", "itinerary"],
      ["我这车该保养了吗", "service"],
      ["我这车续航掉得厉害正常吗", "ownership"],
    ] as const) {
      assert.equal(decideRoute(bare, text).agent, expected, `「${text}」应判为 ${expected}`);
    }
    // 这句应判为 general，不是出行。
    assert.notEqual(decideRoute(bare, "在日历里加一条：明天上午十点洗车").agent, "itinerary");
  });
});

/**
 * 试驾路由。
 *
 * 「去某地试驾」里的"去某地"有 6 分且出行优先级高，不能因此判给出行：
 * 出行 Agent 没有试驾下单能力，会以别的动作顶替并声称已约好（违反 AC-15-8）。
 */
describe("试驾路由", () => {
  const route = (t: string) =>
    decideRoute({ goal: t, constraints: [], context: "", riskBoundary: "" }, t, {});

  it("「去某地试驾」不被出行拽走", () => {
    const r = route("帮我约这个周六上午去深圳南山特斯拉中心试驾 Model Y，我姓林，手机 13800138000");
    assert.equal(r.agent, "testDrive", `实际判到 ${r.agent}：${r.reason}`);
  });

  it("直白的试驾请求", () => {
    assert.equal(route("我想试驾 Model Y，帮我约一下").agent, "testDrive");
    assert.equal(route("约个试乘试驾").agent, "testDrive");
  });

  it("特化压制不能把正常出行拽走", () => {
    // 单程与多天同一目标；这条守的是试驾不把出行请求吸走。
    assert.equal(route("明天去杭州怎么走").agent, "itinerary");
    assert.equal(route("我们去广州玩4天，帮我安排行程和酒店").agent, "itinerary");
  });

  it("选型比较仍归购车顾问：试驾独立后 buying 不受影响", () => {
    assert.equal(route("Model 3 和 Model Y 哪款好").agent, "buying");
    assert.equal(route("帮我选车，预算25万的纯电").agent, "buying");
  });

  it("门店/时段的弱信号单独出现不够格：「哪家店能修车」不判到试驾", () => {
    assert.notEqual(route("哪家店能修车").agent, "testDrive");
    assert.notEqual(route("周六上午有没有空").agent, "testDrive");
  });

  it("故障与保养仍归售后", () => {
    assert.equal(route("车子有异响，要不要紧").agent, "service");
    assert.equal(route("保养一年要花多少钱").agent, "service");
  });
});

describe("试驾 Agent 的工具表", () => {
  it("四件套 + 联系方式两件套（AC-15-8 负向验收：白名单式断言）", () => {
    const names = listForAgent("test-drive").map((t) => t.name);
    // 白名单式断言：新工具进来时必须改这一行。
    // 写成"包含四件套"会放过任何多给出去的工具。
    assert.deepEqual(names.sort(), [
      // 联系方式：免去每次重问手机号
      "contact_lookup",
      "contact_update",
      "dealer_pricing",
      "dealer_slots",
      "dealer_stores",
      "test_drive_book",
    ]);
  });

  it("Agent 名不以 -task/-intent/-voice 结尾，否则 loadAgentPrompt 会找错文件", () => {
    assert.equal(canonicalAgent("test-drive"), "test-drive");
  });

  it("`testDrive` 路由目标接到 `testDriveFlow` 节点（节点名不与状态字段同名）", () => {
    assert.equal(branchFor({ agent: "testDrive" }), "testDriveFlow");
  });
});

/**
 * ④⑥ 三个消费方的工具表。
 *
 * 白名单式断言，理由同上面试驾那组：新工具进来时必须改这几行。
 * 工具按 `--tools` 下发给模型，多给一个就多一条模型可以自己走的路，而测试不会变红。
 */
/**
 * 复述即确认（AC-53-5）。
 *
 * §4.6 要的是"复述 + 一次确认"，不是"先复述、用户说对、再弹一次窗"。
 * 所以复述长在确认弹窗上：`summarizeAction` 的输出就是那一屏的标题。
 */
describe("补录的确认弹窗就是复述", () => {
  it("保养补录：日期、项目、里程都回显，车主能一眼看出哪个数记错", () => {
    const text = summarizeAction(
      "vehicle_profile_write",
      { op: "maintenance", at: Date.UTC(2026, 6, 12), odometerKm: 186_000, items: "小保养" },
      "（工具描述，不该出现在弹窗上）",
    );
    assert.match(text, /记一次保养/);
    assert.match(text, /2026/);
    assert.match(text, /小保养/);
    assert.match(text, /186000 公里/);
    assert.equal(text.includes("工具描述"), false, "弹窗上不许出现写给模型看的文本");
  });

  it("只推里程时只说里程，不编造保养项目", () => {
    const text = summarizeAction("vehicle_profile_write", { op: "odometer", odometerKm: 186_000 }, "x");
    assert.equal(text, "把当前里程更新为 186000 公里");
  });

  it("入参缺失时给动作名，不回落到工具描述 + 原始 JSON", () => {
    const text = summarizeAction("vehicle_profile_write", {}, "把档案改一改（需用户确认）");
    assert.equal(text, "更新车辆档案");
    assert.equal(text.includes("需用户确认"), false);
  });
});

describe("④⑥ 消费方的工具表", () => {
  it("ownership 的工具白名单", () => {
    assert.deepEqual(listForAgent("ownership").map((t) => t.name).sort(), [
      "data_freshness",
      "energy_gap",
      "ragflow_retrieve",
      // `refuel` 是找加油站，`refuel_log` 是记一次加油。
      "refuel",
      "refuel_log",
      // 4S 系统侧的维修史（F-20-05 工况关联的另半边；本地留档在 vehicle_profile）
      "repair_history",
      "submit_range_assessment",
      "usage_profile",
      // 车机此刻报的电量/油量与仪表剩余续航——与 usage_profile 的"长期实测满量程"是两个数据源
      "vehicle_energy",
      "vehicle_member",
      "vehicle_profile",
      "vehicle_profile_write",
    ]);
  });

  it("service 的工具白名单", () => {
    assert.deepEqual(listForAgent("service").map((t) => t.name).sort(), [
      "appointment",
      // 走不走保险的净收益（赔付侧自取报价单或车主估损，涨价侧假系统算）、出险材料与时限词条
      "claim_advisor",
      "claim_checklist",
      "contact_lookup",
      "contact_update",
      "data_freshness",
      // 理赔预检的报价单由工具层自己取，模型只给 VIN，金额不经模型的手
      "insurance_policy",
      "insurance_precheck",
      "ragflow_retrieve",
      "repair_history",
      "repair_quote",
      // 预约引导子图的两条查询（站名与时段只能来自这里）
      "repair_slots",
      "repair_stations",
      "usage_profile",
      "vehicle_profile",
      "vehicle_profile_write",
    ]);
  });

  it("trip 的工具白名单", () => {
    assert.deepEqual(listForAgent("trip").map((t) => t.name).sort(), [
      "charging",
      "data_freshness",
      // 目的地的美食榜 / 打卡点 / 拍照建议（经模型内置联网搜索）
      "destination_highlights",
      "energy_gap",
      "map_route",
      "preference_recall",
      "pretrip_items",
      "refuel",
      "refuel_log",
      // 路径顺序体检：单日多点出行的顺序也要能体检
      "route_audit",
      // 多天行程的 Plan 层以 trip 身份在编排层搜景点（planCollect），不是让应答会话自己搜
      "spot_search",
      "trip_plan_cancel",
      "trip_plan_commit",
      "trip_plan_list",
      "trip_plan_nav",
      "trip_plan_query",
      "trip_plan_update",
      "usage_profile",
      "vehicle_member",
      "vehicle_profile",
      "weather",
    ]);
  });

  it("cabin 的工具白名单", () => {
    // 白名单式断言，与试驾那条同一个理由：新工具进来必须改这一行。
    // 座舱手上有会真的动车内设备的工具，尤其不能多给。
    assert.deepEqual(listForAgent("cabin").map((t) => t.name).sort(), [
      "cabin_apply_preferences",
      "cabin_child_mode",
      "cabin_control",
      "cabin_media",
      "cabin_status",
      "contact_lookup",
      "contact_update",
      "member_preference_set",
      "preference_recall",
      "vehicle_member",
    ]);
  });

  it("cabin_media 只给座舱：别的 Agent 拿到就能越权放歌", () => {
    for (const agent of ["supervisor", "ownership", "service", "buying", "trip", "test-drive"] as const) {
      assert.equal(
        listForAgent(agent).some((t) => t.name === "cabin_media"),
        false,
        `${agent} 不该拿到 cabin_media`,
      );
    }
  });

  it("其余 Agent 一律拿不到 data_freshness：它是用户私有数据", () => {
    for (const agent of ["supervisor", "buying", "cabin", "test-drive"] as const) {
      assert.equal(
        listForAgent(agent).some((t) => t.name === "data_freshness"),
        false,
        `${agent} 不该拿到 data_freshness`,
      );
    }
  });

  /*
   * 行程各条腿的白名单。hotel 不拿 `preference_recall`：住宿偏好在 `PREFERENCE_DOMAINS` 里
   * 没有对应领域（只有 charging/commute/driving/cabin/trip/service），
   * 调用只会返回无关偏好，却多一轮往返。
   */
  it("hotel（住宿分支）：只搜酒店、只交酒店，不拿 preference_recall", () => {
    assert.deepEqual(listForAgent("hotel").map((t) => t.name).sort(), [
      // 钉死酒店类别的搜索实例（多类别的 poi_search 不给它，见 poi-search.ts 文件头）。
      "hotel_search",
      "submit_hotels",
    ]);
  });

  it("tour（逐天分支）：只搜景点 + 天气；顺序体检归编排层（Plan 层 1b + orderAudit），tour 不自调", () => {
    assert.deepEqual(listForAgent("tour").map((t) => t.name).sort(), [
      "spot_search",
      "submit_tour_days",
      "weather",
    ]);
  });

  it("tour-plan（Plan 层 1c 语义裁决）：只交骨架，不搜、不体检、不查天气", () => {
    assert.deepEqual(listForAgent("tour-plan").map((t) => t.name).sort(), ["submit_tour_days"]);
  });

  it("trip-review（装配体检裁决）：看事实 + 机械改动 + 两个提交通道，不搜、不查天气", () => {
    assert.deepEqual(listForAgent("trip-review").map((t) => t.name).sort(), [
      "itinerary_assemble",
      "plan_audit",
      "plan_edit",
      "route_audit",
      "submit_repairs",
      "submit_verdict",
    ]);
  });

  it("transit（大交通分支）：查真实班次，别的不归它", () => {
    assert.deepEqual(listForAgent("transit").map((t) => t.name).sort(), [
      "submit_transit",
      "transit_route",
    ]);
  });

  it("preference_recall 只给 cabin / trip：住宿偏好在 PREFERENCE_DOMAINS 里存不进去，给了 hotel 也查不到", () => {
    const reg = TOOL_REGISTRY.find((t) => t.name === "preference_recall")!;
    assert.deepEqual([...reg.agents].sort(), ["cabin", "trip"]);
  });

  it("drive（行车分支）的工具白名单：提交通道是 submit_drive_plan，不拿 pretrip_items", () => {
    assert.deepEqual(listForAgent("drive").map((t) => t.name).sort(), [
      "charging",
      "energy_gap",
      "map_route",
      // 不含 pretrip_items：它挂在确认那一跳、由编排层自己调，给分支只会让它白走一轮。
      "refuel",
      "refuel_log",
      // 结论提交通道：只有 drive 有它，别的分支各有各的 submit_*。
      "submit_drive_plan",
      "transit_route",
      "weather",
    ]);
  });
});

describe("座舱设置路由", () => {
  const route = (t: string) =>
    decideRoute({ goal: t, constraints: [], context: "", riskBoundary: "" }, t, {});

  it("设置指令归 cabin：带动作语义的温度/座椅/媒体/儿童模式", () => {
    assert.equal(route("帮我把空调调到 23 度").agent, "cabin");
    assert.equal(route("空调调到 23 度，座椅加热开 2 档").agent, "cabin");
    assert.equal(route("后排通风开一下，温度 35 度").agent, "cabin");
    assert.equal(route("后排放个儿歌，屏幕锁上").agent, "cabin");
    assert.equal(route("今天副驾是妈妈，后排是小宝").agent, "cabin", "乘坐声明触发按人调好，不是出行规划");
  });

  it("咨询句照旧归 ownership：温度信号要求数字在场，咨询一分拿不到", () => {
    assert.equal(route("空调怎么用").agent, "ownership");
    assert.equal(route("座椅加热在哪打开").agent, "ownership");
  });
});

describe("「出发前」是时间状语，不是动身指令（评测 o-30）", () => {
  /*
   * 「冬天出发前想先暖车，我这车的定时预热功能怎么用」问的是功能。
   * `DEPART_PATTERNS` 会命中其中的「出发」，而动身指令一律走 itinerary、不看分数，
   * 所以「出发前」必须是 `DEPART_AS_PLAN` 的否决项，否则会连用车助手的双路检索一起丢掉。
   */
  it("o-30 原话 → ownership", () => {
    expectRoute("冬天出发前想先暖车，我这车的定时预热功能怎么用", "ownership");
  });
  it("「出发之前把行程定了」不是动身指令（它在说计划）", () => {
    const r = decideRoute(bare, "出发之前把行程定了再说");
    assert.doesNotMatch(r.reason, /出发\/结束导航/, `被当成了动身指令：${r.reason}`);
  });
  it("「现在出发」仍是动身指令", () => {
    const r = decideRoute(bare, "现在出发");
    assert.match(r.reason, /出发\/结束导航/);
  });
});

/**
 * 副路由透传（ACR-023）：与主路由同源，只在 LLM 路由生效那条路上透传；
 * 规则表与粘性规则没有模型的判断，恒不带副路由。
 */
describe("[F-11-06][AC-11-5] 副路由透传", () => {
  it("LLM 给了 route 与 sideTasks → secondary 深等于 sideTasks", () => {
    const side = [{ route: "service", goal: "在杭州预约一次保养" }];
    const r = decideRoute(withIntent({ route: "itinerary", sideTasks: side }), "下周末带父母去杭州自驾，顺路把保养做了");
    assert.equal(r.agent, "itinerary");
    assert.deepEqual(r.secondary, side);
  });
  it("LLM 给了 route 但没给 sideTasks → 没有 secondary 键", () => {
    const r = decideRoute(withIntent({ route: "itinerary" }), "去杭州");
    assert.equal("secondary" in r, false);
  });
  it("规则表兜底（无 route，原话「两日一晚游」）→ secondary 为空", () => {
    const r = decideRoute(withIntent({ sideTasks: [{ route: "service", goal: "g" }] }), "两日一晚游");
    assert.equal(r.agent, "itinerary");
    assert.equal(r.secondary, undefined);
  });
  it("粘性路径（进行中的维修预约 + 「第一家」）→ secondary 为空", () => {
    const r = decideRoute(withIntent({ sideTasks: [{ route: "cabin", goal: "g" }] }), "就第一家", { hasActiveRepairBooking: true });
    assert.equal(r.agent, "service");
    assert.equal(r.secondary, undefined);
  });
});

describe("[F-20-03][AC-20-1] 带照片的路由守卫 guardRouteForPhoto", () => {
  const service = { agent: "service", reason: "意图理解给出的路由（LLM）" };
  it("落到 service、照片认出符号、车主没在要修车 → 改走 ownership，理由说清为什么（指示灯在车主手册）", () => {
    const r = guardRouteForPhoto(service, { readable: true, symbols: 2 }, false);
    assert.equal(r.agent, "ownership");
    assert.match(r.reason, /车主手册/);
  });
  it("车主明确要修车 / 预约 / 留档 → 不动，售后链路接着走", () => {
    assert.equal(guardRouteForPhoto(service, { readable: true, symbols: 2 }, true).agent, "service");
  });
  it("照片读不出 / 一个符号都没有 / 没照片 → 不动", () => {
    assert.equal(guardRouteForPhoto(service, { readable: false, symbols: 0 }, false).agent, "service");
    assert.equal(guardRouteForPhoto(service, { readable: true, symbols: 0 }, false).agent, "service");
    assert.equal(guardRouteForPhoto(service, undefined, false).agent, "service");
  });
  it("落到 general 的照片轮仍改走 ownership", () => {
    const r = guardRouteForPhoto({ agent: "general", reason: "兜底" }, { readable: true, symbols: 0 }, false);
    assert.equal(r.agent, "ownership");
    assert.match(r.reason, /M71-04/);
  });
  it("其它路由（itinerary / cabin）带照片也不动", () => {
    assert.equal(guardRouteForPhoto({ agent: "itinerary", reason: "x" }, { readable: true, symbols: 3 }, false).agent, "itinerary");
  });
});

describe("[F-20-03][AC-20-1] 警报页的路由守卫", () => {
  const photo = (over: Partial<{ readable: boolean; symbols: number; alerts: number }>) => ({ readable: true, symbols: 0, alerts: 0, ...over });
  it("读出警报列表 → service：逐条代码的官方解释在维修知识库", () => {
    for (const from of ["general", "ownership", "itinerary"]) {
      const r = guardRouteForPhoto({ agent: from, reason: "x" }, photo({ alerts: 3 }), false);
      assert.equal(r.agent, "service", from);
      assert.match(r.reason, /维修知识库/);
    }
  });
  it("已经是 service 就不动，理由不重复叠加", () => {
    const r = guardRouteForPhoto({ agent: "service", reason: "x" }, photo({ alerts: 3 }), false);
    assert.equal(r.agent, "service");
    assert.equal(r.reason, "x");
  });
  it("警报页压过图标那条：两者同时有时以警报为准，车主是专门点开警报页拍的", () => {
    const r = guardRouteForPhoto({ agent: "service", reason: "x" }, photo({ symbols: 4, alerts: 2 }), false);
    assert.equal(r.agent, "service", "不能被 M80-09 那条拽回 ownership");
  });
  it("没有警报时图标那条照旧生效", () => {
    assert.equal(guardRouteForPhoto({ agent: "service", reason: "x" }, photo({ symbols: 4 }), false).agent, "ownership");
  });
  it("照片读不出 → 一条都不触发", () => {
    assert.equal(guardRouteForPhoto({ agent: "general", reason: "x" }, photo({ readable: false, alerts: 3 }), false).agent, "general");
  });
});

