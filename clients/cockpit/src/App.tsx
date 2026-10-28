/**
 * 车机端应用外壳
 *
 * 职责：消费数据源 → 驱动 HUD；承载轮播与助手交互；弱网降级；
 * 会话引导与跨重启复用、桥接事件单点订阅（消息/状态/连接）、
 * HUD ⇄ 对话层切换（HUD 保持挂载，切层不丢上下文）。
 * 约束：HUD 内不出现任何有后果的动作，点击助手只进入对话层（Brief §7-6）；
 * HUD 层无文字输入框（US-01 AC-01-1）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  SPRITES,
  TopBar,
  GuideScreen,
  GuideJobsPanel,
  GUIDE_JOBS_POLL_MS,
  applyGuideFetchOptimistic,
  outstandingGuideJobs,
  readyGuideSpots,
  shouldPollGuideJobs,
  useAssistantInteraction,
  useBranchFaults,
  useCarousel,
  useMapViewport,
  useToolProgress,
  tripActiveFor,
  type GuideScreenState,
  type NavView,
  type ThemeName,
  type LiveEnergy,
  vehicleCharacter,
  type EnRouteEvent,
  type ReminderDensity,
  selectedServicePois,
  type ServiceCategoryKey,
} from "@cabinhug/ui";

import { guideBriefIsEmpty,
  type AttachmentRef,
} from "@cabinhug/shared";
import type {
  AssistantState,
  ChatMessage,
  GuideBriefResponse,
  GuideJobsResponse,
  GuideJobsStatus,
  PermissionRequest,
} from "@cabinhug/shared";
import { ACCOUNT_EVENTS, SESSION_EXPIRED } from "@cabinhug/shared";

import { HudScreen, type HudTripMapProps } from "./hud/HudScreen";
import type { NavTripProgress } from "@cabinhug/ui";
import {
  createGatewayHudSource,
  createMockHudSource,
  invokeFetchEnergy,
  invokeFetchTripPlan,
  makeSnapshot,
  type GatewayHudSource,
  MOCK_HOME,
  type HomePlace,
} from "./data/mockSource";
import {
  highlightsPage,
  tripPlanNavDay,
  tripPlanStops,
  validateHudSnapshot,
  type HudSnapshot,
  WEATHER_KINDS,
  WEATHER_LABELS,
  type WeatherKind,
} from "./data/types";
import type { TripPlanSnapshot } from "@cabinhug/shared";
import { DEMO_TRIP_PLAN, withDemoNav } from "./data/demoTripPlan";
import { DEMO_PERMISSION, isHitlDemo } from "./data/demoPermission";
// 演示数据住在共享包（两端共用一份，见各自文件头）。
import {
  DEMO_DIALOG_MESSAGES,
  DEMO_DIALOG_SESSIONS,
  DEMO_DIALOG_STREAMING,
  DEMO_GUIDE_BRIEF,
  isDialogDemo,
  isGuideDemo,
} from "@cabinhug/ui";
import { createTauriReminderSpeaker } from "./features/trip/en-route-speak";
import { densityFromRust, EN_ROUTE_EVENTS } from "./features/trip/en-route-prefs";
import { listen } from "@tauri-apps/api/event";
import { devFetch } from "./devAuth";
import { createVoicePort, isTauriEnv } from "./voice/tauriVoicePort";
import { subscribeBridge } from "./bridge";
// 对话层、会话列表与会话生命周期判据在 @cabinhug/ui（两端共用一份）。
import {
  DialogScreen,
  assistantMode,
  canRetire,
  sessionResumable,
  type SessionBrief,
  type StreamingTurn,
} from "@cabinhug/ui";
import { OwnershipScreen } from "./features/ownership/OwnershipScreen";
import { DriveTransition } from "./features/nav/DriveTransition";
import { loadVehicles } from "./features/ownership/api";
// 实时能量与到站播报判据在 @cabinhug/ui（两端共用）。
import {
  DEMO_TRIP_ENTRIES,
  TripReviewSheet,
  createArrivalAnnouncer,
  createReviewAnnouncer,
  demoEnergy,
  hudAlertFrom,
  hudSourceFailure,
  startEnergyPolling,
  type EnergyPoller,
  type HudSourceFailure,
  type TopBarLink,
} from "@cabinhug/ui";
import { createAnnounceStore } from "./features/trip/announce-prefs";
import { ConfirmSheet } from "./features/hitl/ConfirmSheet";
// 样式在入口引：组件文件不 import css，node 的测试跑器加载不了它。
import { invokeAckTripReview } from "./data/mockSource";
import { adjustStructurePrompt } from "@cabinhug/shared";
import type { TripPlanListEntry, TripStructureEdit } from "@cabinhug/shared";
import { SettingsSheet } from "./features/settings/SettingsSheet";
import { SettingsScreen } from "./features/settings/SettingsScreen";
import { demoTheme, isProfileDemo } from "./data/demoVehicleProfile";
import { planBootstrap } from "./data/bootstrapSession";
import { createInflight, INFLIGHT_BOOTSTRAP, INFLIGHT_NEW_SESSION } from "./data/inflight";

/**
 * 建会话的在飞闸。放在模块级而不是 `useRef`：除 StrictMode 的两次 effect 外，
 * 还能挡住 App 整体重新挂载的情况，代价只是一个 Map。
 * 判据见 `data/inflight.ts` 的模块注释。
 */
const sessionInflight = createInflight();

/** 跨重启复用会话（Demo 脚本第 5 步"重启后历史仍在"的前提）。 */
const SESSION_STORAGE_KEY = "cabinhug.sessionId";
/** 与 id 成对保存的本地创建时间；用于区分新建空会话与旧的空会话。 */
const SESSION_META_KEY = "cabinhug.sessionMeta";

function rememberSession(sessionId: string, createdAt = Date.now()): void {
  localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  if (Number.isFinite(createdAt)) {
    localStorage.setItem(SESSION_META_KEY, JSON.stringify({ sessionId, createdAt }));
  } else {
    localStorage.removeItem(SESSION_META_KEY);
  }
}

