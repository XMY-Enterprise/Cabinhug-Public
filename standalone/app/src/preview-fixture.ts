/**
 * 浏览器预览的样例数据（只给走查用，`preview.html?fixture=hangzhou`）：对着 内部文档 四张定稿
 * 逐屏核对时，不必先让本机网关真的排出一份行程。生产入口 index.html 不引它。
 *
 * 内容照定稿图里的杭州三天行程摆；坐标取各地点的大致真实位置，只为地图能画出形状。
 */
import {
  tripServicesKey,
  type ChatMessage,
  type GuideJobsStatus,
  type OwnerBillingSummary,
  type TripPlanSnapshot,
} from "@cabinhug/shared";
import { DEMO_GUIDE_BRIEF } from "@cabinhug/ui";

import type { SessionItem } from "./types";

const SESSION = "sess-fixture-hz";
const HOTEL = {
  name: "杭州国际会议中心洲际酒店",
  address: "上城区解放东路 2 号",
  area: "钱江新城",
  rating: "4.7",
  estPrice: "¥900–1300/晚",
  lat: 30.2466,
  lon: 120.2109,
};

export const FIXTURE_PLAN: TripPlanSnapshot = {
  status: "confirmed",
  origin: "上海",
  destination: "杭州",
  startDate: "2026-10-24",
  days: 3,
  skeleton: [
    {
      day: 1,
      theme: "抵达杭州",
      area: "钱塘江畔",
      spots: [
        { name: "钱江世纪公园", poiKind: "park", estStart: "14:00", estEnd: "15:30", lat: 30.2389, lon: 120.2566, note: "欣赏钱塘江两岸现代城市风光，江边草坪适合歇脚。" },
        { name: "城市阳台江堤步道", poiKind: "spot", estStart: "15:50", estEnd: "17:10", lat: 30.2448, lon: 120.2141, note: "漫步江边，感受钱塘江畔的都市景观。" },
      ],
      hotel: HOTEL,
      lodging: { strategy: "checkin-evening" },
      endLeg: { driveMinutes: 16, toName: HOTEL.name, computedAt: "2026-10-24T02:00:00.000Z" },
    },
    {
      day: 2,
      theme: "老城漫步",
      area: "西湖风光",
      spots: [
        {
          name: "清河坊历史文化街区",
          poiKind: "old_town",
          estStart: "09:30",
          estEnd: "11:00",
          lat: 30.2427,
          lon: 120.1679,
          note: "清河坊是杭州保存较完整的历史文化街区之一，汇聚了南宋风貌、老字号商铺与特色小吃，是感受杭州古城人文气息的好去处。",
        },
        { name: "胡雪岩旧居", poiKind: "museum", estStart: "11:10", estEnd: "13:10", lat: 30.2436, lon: 120.1729, note: "参观晚清红顶商人胡雪岩的故居，了解杭州近代历史。" },
        { name: "柳浪闻莺", poiKind: "park", estStart: "14:00", estEnd: "16:30", lat: 30.2452, lon: 120.1601, note: "西湖十景之一，湖光柳色，环境清幽，适合漫步拍照。", indoor: false },
      ],
      hotel: HOTEL,
      endLeg: { driveMinutes: 26, toName: HOTEL.name, computedAt: "2026-10-24T02:00:00.000Z" },
    },
    {
      day: 3,
      theme: "运河街区",
      area: "返程",
      spots: [
        { name: "西湖文化广场", poiKind: "park", estStart: "09:00", estEnd: "11:00", lat: 30.2785, lon: 120.1676, note: "城市文化地标，周边有博物馆、大剧院等，适合拍照打卡。" },
        { name: "大兜路历史文化街区", poiKind: "old_town", estStart: "11:20", estEnd: "14:00", lat: 30.2937, lon: 120.1612, note: "沿运河而建的历史街区，感受老杭州的市井烟火。" },
      ],
    },
  ],
  legs: [
    { day: 1, direction: "outbound", driveMinutes: 158, fromStop: "上海", toStop: "钱江世纪公园" },
    { day: 3, direction: "return", driveMinutes: 164, fromStop: "大兜路历史文化街区", toStop: "上海" },
  ],
  leg: { distanceKm: 174, durationMin: 158, computedAt: "2026-10-24T02:00:00.000Z" },
  weather: { kind: "rain", label: "小雨", source: { name: "高德开放平台", url: "https://lbs.amap.com" } },
  pretripItems: [{ key: "umbrella" }, { key: "jacket" }],
  caveats: ["杭州有小雨，请携带雨具", "住宿价格为估算，以预订平台为准"],
  updatedTurnId: `${SESSION}#1`,
};

