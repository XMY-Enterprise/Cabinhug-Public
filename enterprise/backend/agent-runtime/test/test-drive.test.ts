/**
 * 试驾子图：多步引导、指代解析、代码发起下单。
 *
 * 三条主线：
 *
 *  1. 指代解析不猜。猜错会把单下到另一家店。
 *  2. 图直调自己过权限门。`DISCLOSURE_BUILDERS` 挂在 `tools-endpoint` 上，
 *     图直调不经过那里；漏掉会导致无确认下单，或确认弹窗上的外发块为空。
 *  3. 没确认就不说已经约好。
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import { setDealerBackend, setMemberStores, type DealerBackend } from "@cabinhug/tools";

import { buildChatGraph } from "../src/graph/supervisor";
import { GuardGate } from "../src/guard/http-endpoint";
import { setGuardGate } from "../src/tools-endpoint";
import {
  resolveStoreRef,
  resolveSlotRef,
  human,
  pickContact,
  pickCityDistrict,
  matchModel,
  startsNewBooking,
} from "../src/graph/subgraphs/test-drive";
import type { ChatStreamer } from "../src/llm";
import type { TestDriveSlot, TestDriveStore } from "../src/graph/state";

/**
 * 捕获喂给应答节点的上下文。
 *
 * 不能断言 `state.agentResults`：`answerNode` 跑完会把它覆盖成助手回复。
 * 子图交出去的那段话只在应答的入参里。
 */
const answerPrompts: string[] = [];
const answerOnly: ChatStreamer = async function* (m) {
  answerPrompts.push(m.map((x) => x.content).join("\n"));
  yield "[答]";
};
const lastPrompt = () => answerPrompts.at(-1) ?? "";

const STORES: TestDriveStore[] = [
  { storeId: "sz-nanshan-exp", name: "深圳南山体验店", district: "南山区", address: "科苑南路 2888 号" },
  { storeId: "sz-futian-exp", name: "深圳福田体验店", district: "福田区", address: "深南大道 7888 号" },
];

/** 两天各两个时段：周五(14日)10点/15点、周六(15日)10点。 */
const SLOTS: TestDriveSlot[] = [
  { slotId: "s1_a", startAt: "2026-08-14T10:00:00+08:00", endAt: "2026-08-14T10:45:00+08:00", remaining: 1 },
  { slotId: "s1_b", startAt: "2026-08-14T15:00:00+08:00", endAt: "2026-08-14T15:45:00+08:00", remaining: 2 },
  { slotId: "s2_a", startAt: "2026-08-15T10:00:00+08:00", endAt: "2026-08-15T10:45:00+08:00", remaining: 1 },
];

const fakeDealer = (over: Partial<DealerBackend> = {}): DealerBackend => ({
  // 按区过滤，与真服务一致：不过滤时「深圳南山」也返回两家，
  // 覆盖不到"只有一家自动选中"这条主路径。
  async stores(a) {
    const rows = a.district ? STORES.filter((s) => s.district.includes(a.district!)) : STORES;
    return { stores: rows as never, matched: rows.length };
  },
  async slots() {
    return { slots: SLOTS as never };
  },
  async pricing() {
    return { model: "Model Y", currency: "CNY", trims: [] };
  },
  async book() {
    return {
      orderId: "TD-000009",
      storeId: "sz-nanshan-exp",
      storeName: "深圳南山体验店",
      model: "Model Y",
      startAt: SLOTS[0].startAt,
      status: "confirmed",
      disclosed: ["称呼", "手机号"],
    };
  },
  ...over,
});

