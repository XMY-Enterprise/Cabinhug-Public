/**
 * 车机端 HUD 默认视图（数据与交互由容器接入）
 *
 * 布局依据 Brief §6：
 *   可读的地理背景 + 有序生活环：家(出发) → ① → ② → ③ → ④
 *   放大卡通助手（点击对话 / 长按说话）   集中行前温馨提示卡（3项/页）
 *                                        预计里程 · 当前电量 · 预计需电量
 */
import { useCallback, useEffect, useState } from "react";

import {
  AmapBackdrop,
  AmapTripLayer,
  AssistantDock,
  HudScene,
  HudStage,
  LifeRing,
  LODGING_LABEL,
  MicIndicator,
  NavBar,
  NODE_ANCHORS,
  PoiNode,
  PortraitTimeline,
  SPRITES,
  HighlightsCard,
  LocateButton,
  StatusBar,
  TipsCard,
  TripCalendarCard,
  TripDateBanner,
  TripDetailDrawer,
  spriteFor,
  type HudTripMapProps,
  type ListenState,
  type NavTripProgress,
  type ThemeName,
  type UseMapViewportResult,
} from "@cabinhug/ui";

// 行程地图入参、跟车顶栏、精灵语义映射在 @cabinhug/ui（两端共用）；这里转出以保持 App 的 import 路径。
export type { HudNavProps, HudTripMapProps } from "@cabinhug/ui";

import { CabinArrivalDemo } from "../features/cabin/CabinArrivalDemo";
import type { TripPlanLeg, TripPlanListEntry, TripPlanSnapshot, TripStructureEdit } from "@cabinhug/shared";
import { EnRouteReminderCard, useEnRouteReminders, type EnRouteEvent, type ReminderDensity } from "@cabinhug/ui";
import type { ServiceCategoryKey } from "@cabinhug/ui";
import { isHighlightsPage, type HudSnapshot } from "../data/types";