// 沿途服务：指纹按上面这份骨架算，展示层才认（骨架一变就作废，见 `tripServicesForDay`）。
FIXTURE_PLAN.services = {
  computedAt: "2026-10-24T02:00:00.000Z",
  radiusM: 1500,
  skeletonKey: tripServicesKey(FIXTURE_PLAN),
  days: [
    {
      day: 1,
      food: 2,
      restroom: 2,
      parking: 1,
      charging: 1,
      pois: {
        food: [
          { name: "外婆家（来福士店）", lat: 30.2482, lon: 120.2108 },
          { name: "绿茶餐厅（钱江新城店）", lat: 30.2431, lon: 120.2172 },
        ],
        restroom: [
          { name: "城市阳台公厕", lat: 30.2443, lon: 120.2133 },
          { name: "钱江世纪公园公厕", lat: 30.2396, lon: 120.2551 },
        ],
        parking: [{ name: "城市阳台地下停车场", lat: 30.2451, lon: 120.2125 }],
        charging: [{ name: "特来电钱江新城充电站", lat: 30.2477, lon: 120.2161 }],
      },
      serviceAreas: ["嘉兴服务区", "长安服务区"],
    },
    {
      day: 2,
      food: 3,
      restroom: 2,
      parking: 2,
      charging: 0,
      pois: {
        food: [
          { name: "知味观（湖滨店）", lat: 30.2569, lon: 120.1655 },
          { name: "奎元馆", lat: 30.2468, lon: 120.1688 },
          { name: "王润兴酒楼", lat: 30.2433, lon: 120.1691 },
        ],
        restroom: [
          { name: "河坊街公厕", lat: 30.2429, lon: 120.1689 },
          { name: "柳浪闻莺公厕", lat: 30.2455, lon: 120.1612 },
        ],
        parking: [
          { name: "吴山广场地下停车场", lat: 30.2447, lon: 120.1701 },
          { name: "柳浪闻莺停车场", lat: 30.2449, lon: 120.1622 },
        ],
      },
    },
  ],
};

/** 导览进度：一站就绪、一站在采、其余排队或未采（预览里看齐五种状态）。 */
const FIXTURE_JOBS: GuideJobsStatus = {
  spots: [
    { spotName: "钱江世纪公园", state: "ready" },
    { spotName: "城市阳台江堤步道", state: "ready" },
    { spotName: "清河坊历史文化街区", state: "ready", cached: true },
    { spotName: "胡雪岩旧居", state: "processing" },
    { spotName: "柳浪闻莺", state: "pending" },
    { spotName: "西湖文化广场", state: "unprocessed" },
    { spotName: "大兜路历史文化街区", state: "failed", note: "联网检索超时" },
  ],
  summary: { total: 7, ready: 3, processing: 1, pending: 1, failed: 1, unprocessed: 1 },
};

/** 费用明细的样例：只为看版式，数字按「近 7 天是今天的几倍」随手放大，不对应任何真实账单。 */
function fixtureBilling(range: "today" | "7d" | "30d"): OwnerBillingSummary {
  const k = range === "today" ? 1 : range === "7d" ? 5 : 18;
  const agents: Array<[string, number, number, number]> = [
    ["guide-spots-task", 21, 412_000, 38_000],
    ["tour-plan-task", 4, 96_000, 21_000],
    ["drive-task", 6, 88_000, 9_400],
    ["tour-task", 5, 71_000, 12_000],
    ["supervisor-intent", 10, 64_000, 3_100],
    ["hotel-task", 3, 41_000, 6_200],
    ["title", 6, 9_000, 600],
  ];
  const rows = agents.map(([key, calls, p, c]) => ({
    key,
    calls: calls * k,
    promptTokens: p * k,
    completionTokens: c * k,
    costEstimate: Number((((p / 1000) * 0.003 + (c / 1000) * 0.009) * k).toFixed(6)),
  }));
  const llmCost = Number(rows.reduce((t, r) => t + r.costEstimate, 0).toFixed(6));
  return {
    range,
    since: new Date(now - k * 86_400_000).toISOString(),
    until: new Date(now).toISOString(),
    generatedAt: new Date(now).toISOString(),
    totalCostEstimate: llmCost,
    background: "included",
    services: [
      {
        id: "deepseek",
        label: "大模型 · DeepSeek",
        role: "对话、行程规划、景点导览",
        calls: rows.reduce((t, r) => t + r.calls, 0),
        costEstimate: llmCost,
        balance: { status: "ok", amount: 86.42, currency: "CNY", consoleUrl: "https://platform.deepseek.com/usage" },
        note: "花费按本机记的 token 与配置的单价估算（经 pi-acp 的调用按字符估），只能说「至少花了这么多」，以 DeepSeek 账单为准",
        rows,
      },
      {
        id: "aliyun",
        label: "阿里云内容审核",
        role: "输入与输出的内容安全审核",
        calls: 38 * k,
        balance: { status: "failed", note: "HTTP 403（AccessKey 没有费用中心的只读权限）", consoleUrl: "https://usercenter2.aliyun.com/" },
        note: "每条审核记录对应一次阿里云调用（放行也计）；按次计费，单价以阿里云账单为准",
        rows: [
          { key: "input_moderation", calls: 20 * k },
          { key: "output_moderation", calls: 18 * k },
        ],
      },
      {
        id: "amap",
        label: "高德开放平台",
        role: "地点搜索、路线规划、天气",
        calls: 214,
        quota: { used: 162, limit: 450, day: "2026-10-27" },
        note: "高德按北京日计额度，这里只有今天；个人 Key 在免费额度内不产生费用",
        rows: [
          { key: "place", calls: 162 },
          { key: "direction", calls: 38 },
          { key: "geocode", calls: 9 },
          { key: "weather", calls: 5 },
        ],
      },
    ],
  };
}

