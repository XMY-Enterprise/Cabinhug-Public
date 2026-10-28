/**
 * 工具名 → 人话（FL-08 F-08-05）。
 *
 * # 表在服务端，不在端上
 *
 * 放端上则每加一个工具都要改两个端，漏改时车主会看到 `ragflow_retrieve` 这类函数名，
 * 像是程序出错。放在服务端，端上只显示收到的字符串。
 *
 * # 措辞是"正在…"，不复用工具的 description
 *
 * `description` 写给模型看（何时调用），内容是判据与约束；车主需要的是一句
 * 对得上等待的话。两者刻意不共用。
 *
 * # 没有兜底话术，兜底行为是不发
 *
 * 表里没有的工具不产生事件，既不显示函数名，也不编一句"正在查询"：后者在
 * 什么都没发生时是一句用户无法证伪的假话（与旁路 L0 模板"匹配不到就返回
 * undefined"同一条纪律）。
 *
 * 漏配由 `tool-display.test.ts` 拦截：它断言 `TOOL_REGISTRY` 里每一个工具都在这张表里。
 */

/**
 * 措辞的两条约定：
 *  1. 一律"正在…"，因为它只在 `started` 时下发；
 *  2. 不带对象的具体值（城市、车型、人名）：那些来自入参，
 *     而入参里有用户原文，进不了这条不走脱敏的通道（AC-44-10 同源）。
 */
export const TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  // ── 行程与出行 ────────────────────────────────────
  weather: "正在查天气",
  map_route: "正在算路线",
  poi_search: "正在找地点",
  // spot_search / hotel_search 是同一后端钉死类别的实例（见 poi-search.ts 文件头）。
  spot_search: "正在找景点",
  hotel_search: "正在找酒店",
  route_audit: "正在核对路线顺序",
  plan_audit: "正在核对行程安排",
  // 装配体检裁决：四个工具都是"看一遍 / 改一改 / 交结论"，不出现分支名与地名。
  itinerary_assemble: "正在把各路结果拼成一份行程",
  plan_edit: "正在调整行程安排",
  submit_repairs: "正在安排补查",
  submit_verdict: "正在给出行程结论",
  // 编排层的采集步骤（Plan 层按区县分次搜景点），模型不调；进度文案只为注册表齐全
  city_districts: "正在看目的地有哪些区县",
  transit_route: "正在查大交通",
  pretrip_items: "正在整理出行物品",
  destination_highlights: "正在上网找当地好吃好拍的",
  trip_plan_commit: "正在保存行程",
  trip_plan_cancel: "正在取消行程",
  trip_plan_update: "正在更新行程",
  trip_plan_nav: "正在开始导航",
  trip_plan_list: "正在翻你的行程",
  trip_plan_query: "正在查这份行程",

  // ── 用车与能源 ────────────────────────────────────
  vehicle_profile: "正在读车辆档案",
  vehicle_profile_write: "正在更新车辆档案",
  usage_profile: "正在看你的用车习惯",
  energy_gap: "正在算续航够不够",
  refuel_log: "正在记补能记录",
  data_freshness: "正在核对数据新旧",
  charging: "正在找充电桩",
  refuel: "正在找加油站",
  // 编排层后台调用（行程落库后补沿途服务），不进对话轮；进度文案只为注册表完整性而存在。
  route_services: "正在查沿途的餐饮、卫生间和停车场",
  ragflow_retrieve: "正在翻手册",

  // ── 座舱 ──────────────────────────────────────────
  cabin_status: "正在读车机状态",
  vehicle_energy: "正在读车上的电量和续航",
  cabin_control: "正在调车内设置",
  cabin_child_mode: "正在切儿童模式",
  cabin_apply_preferences: "正在按你的习惯调好",
  cabin_media: "正在放音乐",
  member_preference_set: "正在记下这个习惯",
  vehicle_member: "正在查同行人档案",
  preference_recall: "正在回想你的偏好",
  // 分支交结论的动作。对车主而言它意味着"这部分查完了"，措辞照此。
  submit_hotels: "正在整理酒店候选",
  submit_tour_days: "正在整理每日安排",
  submit_transit: "正在整理大交通方案",
  // ACR-047：段列表契约、续航评估与意图理解的提交通道。
  submit_drive_plan: "正在整理自驾方案",
  submit_range_assessment: "正在整理续航评估",
  submit_intent: "正在理解你的意思",
  // 出发导航规划的提交通道。
  submit_nav_plan: "正在整理出发导航方案",
  // 景区导览采集。web_search 的措辞不提"搜索引擎"，车主关心的是在查什么。
  web_search: "正在联网查攻略",
  submit_guide_spots: "正在整理必玩打卡点",
  submit_guide_access: "正在整理停车与补能",
  submit_guide_comfort: "正在整理休息与餐饮",

  // ── 购车与试驾 ────────────────────────────────────
  car_catalog: "正在查车型",
  trim_compare: "正在比配置",
  dealer_pricing: "正在问报价",
  dealer_stores: "正在找门店",
  dealer_slots: "正在看可约时段",
  test_drive_book: "正在约试驾",
  cost_calc: "正在算用车成本",
  loan_calc: "正在算贷款",
  insurance_quote: "正在算保费",
  // 售后维修与保险四工具
  repair_history: "正在查维修记录",
  repair_stations: "正在查维修站",
  repair_slots: "正在查进厂时段",
  repair_quote: "正在查维修报价单",
  insurance_policy: "正在查保单",
  insurance_precheck: "正在算理赔预检",
  // 走不走保险的净收益、出险材料与时限
  claim_advisor: "正在算走不走保险",
  claim_checklist: "正在列理赔材料",

  // ── 售后与联系人 ──────────────────────────────────
  appointment: "正在约保养",
  contact_lookup: "正在查联系方式",
  contact_update: "正在更新联系方式",
};

/**
 * 同一个工具、不同 Agent 下说法不同的那几个。
 *
 * 只有 `ragflow_retrieve` 一条：它缺省查该 Agent 允许的全部集（ACR-042），
 * 而售后与购车的允许集里有车险条款、用车助手没有。"正在翻手册"对售后是漏说，
 * "正在翻手册与条款"对用车助手是多说，车主会据此去找并不存在的条款。
 */
const BY_AGENT: Record<string, Record<string, string>> = {
  ragflow_retrieve: { service: "正在翻手册与条款", buying: "正在翻车型资料与条款" },
};

/**
 * 查不到就返回 undefined，调用方据此不发事件，见模块注释。
 *
 * `agent` 由调用方从 `ToolCallContext.agent` 传进来（ADR-010：判断者的输入里要有它需要的事实）。
 * 不传就退到通用说法，不报错：进度提示出错不应影响工具调用。
 */
export function toolDisplayName(name: string, agent?: string): string | undefined {
  if (agent) {
    const byAgent = BY_AGENT[name]?.[agent];
    if (byAgent) return byAgent;
  }
  return TOOL_DISPLAY_NAMES[name];
}