export interface HudScreenProps {
  theme: ThemeName;
  snapshot: HudSnapshot;
  /** 提示卡当前页（1 起）与手势属性，由容器提供。 */
  tipsPage?: number;
  tipsGestureProps?: Record<string, unknown>;
  tipsFooter?: React.ReactNode;
  assistantGestureProps?: Record<string, unknown>;
  /**
   * 休息 / 办公。与五态正交：办公中仍有那五态。
   * 判据在 `App.tsx`，是派生值（本会话有没有说过话），不是另存的状态位。
   */
  assistantMode?: "rest" | "work";
  /** 点「退下」结束这段对话；不给就不渲染那个按钮。 */
  onAssistantDismiss?: () => void;
  /**
   * 覆盖暖暖卡片两行文案（如麦克风未授权时挂文字说明）。
   * 不给就走 AssistantDock 的默认状态文案。
   */
  assistantHint?: { primary: string; secondary?: string };
  /** 真实地图行程模式；缺省走装饰生活环。 */
  tripMap?: HudTripMapProps;
  /**
   * 出发卡的数据源：HUD 此刻展示的那份行程，透传给出发入口
   * （CabinArrivalDemo）。不给 = 出发卡如实说"还没有已确认的行程"。
   */
  departurePlan?: TripPlanSnapshot | null;
  /**
   * 哨兵监听指示（F-52-06）。状态来自 Rust 采集层的真实快照
   * （`voice:sentinel` 事件），页面不推断；不给就不渲染（浏览器开发态）。
   */
  mic?: {
    state: ListenState;
    micEnabled: boolean;
    degraded?: boolean;
    onToggleMic?: (next: boolean) => void;
  };
  /**
   * 地图视图记忆（`useMapViewport()`）。给了就：上次拖到哪、下次打开还在哪；
   * 并渲染右下角的「定位到我」按钮。
   *
   * 优先级高于 `home`：常住地是"没有别的信息时的合理猜测"，而上次的构图
   * 是用户自己摆出来的，下次打开不拽回常住地。
   * 不传（或端上没存过）时按 `home` 与内置默认中心。
   */
  mapView?: UseMapViewportResult;
  /**
   * 车主常住地。没有行程时地图落在这里，出发锚点显示城市名。
   *
   * 缺省（网关没给／读失败）时地图退回内置默认中心；那是写死的坐标，只作兜底。
   */
  home?: { city: string; lat: number; lon: number };
  /**
   * 右上角行程列表。`entries` 为空时不渲染且提示卡窗保持原尺寸：
   * 空列表卡像故障。选中与打开摘要都上抛给 App（卡不碰网络、不做判断）。
   */
  trips?: {
    entries: readonly TripPlanListEntry[];
    /** 选中的那程；空 = 未选中态（周日历卡、无提示卡、地图跟列表首条）。 */
    selectedPlanId?: string;
    /** 本地今天（YYYY-MM-DD）：周条与相对时间的口径。 */
    today: string;
    onSelect: (planId: string) => void;
    onOpenReview: (planId: string) => void;
    /** 顶部日期条的 ×：回未选中态。 */
    onClearSelection: () => void;
    /**
     * 胶囊上的工具菜单。状态在 `App`：抽屉与"换了一程就收起"都要读它。
     */
    detailMenuOpen?: boolean;
    onToggleDetailMenu?: () => void;
    /** 菜单项「行程详情」：打开右侧抽屉。 */
    onOpenDetail?: () => void;
    /** 行程详情抽屉：开没开、看第几天、能不能进编辑态。 */
    detailOpen?: boolean;
    detailDay?: number;
    onSelectDetailDay?: (day: number) => void;
    onCloseDetail?: () => void;
    /** 沿途服务选中了哪几类：抽屉画选中态、地图画点位，同一份状态喂两边。 */
    selectedServices?: readonly ServiceCategoryKey[];
    onToggleService?: (key: ServiceCategoryKey) => void;
    canEditDetail?: boolean;
    /** 编辑态：状态与变更集都在页面层。 */
    detailEditing?: boolean;
    detailEdits?: readonly TripStructureEdit[];
    onChangeDetailEdits?: (next: TripStructureEdit[]) => void;
    onStartDetailEdit?: () => void;
    onCancelDetailEdit?: () => void;
    onSaveDetailEdits?: (edits: readonly TripStructureEdit[]) => void;
    detailSaving?: boolean;
    detailSaveDisabledReason?: string;
    detailConfirmDiscard?: boolean;
    onConfirmDiscardDetail?: () => void;
    onKeepEditingDetail?: () => void;
  };
  /**
   * 我的座驾（新版 UI 的屏底状态栏）：车型名 + 形象图。形象由档案页的活动车辆决定
   * （`vehicleCharacter`），匹配不到就 undefined，状态栏画中性车图标，不拿别的车顶替。
   */
  vehicle?: { model?: string; art?: string };
  /**
   * 途中提醒（FL-62）：跟车中按快照分段与进度出停靠提前 / 连续驾驶提醒。
   * `speak` 不传就只卡片（浏览器预览）；`onRestActive` 让 App 把暖暖切到 alert 态。
   */
  reminders?: {
    legs?: TripPlanLeg[];
    limitMin?: number;
    density?: ReminderDensity;
    enabled?: boolean;
    muted?: boolean;
    speak?: (line: string, kind: "stop" | "rest") => Promise<boolean>;
    isInFlight?: () => boolean;
    onEvent?: (e: EnRouteEvent) => void;
    onRestActive?: (active: boolean) => void;
    /** 语音「闭嘴」的计数信号：每变一次，控制器 hush 一次（本段静默）。 */
    hushSignal?: number;
  };
}