describe("指代解析：解析不出就不猜", () => {
  it("「第二家」按序号命中", () => {
    assert.equal(resolveStoreRef("第二家吧", STORES), "sz-futian-exp");
  });

  it("「南山那家」按名字/区命中", () => {
    assert.equal(resolveStoreRef("南山那家", STORES), "sz-nanshan-exp");
    assert.equal(resolveStoreRef("就去福田", STORES), "sz-futian-exp");
  });

  it("说了「第五家」而只有两家 → undefined，不折回第一家", () => {
    assert.equal(resolveStoreRef("第五家", STORES), undefined);
  });

  it("「随便」「都行」→ undefined，不替他挑一家", () => {
    assert.equal(resolveStoreRef("随便", STORES), undefined);
    assert.equal(resolveStoreRef("都行", STORES), undefined);
  });

  it("时段：「周六上午」唯一命中", () => {
    assert.equal(resolveSlotRef("周六上午那个", SLOTS), "s2_a");
  });

  it("时段：「14 号下午」唯一命中", () => {
    assert.equal(resolveSlotRef("14号下午", SLOTS), "s1_b");
  });

  it("排班日历使用 ISO 本地日期，不受宿主时区影响", () => {
    assert.equal(resolveSlotRef("周六上午那个", SLOTS), "s2_a");
    assert.equal(human(SLOTS[2].startAt), "8 月 15 日（周六）10:00");
  });

  /**
   * `下午3点` 按 12 小时制还原成 15 点，`下午三点` 的中文数字也要认。
   * 解析失败时的表现与"车主没说清楚"相同，日志上看不出区别。
   */
  it("「下午三点」还原成 15 点：12 小时制与中文数字都要认", () => {
    const S = [
      { slotId: "d10", startAt: "2026-08-14T10:00:00+08:00", endAt: "", remaining: 1 },
      { slotId: "d14", startAt: "2026-08-14T14:00:00+08:00", endAt: "", remaining: 1 },
      { slotId: "d15", startAt: "2026-08-14T15:00:00+08:00", endAt: "", remaining: 1 },
    ];
    assert.equal(resolveSlotRef("周五下午三点那个", S), "d15");
    assert.equal(resolveSlotRef("周五下午3点", S), "d15");
    assert.equal(resolveSlotRef("15点那个", S), "d15");
    assert.equal(resolveSlotRef("上午十点", S), "d10");
    assert.equal(resolveSlotRef("早上10点", S), "d10");
  });

  /**
   * `上午` 的区间包含 11 点：门店开放时刻里有 11 点，排除它会让
   * 只有 11 点时段的「周六上午那个」过滤为空。
   */
  it("11 点算上午：门店开放时刻里有它", () => {
    const S = [
      { slotId: "am11", startAt: "2026-08-15T11:00:00+08:00", endAt: "", remaining: 1 },
      { slotId: "pm15", startAt: "2026-08-15T15:00:00+08:00", endAt: "", remaining: 1 },
    ];
    assert.equal(resolveSlotRef("周六上午那个", S), "am11");
    assert.equal(resolveSlotRef("上午吧", S), "am11");
    assert.equal(resolveSlotRef("下午那个", S), "pm15");
  });

  /**
   * 「我要八月十七十点的」：日期既没有阿拉伯数字也没有「号」字，
   * 钟点不能贪婪取成 `十七十`。
   */
  it("「八月十七十点」这种不带「号」字的中文日期要认", () => {
    const S = [
      { slotId: "d16_11", startAt: "2026-08-16T11:00:00+08:00", endAt: "", remaining: 1 },
      { slotId: "d16_15", startAt: "2026-08-16T15:00:00+08:00", endAt: "", remaining: 1 },
      { slotId: "d17_10", startAt: "2026-08-17T10:00:00+08:00", endAt: "", remaining: 1 },
      { slotId: "d17_11", startAt: "2026-08-17T11:00:00+08:00", endAt: "", remaining: 1 },
    ];
    assert.equal(resolveSlotRef("我要八月十七十点的", S), "d17_10", "真跑翻车的那一句");
    assert.equal(resolveSlotRef("八月十七号十点", S), "d17_10");
    assert.equal(resolveSlotRef("十七号十点", S), "d17_10");
    assert.equal(resolveSlotRef("我要8月17号10点的", S), "d17_10");
    assert.equal(resolveSlotRef("8月17日11点", S), "d17_11");
    assert.equal(resolveSlotRef("十六号十一点", S), "d16_11");
    // 「八月十六」后面跟的是 `十五点`：日期取前缀 16，钟点取后缀 15，两个方向不能弄反
    assert.equal(resolveSlotRef("八月十六十五点", S), "d16_15");
  });

  /**
   * 时段的理解交给意图节点给出的 `when`，正则退为兜底：字面判据覆盖不全人的说法。
   *
   * id 消解仍在代码里，唯一命中的纪律不变，见下面两条。
   */
  it("`when` 优先于正则：模型看过整句，比字面判据更清楚", () => {
    const S = [
      { slotId: "d16_11", startAt: "2026-08-16T11:00:00+08:00", endAt: "", remaining: 1 },
      { slotId: "d17_10", startAt: "2026-08-17T10:00:00+08:00", endAt: "", remaining: 1 },
      { slotId: "d17_15", startAt: "2026-08-17T15:00:00+08:00", endAt: "", remaining: 1 },
    ];
    assert.equal(resolveSlotRef("我要八月十七十点的", S, { date: "2026-08-17", hour: 10 }), "d17_10");
    // 只说了「十七号」时模型给 `--DD`——只取日那一位
    assert.equal(resolveSlotRef("十七号那个", S, { date: "--17", hour: 15 }), "d17_15");
    assert.equal(resolveSlotRef("下午三点", S, { hour: 15 }), "d17_15");
  });

  it("`when` 缺席时完全退回正则：降级路径不是遗留代码", () => {
    const S = [
      { slotId: "d16_11", startAt: "2026-08-16T11:00:00+08:00", endAt: "", remaining: 1 },
      { slotId: "d17_10", startAt: "2026-08-17T10:00:00+08:00", endAt: "", remaining: 1 },
    ];
    // 意图节点降级 / 离线 / 图测不跑意图节点时走这条，行为与纯正则解析一致
    assert.equal(resolveSlotRef("我要八月十七十点的", S, undefined), "d17_10");
    assert.equal(resolveSlotRef("十六号十一点", S), "d16_11");
  });

  /**
   * 模型可能给出通过校验却不命中任何时段的值（如 `hour=0`，凌晨 0 点是合法钟点），
   * 此时时段永远选不中、确认框永远不弹。所以 `when` 没能唯一命中时退回正则重来一次。
   */
  it("`when` 给了坏值时退回正则：真实时段表才是权威", () => {
    const S = [
      { slotId: "d16_10", startAt: "2026-08-16T10:00:00+08:00", endAt: "", remaining: 1 },
      { slotId: "d16_15", startAt: "2026-08-16T15:00:00+08:00", endAt: "", remaining: 1 },
      { slotId: "d17_11", startAt: "2026-08-17T11:00:00+08:00", endAt: "", remaining: 1 },
    ];
    // 坏值 hour=0：按正则命中，而不是 undefined（时段永远选不中）
    assert.equal(resolveSlotRef("下周一的上午", S, { hour: 0 }), "d17_11");
    // 模型把「下周一」算成了门店没开放的日期 → 同样退回正则
    assert.equal(resolveSlotRef("下周一", S, { date: "2026-09-01", hour: 10 }), "d17_11");
    // 给对时仍然用 when
    assert.equal(resolveSlotRef("下周一的上午", S, { date: "--17", hour: 11 }), "d17_11");
  });

  it("退回正则不等于放松唯一命中：两边都定不了就回去问", () => {
    const S = [
      { slotId: "d16_10", startAt: "2026-08-16T10:00:00+08:00", endAt: "", remaining: 1 },
      { slotId: "d16_15", startAt: "2026-08-16T15:00:00+08:00", endAt: "", remaining: 1 },
    ];
    // 「周日」命中两个 → 仍 undefined
    assert.equal(resolveSlotRef("周日吧", S, { hour: 0 }), undefined);
    // 纯确认词没有任何时间信息 → 仍 undefined（不许凭空替他挑一个）
    assert.equal(resolveSlotRef("可以的", S, { hour: 0 }), undefined);
    assert.equal(resolveSlotRef("确认确认", S, { hour: 0 }), undefined);
  });

  it("「上午」命中两个 → undefined，那是他没说清，不替他挑", () => {
    assert.equal(resolveSlotRef("上午吧", SLOTS), undefined);
  });

  it("没有任何时间限定词 → undefined（他不是在选时段）", () => {
    assert.equal(resolveSlotRef("那这个店怎么样", SLOTS), undefined);
  });

  it("联系方式：认姓与手机号，不代拟备注", () => {
    const c = pickContact("我姓林，手机 13800138000");
    assert.equal(c.name, "林先生");
    assert.equal(c.phone, "13800138000");
    assert.equal(pickContact("帮我约一下").phone, undefined);
  });

  /**
   * 语音是默认入口，ASR 出来的手机号是中文口语数字。认不出时应答模型仍会复述号码，
   * 状态里却为空，下一轮会再问一遍。
   */
  it("中文口语数字的手机号也要认：语音场景下这是常态", () => {
    assert.equal(pickContact("我手机号码是幺三九幺二三四五六幺三").phone, "13912345613");
    assert.equal(pickContact("一三八零零一三八零零零").phone, "13800138000");
    assert.equal(pickContact("我的号码是139 1234 5613").phone, "13912345613");
    assert.equal(pickContact("139-1234-5613").phone, "13912345613");
  });

  it("「八月十五号上午十点」不能被拼成手机号：只逐字映射，不处理十/百", () => {
    assert.equal(pickContact("我要八月十五号上午十点的").phone, undefined);
    assert.equal(pickContact("第二家吧").phone, undefined);
  });

  it("城市到区", () => {
    assert.deepEqual(pickCityDistrict("我在深圳南山"), { city: "深圳", district: "南山" });
  });

  /**
   * 门店系统按 (城市, 区) 现合成门店，城市识别不设白名单。
   */
  it("认任意城市，不限于种子城市", () => {
    assert.deepEqual(pickCityDistrict("帮我约北京朝阳的试驾"), { city: "北京", district: "朝阳" });
    assert.deepEqual(pickCityDistrict("我在成都武侯区"), { city: "成都", district: "武侯" });
    assert.equal(pickCityDistrict("想在拉萨试驾").city, "拉萨");
    assert.equal(pickCityDistrict("在珠海").city, "珠海");
  });

  it("按在句子里出现的先后取城市：「从深圳开到北京」他人在深圳", () => {
    assert.equal(pickCityDistrict("从深圳开到北京").city, "深圳");
    // 「开到」不能被当成区：合成是来者不拒的，放过去就是一家「深圳开到体验店」
    assert.equal(pickCityDistrict("从深圳开到北京").district, undefined);
  });

  it("不像地名就认不出：宁可回去问，也不凭空长出一家店", () => {
    assert.equal(pickCityDistrict("我想去市中心看看").city, undefined);
    assert.equal(pickCityDistrict("约试驾").city, undefined);
  });

  /**
   * 「上海 model Y 的…」不能截出区 `" m"`（空格 + 字母）。门店系统的
   * `isPlausiblePlace` 也会拦，但噪音不应发出去。
   */
  it("区必须是两个汉字：字母和空格不算", () => {
    assert.equal(pickCityDistrict("帮我预约一下上海 model Y 的八月十五号的试驾").district, undefined);
    assert.equal(pickCityDistrict("帮我预约一下上海 model Y 的八月十五号的试驾").city, "上海");
    assert.equal(pickCityDistrict("北京 Model 3 试驾").district, undefined);
  });

  /**
   * 一单下完，那份计划就退休。之后换城市、换车型或说再约都开新的一单，
   * 否则应答会拿已完成的旧计划（旧城市的时段）作答。
   */
  it("下过单之后换城市 / 换车型 / 说再约 → 开新的一单", () => {
    const booked = {
      model: "Model Y", city: "深圳", stores: [], slots: [],
      status: "booked" as const, orderId: "TD-000004", at: 0,
    };
    assert.equal(startsNewBooking("帮我预约上海的试驾", "上海", "Model Y", booked), true);
    assert.equal(startsNewBooking("再帮我约一个周日的", undefined, "Model Y", booked), true);
    assert.equal(startsNewBooking("Model 3 也想试试", undefined, "Model 3", booked), true);
  });

  it("「我那个试驾几点来着」不算新的一单：该继续讲已下的那单", () => {
    const booked = {
      model: "Model Y", city: "深圳", stores: [], slots: [],
      status: "booked" as const, orderId: "TD-000004", at: 0,
    };
    assert.equal(startsNewBooking("我那个试驾几点来着", undefined, "Model Y", booked), false);
    // 还没下单的计划不归它管，走 movedCity 那条
    const going = { model: "Model Y", city: "深圳", stores: [], slots: [], status: "choosing_slot" as const, at: 0 };
    assert.equal(startsNewBooking("上海呢", "上海", "Model Y", going), false);
  });

  /**
   * 区名不在句尾时贪婪匹配会多吃字（「深圳南山有没有啊」→ `南山有`），
   * 门店系统随之零命中，助手会断言该区没有门店。截错区比截不出来代价更高。
   */
  it("区名不在句尾时也要截对", () => {
    assert.equal(pickCityDistrict("深圳南山有没有啊").district, "南山");
    assert.equal(pickCityDistrict("深圳南山区").district, "南山");
    assert.equal(pickCityDistrict("上海浦东新区").district, "浦东新");
    assert.equal(pickCityDistrict("约个广州天河的试驾").district, "天河");
  });

  it("截不出区就返回 undefined，不拿语气词当地名", () => {
    assert.equal(pickCityDistrict("深圳有没有店").district, undefined);
    assert.equal(pickCityDistrict("约个深圳的试驾").district, undefined);
    assert.equal(pickCityDistrict("深圳这边能试驾吗").district, undefined);
    assert.equal(pickCityDistrict("我在深圳").district, undefined);
  });

  it("车型认不出返回 undefined", () => {
    assert.equal(matchModel("我想试驾 Model Y"), "Model Y");
    assert.equal(matchModel("我想试驾那个车"), undefined);
  });
});

