/**
 * 能力开关在编排层的收口（ACR-056）。
 *
 * # 收在路由之后，不改意图层
 *
 * 意图层照常把「我这车胎压灯亮了」判成 ownership：模型认得出这是用车问题，编排层才能明确回一句
 * 「这一版没开放」。把 ownership/service 从路由候选里拿掉，这类问题会落到 general，由模型凭自己的
 * 知识作答——没有手册依据的保养、故障结论，正是关掉这项能力要避免的。
 *
 * # 不新增图节点
 *
 * 主目标关闭时改落 general（`branchFor` → `answer`），带上 `closedBy`，`answer` 见到它就下发固定话术、
 * 不调表述模型。走既有的 `dispatch → answer` 边，控制台的图与漂移守护都不用动。
 */

import type { Capability } from "@cabinhug/shared";

import type { RouteDecision } from "./state";

/** 路由目标 → 能力。不在表里的目标不受能力开关管。 */
const ROUTE_CAPABILITY: Readonly<Record<string, Capability>> = {
  ownership: "ownership-qa",
  service: "service-qa",
  // ACR-059：单机版只做行程，这三类分支依赖的门店、车型库、座舱系统都不在单机包里。
  buying: "buying-advice",
  testDrive: "test-drive",
  cabin: "cabin-control",
};

export function capabilityOfRoute(agent: string | undefined): Capability | undefined {
  return agent ? ROUTE_CAPABILITY[agent] : undefined;
}

/*
 * 话术与硬禁那一套同一个写法：拒绝的是依据不足的回答，不是帮助，每条都带一个可执行的下一步。
 * 「先在安全的地方停车」放在前面：问用车 / 售后的人，可能正开着一辆亮了灯的车。
 */
const REPLIES: Readonly<Partial<Record<Capability, string>>> = {
  "ownership-qa":
    "这一版还没有开放用车问答：车辆手册知识库没有接入，我给不出有依据的回答。" +
    "如果是仪表报警或行驶中出现异常，请先在安全的地方停车，再查看随车手册或联系售后服务门店。" +
    "行程规划、天气和地图，我可以帮你。",
  "service-qa":
    "这一版还没有开放售后问答和维修预约：维修知识库与门店系统没有接入。" +
    "车辆出现故障或异常，请先在安全的地方停车，再联系售后服务门店或道路救援。" +
    "行程规划、天气和地图，我可以帮你。",
  "buying-advice":
    "这一版还没有开放购车顾问：车型库、门店报价和贷款保险测算都没有接入，我给不出有依据的选车建议。" +
    "可以去品牌官网或门店了解车型与价格。行程规划、天气和地图，我可以帮你。",
  "test-drive":
    "这一版还没有开放试驾预约：门店系统没有接入，我查不到门店和可约时段，也约不了。" +
    "可以直接联系品牌门店预约试驾。行程规划、天气和地图，我可以帮你。",
  "cabin-control":
    "这一版还没有开放车内控制：空调、座椅、音乐这些我在这里调不了，请在车上直接操作。" +
    "行程规划、天气和地图，我可以帮你。",
};

// 照片与视频在网关就被拒收（403 capability_off），到不了编排层，这里只留兜底。
const FALLBACK = "这一版还没有开放这项功能。行程规划、天气和地图，我可以帮你。";

export function capabilityOffReply(capability: Capability): string {
  return REPLIES[capability] ?? FALLBACK;
}

/**
 * 按关闭清单收口一轮的路由，返回新对象、不改入参。
 *
 * - 主目标关闭 → 改落 general、记下 `closedBy`、清空副任务：这一轮只回固定话术，
 *   副任务若照跑，结果到了 `answer` 也不会被说出来，白占一次 fan-out。
 * - 主目标开着 → 只剔除副任务里关闭的那几件。
 */
export function closeRoute(route: RouteDecision, off: ReadonlySet<Capability>): RouteDecision {
  if (off.size === 0) return route;
  const closedBy = capabilityOfRoute(route.agent);
  if (closedBy && off.has(closedBy)) {
    return { agent: "general", reason: `${route.reason}；${closedBy} 已关闭→固定话术（ACR-056）`, closedBy };
  }
  if (!route.secondary?.length) return route;
  const secondary = route.secondary.filter((t) => {
    const c = capabilityOfRoute(t.route);
    return !(c && off.has(c));
  });
  if (secondary.length === route.secondary.length) return route;
  const { secondary: _dropped, ...rest } = route;
  return secondary.length ? { ...rest, secondary } : rest;
}