export function HudScreen({
  theme,
  snapshot,
  tipsPage = 1,
  tipsGestureProps,
  tipsFooter,
  assistantGestureProps,
  assistantHint,
  tripMap,
  departurePlan,
  mapView,
  home,
  assistantMode,
  onAssistantDismiss,
  mic,
  trips,
  vehicle,
  reminders,
}: HudScreenProps) {
  // 哨兵指示：两个布局分支共用一份，贴在暖暖身侧，避开右上角「暖暖出发演示」的重播/关闭按钮。
  // 落位交给 `.hud-assistant-mic`（与 EDGE_ANCHORS.assistantHero 同源），
  // 不在这里写内联坐标：竖屏另有一套锚点。
  const micNode = mic ? (
    <MicIndicator
      size="cockpit"
      variant="icon"
      className="hud-assistant-mic"
      mode="always-on"
      state={mic.state}
      micEnabled={mic.micEnabled}
      degraded={mic.degraded}
      onToggleMic={mic.onToggleMic}
    />
  ) : null;
  const sprites = SPRITES[theme];
  const { trip, energy, tips, weather, assistantState, freshness, leg } = snapshot;

  /*
   * 跟车进度。hook 必须在任何 return 之前：下面的 `if (tripMap)` 是一条早退分支，
   * 把 useState 写在它里面会让两次渲染的 hook 数量不一致，React 会抛错。
   */
  const [navProgress, setNavProgress] = useState<NavTripProgress | undefined>(undefined);
  const navOnProgress = tripMap?.nav?.onProgress;
  /*
   * 途中提醒：判据与卡片状态在 @cabinhug/ui 的控制器里，这里只把进度帧喂进去。
   * 换一次导航（nav.key 变）控制器重建；不在跟车时归零。
   */
  const enRoute = useEnRouteReminders({
    active: Boolean(tripMap?.nav),
    navKey: tripMap?.nav?.key,
    legs: reminders?.legs,
    limitMin: reminders?.limitMin,
    density: reminders?.density,
    enabled: reminders?.enabled,
    speak: reminders?.speak,
    isInFlight: reminders?.isInFlight,
    onEvent: reminders?.onEvent,
  });
  const hushSignal = reminders?.hushSignal ?? 0;
  const enRouteHush = enRoute.hush;
  useEffect(() => {
    if (hushSignal > 0) enRouteHush();
  }, [hushSignal, enRouteHush]);
  const onRestActive = reminders?.onRestActive;
  const restActive = enRoute.card?.reminder.kind === "rest" && !enRoute.card.collapsed;
  useEffect(() => {
    onRestActive?.(Boolean(restActive));
  }, [onRestActive, restActive]);
  const enRouteOnProgress = enRoute.onProgress;
  const handleNavProgress = useCallback(
    (p: NavTripProgress) => {
      setNavProgress(p);
      navOnProgress?.(p);
      enRouteOnProgress(p);
    },
    [navOnProgress, enRouteOnProgress],
  );

  /*
   * 屏底状态栏的「开始行程」→ 出发动画（CabinArrivalDemo）。信号计数在这里，
   * 两条路径（钥匙 / 状态栏）播的是同一段动画，见 CabinArrivalDemo 的 `playSignal`。
   */
  const [departSignal, setDepartSignal] = useState(0);
  const startTrip = useCallback(() => setDepartSignal((n) => n + 1), []);

  const terminal = trip.nodes[trip.nodes.length - 1];
  const finalAnchor = terminal ? NODE_ANCHORS[terminal.anchor] : undefined;
  const page = tips.pages[tipsPage - 1] ?? tips.pages[0];
  /*
   * 没有贴纸的 key 不上卡。
   *
   * 契约表（`PRETRIP_ITEMS`）与贴纸独立补齐，先有 key 后有图是常态。
   * 不过滤时 `<img src={undefined}>` 会在卡上留一个有名字没有图的空格子。
   */
  /*
   * 提示卡窗口里轮播的是两类卡：行前物品 / 目的地推荐。
   *
   * 分流收成下面这一个 `windowCard` 变量，而不是在两处渲染点各写一遍三元，
   * 避免只改一处（见下面 AssistantDock 那条注释）。
   * 两类卡的 page/pageCount/gestureProps/footer 完全一样：它们共用同一套轮播状态。
   */
  const pageItems = isHighlightsPage(page)
    ? []
    : page.items
        .filter((it) => sprites.items[it.key] !== undefined)
        .map((it) => ({ ...it, icon: sprites.items[it.key] }));

  /*
   * 三态：无行程 = 只有提示卡；有行程未选中 = 右列只有周日历卡；选中 = 顶部日期条 + 紧凑列表 + 提示卡。
   * 提示卡在「有行程且未选中」时不渲染（由 React 决定，不靠 CSS 藏）。
   */
  const hasTrips = Boolean(trips && trips.entries.length > 0);
  const selectedTrip = trips && trips.selectedPlanId ? trips.entries.find((e) => e.planId === trips.selectedPlanId) : undefined;
  const showTips = !hasTrips || selectedTrip !== undefined;

  const windowCard = !showTips ? null : isHighlightsPage(page) ? (
    <HighlightsCard
      highlights={page.highlights}
      page={tipsPage}
      pageCount={tips.pages.length}
      gestureProps={tipsGestureProps}
      footer={tipsFooter}
    />
  ) : (
    <TipsCard
      weatherIcon={sprites.weather[weather.kind] ?? sprites.weather.sunny}
      weatherSource={weather.source}
      headline={tips.headline}
      items={pageItems}
      page={tipsPage}
      pageCount={tips.pages.length}
      gestureProps={tipsGestureProps}
      footer={tipsFooter}
    />
  );

  /*
   * 行程列表卡：与 `windowCard` 同一规则，只写一处、用两处。
   * 没有行程不渲染，`hud-stage--has-trips` 也不加，提示卡窗尺寸不变。
   */
  /*
   * 选中态不显示行程卡：右列只剩提示卡，顶部日期条是唯一的行程锚点，
   * 点 × 才回到周日历卡。所以 `hud-stage--has-trips`（提示卡下移让位）也只在未选中态加；
   * 那时提示卡不渲染，这个类只是给舞台一个"有行程"的标记。
   */
  const tripsCard = !trips || !hasTrips || selectedTrip ? null : (
    <TripCalendarCard
      entries={trips.entries}
      today={trips.today}
      homeCity={home?.city}
      weatherIcons={sprites.weather}
      poiIcons={sprites.poi}
      onSelect={trips.onSelect}
      onOpenReview={trips.onOpenReview}
    />
  );
  /*
   * 顶部日期条只在选中态，且跟车时不渲染：跟车顶栏占同一带（下一站与 ETA 比日期要紧）。
   */
  const dateBanner =
    trips && selectedTrip && !tripMap?.nav ? (
      <TripDateBanner
        entry={selectedTrip}
        today={trips.today}
        onClose={trips.onClearSelection}
        showTools
        menuOpen={trips.detailMenuOpen ?? false}
        onToggleMenu={trips.onToggleDetailMenu}
        onOpenDetail={trips.onOpenDetail}
      />
    ) : null;
  /*
   * 行程详情抽屉：与 `windowCard` / `tripsCard` / `dateBanner` 同一规则，
   * 只写一处、用两处。它盖在提示卡窗之上，轮播由 App 在打开期间暂停。
   * 跟车时仍可打开（可看不可改）；日期条让位给跟车顶栏是因为占同一带。
   */
  const detailDrawer =
    trips && selectedTrip && trips.detailOpen ? (
      <TripDetailDrawer
        // 画的是选中那一程的快照，不是 App 的当前行程：多程时两者不同。
        plan={selectedTrip.plan}
        entry={selectedTrip}
        selectedDay={trips.detailDay ?? 1}
        onSelectDay={trips.onSelectDetailDay ?? (() => {})}
        onClose={trips.onCloseDetail ?? (() => {})}
        canEdit={trips.canEditDetail ?? true}
        editing={trips.detailEditing ?? false}
        edits={trips.detailEdits ?? []}
        onChangeEdits={trips.onChangeDetailEdits}
        onStartEdit={trips.onStartDetailEdit}
        onCancelEdit={trips.onCancelDetailEdit}
        onSave={trips.onSaveDetailEdits}
        saving={trips.detailSaving ?? false}
        saveDisabledReason={trips.detailSaveDisabledReason}
        selectedServices={trips.selectedServices}
        onToggleService={trips.onToggleService}
        confirmDiscard={trips.detailConfirmDiscard ?? false}
        onConfirmDiscard={trips.onConfirmDiscardDetail}
        onKeepEditing={trips.onKeepEditingDetail}
      />
    ) : null;

  const stageClass = selectedTrip ? "hud-stage--trip-selected" : hasTrips ? "hud-stage--has-trips" : undefined;

  /*
   * 暖暖的对话气泡（新版 UI 定稿）。只在没选中行程、她也闲着时说「说说你的下一段旅程吧」：
   * 选中了行程再问下一段是答非所问；她在听/在想/在说时气泡会盖住状态卡的语义。
   * 覆盖文案（麦克风未授权那类）在场时也不说：卡上写的是故障，不与邀约并列。
   */
  const bubble =
    !selectedTrip && assistantState === "idle" && !assistantHint ? "说说\n你的下一段旅程吧！" : undefined;

  /*
   * 屏底状态栏：两个布局分支共用一份（与 windowCard 同一"只写一处"规则）。
   * 预计里程 / 用时 / 道路情况只认 `snapshot.leg`
   * （出发地 → 今天第一站的高德规划，网关每轮带来）；没有就三格「暂无」。
   */
  /*
   * 编辑态时底栏「开始行程」降为禁用：一屏只有一个主行动，
   * 那一刻的主行动是抽屉里的「保存调整」。
   */
  const statusBar = (
    <StatusBar
      summary={energy}
      leg={leg}
      stale={freshness.stale}
      vehicle={vehicle}
      onStart={startTrip}
      startDisabled={trips?.detailEditing === true}
    />
  );

  // ── 真实地图行程模式：真实坐标标注 + 路线动画 + 逐日切换。
  //    装饰生活环整套不渲染：两套坐标系不能叠加。
  if (tripMap) {
    return (
      <HudStage theme={theme} className={stageClass}>
        <AmapTripLayer
          theme={theme}
          stops={tripMap.stops}
          showDayBadge={tripMap.showDayBadge}
          closeLoop={tripMap.closeLoop}
          planKey={tripMap.planKey}
          focusDay={tripMap.focusDay}
          servicePois={tripMap.servicePois}
          animated={!freshness.stale}
          navKey={tripMap.nav?.key}
          navSpeedup={tripMap.nav?.speedup}
          onNavProgress={tripMap.nav ? handleNavProgress : undefined}
          onFallback={tripMap.onFallback}
          onStopClick={tripMap.onStopClick}
          guidedSpots={tripMap.guidedSpots}
        />
        {tripMap.nav && (
          <NavBar nav={tripMap.nav} progress={navProgress} />
        )}
        {tripMap.nav && enRoute.card && (
          <EnRouteReminderCard
            card={enRoute.card}
            density={reminders?.density}
            muted={reminders?.muted}
            onAck={enRoute.ack}
            onRestDecision={enRoute.decideRest}
          />
        )}
        {tripMap.tabs.length > 1 && (
          <div className="hud-daytabs" role="tablist" aria-label="行程视图切换">
            {tripMap.tabs.map((t) => (
              <button
                key={String(t.value)}
                type="button"
                role="tab"
                aria-selected={tripMap.active === t.value}
                className={tripMap.active === t.value ? "is-active" : ""}
                onClick={() => tripMap.onSelect(t.value)}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
        {tripMap.lodgingNotes && tripMap.lodgingNotes.length > 0 && (
          // 住宿策略横幅：换酒店日/到达日的"行李怎么办"要在图上有答案。
          <div className="hud-lodging" aria-label="住宿安排">
            {tripMap.lodgingNotes.map((l) => (
              <span key={l.day} className="hud-lodging__item">
                <b>D{l.day}·{LODGING_LABEL[l.strategy]}</b>
                {l.note ? `：${l.note}` : ""}
              </span>
            ))}
          </div>
        )}
        {dateBanner}
        {tripsCard}
        {windowCard}
        {detailDrawer}
        {statusBar}
        <AssistantDock
          sprite={sprites.assistant}
          workingSprite={sprites.assistantWorking}
          state={assistantState}
          mode={assistantMode}
          onDismiss={onAssistantDismiss}
          gestureProps={assistantGestureProps}
          primaryLabel={assistantHint?.primary}
          secondaryLabel={assistantHint?.secondary}
          // 车机端点助手不进对话（触屏上会吃掉长按说话），进对话只走底部「对话」按钮。
          // 短按手势用于打断：她在说/在想时点一下就停。
          tapOpensDialog={false}
          tapInterrupts
          compact
          bubble={bubble}
        />
        {/* assistantState 下传给音景：暖暖说话时它全静。 */}
        <CabinArrivalDemo theme={theme} plan={departurePlan} assistantState={assistantState} playSignal={departSignal} />
        {micNode}
      </HudStage>
    );
  }

  return (
    <HudStage theme={theme} className={stageClass}>
      {/* ① 地图：铺满视口，任意屏幕比例都无信箱黑边。
          配了 AMAP_JS_KEY 走高德真实底图，未配/离线/加载失败回退程序化底图；
          回退在 AmapBackdrop 内部完成，这里不需要分支。 */}
      <AmapBackdrop
        theme={theme}
        center={mapView?.restored ?? (home ? { lat: home.lat, lon: home.lon } : undefined)}
        zoom={mapView?.restored?.zoom}
        focus={mapView?.focus ?? undefined}
        onViewportChange={mapView?.remember}
      />

      {/* 「定位到我」。只挪镜头，不下发任何指令，符合 HUD 红线。
          定位关着时它也在，点了会说清楚去哪儿打开（见 LocateButton 文件头）。 */}
      {mapView && (
        <LocateButton
          onLocated={(fix) => mapView.focusOn({ lat: fix.lat, lon: fix.lon, zoom: 15 })}
        />
      )}

      {/* ② 竖屏 V2：与横屏生活环分开排布为自上而下时间轴（CSS 仅在真竖屏显示）。 */}
      <PortraitTimeline
        weatherIcon={sprites.weather[weather.kind] ?? sprites.weather.sunny}
        origin={{
          anchor: trip.origin.anchor,
          // 竖屏时间轴同款：没有行程时首格显示常住地而不是通用的「家」。
          name: home?.city ?? trip.origin.name,
          sprite: spriteFor(sprites, trip.origin),
          origin: true,
        }}
        nodes={trip.nodes.map((node, i) => ({
          anchor: node.anchor,
          name: node.name,
          sprite: spriteFor(sprites, node),
          index: i + 1,
          terminal: i === trip.nodes.length - 1,
        }))}
        animated={!freshness.stale}
      />

      {/* ③ 横屏/近方屏：固定 1672:941 等比生活环，构图永不拉伸。 */}
      <HudScene>
        <LifeRing
          activeSegment={trip.activeSegment}
          finalGlow={finalAnchor ? { cx: finalAnchor.cx, cy: finalAnchor.cy } : undefined}
          animated={!freshness.stale}
        />

        {/* 出发锚点：3D 小屋，定位 pin 仅辅助（Brief §3.1）。
            没有行程时它表示"家在哪"：名字用常住地城市名，
            拿不到常住地才退回通用的「家」。 */}
        <PoiNode
          anchor={trip.origin.anchor}
          sprite={spriteFor(sprites, trip.origin)}
          name={trip.origin.name}
          origin
          originLabel={home?.city}
        />

        {/* ①–④：序号徽章优先于地点名，随真实计划重新编号 */}
        {trip.nodes.map((node, i) => (
          <PoiNode
            key={node.anchor}
            anchor={node.anchor}
            sprite={spriteFor(sprites, node)}
            name={node.name}
            index={i + 1}
            terminal={i === trip.nodes.length - 1}
          />
        ))}
      </HudScene>

      {/* ④ 悬浮层：横屏贴视口边缘；竖屏按 V2 连续信息区重新落位。 */}
      {dateBanner}
      {tripsCard}
      {windowCard}
      {detailDrawer}

      {statusBar}

      {/* 本文件有两处 AssistantDock（行程地图模式与默认模式），改动须两处同步；
          只改一处时行程视图里的暖暖会一直停在休息态，且不报错。 */}
      <AssistantDock
        sprite={sprites.assistant}
        workingSprite={sprites.assistantWorking}
        state={assistantState}
        mode={assistantMode}
        onDismiss={onAssistantDismiss}
        gestureProps={assistantGestureProps}
        primaryLabel={assistantHint?.primary}
        secondaryLabel={assistantHint?.secondary}
          // 车机端点助手不进对话（触屏上会吃掉长按说话），进对话只走底部「对话」按钮。
          // 短按手势用于打断：她在说/在想时点一下就停。
          tapOpensDialog={false}
          tapInterrupts
          compact
          bubble={bubble}
      />
      {/* assistantState 下传给音景：暖暖说话时它全静。 */}
      <CabinArrivalDemo theme={theme} plan={departurePlan} assistantState={assistantState} playSignal={departSignal} />
      {micNode}
    </HudStage>
  );
}