describe("多步引导：跨轮推进（真图）", () => {
  const cfg = (id: string) => ({
    configurable: { thread_id: id, userId: "u1", emit: { onDelta: () => {} } },
  });

  beforeEach(() => {
    answerPrompts.length = 0;
    setDealerBackend(fakeDealer());
    // 默认放行，专测流程；权限门的分支在下一组。
    setGuardGate({ check: async () => ({ decision: "allow", reason: "ok" }) } as never);
  });

  it("三轮走到选时段：说车型城市 → 选店 → 报时段", async () => {
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const c = cfg("td-1");

    const s1 = await graph.invoke({ messages: [{ role: "user", content: "我想试驾 Model Y，我在深圳" }] }, c);
    assert.equal(s1.testDrivePlan?.stores.length, 2);
    assert.equal(s1.testDrivePlan?.chosenStoreId, undefined, "两家店要让他选");

    const s2 = await graph.invoke({ messages: [{ role: "user", content: "第二家吧" }] }, c);
    assert.equal(s2.testDrivePlan?.chosenStoreId, "sz-futian-exp");
    assert.ok((s2.testDrivePlan?.slots.length ?? 0) > 0, "选完店应当去查时段");
    assert.equal(s2.testDrivePlan?.status, "choosing_slot");
  });

  it("没查过时段就不许说时间：上下文里有硬拦截", async () => {
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const s = await graph.invoke(
      { messages: [{ role: "user", content: "我想试驾 Model Y，我在深圳" }] },
      cfg("td-2"),
    );
    assert.match(lastPrompt(), /本轮没有查过任何可预约时段/);
  });

  /**
   * 「这个区没有店」和「这个城市没有店」是两句话，后者是强断言。
   * 只按区查一次就播报"没有"，在截错区时就是一句假话。
   */
  it("区级零命中要退回城市级重查，并且明说放宽了范围", async () => {
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const s = await graph.invoke(
      // 龙华在种子里没有店，深圳有
      { messages: [{ role: "user", content: "我想试驾 Model Y，我在深圳龙华" }] },
      cfg("td-widen"),
    );
    const ctx = lastPrompt();
    assert.match(ctx, /龙华/, "得告诉他他问的那个区没有");
    assert.match(ctx, /同城其它区/);
    assert.equal(s.testDrivePlan?.stores.length, 2, "退回城市级应当查到两家");
    assert.equal(s.testDrivePlan?.chosenStoreId, undefined, "放宽过范围就不许自动选中");
  });

  /**
   * 门店时段已定、只差手机号时问「上海有没有」，状态机也要走查询分支；
   * 停在原地时应答模型会编一句没查过的"上海没查到"。
   */
  it("中途换城市要真的重查，不能停在原地让模型编", async () => {
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const c = cfg("td-move");
    const s1 = await graph.invoke(
      { messages: [{ role: "user", content: "我想试驾 Model Y，我在深圳南山，我姓林，手机 13800138000" }] },
      c,
    );
    assert.equal(s1.testDrivePlan?.chosenStoreId, "sz-nanshan-exp");

    const asked: string[] = [];
    setDealerBackend(
      fakeDealer({
        async stores(a) {
          asked.push(a.city ?? "");
          return { stores: [], matched: 0 };
        },
      }),
    );
    const s2 = await graph.invoke({ messages: [{ role: "user", content: "上海有没有可以试驾的门店" }] }, c);
    assert.deepEqual(asked, ["上海"], "换了城市就必须真发一次查询");
    assert.equal(s2.testDrivePlan?.chosenStoreId, undefined, "旧城市选中的店要作废");
    assert.equal(s2.testDrivePlan?.chosenSlotId, undefined);
    assert.equal(s2.testDrivePlan?.contact?.phone, "13800138000", "**手机号不能跟着城市一起丢**");
  });

  /**
   * 一单落定后换城市仍要重查：若状态机把已完成的旧计划判定为"已经做完"，
   * 会把它再交一遍上下文，应答拿旧城市的时段作答。
   */
  it("下过单之后换城市 → 真的重查，不拿旧计划顶", async () => {
    const asked: Array<string | undefined> = [];
    setDealerBackend(
      fakeDealer({
        async stores(a) {
          asked.push(a.city);
          const rows = a.city === "深圳" ? STORES.slice(0, 1) : STORES.slice(1, 2);
          return { stores: rows as never, matched: rows.length };
        },
      }),
    );
    setGuardGate({ check: async () => ({ decision: "allow", reason: "ok" }) } as never);

    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const c = cfg("td-second");
    await graph.invoke(
      { messages: [{ role: "user", content: "我想试驾 Model Y，我在深圳，我姓林，手机 13800138000" }] },
      c,
    );
    const s1 = await graph.invoke({ messages: [{ role: "user", content: "周六上午那个" }] }, c);
    assert.equal(s1.testDrivePlan?.status, "booked", "先得真约上一单");

    const s2 = await graph.invoke(
      { messages: [{ role: "user", content: "帮我预约一下上海 Model Y 的试驾" }] },
      c,
    );
    assert.ok(asked.includes("上海"), "换了城市就必须真发一次查询——不查就只能编");
    assert.equal(s2.testDrivePlan?.orderId, undefined, "新的一单不该带着旧订单号");
    assert.equal(s2.testDrivePlan?.city, "上海");
    assert.equal(s2.testDrivePlan?.contact?.phone, "13800138000", "手机号不能跟着退休的计划一起丢");
  });

  /**
   * 时段未选中、未过权限门、订单不存在时，应答模型仍可能说"已经约好了"，
   * 车主到店时门店没有他的预约。报时段这一步与下单一样需要这条拦截。
   */
  it("还在选时段时，上下文必须明说「没约上」", async () => {
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const c = cfg("td-notbooked");
    await graph.invoke({ messages: [{ role: "user", content: "我想试驾 Model Y，我在深圳南山" }] }, c);
    const ctx = lastPrompt();
    assert.match(ctx, /本轮没有约上任何时段/);
    assert.match(ctx, /不要说「已经约好」/);
    assert.match(ctx, /不要交代到店注意事项/, "「记得带好驾照」正是那次编出来的话");
  });

  it("解析不出时段时也要有那条拦截", async () => {
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const c = cfg("td-notbooked-2");
    await graph.invoke({ messages: [{ role: "user", content: "我想试驾 Model Y，我在深圳南山" }] }, c);
    // 「上午吧」是选择类句式（粘得住试驾分支），但两天上午各有一个 10 点 →
    // 命中两个 → 解析不出。时段仍未选中，上下文要再喊一次。
    await graph.invoke({ messages: [{ role: "user", content: "上午吧" }] }, c);
    assert.match(lastPrompt(), /本轮没有约上任何时段/);
  });

  it("门店零命中时如实说没有，不编一家", async () => {
    setDealerBackend(fakeDealer({ async stores() { return { stores: [], matched: 0 }; } }));
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const s = await graph.invoke(
      { messages: [{ role: "user", content: "我想试驾 Model Y，我在杭州" }] },
      cfg("td-3"),
    );
    assert.match(lastPrompt(), /没有.*门店/);
  });

  it("门店系统连不上 → 一个门店名都不说", async () => {
    setDealerBackend(fakeDealer({ async stores() { throw new Error("fetch failed"); } }));
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const s = await graph.invoke(
      { messages: [{ role: "user", content: "我想试驾 Model Y，我在深圳" }] },
      cfg("td-4"),
    );
    const ctx = lastPrompt();
    assert.match(ctx, /没连通/);
    assert.match(ctx, /一个门店名都不要说/);
    assert.equal(ctx.includes("体验店"), false);
  });
});