function storedSessionCreatedAt(sessionId: string): number | undefined {
  const raw = localStorage.getItem(SESSION_META_KEY);
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const meta = parsed as { sessionId?: unknown; createdAt?: unknown };
    if (meta.sessionId !== sessionId || typeof meta.createdAt !== "number") return undefined;
    return Number.isFinite(meta.createdAt) ? meta.createdAt : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 演示车速的候选档。三档循环；×1 放在最后，保留真实节奏但不作默认。
 * 不做输入框：车机上不便输入数字。
 */
const NAV_SPEEDUPS: number[] = [60, 120, 1];

/**
 * 车机端主界面。
 *
 * `declaredSessionId`：上车声明（`BoardingGate`）刚建出的会话。
 * 车机持车辆级 token，`POST /v1/session` 要求显式声明谁在用，
 * 所以车机上唯一能建出会话的入口是上车声明；第一句话要用的 sid 由它交过来。
 * 个人身份 / 浏览器环境下为 undefined。
 *
 * `onNeedBoarding`：车机上建会话被服务端判为"没声明谁在用"时回调，
 * 由外层重新挂出上车声明。不静默失败，否则车主说话后没有任何反应。
 */

/** 本地日期串（年-月-日），点火播报「同一天最多一次」的口径——车主看的是车机的钟。 */
function localDayKey(now = new Date()): string {
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${mm}-${dd}`;
}

export function App({
  declaredSessionId,
  onNeedBoarding,
}: {
  declaredSessionId?: string;
  onNeedBoarding?: () => void;
} = {}) {
  // 初始主题可由 ?theme=dark 指定（截图脚本用，见 demoVehicleProfile.ts）。
  const [theme, setTheme] = useState<ThemeName>(demoTheme() ?? "light");

  /*
   * 主题同时写到文档根。
   *
   * 盖在 App 层的覆盖层（HITL 确认弹层）是 `.hud-viewport` 的兄弟节点，
   * 只挂在 viewport 上时取不到深色 token。挂在根上，任何在 HUD 之外渲染的层
   * 都能拿到同一套 token。
   */
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const [weather, setWeather] = useState<WeatherKind>("sunny");
  const [snapshot, setSnapshot] = useState<HudSnapshot | null>(null);
  /*
   * 当前这辆车。HUD 右下角的能量读数按它取。
   *
   * 真相源在档案页（`OwnershipScreen` 的 `activeVin`，默认取列表首位＝默认车），
   * 但 HUD 在没进过档案页时也要有能量读数，所以 App 自己解析一次默认车，
   * 之后由档案页的切换回调覆盖。两处写同一个 state，不各存一份。
   */
  const [activeVin, setActiveVin] = useState<string | null>(null);
  /*
   * 过场动画里开的是这辆车的形象，所以要跟着 vin 一起记车型
   * （`vehicleCharacter` 的键是 `Vehicle.model`）。记不到就画中性剪影。
   */
  const [activeModel, setActiveModel] = useState<string | undefined>(undefined);
  /*
   * 「开车去档案」过场。两个状态各管一件事：
   *  - `driving`：这一层在不在。进档案时置起，动画自己放完后落下；
   *  - `profileReady`：档案页的数据到了没有。它是过场从"一直开"转到"开走"的信号。
   * 从任何页面切进档案都放：过场是档案页的开场白。已在档案页时
   * 重复点档案不再开一趟，那不是"进入"。
   */
  const [driving, setDriving] = useState(false);
  const [profileReady, setProfileReady] = useState(false);
  const [liveEnergy, setLiveEnergy] = useState<LiveEnergy | undefined>(demoEnergy);
  const [stale, setStale] = useState(false);
  /*
   * 顶栏指示灯要区分「还没拿到过」与「拿到过但这次失败了」。
   *
   * `stale` 的初值 false 同时表示"开机头两秒"和"一切正常"，只凭它点灯时
   * 网关没起来的开机那几秒也是绿灯。所以另记"成功过没有"：绿灯的前提是
   * 真的收到过一份数据。
   */
  const [linkSeen, setLinkSeen] = useState(false);
  /*
   * 最近一次取数失败属于哪一类。
   *
   * 连不上（网络）与没身份（401：车机未做上车声明或声明为访客，车辆级凭证
   * 不代表任何人，个人域端点一律拒）的补救动作不同：前者重试，后者重新声明。
   * 所以两种失败分开记。
   */
  const [linkFail, setLinkFail] = useState<HudSourceFailure | null>(null);
  /** 顶栏刷新按钮这一轮还在路上。 */
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  // ⑥用车流水的采集开关与最近一次上报结果（仅 Tauri 内有效）
  const [tripCollect, setTripCollect] = useState(true);
  const [tripNote, setTripNote] = useState("");
  /*
   * `?profile=demo` 直接落在档案页并隐藏 devbar。
   * 它是版式截图入口：`scripts/assets/ui-diff.py` 要拿一张与定稿同尺寸、
   * 且不含验收开关的图去比。真实运行不带 query，行为不变。
   */
  const profileDemo = isProfileDemo();
  /* `?hitl=demo`：直接弹确认层并隐藏 devbar，同款版式截图入口（见 demoPermission.ts）。 */
  const hitlDemo = isHitlDemo();
  const [nav, setNav] = useState<NavView>(profileDemo ? "profile" : isDialogDemo() ? "dialog" : "hud");
  /*
   * devbar 默认收起（只留一个「功能演示」圆钮）。
   * 展开时它会盖住 HUD 顶部的时间轴与天气。
   */
  const [devbarOpen, setDevbarOpen] = useState(false);

  // ── 真实地图行程模式 ────────────────────────────────
  // fetchedPlan 来自数据源；demoPlan 是 devbar 的演示开关（浏览器里唯一的演示路径）。
  const [fetchedPlan, setFetchedPlan] = useState<TripPlanSnapshot | null>(null);
  /*
   * 右上角行程列表：活动行程 + 每程最新核查，与行程同一次轮询回来。
   * `selectedPlanId` 只在端上记（不落库、不改服务端「当前行程」）；`reviewPlanId` 是打开着摘要的那程。
   */
  const [fetchedEntries, setFetchedEntries] = useState<TripPlanListEntry[]>([]);
  const [currentPlanId, setCurrentPlanId] = useState<string | undefined>(undefined);
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  /** 胶囊上的工具菜单是否展开。 */
  const [detailMenuOpen, setDetailMenuOpen] = useState(false);
  /** 行程详情抽屉：开没开、看的是第几天。两者都只在端上记，不落库。 */
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailDay, setDetailDay] = useState(1);
  /**
   * 沿途服务里选中了哪几类。只在端上记、不落库，与 `detailOpen` / `detailDay`
   * 一致；抽屉一关就清空，下次打开是干净的一屏。
   *
   * 住在页面层是因为它要同时喂给两个兄弟组件：抽屉那一排格子（选中态）与地图那一层标记。
   */
  const [selectedServices, setSelectedServices] = useState<ServiceCategoryKey[]>([]);
  /**
   * 编辑态与变更集。放在这里而不是抽屉里：关抽屉、换一程、切页面
   * 都要先问一句"有没有没保存的改动"，那几处只有页面层管得着。
   */
  const [detailEditing, setDetailEditing] = useState(false);
  const [detailEdits, setDetailEdits] = useState<TripStructureEdit[]>([]);
  const [detailConfirmDiscard, setDetailConfirmDiscard] = useState(false);
  const [reviewPlanId, setReviewPlanId] = useState<string | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  /** 演示条目里点过「知道了」的（演示数据是静态的，得自己记）。 */
  const [demoAcked, setDemoAcked] = useState<ReadonlySet<string>>(() => new Set());
  /** 行驶中点了带点的那程：不弹，留一句话。 */
  const [tripHint, setTripHint] = useState<string | undefined>(undefined);
  /*
   * 最近一次长按没录成的原因，显示在助手卡上。
   *
   * 失败原因来自两处：Rust 侧 emit 的 `voice:capture` failed 事件与 invoke 的 reject。
   * 录成一次就清掉：它描述的是上一次长按，不是长期状态。
   */
  const [captureFault, setCaptureFault] = useState<string | undefined>(undefined);
  /*
   * 车主常住地：没有行程时 HUD 的地图落点，与行程同一次轮询回来。
   * 浏览器（无 Tauri invoke）没有那一路，用 mock 值，否则浏览器里看不到这一层。
   */
  const [home, setHome] = useState<HomePlace | undefined>(
    isTauriEnv() ? undefined : MOCK_HOME,
  );
  /*
   * `?trip=demo`：一进来就开着行程演示，给截图脚本 / 无头浏览器用，
   * 与 `?profile=demo` 同一类（这两种场景点不到 devbar）。真实运行不带 query，行为不变。
   */
  const [demoPlan, setDemoPlan] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("trip") === "demo",
  );
  const [dayMode, setDayMode] = useState<"all" | number>("all");
  const [amapFailed, setAmapFailed] = useState(false);
  /*
   * 演示车速。默认 ×60：一段 40 分钟的市内车程约 40 秒走完，
   * 既能在演示时长内走完，又能看清车在走哪条路。
   * 接入真实定位后这个开关连同模拟源一起移除（二期）。
   */
  const [navSpeedup, setNavSpeedup] = useState(60);
  /** 跟车演示开关（浏览器环境用，见 withDemoNav）。 */
  const [demoNav, setDemoNav] = useState(false);
  /*
   * 网关设置页（ACR-004）。`firstRun` 只在"地址还没有任何来源"时为真，
   * 即 `source === "default"`（既没存过、env 也不在）：此时 iPad 上默认的
   * localhost 指向 iPad 自己，不引导就拿不到任何数据。
   * 桌面不弹：env 恒在，`source` 是 `env`，地址至少是通的。
   */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsFirstRun, setSettingsFirstRun] = useState(false);
  useEffect(() => {
    if (!isTauriEnv()) return;
    void invoke<{ platform: string; storedUrl: string | null; source: string }>(
      "get_gateway_settings",
    ).then((v) => {
      if (v.platform === "ios" && v.source === "default") {
        setSettingsFirstRun(true);
        setSettingsOpen(true);
      }
    }).catch(() => {
      // 旧版 Rust 侧没有这个命令（升级中间态）：不弹、不报——设置只是打不开
    });
  }, []);

  // 真实数据源：Tauri 内轮询网关的已确认行程；没有可展示的行程时
  // 源自己回落基线快照。浏览器 mock 环境维持原 mock 源。
  const source = useMemo(
    () =>
      isTauriEnv()
        ? createGatewayHudSource({
            base: () => makeSnapshot(weather),
            fetchPlanJson: invokeFetchTripPlan,
            onPlan: setFetchedPlan,
            onHome: setHome,
            onPlans: (entries, current) => {
              setFetchedEntries(entries);
              setCurrentPlanId(current);
              // 点火播报：每轮列表都喂进去，闸门（一份一次 / 一天一次 / 开关 / 行驶中）在 announcer 里。
              reviewAnnouncerRef.current?.consider(entries, {
                today: localDayKey(),
                driving: drivingRef.current,
              });
            },
          })
        : createMockHudSource(weather),
    [weather],
  );

  /*
   * 给 appendMessage 用的引用通道。appendMessage 的身份变化会重跑整段
   * bootstrap（见它的依赖注释），所以 source 不能进它的依赖，
   * 而 source 挂在 weather 上，天气一变就是一个新对象。
   */
  const sourceRef = useRef(source);
  useEffect(() => {
    sourceRef.current = source;
  }, [source]);

  useEffect(() => {
    return source.subscribe(
      (s) => {
        const problems = validateHudSnapshot(s);
        if (problems.length) console.warn("HUD 快照不满足 Brief 约束:", problems);
        setSnapshot(s);
        setStale(false);
        setLinkFail(null);
        setLinkSeen(true);
      },
      (err) => {
        const kind = hudSourceFailure(err);
        setLinkFail(kind);
        /*
         * 只有连不上才算 stale。401 时服务正常，状态栏那四格写「暂无」而不是
         * 「服务暂不可用」；原因由顶栏指示灯说明（它带补救动作）。
         */
        setStale(kind === "unreachable");
      },
    );
  }, [source]);

  /*
   * 默认车解析。只在 Tauri 里做：浏览器环境没有网关那一路，
   * 硬拉只会把环境限制显示成"车机读不到"。
   */
  useEffect(() => {
    if (!isTauriEnv()) return;
    let alive = true;
    void loadVehicles().then((r) => {
      // 列表首位是默认车（服务端排序），与档案页的初值口径一致。
      if (alive && r.kind === "ready" && r.vehicles[0]) {
        setActiveVin(r.vehicles[0].vin);
        setActiveModel(r.vehicles[0].model);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  /* 能量轮询：换车即重起一路，旧的立刻停——否则切完车还会收到上一辆的读数。 */
  const energyPollerRef = useRef<EnergyPoller | null>(null);
  useEffect(() => {
    if (!isTauriEnv()) return;
    const poller = startEnergyPolling(activeVin, setLiveEnergy, { fetchEnergyJson: invokeFetchEnergy });
    energyPollerRef.current = poller;
    return () => {
      poller.stop();
      // 只清自己：换车时新的那一路已经写进来了，无条件置 null 会把它抹掉。
      if (energyPollerRef.current === poller) energyPollerRef.current = null;
    };
  }, [activeVin]);

  // 首帧到达前使用同源的默认快照，避免空白页（Brief §6）
  const effective = snapshot ?? makeSnapshot(weather);
  const withEnergy: HudSnapshot =
    liveEnergy === undefined ? effective : { ...effective, energy: { ...effective.energy, live: liveEnergy } };
  const fresh: HudSnapshot = stale
    ? { ...withEnergy, freshness: { stale: true, updatedAt: withEnergy.freshness.updatedAt } }
    : withEnergy;

  /*
   * 目的地推荐页（浏览器环境补位）。
   *
   * 真实链路：网关带回 `destinationHighlights`，
   * `createGatewayHudSource` 经 `tripPlanToHud` 把它投影成第二页。
   * 浏览器里 HUD 快照来自 mock 源，不经 `tripPlanToHud`，这一页不会出现；
   * 这里补上，只在 devbar「行程演示」开着时生效。
   *
   * 造页走 shared 的 `highlightsPage()` 而不是自己拼对象：
   * "三段全空不造页"只有一份实现。
   */
  const demoHighlightsPage = useMemo(
    () => (demoPlan ? highlightsPage(DEMO_TRIP_PLAN.destinationHighlights) : undefined),
    [demoPlan],
  );
  const view: HudSnapshot = {
    ...(demoHighlightsPage
      ? { ...fresh, tips: { ...fresh.tips, pages: [...fresh.tips.pages, demoHighlightsPage] } }
      : fresh),
    // 同一条缝：出发段（状态栏三格）真实链路由网关带回、经 tripPlanToHud 投影；浏览器演示态在这里补上。
    ...(demoPlan && DEMO_TRIP_PLAN.leg ? { leg: DEMO_TRIP_PLAN.leg } : {}),
  };

  // 真实地图报废（无 key/离线）→ 回落装饰概览。memo 化：内联箭头函数会被
  // 地图层当成"配置变了"而重建，导致白屏（见 AmapTripLayer 的注释）。
  const onTripMapFallback = useCallback(() => setAmapFailed(true), []);

  /*
   * 跟车演示的 nav 只挂一次（useMemo）：每次渲染新造一份会让 startedAt 一直往前跑，
   * navKey 跟着变，跟车于是每帧从头起跑——车标钉在起点一动不动。
   */
  const demoNavPlan = useMemo(() => withDemoNav(DEMO_TRIP_PLAN, 2), [demoNav]);
  const plan = demoPlan ? (demoNav ? demoNavPlan : DEMO_TRIP_PLAN) : fetchedPlan;

  /*
   * ── 跟车模式 ───────────────────────────────────────
   *
   * 判据在 `@cabinhug/shared`（`tripPlanNavDay`），端上不自己判：
   * 「还算不算在导航」牵涉过期规则（跨天作废），两处各写一份会漂移成
   * "车机说在导航、服务端说没有"。
   *
   * 演示倍速经 devbar 开关；大于 1 时顶栏恒显角标（HudScreen 的 NavBar 保证）。
   */
  const navDay = plan ? tripPlanNavDay(plan, new Date().toISOString()) : undefined;
  /** 点火播报要在 source 的回调里读到最新的 announcer 与"是否在跟车"——两者都经 ref（source 挂在 weather 上，不能进它的依赖）。 */
  const reviewAnnouncerRef = useRef<ReturnType<typeof createReviewAnnouncer> | null>(null);
  const drivingRef = useRef(false);

  /*
   * 列表条目：真实数据来自轮询；浏览器「行程演示」用固定三程（浏览器里查看列表卡与
   * 摘要弹层的唯一路径）。演示条目点过「知道了」的在本地打上 ackedAt。
   */
  const tripEntries: TripPlanListEntry[] = useMemo(() => {
    if (!demoPlan) return fetchedEntries;
    return DEMO_TRIP_ENTRIES.map((e) =>
      e.review && demoAcked.has(e.review.reviewId)
        ? { ...e, review: { ...e.review, ackedAt: new Date().toISOString() } }
        : e,
    );
  }, [demoPlan, fetchedEntries, demoAcked]);
  /**
   * 选中的那程。不回落到当前行程：有选中才是选中态；演示态也从未选中开始，
   * 否则周日历卡不会出现。`currentPlanId` 只用于排障，不参与高亮。
   */
  const highlightedPlanId =
    selectedPlanId && tripEntries.some((e) => e.planId === selectedPlanId) ? selectedPlanId : undefined;
  void currentPlanId;
  /*
   * 行程模式判定（判据在 `@cabinhug/ui` 的 `tripActiveFor`，与手机端同一份）：
   * 确认过、这一程该上地图、有真实坐标、且真实地图没有报废——缺一样都回落装饰概览。
   * 排在 `highlightedPlanId` 之后是因为它要知道"这一程是不是车主自己点开的"：
   * 点开的那程即使已经走完也照画。
   */
  const tripActive = tripActiveFor({
    plan,
    amapFailed,
    today: new Date().toISOString().slice(0, 10),
    selected: highlightedPlanId !== undefined,
  });
  const reviewEntry = reviewPlanId ? tripEntries.find((e) => e.planId === reviewPlanId) : undefined;
  /** 暖暖 alert：critical 且未确认、未作废（AC-01-4，「知道了」即清除）。 */
  const hudAlert = hudAlertFrom(tripEntries);
  drivingRef.current = navDay !== undefined;

  const onSelectTrip = useCallback(
    (planId: string) => {
      setSelectedPlanId(planId);
      // 菜单与抽屉都是"对这一程"的：换了一程还开着，看的、点的就都是另一程了。
      setDetailMenuOpen(false);
      setDetailOpen(false);
      setDetailEditing(false);
      setDetailEdits([]);
      if ("select" in source) (source as GatewayHudSource).select(planId);
    },
    [source],
  );
  /** 顶部日期条的 ×：回未选中态——周日历卡回来、提示卡收起、地图回到列表首条。 */
  const onClearTripSelection = useCallback(() => {
    setSelectedPlanId(null);
    setDetailMenuOpen(false);
    setDetailOpen(false);
    setDetailEditing(false);
    setDetailEdits([]);
    if ("select" in source) (source as GatewayHudSource).select(null);
  }, [source]);
  /**
   * 胶囊上的工具菜单。状态在这里而不是组件里：抽屉、"换了一程"、"切走页面"
   * 都要能把它收起来，藏在组件内部这几处就够不着。
   */
  const onToggleDetailMenu = useCallback(() => setDetailMenuOpen((v) => !v), []);
  /**
   * 打开抽屉。默认看第几天：跟车中看当前导航天（车主此刻关心的就是它），
   * 否则第 1 天。`navDay` 在这一行之前已经算好。
   */
  const onOpenDetail = useCallback(() => {
    setDetailMenuOpen(false);
    setDetailDay(navDay ?? 1);
    setDetailEditing(false);
    setDetailEdits([]);
    setSelectedServices([]);
    setDetailOpen(true);
  }, [navDay]);
  const onCloseDetail = useCallback(() => {
    setSelectedServices([]);
    setDetailOpen(false);
  }, []);
  /** 点一格就取反：可多选，再点一次取消。 */
  const onToggleService = useCallback((key: ServiceCategoryKey) => {
    setSelectedServices((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  }, []);
  /** 退出编辑态并丢掉变更集。关抽屉、取消、放弃三处共用。 */
  const dropDetailEdits = useCallback(() => {
    setDetailEditing(false);
    setDetailEdits([]);
    setDetailConfirmDiscard(false);
  }, []);
  /**
   * 想关抽屉：有未保存的变更就先弹确认，没有就直接关。
   * 不静默丢弃未保存的改动。
   */
  const onRequestCloseDetail = useCallback(() => {
    if (detailEditing && detailEdits.length > 0) {
      setDetailConfirmDiscard(true);
      return;
    }
    dropDetailEdits();
    setSelectedServices([]);
    setDetailOpen(false);
  }, [detailEditing, detailEdits.length, dropDetailEdits]);
  const onConfirmDiscardDetail = useCallback(() => {
    dropDetailEdits();
    setSelectedServices([]);
    setDetailOpen(false);
  }, [dropDetailEdits]);
  const onOpenTripReview = useCallback(
    (planId: string) => {
      if (navDay !== undefined) {
        // 行驶中不弹模态（Brief §2 / F-19-07）：留一句话，停车再看。
        setTripHint("停车后再看行程变化");
        window.setTimeout(() => setTripHint(undefined), 4000);
        return;
      }
      setReviewPlanId(planId);
    },
    [navDay],
  );

  /*
   * 跟车时只看当天那一段。
   *
   * 不收窄的话，车会沿着整程路线跑，包括别的天的酒店与景点。
   */
  const viewDay = navDay ?? (dayMode === "all" ? undefined : dayMode);

  // stops 同样要稳定引用：每次渲染换新数组会让覆盖物每帧重建、路线动画不停重启。
  const tripStops = useMemo(
    () => (plan ? tripPlanStops(plan, viewDay) : []),
    [plan, viewDay],
  );

  /*
   * 「结束导航」走同一条语音链路而不是直接调工具：
   * 按钮与说「结束导航」落到同一处处置，图状态也能知道按钮按过。
   *
   * 经 ref 取 `sendText`：它声明在下文，而这里要早于它算出 tripMap。
   * 按钮点下去时 ref 已在同一次渲染末尾赋值。
   */
  const sendTextRef = useRef<((content: string) => Promise<void>) | null>(null);
  const onNavEnd = useCallback(() => {
    if (isTauriEnv()) void sendTextRef.current?.("结束导航");
  }, []);

  /*
   * 到站播报：把到站事件发上去，由助手回一句，车机既有的 TTS 链路负责念
   * （TTS 在 Rust 侧、挂在"助手回了一句话"上）。
   * 去重与在飞防叠的判据在 `@cabinhug/ui` 的 `createArrivalAnnouncer`（两端共用、有单测）。
   */
  /*
   * 点火播报（F-19-07）：主页拿到行程列表后，critical 且没看过的核查让暖暖主动说一句。
   * 判据与三道闸在 `@cabinhug/ui` 的 `createReviewAnnouncer`（有单测）；存储在端上（`announce-prefs.ts`）。
   * 只在 Tauri 里发，浏览器环境没有会话。
   */
  const reviewAnnouncer = useMemo(
    () =>
      createReviewAnnouncer(
        (note) => (isTauriEnv() ? (sendTextRef.current?.(note) ?? Promise.resolve()) : Promise.resolve()),
        createAnnounceStore(),
      ),
    [],
  );
  reviewAnnouncerRef.current = reviewAnnouncer;
  const announcer = useMemo(
    () => createArrivalAnnouncer((note) => sendTextRef.current?.(note) ?? Promise.resolve()),
    [],
  );
  /*
   * 途中提醒：出声走端上 speak_reminder，不进会话；连续驾驶卡在场时暖暖进 alert 态。
   */
  const speakReminder = useMemo(() => createTauriReminderSpeaker(invoke, isTauriEnv), []);
  const [restAlert, setRestAlert] = useState(false);
  const reminderIsInFlight = useCallback(() => announcer.isInFlight(), [announcer]);
  /*
   * 途中提醒的偏好与口令：真相源在 Rust。启动问一次，之后只听三个事件——
   * 设置页拨的、语音拨的都经 Rust 的唯一落点广播回来，这里不自己维护第二份。
   */
  const [enRoutePrefs, setEnRoutePrefs] = useState<{ enabled: boolean; density: ReminderDensity }>({ enabled: true, density: "normal" });
  const [hushSignal, setHushSignal] = useState(0);
  useEffect(() => {
    if (!isTauriEnv()) return;
    void invoke<boolean>("get_en_route_reminders")
      .then((enabled) => setEnRoutePrefs((p) => ({ ...p, enabled })))
      .catch(() => {});
    void invoke<string>("get_en_route_density")
      .then((d) => setEnRoutePrefs((p) => ({ ...p, density: densityFromRust(d) })))
      .catch(() => {});
    let stops: Array<() => void> = [];
    let disposed = false;
    void Promise.all([
      listen<boolean>(EN_ROUTE_EVENTS.enabled, (e) => setEnRoutePrefs((p) => ({ ...p, enabled: e.payload }))),
      listen<string>(EN_ROUTE_EVENTS.density, (e) => setEnRoutePrefs((p) => ({ ...p, density: densityFromRust(e.payload) }))),
      listen(EN_ROUTE_EVENTS.hushed, () => setHushSignal((n) => n + 1)),
    ])
      .then((us) => {
        if (disposed) us.forEach((u) => u());
        else stops = us;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      stops.forEach((u) => u());
    };
  }, []);
  /*
   * 账号级事件 → 重拉会话列表（ACR-032）。
   *
   * 跨端同步的唯一消费点：Rust 侧收到 `/v1/events` 的 `sessions_changed`
   * 就发这个事件，前端整拉一次列表。
   *
   * 回看态下照样重拉：列表与「正在看哪一段」是两件事，不刷新会让别的端
   * 新建的会话不出现在左栏。整拉而不是插入单条：通道语义是整拉，端上增量会引入乱序。
   */
  useEffect(() => {
    if (!isTauriEnv()) return;
    let stop: (() => void) | undefined;
    let disposed = false;
    void listen<{ reason: string }>(ACCOUNT_EVENTS.sessionsChanged, (e) => {
      console.info(`[session] 别处改了会话列表（${e.payload.reason}），重拉一次`);
      void loadSessionsRef.current?.(true);
    })
      .then((un) => {
        if (disposed) un();
        else stop = un;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  /** 端侧判定日志（F-62-14）：进 Rust 的有界缓冲，不上报；浏览器环境不记。 */
  const logEnRoute = useCallback((e: EnRouteEvent) => {
    if (!isTauriEnv()) return;
    void invoke("log_en_route_event", { name: e.type, detail: JSON.stringify(e) }).catch(() => {});
  }, []);
  const onNavProgress = useCallback(
    (p: NavTripProgress) => {
      if (!isTauriEnv()) return;
      announcer.onProgress(p);
    },
    [announcer],
  );

  /*
   * ── 景区导览页 ─────────────────────────────────────
   *
   * 点击地图上的景点标记 → 全屏导览页（覆盖层，HUD 保持挂载）。
   * 冷启是三分支采集（最坏 90s 量级），所以先出"采集中"态；
   * 返回后迟到的结果按序号丢弃，避免旧请求的数据盖上新页面。
   */
  const [guide, setGuide] = useState<{ spot: string; state: GuideScreenState } | null>(() =>
    // `?guide=demo`：直接落在 ready 态——版式截图入口，见 @cabinhug/ui 的 demo-guide-brief.ts。
    isGuideDemo() ? { spot: DEMO_GUIDE_BRIEF.spot, state: { status: "ready", brief: DEMO_GUIDE_BRIEF } } : null,
  );
  const guideSeqRef = useRef(0);
  const openGuide = useCallback(
    (spotName: string, opts?: { force?: boolean }) => {
      const seq = ++guideSeqRef.current;
      setGuide({ spot: spotName, state: { status: "collecting" } });
      const body = {
        spotName,
        // 行程上下文顺手带上：目的地当城市线索、出发日进提示词（缺了也能查）。
        ...(plan?.destination ? { city: plan.destination } : {}),
        ...(plan?.startDate ? { date: plan.startDate } : {}),
        selfDrive: true,
        // 「重新采集」：跳过服务端持久层（简报只采一次）。
        ...(opts?.force ? { force: true } : {}),
      };
      const request = async (): Promise<GuideBriefResponse> => {
        if (isTauriEnv()) {
          // 网络在 Rust（§2.2 C2）：invoke 原样 JSON 往返，契约在 shared。
          return JSON.parse(
            await invoke<string>("get_guide_brief", { bodyJson: JSON.stringify(body) }),
          ) as GuideBriefResponse;
        }
        /*
         * 浏览器形态（vite 直开 1430，无 Rust 桥）：走 vite 的 /v1 代理到本机网关。
         * 只在 dev 存在，release 客户端恒为 Tauri 环境。
         *
         * 鉴权见 `devAuth`：使用者自己贴一枚真 token。网关不接受硬编码的演示 token，
         * 用它会恒 401，界面上"采集失败"与"这个景点确实采不到"无法区分。
         */
        const r = await devFetch("/v1/guide/brief", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) return { status: "failed" };
        return (await r.json()) as GuideBriefResponse;
      };
      void request()
        .catch(() => ({ status: "failed" }) as GuideBriefResponse)
        .then((resp) => {
          if (guideSeqRef.current !== seq) return; // 已返回/重开，迟到结果作废
          setGuide((cur) =>
            cur && cur.spot === spotName
              ? {
                  spot: spotName,
                  state:
                    // 三支全空的"ready"按 failed 呈现（有重试钮），空栏目页不诚实。
                    resp.status === "ready" && resp.brief && !guideBriefIsEmpty(resp.brief)
                      ? { status: "ready", brief: resp.brief, cached: resp.cached }
                      : { status: "failed" },
                }
              : cur,
          );
        });
    },
    [plan],
  );
  const closeGuide = useCallback(() => {
    guideSeqRef.current += 1; // 在途请求作废
    setGuide(null);
  }, []);

  /*
   * ── 导览采集进度面板（数据面 ACR-008）──────────────
   *
   * 面板以 `/v1/guide/jobs` 为唯一真相源（服务端按鉴权身份取当前行程），
   * 不依赖 HUD 地图上摆的是哪份行程：演示开关下地图可能是 demo 行程，
   * 而进度对的是库里真实确认的那份，两者对不上时以真实为准。
   * 节流与乐观规则是共享纯逻辑（clients/shared/ui jobs-logic，两端一致）。
   */
  const [guideJobs, setGuideJobs] = useState<GuideJobsStatus | null>(null);
  const guideJobsBusyRef = useRef(false);
  const refreshGuideJobs = useCallback(async () => {
    if (guideJobsBusyRef.current) return; // 上一发未归不叠发
    guideJobsBusyRef.current = true;
    try {
      const raw = isTauriEnv()
        ? await invoke<string>("get_guide_jobs")
        : await (
            await devFetch("/v1/guide/jobs")
          ).text();
      const parsed = JSON.parse(raw) as GuideJobsResponse;
      setGuideJobs(parsed.jobs ?? null);
    } catch {
      // 轮询面不出声：拿不到保持上一份——进度卡短暂陈旧比弹错误卡好
    } finally {
      guideJobsBusyRef.current = false;
    }
  }, []);
  // 首拉：进 HUD / 关导览页时刷一次
  useEffect(() => {
    if (nav !== "hud" || guide) return;
    void refreshGuideJobs();
  }, [nav, guide, refreshGuideJobs]);
  // 节流轮询：只在 HUD 可见、导览页关着、且有在途任务时 10s 一轮（总览约束 1）
  useEffect(() => {
    if (nav !== "hud" || guide || !shouldPollGuideJobs(guideJobs)) return;
    const t = setInterval(() => void refreshGuideJobs(), GUIDE_JOBS_POLL_MS);
    return () => clearInterval(t);
  }, [nav, guide, guideJobs, refreshGuideJobs]);

  /*
   * ── 顶栏刷新按钮 ─────────────────────────
   *
   * 主页数据是三路各自轮询的，节奏与失败语义不同（行程 60s、能量 15s、
   * 导览任务 10s 且只在有在途任务时）。等各自下一拍最坏要一分钟，
   * 所以"重新请求"把三路一起触发一遍。
   *
   * # 刷新改数据，不改操作
   *
   * 选中的那一程要保留。这里不碰任何 setState：
   *  - 选中的行程记在数据源闭包里（`gateway-source` 的 `selectedPlanId`），
   *    `pull()` 之后照原样重投影；那一程被改掉/取消了才回落首条；
   *  - 逐日页签 `dayMode`、当前页 `nav`、摘要弹层 `reviewPlanId`、演示开关全在
   *    别的 state 里，这个函数不读它们；
   *  - 不重新解析默认车：车主可能在档案页切过车，重解析会把车换回默认车。
   *    能量按现在这辆 vin 重读。
   *
   * # 带 pretrip 重算
   *
   * 这是它与 60 秒轮询唯一的语义差别：按下按钮等同于重新打开 App，
   * 所以带上按最新天气重算行前物品的 opt-in。
   */
  const refreshHome = useCallback(() => {
    if (refreshingRef.current) return; // 连点不叠发
    refreshingRef.current = true;
    setRefreshing(true);
    const tasks: Array<Promise<unknown>> = [refreshGuideJobs()];
    if ("refresh" in source) tasks.push((source as GatewayHudSource).refresh({ pretrip: true }));
    if (energyPollerRef.current) tasks.push(energyPollerRef.current.refresh());
    /*
     * 转圈的下限 450ms。本地网关常 30ms 就返回，图标只闪一下，
     * 而这颗按钮唯一的反馈就是它转没转。
     */
    tasks.push(new Promise((r) => setTimeout(r, 450)));
    void Promise.allSettled(tasks).then(() => {
      refreshingRef.current = false;
      setRefreshing(false);
    });
  }, [source, refreshGuideJobs]);

  /*
   * 指示灯取值，分支顺序：
   *  - 401 排最前，它是最具体的失败，且只有它有补救动作；
   *  - `stale` 次之，表示这一跳没连上，devbar 的开关也拨它；
   *  - 浏览器（无 Tauri）走 mock 源，永远"成功"，显式标为演示数据，不给绿灯。
   */
  const topBarLink: TopBarLink =
    linkFail === "unauthorized"
      ? "noidentity"
      : stale
        ? "offline"
        : !isTauriEnv()
          ? "demo"
          : linkSeen
            ? "online"
            : "connecting";
  /*
   * 灯的补救动作，只有未上车这一档有：重新挂出 `BoardingGate`，
   * 选择身份后 `create_session_as` 落地 → `acting::session()` 有值 →
   * 下一跳请求带上 `x-cabinhug-session` → 网关回查到人 → 绿灯。
   *
   * 刷新按钮对这一档无效：它重发的是同一个没有身份的请求。
   */
  const topBarLinkAction =
    topBarLink === "noidentity" && onNeedBoarding ? onNeedBoarding : undefined;
  /*
   * HUD 小卡只挂"还欠着的"：ready 的行采完即从卡上消失，全采完整张卡收掉。
   * 卡是待办条不是索引——已就绪的导览入口在地图景点标记上（onStopClick → openGuide），
   * 从卡上撤掉不等于没处进。summary 不动，进度头照旧是服务端账本的 x/N。
   */
  const guideJobsOutstanding = useMemo(
    () => (guideJobs ? outstandingGuideJobs(guideJobs) : null),
    [guideJobs],
  );
  /*
   * 索引的那一半：ready 的景点在地图胶囊上挂「✓ 导览」角标（AmapTripLayer.guidedSpots）。
   * 卡上撤掉了，标记上就得标出来——否则用户只能挨个点开试哪个有导览。
   * 与 guideJobs 同源（服务端账本），不另存一份"已看过"。
   */
  const guidedSpots = useMemo(() => readyGuideSpots(guideJobs), [guideJobs]);
  const fetchGuideSpot = useCallback(
    (spotName: string) => {
      // 乐观置 pending（按了要有反应，总览约束 2）；真相以响应后的刷新为准
      setGuideJobs((cur) => (cur ? applyGuideFetchOptimistic(cur, spotName) : cur));
      const req = async () => {
        if (isTauriEnv()) {
          await invoke<string>("trigger_guide_job", { bodyJson: JSON.stringify({ spotName }) });
        } else {
          await devFetch("/v1/guide/jobs/trigger", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ spotName }),
          });
        }
      };
      void req()
        .catch(() => {}) // 失败由下一拍刷新如实纠正（乐观态被真实态覆盖）
        .finally(() => void refreshGuideJobs());
    },
    [refreshGuideJobs],
  );

  // `plan &&` 是给类型收窄的（`tripActiveFor` 里已经判过 null，但判据搬进函数后 TS 看不见了）。
  const tripMap: HudTripMapProps | undefined = tripActive && plan
    ? {
        stops: tripStops,
        // 点击景点标记 → 导览页。AmapTripLayer 只对 kind=spot 回调。
        onStopClick: (stop) => openGuide(stop.name),
        // 导览已就绪的景点挂角标——点之前就知道哪些能看。
        guidedSpots,
        ...(navDay !== undefined
          ? {
              nav: {
                // 换一次导航（换天/重新出发）就重新起跑。
                key: `${plan.updatedTurnId}:${navDay}:${plan.nav?.startedAt ?? ""}`,
                speedup: navSpeedup,
                onProgress: onNavProgress,
                onEnd: onNavEnd,
              },
            }
          : {}),
        // 行程身份：确认/更新都会换轮次 id，换行程时地图收回镜头否决权重新取景。
        planKey: plan.updatedTurnId,
        /*
         * 抽屉开着时，地图跟着它选的那一天走：选中的天保持原样，
         * 别的天淡成灰色半透明（不是隐藏，整程的形状要还在）。
         * 抽屉一关就没有焦点天，地图回到全程原样。
         */
        focusDay: detailOpen ? detailDay : undefined,
        /*
         * 选中的那几类沿途服务点。筛选在 `selectedServicePois` 里做（纯函数、可测），
         * 地图只负责画。抽屉关着就是空数组，那一层跟着收起来。
         */
        servicePois: detailOpen ? selectedServicePois(plan, detailDay, selectedServices) : [],
        showDayBadge: viewDay === undefined,
        /*
         * 单日视图闭环：酒店 → 景点 → 回酒店（首日放行李/末日寄存的场景语义）。
         * 跟车时不闭环：车不会在到达最后一站之后自己开回酒店。
         */
        closeLoop: viewDay !== undefined && navDay === undefined,
        /*
         * 顶部逐日胶囊暂时隐藏：默认只看全程安排，
         * 每个站点自己带 Day N · 时刻。
         * 空数组 = 不渲染切换条（`tabs.length > 1` 才渲染），
         * 保留字段与 dayMode 状态以便重新开启。
         */
        tabs: [],
        active: dayMode,
        onSelect: setDayMode,
        onFallback: onTripMapFallback,
        // 住宿策略横幅：只有带 lodging 的天（换酒店日/到达日）出现。
        lodgingNotes: plan.skeleton
          .filter((d) => d.lodging)
          .map((d) => ({ day: d.day, strategy: d.lodging!.strategy, note: d.lodging!.note })),
      }
    : undefined;

  // ── 会话引导（复用或新建）+ 桥接事件单点订阅 ────────────────
  const sessionIdRef = useRef<string | null>(null);
  /**
   * 当前会话 id 的可渲染副本。
   *
   * `sessionIdRef` 是 ref，换会话不会触发重渲染，左侧列表的高亮靠它不会更新。
   * 两份不是冗余：ref 供回调里同步读（`sendText` 那些地方拿的必须是最新值），
   * state 供渲染。两处必须一起改，所以只在 `adoptCurrentSession` 里改。
   */
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);

  /**
   * 系统麦克风授权现状。null = 还没查到（非 Tauri 环境恒为 null）。
   * 不是 granted 时暖暖卡片挂文字说明，否则长按无反应时车主无从知道缺的是系统权限。
   */
  const [micPermission, setMicPermission] = useState<
    "granted" | "denied" | "undetermined" | null
  >(null);
  const refreshMicPermission = useCallback(async () => {
    if (!isTauriEnv()) return;
    try {
      const status = await invoke<string>("mic_permission_status");
      setMicPermission(status as "granted" | "denied" | "undetermined");
    } catch {
      /* 查不到不挂说明——别拿一个不确定的状态吓人 */
    }
  }, []);
  useEffect(() => {
    void refreshMicPermission();
  }, [refreshMicPermission]);
  const [serverAvatarState, setServerAvatarState] = useState<AssistantState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /*
   * 会话生命周期。
   *
   * `lastInteractionAt` 只驱动形象，正确性由服务端兜（过期的会话
   * `POST /messages` 直接 409）。所以这个时钟粗一点没关系：30 秒一跳，
   * 比每秒重渲染整屏 HUD 划算得多。
   */
  const [lastInteractionAt, setLastInteractionAt] = useState<number | undefined>(undefined);
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const [streaming, setStreaming] = useState<StreamingTurn | null>(null);
  /**
   * 工具进展（F-08-05）：填那十几秒空白。不进历史，
   * 它只是一个内存态，轮次收口时 reset。
   */
  const toolProgress = useToolProgress();
  // 分支失败的"部分结果"标识。与工具进展不同：不在本轮收口时清，
  // 横幅标注的是"这轮答案缺了什么"，要跟着答案一起被读；清理时机是下一轮开始，
  // 以及换会话（下面这个 effect）：别的会话的缺失不该挂在新会话头上。
  const branchFaults = useBranchFaults();
  useEffect(() => {
    branchFaults.reset();
  }, [currentSessionId, branchFaults.reset]);
  const [connection, setConnection] = useState<"online" | "reconnecting" | "unknown">("unknown");

  /*
   * 左侧会话历史，懒加载一次 20 条。
   *
   * 列表是服务端那份的投影：不在这里插入/删除会话，只在换会话时整页重拉。
   * 端上自己维护一份的话，"列表里没有"与"服务端没建成"无法区分。
   */
  const [sessions, setSessions] = useState<SessionBrief[]>([]);
  const [sessionsCursor, setSessionsCursor] = useState<string | null>(null);
  const [sessionsHasMore, setSessionsHasMore] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  /**
   * 正在回看的历史会话。`null` = 在看当前会话。
   *
   * 回看不碰会话所有权：不换 localStorage、不切 SSE 流、不动哨兵绑定。
   * 否则语音唤醒会指向一个已关闭的会话，服务端 409 而端上没有任何表示。
   */
  const [viewing, setViewing] = useState<{ sessionId: string; messages: ChatMessage[] } | null>(
    null,
  );

  /** 拉一页会话。`reset` 时从头拉并丢掉游标（换会话 / 首次进入）。 */
  const loadSessions = useCallback(
    async (reset: boolean) => {
      if (!isTauriEnv()) return;
      setSessionsLoading(true);
      setSessionsError(null);
      try {
        const cursor = reset ? null : sessionsCursor;
        const raw = await invoke<string>("list_sessions", {
          limit: 20,
          cursor: cursor ?? undefined,
        });
        const page = JSON.parse(raw) as {
          sessions: SessionBrief[];
          hasMore: boolean;
          nextCursor: string | null;
        };
        setSessions((prev) => {
          if (reset) return page.sessions;
          // 去重：`updatedAt` 游标遇上同毫秒的两条会话时，第二页会重发一条；
          // key 重复会让 React 整片报错，列表显示为空。
          const seen = new Set(prev.map((s) => s.sessionId));
          return [...prev, ...page.sessions.filter((s) => !seen.has(s.sessionId))];
        });
        setSessionsCursor(page.nextCursor);
        setSessionsHasMore(page.hasMore);
      } catch (err) {
        setSessionsError("会话历史读取失败");
        console.warn("[session] 会话列表拉取失败", err);
      } finally {
        setSessionsLoading(false);
      }
    },
    [sessionsCursor],
  );
  /*
   * 引导流程要用 `loadSessions`，但它的 deps 里有 `sessionsCursor`，
   * 直接进那个 effect 的依赖数组会让整段会话引导每翻一页就重跑一次
   * （重建会话、重起流）。所以用 ref 递最新的那一份。
   */
  const loadSessionsRef = useRef(loadSessions);
  useEffect(() => {
    loadSessionsRef.current = loadSessions;
  }, [loadSessions]);
  /**
   * 唤醒窗口截止时刻。0 = 没有唤醒态。派生进 `assistantMode`：
   * 喊一声「暖暖」形象就切到办公，哪怕消息还没落库；窗口过了自然消散。
   * Rust 侧窗口过期不发关闭事件（被动过期），所以这里存截止时刻而不是布尔：
   * 布尔会在错过关闭事件时卡在 true。
   */
  const [wakeUntil, setWakeUntil] = useState(0);
  /**
   * 语音最近一次把闲聊旁路拨到了哪一边（`SidecarSwitched`）。
   * 只喂给设置页显示，偏好本身在 Rust 侧已经改完了，这里不改任何行为。
   */
  const [sidecarOn, setSidecarOn] = useState<boolean | undefined>(undefined);
  /**
   * 哨兵指示快照：唯一来源是 Rust `voice:sentinel` 事件，
   * MicIndicator 不接受由页面推断出来的值。null = 事件还没来
   * （哨兵未启动/浏览器开发态），此时不渲染指示。
   */
  const [sentinelInd, setSentinelInd] = useState<{
    switchOn: boolean;
    state: "off" | "idle" | "listening" | "uploading" | "suspended";
    degraded: boolean;
  } | null>(null);
  /** 播报总开关（F-02-12）：车机默认开，关闭状态跨重启保持。 */
  const [broadcast, setBroadcast] = useState(true);

  useEffect(() => {
    if (!isTauriEnv()) return;
    void invoke<boolean>("get_broadcast_enabled").then(setBroadcast);
    void invoke<boolean>("get_trip_collect_enabled").then(setTripCollect);
  }, []);

  const toggleBroadcast = useCallback(async () => {
    const next = !broadcast;
    setBroadcast(next); // 乐观：开关必须手感即时
    try {
      const applied = await invoke<boolean>("set_broadcast_enabled", { enabled: next });
      setBroadcast(applied);
    } catch {
      setBroadcast(!next); // 失败回滚，不留一个"看起来关了其实没关"的开关
    }
  }, [broadcast]);

  /**
   * 发送文字消息（F-03-09）。
   * 网络在 Rust 侧（§2.2 C2）：WebView 只 invoke，不直接访问网关。
   * 用户消息与助手回复都由 SSE 事件回流，这里不做乐观插入，
   * 避免"本地先显示、服务端却失败"的两份真相。
   */
  // HITL 确认弹层：盖 App 层，确认常发生在语音场景，用户人在 HUD 层。
  const [permission, setPermission] = useState<PermissionRequest | null>(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  /** resume 没被接住时的告知文案，不能静默收起，见 decidePermission。 */
  const [permissionNotice, setPermissionNotice] = useState<string | undefined>(undefined);
  // devbar 的弹层演示开关（浏览器里唯一的演示路径），真实中断始终优先。
  const [demoPermission, setDemoPermission] = useState(hitlDemo);

  /**
   * 建一个新会话并接管：写 localStorage、起流、清空当前消息列表。
   *
   * 历史不删：服务端那份还在，上滑仍能翻阅（D4）。这里清空的只是
   * "当前这段对话"的显示，否则新会话一开场就挂着上一段的气泡，
   * 而暖暖的形象判据（本会话有没有说过话）会立刻判成办公。
   */
  const doStartNewSession = useCallback(async (): Promise<string> => {
    const sid = await invoke<string>("create_session");
    rememberSession(sid);
    sessionIdRef.current = sid;
    setCurrentSessionId(sid);
    // 换了会话就退出回看：否则屏幕上摊着旧对话，而车主说的话进的是新会话。
    setViewing(null);
    setMessages([]);
    setStreaming(null);
    setLastInteractionAt(undefined);
    await invoke("start_session_stream", { sessionId: sid });
    // 哨兵跟上新会话：语音唤醒的指令要落进"现在这段对话"。
    // 绑不上不挡会话建立，哨兵是增强入口，不是前置条件。
    invoke("sentinel_bind_session", { sessionId: sid }).catch(() => {});
    // 新会话要出现在左侧列表里。整页重拉而不是本地插一条：
    // 本地插的那条与服务端真的建成了，是两件事。
    void loadSessionsRef.current?.(true);
    return sid;
  }, []);

  /**
   * 建会话失败时分流：服务端说"先声明谁在用"就请外层挂回上车声明，其余原样抛。
   *
   * `active_user_required` 只出现在车辆级 token 上，吞掉它会让车主说话后没有任何反应。
   */
  const needBoardingOrRethrow = useCallback(
    (err: unknown): never => {
      if (String(err).includes("active_user_required")) {
        console.info("[session] 服务端要求先声明谁在用——挂回上车声明");
        onNeedBoarding?.();
      }
      throw err;
    },
    [onNeedBoarding],
  );

  /**
   * 对外的"新建会话"。并发的两次合并成一次：
   * 连点「新建对话」、以及"会话过期重发"与别处同时触发时，
   * 各自拿到同一个 sid，而不是各建一个、丢掉一个空会话。
   */
  const startNewSession = useCallback(
    (): Promise<string> => sessionInflight.run(INFLIGHT_NEW_SESSION, doStartNewSession),
    [doStartNewSession],
  );

  /**
   * 发之前确认会话还能用；没有就现建，该退休就先换一个。除上车声明外，
   * 这是唯一会建出会话的路径。
   *
   * 车机上建会话会被服务端要求"先声明谁在用"：那是要求重新走上车声明，
   * 不能静默吞掉，否则车主说话后没有任何反应。
   */
  const ensureUsableSession = useCallback(async (): Promise<string> => {
    const sid = sessionIdRef.current;
    if (!sid) return startNewSession().catch(needBoardingOrRethrow);
    const retire = canRetire({
      lastInteractionAt,
      now: Date.now(),
      streaming: streaming !== null,
      awaitingPermission: permission !== null,
    });
    return retire ? startNewSession().catch(needBoardingOrRethrow) : sid;
  }, [lastInteractionAt, streaming, permission, startNewSession, needBoardingOrRethrow]);

  /**
   * 结束当前这段对话：关掉它、把端上的会话位置空，不预建下一个。
   *
   * 下一句话由 `ensureUsableSession` 现建并立刻发送，不留零消息会话。
   *
   * 历史不删：`close_session` 是软关闭，上滑仍能翻阅。
   * 两个入口（HUD 的「退下」按钮、语音口令退下）共用这一条。
   */
  const endCurrentSession = useCallback(async (opts: { close: boolean }) => {
    const sid = sessionIdRef.current;
    if (sid && opts.close) {
      try {
        await invoke("close_session", { sessionId: sid });
      } catch (err) {
        // 关不上不该挡住"我要收尾"这个诉求：端上照样收尾，旧的留给服务端的空闲判定收。
        console.warn("[session] 关闭旧会话失败，端上仍然收尾", err);
      }
    }
    sessionIdRef.current = null;
    setCurrentSessionId(null);
    setViewing(null);
    setMessages([]);
    setStreaming(null);
    setLastInteractionAt(undefined);
    // 列表里那条要变成"已关闭"，重拉一次（不 await，拉不到不挡收尾）。
    void loadSessionsRef.current?.(true);
  }, []);

  /** 车主点「退下」：关掉这段对话并收尾。 */
  const dismissAssistant = useCallback(
    () => endCurrentSession({ close: true }),
    [endCurrentSession],
  );
  /*
   * 语音口令「退下」经桥接事件回来，而那个订阅挂在只跑一次的大 effect 里
   * （依赖只有稳定的 appendMessage，见它的注释）——直接闭包捕获会捕到第一版。
   * 与 `sendTextRef` / `loadSessionsRef` 同一形态。
   */
  const endCurrentSessionRef = useRef(endCurrentSession);
  endCurrentSessionRef.current = endCurrentSession;

  /**
   * 收编 Rust 侧新建的会话：409 过期重建，以及关闭会话后的第一次长按
   * （手上没有会话时 Rust 停完采集现建一个再上传，与文字路的
   * `ensureUsableSession` 对称）。
   * 暖暖休息时绑定会话往往已过期；唤醒指令不能丢，Rust 已新建并重发，
   * 这里把前端的会话所有权切过去：换存储、切流、拉新会话的历史。
   */
  const adoptSession = useCallback(async (sid: string) => {
    rememberSession(sid);
    sessionIdRef.current = sid;
    setCurrentSessionId(sid);
    setViewing(null);
    setMessages([]);
    setStreaming(null);
    setLastInteractionAt(Date.now());
    // 服务端已经多了一个会话，左栏列表要跟上——与 `doStartNewSession` 同一做法。
    void loadSessionsRef.current?.(true);
    try {
      await invoke("start_session_stream", { sessionId: sid });
      // PTT 收编也要让哨兵跟上；否则下一次免手指令仍会打到旧会话。
      invoke("sentinel_bind_session", { sessionId: sid }).catch(() => {});
      const history = await invoke<ChatMessage[]>("refresh_history", { sessionId: sid });
      setMessages(history);
    } catch (err) {
      console.warn("[sentinel] 收编新会话失败", err);
    }
  }, []);

  /**
   * 上车声明刚建出来的会话直接接管。
   *
   * 车机建会话的唯一入口是上车声明（车辆级 token 必须显式声明谁在用），
   * 所以这是车机拿到 sid 的正路。
   * 依赖只挂 sid：`adoptSession` 是稳定引用，声明一次只接管一次。
   */
  useEffect(() => {
    if (!declaredSessionId) return;
    void adoptSession(declaredSessionId)
      .catch((err) => console.warn("[session] 接管上车声明的会话失败", err))
      .finally(() => {
        /*
         * 声明落地即重拉个人域数据。
         *
         * 本组件与 BoardingGate 同时挂载，HUD 源首次拉行程早于 `create_session_as`：
         * 那时 `acting::session()` 还是 None，请求不带 `x-cabinhug-session`，网关回 401。
         * 401 只置 stale，不重拉就要等 60s 轮询的下一拍。
         * `fetch_trip_plan` 每次都 `GatewayClient::new`，这里重拉自然带上新头。
         * 放在 finally：接管失败不影响"现在已经有身份了"这件事。
         */
        const src = sourceRef.current;
        if ("refresh" in src) void (src as GatewayHudSource).refresh();
        void refreshGuideJobs();
        /*
         * 账号事件流跟着换人重起（ACR-032）。
         *
         * 服务端按连接建立时的那个人订阅；车机会换人，不重起的话换人之后
         * 这条流推来的仍是上一个人的会话变动。Rust 侧 `replace_user_stream` 负责掐掉旧流。
         */
        invoke("start_user_events_stream").catch((err) =>
          console.warn("[session] 换人后账号事件流重起失败", err),
        );
      });
  }, [declaredSessionId, adoptSession, refreshGuideJobs]);

  /**
   * 点开左侧列表里的一条会话。
   *
   * 两条路，判据是"服务端还收不收这条会话的消息"（`sessionResumable`，
   * 与网关的 `checkSessionUsable` 同一条，含边界方向）：
   *
   *  - 还能接着说 → 把会话所有权切过去（存储 / 流 / 哨兵一起换），继续对话；
   *  - 已经结束 → 只回看，一个都不换。
   *
   * 对已结束的会话摆出输入框，发送后才拿到 409、端上换成新会话，
   * 车主会以为在续上一段对话，实际在空对话里说话。
   */
  const openSession = useCallback(
    async (row: SessionBrief) => {
      if (row.sessionId === sessionIdRef.current) {
        setViewing(null);
        return;
      }
      let history: ChatMessage[] = [];
      try {
        history = await invoke<ChatMessage[]>("refresh_history", { sessionId: row.sessionId });
      } catch (err) {
        // 拉不到就什么都不做，不要半切：切了流却没有历史，
        // 屏幕上会是一段空对话，像是这条会话的记录丢了。
        console.warn("[session] 历史读取失败，保持原状", err);
        setSessionsError("这段对话读不出来");
        return;
      }

      if (!sessionResumable(row, Date.now())) {
        setViewing({ sessionId: row.sessionId, messages: history });
        return;
      }

      // 接着聊：与 `adoptSession` 同一套动作、同一顺序：
      // 先落存储与 ref，再起流、再绑哨兵，中途失败也不会留下"ref 指向 A、流在 B"。
      rememberSession(row.sessionId, Date.parse(row.createdAt));
      sessionIdRef.current = row.sessionId;
      setCurrentSessionId(row.sessionId);
      setViewing(null);
      setStreaming(null);
      setMessages(history);
      setLastInteractionAt(history[history.length - 1]?.ts);
      try {
        await invoke("start_session_stream", { sessionId: row.sessionId });
        invoke("sentinel_bind_session", { sessionId: row.sessionId }).catch(() => {});
      } catch (err) {
        console.warn("[session] 切换会话时起流失败", err);
      }
    },
    [],
  );

  const exitViewing = useCallback(() => setViewing(null), []);

  /*
   * 给左栏的两个回调过一遍 useCallback：SessionList 里"没占满就再要一页"的 effect
   * 以 onLoadMore 为依赖，裸箭头函数会让它每次渲染都重跑一遍判断。
   * 判断本身有 loading/hasMore 闸，不至于风暴，但没必要空转。
   */
  const onSelectSession = useCallback((row: SessionBrief) => void openSession(row), [openSession]);
  const onLoadMoreSessions = useCallback(() => void loadSessionsRef.current?.(false), []);

  /**
   * 左栏「新建对话」：会话被闲置软关闭后，对话层里需要一个主动另起一段的入口
   * （「退下」在 HUD 层，且语义是"结束"，会 close 旧会话）。
   * 这里不关旧会话：旧的留在列表里还能接着聊，关不关交给服务端的空闲判定。
   *
   * 点它不建会话，只是把手上这段放下：新会话在下一句话时现建，
   * 不留零消息会话。这条路上没有网络请求，不需要防连点。
   */
  const onNewSession = useCallback(
    () => endCurrentSession({ close: false }),
    [endCurrentSession],
  );

  /** 附件取件：句柄 → 字节（Rust 侧带令牌）→ Blob。模块级常量即可，不依赖任何状态。 */
  const cockpitAttachments = useMemo(
    () => ({
      load: async (ref: AttachmentRef): Promise<Blob> => {
        const buf = await invoke<ArrayBuffer>("fetch_attachment", { handle: ref.handle });
        return new Blob([buf], { type: ref.contentType ?? "application/octet-stream" });
      },
    }),
    [],
  );
  const sendText = useCallback(async (content: string) => {
    const sid = await ensureUsableSession();
    setLastInteractionAt(Date.now());
    try {
      await invoke("send_text_message", { sessionId: sid, content });
    } catch (err) {
      /*
       * 服务端是权威：端上计时器只管形象。
       * 端上算漏了（比如车机休眠期间计时器没跑）时这里会拿到 409，
       * 换一个会话重发一次，不丢车主的话。
       */
      if (!String(err).includes(SESSION_EXPIRED)) throw err;
      const fresh = await startNewSession();
      await invoke("send_text_message", { sessionId: fresh, content });
    }
  }, [ensureUsableSession, startNewSession]);
  // 上面 onNavEnd 经 ref 用它（声明顺序所迫，见那里的说明）。
  sendTextRef.current = sendText;

  /** 结构变更发送中：两个出口都禁用，失败时留在编辑态。 */
  const [detailSaving, setDetailSaving] = useState(false);
  /**
   * 「保存调整」：把变更集拼成一句话发进会话，后续走「让暖暖调整」的既有链路
   * （无草案装载 → 粘性细化 → 确认弹窗 → `trip_plan_update`）。
   *
   * 抽屉不写库、不绕 HITL，它只替车主说一句话（HUD Brief §2）。
   *
   * 失败不静默：抽屉留在编辑态、变更集不清，屏上说明原因，
   * 否则车主会以为保存成功了。
   */
  const onSaveDetailEdits = useCallback(
    (next: readonly TripStructureEdit[]) => {
      const planId = highlightedPlanId;
      if (!planId || next.length === 0) return;
      const entry = tripEntries.find((e) => e.planId === planId);
      if (!entry) return;
      const prompt = adjustStructurePrompt(planId, entry.plan, next);
      setDetailSaving(true);
      void sendText(prompt)
        .then(() => {
          setDetailSaving(false);
          setDetailEditing(false);
          setDetailEdits([]);
          setDetailOpen(false);
          // 后面是既有链路（细化 → 确认弹窗），车主要看到暖暖在说什么。
          setNav("dialog");
        })
        .catch((err) => {
          console.warn("[trip-detail] 结构变更没发出去", err);
          setDetailSaving(false);
          setTripHint("调整没发出去，再试一次");
          window.setTimeout(() => setTripHint(undefined), 4000);
        });
    },
    [highlightedPlanId, tripEntries, sendText],
  );


  const appendMessage = useCallback((m: ChatMessage) => {
    setMessages((prev) =>
      prev.some((x) => x.messageId === m.messageId) ? prev : [...prev, m],
    );
    // 新一轮从用户这条消息开始：上一轮的"部分结果"横幅到此为止，
    // 留着会把上一轮的缺失标到这一轮头上。
    if (m.role === "user") branchFaults.reset();
    // 用户说的与助手回的都算交互：D1 定的是"空闲 30 分钟"，
    // 不是"两次发言间隔"。助手长回答期间不该被判成空闲。
    setLastInteractionAt(Date.now());
    // 助手完整回复到达 → 该轮流式气泡结束
    if (m.role === "assistant") {
      setStreaming((s) => (s && s.turnId === m.turnId ? null : s));
      // 本轮收口：进展一律清掉，不能只靠工具自己的 succeeded：
      // 分支超时那一路的完成事件不会来，留着就是一句一直挂着的"正在查天气"。
      toolProgress.reset();
      // 本轮已经收官还挂着弹窗 = 服务端那头已收敛（超时按"未确认=不执行"）——
      // 留着它用户按下去也只会得到 interrupt_expired，收起。
      setPermission(null);
      /*
       * 行程状态可能刚被这轮对话改掉。"定下来"走确认层，批准后有
       * decidePermission 里那次立即刷新；"取消/改期"不弹确认层，没有
       * 刷新触发器，HUD 只能等 60s 轮询的下一拍。所以每轮回复落地都刷一次：
       * 接口耗时 3~6ms，比枚举"哪些话会改行程"可靠。
       * source 经 ref 取（见 sourceRef 的注释），不进本回调的依赖。
       */
      const src = sourceRef.current;
      if ("refresh" in src) void (src as GatewayHudSource).refresh();
    }
    /*
     * 依赖只挂 `toolProgress.reset`，不挂整个 `toolProgress`。
     *
     * `useToolProgress()` 每次渲染返回一个新对象，挂整个对象会让本回调每次渲染
     * 都换身份；而下面那个订阅 + bootstrap 的大 effect 以本回调为依赖，
     * 于是每次渲染都重跑整段 bootstrap（重新订阅桥接事件、refresh_history、起流），
     * 叠加会话列表拉取的 setState 后形成渲染风暴，耗尽 WebView 内存并白屏。
     *
     * `reset` 是 useCallback([]) 出来的稳定引用，本回调用到的也只有它。
     * branchFaults.reset 同一形态（useBranchFaults 返回值 memo，reset 稳定）。
     */
  }, [toolProgress.reset, branchFaults.reset]);

  const decidePermission = useCallback(
    async (approved: boolean) => {
      const sid = sessionIdRef.current;
      if (!sid || !permission) return;
      setPermissionBusy(true);
      /*
       * resume 失败必须说出来。
       *
       * 任何一次 resume 没被接住（例如服务端进程在确认挂起期间重启，挂起随进程消失），
       * 都不能表现得像成功。失败时弹层不收、改成告知态；只有确实被接住才收起。
       */
      try {
        const accepted = await invoke<boolean>("resume_interrupt", {
          sessionId: sid,
          interruptId: permission.interruptId,
          approved,
        });
        if (!accepted) {
          setPermissionNotice(
            "这次确认没有生效——服务端已经不在等这条确认了（多半是超时或服务重启）。行程没有保存，请再说一次。",
          );
          return;
        }
      } catch (err) {
        console.warn("[hitl] resume 发送失败", err);
        setPermissionNotice("确认没能送达（网络或服务异常）。行程没有保存，请稍后再说一次。");
        return;
      } finally {
        setPermissionBusy(false);
      }
      setPermission(null);
      setPermissionNotice(undefined);
      // 确认动作大概率改变了行程状态（confirm/cancel）——立即刷 HUD，不等轮询。
      if (approved && "refresh" in source) void (source as GatewayHudSource).refresh();
    },
    [permission, source],
  );

  useEffect(() => {
    if (!isTauriEnv()) return;
    let cleanup: (() => void) | undefined;
    subscribeBridge({
      onAssistantState: (s) => setServerAvatarState(s),
      onDelta: (d) =>
        setStreaming((prev) =>
          prev && prev.turnId === d.turnId
            ? { turnId: d.turnId, text: prev.text + d.text }
            : { turnId: d.turnId, text: d.text },
        ),
      onMessage: appendMessage,
      onToolCall: toolProgress.onToolCall,
      // 分支起止：failed/timeout 聚合成"部分结果"横幅的数据源。
      onBranch: branchFaults.onBranch,
      onConnection: (c) => setConnection(c.state),
      /*
       * 采集状态：只关心权限相关的两条。
       *  - started：真录上了，说明权限已到手，把"未授权"的文字说明收掉；
       *  - failed(permission_denied)：重查一次系统状态（undetermined→denied
       *    的迁移只有系统知道），让暖暖的说明从"长按弹授权框"换成"去设置开"。
       */
      onCaptureStatus: (s) => {
        if (s.kind === "started") {
          setMicPermission("granted");
          // 录上了就把上一次的失败说明收掉，别让旧错误挂在卡上。
          setCaptureFault(undefined);
        } else if (s.kind === "failed") {
          setCaptureFault(s.reason);
          if (s.reason.startsWith("permission_denied")) void refreshMicPermission();
        }
      },
      onPermission: (p) => setPermission(p),
      onWakeStatus: (w) => {
        switch (w.kind) {
          case "woken":
            // 命中即亮：带指令时消息很快落库接管形象，这里先给 10s 的桥
            setWakeUntil(Date.now() + 10_500);
            break;
          case "listening_window":
            // 与 Rust 侧 WindowConfig 默认值（10s/5s）保持镜像，各 +500ms 余量
            setWakeUntil(w.open ? Date.now() + 10_500 : 0);
            break;
          case "followup_window":
            if (w.open) setWakeUntil(Date.now() + 5_500);
            break;
          case "dismissed":
            // 服务端已软关闭；端上走与「退下」按钮相同的收尾（不再 close 一次，
            // 也不预建下一个，下一句话由 ensureUsableSession 现建）。
            setWakeUntil(0);
            void endCurrentSessionRef
              .current?.({ close: false })
              .catch((err) => console.warn("[sentinel] 退下收尾失败", err));
            break;
          case "session_adopted":
            void adoptSession(w.session_id);
            break;
          case "sentinel_degraded":
            // 降级/恢复的可见状态走 voice:sentinel 快照；这里不用重复处理
            break;
          case "sidecar_switched":
            /*
             * 车主用语音拨了闲聊旁路的开关。这里只记下来交给设置页显示，
             * 本层不改任何行为：偏好已经在 Rust 侧改完了。
             * 不记的话，设置页开着时语音关掉旁路，开关仍显示为开。
             */
            setSidecarOn(w.on);
            break;
        }
      },
      onSentinelStatus: (s) => setSentinelInd(s),
      /*
       * 会话标题。事件走的是当前会话那一路 SSE，
       * 所以归属就是 `sessionIdRef.current`；载荷里不带 sessionId 是刻意的
       * （封套上有，桥接层只把 payload 递上来）。
       *
       * 就地改那一行，不整页重拉：重拉会把列表滚动位置弹回顶部，
       * 而首轮刚结束时车主的手很可能正停在列表上。
       * 列表里还没有这一条（新会话）时补一条占位，否则
       * 名字起好了却要等下次进页面才看得见。
       */
      onSessionTitle: (t) => {
        const sid = sessionIdRef.current;
        if (!sid) return;
        setSessions((prev) => {
          const hit = prev.some((x) => x.sessionId === sid);
          if (hit) {
            return prev.map((x) => (x.sessionId === sid ? { ...x, title: t.title } : x));
          }
          const now = new Date().toISOString();
          return [
            {
              sessionId: sid,
              title: t.title,
              createdAt: now,
              updatedAt: now,
              closedAt: null,
              messageCount: 0,
            },
            ...prev,
          ];
        });
      },
    }).then((un) => {
      cleanup = un;
    });

    const bootstrap = async () => {
      /*
       * 1) 上次那个会话还能不能接着用。判定在 `data/bootstrapSession.ts`（纯函数，
       *    可单测），只给出"接着用"或"手上没有会话"，没有"新建"那一支。
       *    太旧不复用：复用一个三天前的会话会让模型带着三天前的结论继续说话。
       */
      const stored = localStorage.getItem(SESSION_STORAGE_KEY);
      const storedCreatedAt = stored ? storedSessionCreatedAt(stored) : undefined;
      let history: ChatMessage[] | null = null;
      if (stored) {
        history = await invoke<ChatMessage[]>("refresh_history", { sessionId: stored }).catch(
          () => null,
        );
      }
      const plan = planBootstrap({ stored, createdAt: storedCreatedAt, history, now: Date.now() });
      let sid: string | null = null;
      if (plan.kind === "resume") {
        sid = plan.sessionId;
        setMessages(history ?? []);
        setLastInteractionAt(history?.[history.length - 1]?.ts);
        console.info(`[session] 复用 ${sid}（历史 ${history?.length ?? 0} 条）`);
      } else {
        console.info(`[session] 不复用上次会话（${plan.reason}）`);
      }
      /*
       * 引导只复用，不新建。
       *
       * 开机即建会在启动后没说话、或再次重启时留下永远零消息的会话
       * （服务端是懒关闭，没人再访问就不落 `closed_at`）。
       *
       * 建会话统一交给 `ensureUsableSession`，它建完立刻发消息，不留空会话。
       * 车机还有一条：上车声明产出的 sid 由 `adoptDeclaredSession` 直接接管。
       */
      if (!sid) {
        console.info("[session] 没有可复用的会话——等第一句话再建");
        sessionIdRef.current = null;
        setCurrentSessionId(null);
        setMessages([]);
      } else {
        sessionIdRef.current = sid;
        setCurrentSessionId(sid);
        await invoke("start_session_stream", { sessionId: sid });
        console.info(`[session] 流已启动 ${sid}`);
        // 哨兵跟上这段对话。没有会话时不绑，见下面 sentinel_start 的说明。
        invoke("sentinel_bind_session", { sessionId: sid }).catch(() => {});
      }
      /*
       * 哨兵监听：没有会话也要启动。
       *
       * 绑定要有会话才有意义，而启动是"开始听"。懒建之后"还没有会话"是常态，
       * 此时不开麦会让喊名字无人响应。无会话时的唤醒指令由
       * Rust 侧发 `session_required` 事件回来，见下面的处理。
       */
      invoke<boolean>("sentinel_start")
        .then((started) => console.info(`[sentinel] ${started ? "已启动" : "已在运行"}`))
        .catch(() => {});
      /*
       * 账号级事件流（ACR-032）：别的端改了会话列表时，这条流通知这里重拉。
       *
       * 不 await 也不挡引导：它断了只是列表不会自动刷新，对话一切照常。
       * 与会话流各跑各的：那条每换一次会话被替换，这条与「谁在用车」同寿。
       */
      invoke("start_user_events_stream").catch((err) =>
        console.warn("[session] 账号事件流启动失败，列表仍可手动刷新", err),
      );
      // 左侧历史。放最后且不 await：列表拉不到不该挡住对话可用。
      void loadSessionsRef.current?.(true);
    };
    /*
     * 整段引导走在飞闸。
     *
     * 两个端都包在 `<React.StrictMode>` 里，React 18 开发构建会把每个 effect
     * 跑成 effect → cleanup → effect；而从「读 localStorage 的旧 sid」到
     * 「`rememberSession` 写回」之间全是 await、没有互斥，两次运行会各建一个会话，
     * 先建的那个零消息且永不关闭（服务端是懒关闭）。cleanup 只退订桥接事件，
     * 取消不了在飞的 bootstrap，所以闸挡在这里。
     */
    sessionInflight
      .run(INFLIGHT_BOOTSTRAP, bootstrap)
      .catch((err) => console.warn("[session] 引导失败（网关未启动？）", err));

    return () => cleanup?.();
  }, [appendMessage]);

  const voice = useMemo(
    () =>
      createVoicePort(
        // 关闭会话之后这里是 null，照样交下去：Rust 停完采集会现建会话再上传，
        // 建出的 id 从 outcome 回来收编。
        () => sessionIdRef.current,
        (outcome) => {
          console.info("[voice] 已上传", outcome);
          if (outcome.sessionId) {
            void adoptSession(outcome.sessionId).catch((err) =>
              console.warn("[voice] 收编新会话失败", err),
            );
          }
        },
      ),
    [adoptSession],
  );

  /*
   * 地图视图记忆：上次把地图拖到哪，下次打开还在哪。
   *
   * 放在 App 而不是 HudScreen 里，是因为它有两个消费者：主页那张底图，
   * 以及设置页里点「立即定位」之后要把镜头挪过去。各拿一份的话，
   * 在设置里定位完回到主页，地图还停在原处。
   */
  const mapView = useMapViewport();

  /*
   * 抽屉开着时暂停轮播：右侧那个窗口被抽屉整个盖住，
   * 底下继续每 6 秒翻一页没有意义；抽屉一关就原样接着翻（不重置页码）。
   */
  const carousel = useCarousel(view.tips.pages.length, { paused: detailOpen });
  const assistant = useAssistantInteraction({
    // 服务端事件流优先，HUD mock 快照兜底；本地交互态在 hook 内仍最优先。
    // alert 抢占（AC-01-4）：有 critical 且未确认的核查时，形象先说"有一条提醒"。
    externalState: hudAlert ? "alert" : restAlert ? "alert" : (serverAvatarState ?? view.assistantState),
    voice,
    /*
     * 不传 onOpenDialog：车机端进对话只经底部导航的「对话」按钮。
     *
     * 点击与长按共用同一块区域时，触屏上稍短的长按会被判成点击而翻去对话页，
     * 驾驶中很难控制按压时长，误跳的代价高于"点了没反应"。
     * 所以助手身上只留长按说话，进对话交给一个不会被误触的显式按钮。
     */
    /*
     * 单击 = 打断。
     *
     * 只在她真的在说 / 在想的时候才生效：空闲时点一下什么也不做，
     * 不发没有目标的取消。单击与长按在某台设备上分不干净时，长按说话时
     * 形象不是 speaking/thinking，也不会被误判成打断。
     *
     * 判定用服务端事件流给的状态（`serverAvatarState`），不用 hook 的本地交互态：
     * 后者在长按过程中会变成 listening/thinking，会把"长按刚结束"也算成可打断。
     */
    /*
     * 长按被拒时的原因。`voice:capture` 的 failed 事件不覆盖所有路径：
     * `already_recording` 在 Rust 侧直接返回 Err、不发事件，只有 invoke 的 reject 里有。
     * 两条都收到这里。
     */
    onVoiceError: (reason) => setCaptureFault(reason),
    onTap: () => {
      if (!isTauriEnv()) return;
      if (serverAvatarState !== "speaking" && serverAvatarState !== "thinking") return;
      void invoke<boolean>("interrupt_assistant_cmd").catch((err) => {
        // 打断失败不弹窗：车主要的那件事（别说了）在 Rust 侧已经同步做完了
        console.warn("[interrupt] 打断请求失败", err);
      });
    },
  });

  return (
    <>
      {/* HUD 保持挂载：切层往返不丢状态机与轮播上下文 */}
      <div style={{ display: nav === "hud" ? "contents" : "none" }}>
        <HudScreen
          theme={theme}
          home={home}
          snapshot={{ ...view, assistantState: assistant.state }}
          tipsPage={carousel.page}
          tipsGestureProps={carousel.gestureProps}
          assistantGestureProps={assistant.gestureProps}
          /*
           * 未授权的文字说明。两种未授权文案不同：
           * undetermined 长按会弹系统框，denied 长按只能带去系统设置。
           */
          assistantHint={
            micPermission === "denied"
              ? { primary: "麦克风未授权", secondary: "长按打开系统设置，允许使用麦克风" }
              : micPermission === "undetermined"
                ? { primary: "麦克风待授权", secondary: "长按并在系统弹窗中允许" }
                : /*
                   * 其余失败原样显示：原文里带着是哪一步断的
                   * （如 `device_busy: setCategory(playAndRecord) 失败`），是排障线索。
                   */
                  captureFault
                  ? { primary: "这次没录上", secondary: captureFault }
                  : tripHint
                    ? { primary: tripHint, secondary: "行程列表上的点会一直留着" }
                    : undefined
          }
          tripMap={tripMap}
          departurePlan={plan}
          mapView={mapView}
          reminders={{
            legs: plan?.legs,
            enabled: enRoutePrefs.enabled,
            density: enRoutePrefs.density,
            muted: !broadcast || !enRoutePrefs.enabled,
            speak: speakReminder,
            isInFlight: reminderIsInFlight,
            onRestActive: setRestAlert,
            onEvent: logEnRoute,
            hushSignal,
          }}
          // 我的座驾（屏底状态栏）：档案页的活动车辆；匹配不到形象就画中性车图标。
          vehicle={{ model: activeModel, art: vehicleCharacter(activeModel, theme === "dark" ? "dark" : "light") }}
          trips={{
            entries: tripEntries,
            selectedPlanId: highlightedPlanId,
            today: localDayKey(),
            onSelect: onSelectTrip,
            onOpenReview: onOpenTripReview,
            onClearSelection: onClearTripSelection,
            detailMenuOpen,
            onToggleDetailMenu,
            onOpenDetail,
            detailOpen,
            detailDay,
            selectedServices,
            onToggleService,
            onSelectDetailDay: setDetailDay,
            onCloseDetail: onRequestCloseDetail,
            // 行驶中可看不可改（与 TripReviewSheet.canAdjust 同口径）。
            canEditDetail: navDay === undefined,
            detailEditing,
            detailEdits,
            onChangeDetailEdits: setDetailEdits,
            onStartDetailEdit: () => setDetailEditing(true),
            onCancelDetailEdit: dropDetailEdits,
            onSaveDetailEdits,
            detailSaving,
            // 浏览器环境里 planId 是演示的，发出去只会被告知"没找到这份行程"。
            detailSaveDisabledReason: isTauriEnv() ? undefined : "浏览器走查不发送",
            detailConfirmDiscard,
            onConfirmDiscardDetail,
            onKeepEditingDetail: () => setDetailConfirmDiscard(false),
          }}
          assistantMode={assistantMode({
            messageCount: messages.length,
            lastInteractionAt,
            // `clock` 只是让这个派生值随时间重算；判据本身用的是真实 now。
            now: Math.max(clock, Date.now()),
            wakeUntil: wakeUntil || undefined,
          })}
          mic={
            sentinelInd
              ? {
                  // suspended（PTT/播报/流未建）对用户就是"未在收音"
                  state: sentinelInd.state === "suspended" || sentinelInd.state === "off"
                    ? "idle"
                    : sentinelInd.state,
                  micEnabled: sentinelInd.switchOn,
                  degraded: sentinelInd.degraded,
                  onToggleMic: (next) => {
                    void invoke("sentinel_set_switch", { on: next }).catch((err) =>
                      console.warn("[sentinel] 切总开关失败", err),
                    );
                  },
                }
              : undefined
          }
          onAssistantDismiss={isTauriEnv() ? dismissAssistant : undefined}
        />
      </div>

      {/* 导览采集进度卡：右下小卡，导览页开着时让位；只列未完成的（见 outstandingGuideJobs）。 */}
      {nav === "hud" && !guide && guideJobsOutstanding && guideJobsOutstanding.spots.length > 0 && (
        <div className="hud-guide-jobs-slot">
          <GuideJobsPanel jobs={guideJobsOutstanding} onFetch={fetchGuideSpot} onOpen={openGuide} />
        </div>
      )}

      {/* 景区导览页：覆盖层压在 HUD 之上，返回即关，HUD 状态不丢。 */}
      {nav === "hud" && guide && (
        <GuideScreen
          spotName={guide.spot}
          state={guide.state}
          onBack={closeGuide}
          onRetry={() => openGuide(guide.spot)}
          onRegenerate={() => openGuide(guide.spot, { force: true })}
        />
      )}

      {nav === "dialog" && (
        <DialogScreen
          /*
           * 回看态下摊的是那段历史，且没有流式气泡、没有工具进展：
           * 那两样讲的都是"此刻正在发生什么"，而此刻正在发生的事属于当前会话，
           * 不属于屏幕上这段已经结束的对话。
           */
          /* `?dialog=demo`：喂演示消息/会话/进展——版式截图入口，见 @cabinhug/ui 的 demo-dialog.ts。 */
          messages={isDialogDemo() ? DEMO_DIALOG_MESSAGES : viewing ? viewing.messages : messages}
          streaming={isDialogDemo() ? DEMO_DIALOG_STREAMING : viewing ? null : streaming}
          progress={isDialogDemo() ? "正在查天气（演示）" : viewing ? null : toolProgress.progress}
          /*
           * 部分结果横幅与流式/进展同一回看规则：它讲的是"此刻这轮
           * 缺了什么"，回看历史时不显示，历史里的缺失已经写在当时的正文里。
           */
          branchFaults={viewing ? undefined : branchFaults.faults}
          connection={connection}
          onSendText={isTauriEnv() || isDialogDemo() ? sendText : undefined}
          /*
           * 附件回看（F-03-08）：车机只取件不上传，行车态不选文件（FL-06），
           * 但手机端发过来的照片与视频要能在这块屏上看、能放。字节经 Rust 命令带令牌取回。
           */
          attachments={isTauriEnv() ? cockpitAttachments : undefined}
          broadcast={
            isTauriEnv() || isDialogDemo() ? { enabled: broadcast, onToggle: toggleBroadcast } : undefined
          }
          currentSessionId={currentSessionId}
          viewing={viewing ? { sessionId: viewing.sessionId, onExit: exitViewing } : null}
          sessions={
            isDialogDemo()
              ? {
                  items: DEMO_DIALOG_SESSIONS,
                  hasMore: false,
                  loading: false,
                  onSelect: () => {},
                  onLoadMore: () => {},
                  onNew: () => {},
                }
              : isTauriEnv()
              ? {
                  items: sessions,
                  hasMore: sessionsHasMore,
                  loading: sessionsLoading,
                  error: sessionsError,
                  onSelect: onSelectSession,
                  onLoadMore: onLoadMoreSessions,
                  onNew: () => void onNewSession(),
                }
              : undefined
          }
        />
      )}

      {/* 档案页。没有页内返回按钮：换页出口统一在底部导航（见 OwnershipScreen 文件头）。 */}
      {nav === "profile" && (
        <OwnershipScreen
          theme={theme}
          onActiveVinChange={(vin, model) => {
            setActiveVin(vin);
            if (model) setActiveModel(model);
          }}
          // 档案页数据到位 → 过场从"一直开"转到"开走"（见 DriveTransition 文件头）
          onReady={() => setProfileReady(true)}
          onDeclareSeating={isTauriEnv() ? (t) => void sendText(t) : undefined}
          collect={
            // 演示入口也给一张采集卡：定稿右列有它，缺了那格 diff 会一路错位。
            // 它只在 ?profile=demo 下出现，开关是空操作（见 demoVehicleProfile.ts）。
            profileDemo
              ? { enabled: true, onToggle: () => {} }
              : isTauriEnv()
              ? {
                  enabled: tripCollect,
                  onToggle: () => {
                    const next = !tripCollect;
                    void invoke<boolean>("set_trip_collect_enabled", { enabled: next }).then(setTripCollect);
                  },
                }
              : undefined
          }
        />
      )}

      {/*
        「开车去档案」过场（主页 → 档案）。挂在 HITL 之前 = z 序在它之下：
        确认弹层任何时候都必须压在最上面，一段过场动画不该盖住有后果的确认。
      */}
      {driving && (
        <DriveTransition
          ready={profileReady}
          theme={theme}
          model={activeModel}
          onDone={() => setDriving(false)}
        />
      )}

      {/* 行程变化摘要：只在主页；「知道了」→ ack；「让暖暖调整」→ 一句话进会话并切到对话页。 */}
      {nav === "hud" && reviewEntry?.review && (
        <TripReviewSheet
          entry={reviewEntry}
          busy={reviewBusy}
          canAdjust={isTauriEnv() && navDay === undefined}
          onClose={() => setReviewPlanId(null)}
          onAck={() => {
            const review = reviewEntry.review!;
            if (demoPlan) {
              setDemoAcked((prev) => new Set([...prev, review.reviewId]));
              setReviewPlanId(null);
              return;
            }
            setReviewBusy(true);
            const req = isTauriEnv()
              ? invokeAckTripReview(reviewEntry.planId, review.reviewId)
              : devFetch(`/v1/trip-plan/${reviewEntry.planId}/review/ack`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ reviewId: review.reviewId }),
                }).then((r) => r.text());
            void req
              .catch((err) => console.warn("[trip-review] 确认失败（下一轮刷新如实纠正）", err))
              .finally(() => {
                setReviewBusy(false);
                setReviewPlanId(null);
                // 立即重拉：点熄灭不该等下一个 60 秒。
                if ("refresh" in source) void (source as GatewayHudSource).refresh();
              });
          }}
          onAdjust={(prompt) => {
            setReviewPlanId(null);
            void sendText(prompt);
            // 后面是既有链路（细化 → 确认弹窗），车主要看到暖暖在说什么。
            setNav("dialog");
          }}
        />
      )}

      {/* HITL 确认弹层：HUD 与对话层都可见。 */}
      {(permission || demoPermission) && (
        <ConfirmSheet
          request={permission ?? DEMO_PERMISSION}
          busy={permissionBusy}
          notice={permissionNotice}
          onDismissNotice={() => {
            setPermissionNotice(undefined);
            setPermission(null);
            setDemoPermission(false);
          }}
          // 演示弹层没有真实中断点，resume 会拿到 interrupt_expired——直接收起。
          onDecide={permission ? decidePermission : () => setDemoPermission(false)}
        />
      )}

      {/* 网关连接设置（ACR-004）：iOS 首启自动弹（引导语境），其余经「设置」按钮 */}
      <SettingsSheet
        open={settingsOpen}
        firstRun={settingsFirstRun}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsFirstRun(false);
        }}
      />

      {/*
        设置页。与档案页同级的整页形态；iOS 首启引导仍是弹层
        （见下面的 SettingsSheet），那时候不该先教用户认底部导航。
      */}
      {nav === "settings" && (
        <SettingsScreen
          theme={theme === "dark" ? "dark" : "light"}
          sidecarOn={sidecarOn}
          // 哨兵总开关的真相源是 Rust 的指示快照：设置页与 HUD 麦克风图标
          // 拨的是同一个开关，两边显示必须由同一个事实驱动。
          sentinelOn={sentinelInd?.switchOn}
          enRouteOn={enRoutePrefs.enabled}
          enRouteDensity={enRoutePrefs.density}
          onLocated={(fix) => mapView.focusOn({ lat: fix.lat, lon: fix.lon, zoom: 15 })}
        />
      )}

      {/*
        顶栏：页签在屏顶，右端带城市 / 天气 / 时间。
        车机端不渲染 BottomNav（手机端仍用它）；屏底那一带给了出行状态栏。
      */}
      <TopBar
        active={nav}
        link={topBarLink}
        onLinkAction={topBarLinkAction}
        linkHint={
          topBarLink === "noidentity"
            ? "服务是通的，但车机还没有上车声明（或在访客模式），读不到个人行程。点这里重新声明"
            : undefined
        }
        onRefresh={refreshHome}
        refreshing={refreshing}
        city={home?.city}
        weather={{ icon: SPRITES[theme].weather[view.weather.kind] ?? SPRITES[theme].weather.sunny, label: view.weather.label }}
        onSelect={(next) => {
          /*
           * 从任何页面切进档案都放过场（理由见 `driving` 的声明处）；
           * 已在档案页时不算"进入"，不重放。
           * 起过场的同时把 ready 归零：上一次留下的 true 会让这一趟
           * 刚开进画面就立刻开走，看起来像闪了一下。
           */
          if (next === "profile" && nav !== "profile") {
            setProfileReady(false);
            setDriving(true);
          } else if (next !== "profile") {
            /*
             * 过场途中改主意（点了档案又立刻点主页/对话）：立刻撤遮罩，
             * 否则动画放完前会盖住用户要去的那一页。
             */
            setDriving(false);
          }
          setNav(next);
        }}
        profileDisabled={false}
      />

      {/*
        验收用临时开关，非最终产品交互。
        只在主页出现：它是 fixed 定位的，在对话与档案页会压住内容，
        且会被误认为产品功能。
      */}
      <div
        className="hud-devbar"
        style={nav !== "hud" || profileDemo || hitlDemo ? { display: "none" } : undefined}
      >
        <button
          type="button"
          className="hud-devbar-toggle"
          aria-expanded={devbarOpen}
          onClick={() => setDevbarOpen((v) => !v)}
        >
          <span className="hud-devbar-chevron" aria-hidden="true">
            ›
          </span>
          功能演示
        </button>
        {devbarOpen && (
        <div className="hud-devbar-row">
        <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>
          主题：{theme}
        </button>
        {/* 演示用：在全部天气种类之间轮转，逐个看图标 */}
        <button
          onClick={() =>
            setWeather(WEATHER_KINDS[(WEATHER_KINDS.indexOf(weather) + 1) % WEATHER_KINDS.length])
          }
        >
          天气：{WEATHER_LABELS[weather]}
        </button>
        {isTauriEnv() && (
          <button
            onClick={() => {
              // 验收：标准样例序列走真实 fan-out 路径（thinking→delta→idle + 消息落缓存）
              void invoke("start_mock_stream");
            }}
          >
            回放 Mock 流
          </button>
        )}
        {/* 该开关让状态栏四格显示「服务暂不可用」。 */}
        <button onClick={() => setStale(!stale)}>
          数据：{stale ? "服务不可用" : "正常"}
        </button>
        {/*
          行程演示：浏览器没有 Tauri invoke，这是真实地图标注层
          在浏览器里可见的唯一路径。数据名称自带「演示」字样。
        */}
        <button onClick={() => setDemoPlan((v) => !v)}>
          行程演示：{demoPlan ? "开" : "关"}
        </button>
        {/*
          演示车速：把几小时的车程压进演示能走完的时长。
          它只压缩时间不改变路径（nav-position.ts 有单测钉住），
          且顶栏恒显「演示车速 ×N」，车并没有真的在那个位置。
        */}
        <button onClick={() => setDemoNav((v) => !v)}>
          跟车演示：{demoNav ? "开" : "关"}
        </button>
        <button onClick={() => setNavSpeedup((v) => NAV_SPEEDUPS[(NAV_SPEEDUPS.indexOf(v) + 1) % NAV_SPEEDUPS.length]!)}>
          演示车速：×{navSpeedup}
        </button>
        {/*
          确认弹层演示：弹层只在真实动作触发时出现，
          这是横屏/竖屏/双主题版式能在浏览器里查看的唯一路径。数据自带「演示」字样。
        */}
        <button onClick={() => setDemoPermission((v) => !v)}>
          确认弹窗：{demoPermission ? "开" : "关"}
        </button>
        {isTauriEnv() && (
          <>
            {/*
              ⑥用车流水。标题写明"模拟"：真实采集要接车辆信号（点火/熄火/里程表/SOC），
              那一层尚未接入。只写"上报行程"会让人以为系统在自动采集，
              画像会按不完整的样本算出看似正常的数字。
            */}
            <button
              title="POC 期为模拟触发：合成一段行程并上报。真实采集需接车辆信号。"
              onClick={() => {
                void invoke<{ accepted: number; pending: number; note: string }>("record_trip", {
                  distanceKm: 18.4,
                  minutes: 42,
                  roadType: "city",
                  ambientTempC: 28,
                }).then((r) => setTripNote(`${r.note}（已收 ${r.accepted}，待发 ${r.pending}）`));
              }}
            >
              模拟上报行程
            </button>
            <button
              onClick={() => {
                const next = !tripCollect;
                void invoke<boolean>("set_trip_collect_enabled", { enabled: next }).then((v) => {
                  setTripCollect(v);
                  setTripNote(v ? "采集已开启" : "采集已关闭——不会再产生任何上报请求");
                });
              }}
            >
              采集：{tripCollect ? "开" : "关"}
            </button>
            {tripNote && <span className="hud-devbar-note">{tripNote}</span>}
          </>
        )}
        {/*
          事实补录询问（§4.6，US-53）。它是顺带问的：没有独立的提问界面，
          问句挂在一次正常用车问答的末尾。所以这个按钮发起的是一次正常问答，
          而不是弹一个补录框。

          前提是这辆车的 ④ 真的陈旧。答完之后它就新鲜了，再点不会再问；
          要重来跑 `corepack pnpm demo:reset && corepack pnpm demo:seed`。
        */}
        {isTauriEnv() && (
          <button
            title="发起一次正常的用车问答；若 ④ 档案确实陈旧，助手会在回答末尾顺带问一句里程与上次保养。数据不陈旧时不会问——这是设计如此。"
            onClick={() => {
              setNav("dialog");
              void sendText("我这车最近开着感觉有点费电，正常吗？");
            }}
          >
            车辆数据更新
          </button>
        )}
        </div>
        )}
      </div>
    </>
  );
}