const FIXTURE_BRIEF = {
  ...DEMO_GUIDE_BRIEF,
  branchSources: { access: "text", spots: "text", comfort: "text" },
} satisfies typeof DEMO_GUIDE_BRIEF;

const now = Date.now();

export const FIXTURE_SESSIONS: SessionItem[] = [
  { sessionId: SESSION, title: "上海到杭州三天行程", createdAt: new Date(now - 3_600_000).toISOString(), updatedAt: new Date(now - 60_000).toISOString(), closedAt: null, messageCount: 2 },
  { sessionId: "sess-fixture-sz", title: "苏州一日游", createdAt: new Date(now - 7_200_000).toISOString(), updatedAt: new Date(now - 7_000_000).toISOString(), closedAt: null, messageCount: 4 },
  { sessionId: "sess-fixture-qd", title: "周末去千岛湖", createdAt: new Date(now - 90_000_000).toISOString(), updatedAt: new Date(now - 90_000_000).toISOString(), closedAt: null, messageCount: 6 },
];

const msg = (i: number, role: ChatMessage["role"], content: string): ChatMessage => ({
  messageId: `fx-${i}`,
  sessionId: SESSION,
  turnId: "fx-turn-1",
  role,
  source: "text",
  content,
  ts: now - (3 - i) * 30_000,
});

export const FIXTURE_MESSAGES: ChatMessage[] = [
  msg(1, "user", "帮我安排杭州三天行程"),
  msg(2, "assistant", "行程已确认。今天先去**钱江世纪公园**，再到城市阳台看江景。\n杭州有小雨，记得带伞。☂️"),
];

/** 预览里的网关：按路径回样例。没覆盖到的路径回空，让界面走它自己的空态。 */
export function fixtureGateway(method: string, path: string): { status: number; body: string } {
  const ok = (v: unknown) => ({ status: 200, body: JSON.stringify(v) });
  if (method === "GET" && path.startsWith("/v1/sessions")) return ok({ sessions: FIXTURE_SESSIONS, hasMore: false });
  if (method === "GET" && path === `/v1/session/${SESSION}/messages`) return ok({ messages: FIXTURE_MESSAGES });
  if (method === "GET" && path === `/v1/session/${SESSION}/trip-draft`) return ok({ plan: FIXTURE_PLAN });
  if (method === "GET" && path.endsWith("/messages")) return ok({ messages: [] });
  if (method === "GET" && path.endsWith("/trip-draft")) return ok({ plan: null });
  if (method === "POST" && path === "/v1/session") return ok({ sessionId: `sess-fixture-${Math.random().toString(16).slice(2, 8)}` });
  if (method === "GET" && path.startsWith("/v1/trip-plan/current")) return ok({ plan: FIXTURE_PLAN, currentPlanId: "plan-fixture" });
  if (method === "GET" && path === "/v1/guide/jobs") return ok({ planId: "plan-fixture", jobs: FIXTURE_JOBS });
  if (method === "POST" && path === "/v1/guide/jobs/trigger") return ok({ spot: { spotName: "x", state: "pending" } });
  // 简报用两端共用的那份演示数据（`DEMO_GUIDE_BRIEF`）：预览只看版式，不冒充真实景点内容。
  // 它的三支来源都记成 missing（演示数据不冒充查到过），照原样回会被 `guideBriefIsEmpty` 判成失败态，
  // 所以这里只把来源改成 text，让 ready 态的版式能看到。
  if (method === "POST" && path === "/v1/guide/brief") return ok({ status: "ready", brief: FIXTURE_BRIEF, cached: true });
  if (method === "GET" && path.startsWith("/v1/billing")) {
    const range = new URLSearchParams(path.split("?")[1] ?? "").get("range") ?? "today";
    return ok(fixtureBilling(range === "7d" || range === "30d" ? range : "today"));
  }
  return { status: 202, body: "" };
}