/**
 * 档案里已登记的联系方式。
 *
 * 明文不进图状态：图状态会进检查点、会被回放页读到。
 * 所以子图手上只有尾号，下单参数里只有 memberId。
 */
describe("联系方式来自档案：省掉那一问，且明文不进图状态", () => {
  const cfg2 = (id: string) => ({
    configurable: { thread_id: id, userId: "u1", emit: { onDelta: () => {} } },
  });

  /**
   * 假 store 必须自洽：`listByOwner` 与 `get` 返回同一条记录，
   * 与真实实现里两条路读同一张表一致。
   */
  const withPhone = (phone?: string) => {
    const row = {
      id: "m-self",
      vin: "V",
      ownerId: "u1",
      displayName: "阿东",
      relation: "本人",
      roles: ["driver"],
      needs: [],
      updatedAt: 0,
      phone,
    };
    setMemberStores(
      {
        async listByOwner(ownerId: string) {
          return (ownerId === "u1" ? [row] : []) as never;
        },
        async listByVehicle() {
          return [] as never;
        },
        async get(ownerId: string, id: string) {
          return (ownerId === "u1" && id === row.id ? row : null) as never;
        },
        async upsert() {
          return row as never;
        },
        async remove() {
          return null;
        },
      } as never,
      undefined as never,
    );
  };

  beforeEach(() => {
    answerPrompts.length = 0;
    setDealerBackend(fakeDealer());
  });

  it("档案里有号就不再问，且下单走 memberId 而不是明文", async () => {
    withPhone("13912345613");
    const seen: Array<Record<string, unknown>> = [];
    setGuardGate({
      check: async (i: Record<string, unknown>) => {
        seen.push(i);
        return { decision: "allow", reason: "ok" };
      },
    } as never);

    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const c = cfg2("td-ref-1");
    // 一句话到底：南山只有一家 → 自动选中 → 查时段
    await graph.invoke({ messages: [{ role: "user", content: "我想试驾 Model Y，我在深圳南山" }] }, c);
    const s = await graph.invoke({ messages: [{ role: "user", content: "周六上午那个" }] }, c);

    assert.equal(s.testDrivePlan?.contactRef?.phoneTail, "5613");
    assert.equal(s.testDrivePlan?.contactRef?.memberId, "m-self");
    // 图状态里搜不到明文
    assert.equal(JSON.stringify(s.testDrivePlan).includes("13912345613"), false);
    // 外发块仍然在（AC-15-7），且是掩码
    const disclosures = seen.at(-1)?.disclosures as string[] | undefined;
    assert.deepEqual(disclosures, ["称呼：阿东", "手机号：···****5613"]);
    // 单要真的下成：只断言弹窗形状会漏掉"查得到号却下不了单"
    assert.equal(s.testDrivePlan?.orderId, "TD-000009");
    assert.equal(s.testDrivePlan?.status, "booked");
  });

  it("下单后要说尾号，不说星号：门店回拨哪个号是他最后能纠正的东西", async () => {
    withPhone("13912345613");
    setGuardGate({ check: async () => ({ decision: "allow", reason: "ok" }) } as never);
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const c = cfg2("td-ref-2");
    await graph.invoke({ messages: [{ role: "user", content: "我想试驾 Model Y，我在深圳南山" }] }, c);
    await graph.invoke({ messages: [{ role: "user", content: "周六上午那个" }] }, c);
    assert.match(lastPrompt(), /尾号 5613/);
    assert.match(lastPrompt(), /不要念星号/);
  });

  /**
   * 试驾这条路的应答是无工具的直连模型（`CABINHUG_ANSWER_RUNTIME=direct`），
   * 模型结构上调不到 `contact_update`，所以由子图发起写入；
   * 否则注册给 test-drive 的这个工具永远不会被执行。
   */
  it("车主口述的号码要记进档案，并明说记下了", async () => {
    const saved: Array<{ memberId: string; phone: string }> = [];
    const row = {
      id: "m-self",
      vin: "V",
      ownerId: "u1",
      displayName: "阿东",
      relation: "本人",
      roles: ["driver"],
      needs: [],
      updatedAt: 0,
      phone: undefined as string | undefined,
    };
    setMemberStores(
      {
        async listByOwner() {
          return [row] as never;
        },
        async listByVehicle() {
          return [] as never;
        },
        async get(_o: string, id: string) {
          return (id === row.id ? row : null) as never;
        },
        async upsert(m: { id: string; phone?: string }) {
          saved.push({ memberId: m.id, phone: m.phone! });
          row.phone = m.phone;
          return row as never;
        },
        async remove() {
          return null;
        },
      } as never,
      undefined as never,
    );
    setGuardGate({ check: async () => ({ decision: "allow", reason: "ok" }) } as never);

    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const c = cfg2("td-ref-save");
    await graph.invoke({ messages: [{ role: "user", content: "我想试驾 Model Y，我在深圳南山" }] }, c);
    const s = await graph.invoke(
      { messages: [{ role: "user", content: "周六上午那个，我姓林，手机 13800138000" }] },
      c,
    );

    assert.deepEqual(saved, [{ memberId: "m-self", phone: "13800138000" }], "应当写进档案一次");
    assert.equal(s.testDrivePlan?.contactRef?.phoneTail, "8000");
    assert.equal(s.testDrivePlan?.orderId, "TD-000009");
  });

  it("档案里没号就照旧问，不拿别人的顶替", async () => {
    withPhone(undefined);
    setGuardGate({ check: async () => ({ decision: "allow", reason: "ok" }) } as never);
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const c = cfg2("td-ref-3");
    await graph.invoke({ messages: [{ role: "user", content: "我想试驾 Model Y，我在深圳南山" }] }, c);
    const s = await graph.invoke({ messages: [{ role: "user", content: "周六上午那个" }] }, c);
    assert.equal(s.testDrivePlan?.contactRef, undefined);
    assert.match(lastPrompt(), /还差联系方式/);
    assert.match(lastPrompt(), /档案里没查到/);
  });

  it("档案读不到不中断预约，退回去问", async () => {
    setMemberStores(
      {
        async listByOwner() {
          throw new Error("db down");
        },
      } as never,
      undefined as never,
    );
    setGuardGate({ check: async () => ({ decision: "allow", reason: "ok" }) } as never);
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const c = cfg2("td-ref-4");
    await graph.invoke({ messages: [{ role: "user", content: "我想试驾 Model Y，我在深圳南山" }] }, c);
    const s = await graph.invoke({ messages: [{ role: "user", content: "周六上午那个" }] }, c);
    assert.equal(s.testDrivePlan?.chosenSlotId, "s2_a", "时段照样选中了，没被档案故障带崩");
    assert.match(lastPrompt(), /还差联系方式/);
  });
});

describe("下单：图直调必须自己过权限门", () => {
  const full = "我想试驾 Model Y，我在深圳南山，我姓林，手机 13800138000";

  const runToBooking = async (id: string) => {
    const graph = buildChatGraph(answerOnly, { enableIntent: false });
    const c = { configurable: { thread_id: id, userId: "u1", emit: { onDelta: () => {} } } };
    // 南山只有一家（按 district 过滤后），直接进选时段
    await graph.invoke({ messages: [{ role: "user", content: full }] }, c);
    return { graph, c };
  };

  beforeEach(() => {
    answerPrompts.length = 0;
    setDealerBackend(fakeDealer());
  });

  it("外发项经子图也传到权限门，且手机号是掩码", async () => {
    const seen: Array<Record<string, unknown>> = [];
    setGuardGate({
      check: async (i: Record<string, unknown>) => {
        seen.push(i);
        return { decision: "allow", reason: "ok" };
      },
    } as never);
    const { graph, c } = await runToBooking("td-book-1");
    await graph.invoke({ messages: [{ role: "user", content: "周六上午那个" }] }, c);

    assert.equal(seen.length, 1, "图直调不过 tools-endpoint，权限门必须子图自己调");
    assert.deepEqual(seen[0].disclosures, ["称呼：林先生", "手机号：138****8000"]);
    assert.equal(JSON.stringify(seen[0].disclosures).includes("13800138000"), false);
  });

  it("摘要说人话，不是一串 id，且不含明文手机号", async () => {
    const seen: Array<Record<string, unknown>> = [];
    setGuardGate({
      check: async (i: Record<string, unknown>) => {
        seen.push(i);
        return { decision: "allow", reason: "ok" };
      },
    } as never);
    const { graph, c } = await runToBooking("td-book-2");
    await graph.invoke({ messages: [{ role: "user", content: "周六上午那个" }] }, c);
    const summary = String(seen[0].summary);
    assert.match(summary, /预约试驾/);
    assert.match(summary, /体验店/);
    assert.equal(summary.includes("13800138000"), false);
    assert.equal(/_[a-z0-9]{6}/.test(summary), false, "slotId 不该出现在摘要里");
  });

  it("确认后下单，orderId 进状态", async () => {
    setGuardGate({ check: async () => ({ decision: "allow", reason: "ok" }) } as never);
    const { graph, c } = await runToBooking("td-book-3");
    const s = await graph.invoke({ messages: [{ role: "user", content: "周六上午那个" }] }, c);
    assert.equal(s.testDrivePlan?.orderId, "TD-000009");
    assert.equal(s.testDrivePlan?.status, "booked");
  });

  it("拒绝 → 不下单，且绝不说已经约好", async () => {
    setGuardGate({ check: async () => ({ decision: "deny", reason: "用户拒绝了本次动作" }) } as never);
    const { graph, c } = await runToBooking("td-book-4");
    const s = await graph.invoke({ messages: [{ role: "user", content: "周六上午那个" }] }, c);
    assert.equal(s.testDrivePlan?.orderId, undefined);
    assert.equal(s.testDrivePlan?.status, "choosing_slot");
    const ctx = lastPrompt();
    assert.match(ctx, /没有下单/);
    assert.match(ctx, /绝不要说已经约好/);
  });

  it("权限门未装配 → 拒绝，不是放行（fail-closed）", async () => {
    setGuardGate(undefined as never);
    const { graph, c } = await runToBooking("td-book-5");
    const s = await graph.invoke({ messages: [{ role: "user", content: "周六上午那个" }] }, c);
    assert.equal(s.testDrivePlan?.orderId, undefined);
    assert.match(lastPrompt(), /没有下单/);
  });

  it("时段被抢（409）→ 不重试，退回重查且不说已约好", async () => {
    let calls = 0;
    setDealerBackend(
      fakeDealer({
        async book() {
          calls += 1;
          throw new Error("这个时段刚被订满了——请重新查一次可预约时段");
        },
      }),
    );
    setGuardGate({ check: async () => ({ decision: "allow", reason: "ok" }) } as never);
    const { graph, c } = await runToBooking("td-book-6");
    const s = await graph.invoke({ messages: [{ role: "user", content: "周六上午那个" }] }, c);
    assert.equal(calls, 1, "有副作用的动作绝不重试");
    assert.equal(s.testDrivePlan?.orderId, undefined);
    assert.equal(s.testDrivePlan?.chosenSlotId, undefined, "退回重选");
    assert.match(lastPrompt(), /不要说已经约好/);
  });

  it("幂等：同一时段重复确认只下一单", async () => {
    const keys: string[] = [];
    setDealerBackend(
      fakeDealer({
        async book(a) {
          keys.push(String(a.idempotencyKey));
          return {
            orderId: "TD-000009",
            storeId: "x",
            storeName: "深圳南山体验店",
            model: "Model Y",
            startAt: SLOTS[2].startAt,
            status: "confirmed",
            disclosed: [],
          };
        },
      }),
    );
    const gate = new GuardGate({ confirmTimeoutMs: 50 });
    setGuardGate(gate as never);
    // 幂等键含 slotId：同一时段两次确认拿到同一个键，门店系统据此不下第二单。
    const { graph, c } = await runToBooking("td-book-7");
    setGuardGate({ check: async () => ({ decision: "allow", reason: "ok" }) } as never);
    await graph.invoke({ messages: [{ role: "user", content: "周六上午那个" }] }, c);
    assert.equal(keys.length, 1);
    assert.match(keys[0], /td-book-7.*s2_a/);
  });
});

/**
 * 城市从副任务 goal 取（ACR-023）：副 lane 与主 lane 同 superstep 并行，
 * 看不到主任务写的 tripPlan，地点只能来自意图层的 goal。
 * 取法仍经词表归一，不把 goal 整句当城市发给 repair_stations。
 */
describe("[F-11-07][AC-11-6] pickCityDistrict 对副任务 goal 的归一", () => {
  it("「在杭州预约一次保养」→ 杭州", () => {
    assert.equal(pickCityDistrict("在杭州预约一次保养").city, "杭州");
  });
  it("没有城市词的 goal → undefined（不把整句当城市）", () => {
    assert.equal(pickCityDistrict("预约一次保养").city, undefined);
  });
});
