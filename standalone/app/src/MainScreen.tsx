/**
 * 主界面（内部文档 四张定稿）：一个外壳、两种主区。
 *
 *   地图（01–03）  地图铺满，浮层：缩略图 · 行程概要 · 天气 · 行程详情面板（1 倍 / 2 倍）· 缩放
 *   行程（04）     全屏行程页：每日安排 / 住宿信息 / 出行提示
 *
 * 助手窗在两种主区上都能叫出来。这里只管"哪块开着、选中哪天哪站"，各块长什么样在 features/ 里。
 * 只出现单机版有的能力：没有麦克风、相机、附件、车况条、车辆档案、收藏。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { TripPlanSnapshot } from "@cabinhug/shared";
import {
  ConfirmSheet,
  selectedServicePois,
  type ServiceCategoryKey,
  type TripMapControl,
} from "@cabinhug/ui";

import { gw, host } from "./api";
import {
  AssistantDock,
  type DockHandle,
  type QuickAction,
} from "./features/chat/AssistantDock";
import { MapControls } from "./features/map/MapControls";
import { MapStage } from "./features/map/MapStage";
import { MiniMap } from "./features/map/MiniMap";
import { TripMap } from "./features/map/TripMap";
import { WeatherChip } from "./features/map/WeatherChip";
import { GuideOverlay } from "./features/guide/GuideOverlay";
import { useGuide } from "./features/guide/useGuide";
import { HistoryPanel } from "./features/sessions/HistoryPanel";
import { Settings } from "./features/setup/Settings";
import { AppShell } from "./features/shell/AppShell";
import { NavRail } from "./features/shell/NavRail";
import { StatusBar } from "./features/shell/StatusBar";
import { ALL_DAYS } from "./features/trip/DayTabs";
import { TripBoard } from "./features/trip/TripBoard";
import { TripPanel, type PanelWidth } from "./features/trip/TripPanel";
import { TripSummary, TripSummaryEmpty } from "./features/trip/TripSummary";
import {
  draftFromSession,
  isConfirmed,
  mapStops,
  spotNumbers,
  todayIndex,
  tripTitle,
} from "./trip";
import type { HostStatus, SessionItem } from "./types";
import { Button, Card } from "./ui";
import { useChat } from "./useChat";

type View = "map" | "board";

/** 确认后沿途服务在后台补算（十几秒到一两分钟）：这期间每 15 秒重读一次，最多 8 次。 */
const BACKFILL_POLL_MS = 15_000;
const BACKFILL_POLL_MAX = 8;

/**
 * 已确认的行程读 `GET /v1/trip-plan/current`：后台补算的沿途服务、目的地推荐、出发段都写在那一份上，
 * 会话草案里没有（ACR-065）。只在两边是同一程时换（目的地、出发日、天数相同），别的情况照用草案。
 */
async function withCommitted(
  draft: TripPlanSnapshot,
): Promise<TripPlanSnapshot> {
  if (draft.status !== "confirmed") return draft;
  try {
    const r = await gw<{ plan?: TripPlanSnapshot | null }>(
      "GET",
      "/v1/trip-plan/current",
    );
    const c = r.plan;
    return c &&
      c.destination === draft.destination &&
      c.startDate === draft.startDate &&
      c.days === draft.days
      ? c
      : draft;
  } catch {
    return draft;
  }
}

export function MainScreen({
  status,
  mapReady,
}: {
  status: HostStatus;
  mapReady: boolean;
}) {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [plan, setPlan] = useState<TripPlanSnapshot | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [view, setView] = useState<View>("map");
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState<PanelWidth>("1x");
  const [day, setDay] = useState(ALL_DAYS);
  const [spot, setSpot] = useState<{ day: number; name: string } | null>(null);
  const [dockOpen, setDockOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** 地图上画哪一天的哪几类沿途服务（面板里点格子切换）。 */
  const [serviceSel, setServiceSel] = useState<{
    day: number;
    keys: ServiceCategoryKey[];
  } | null>(null);
  const mapControl = useRef<TripMapControl | null>(null);
  const dock = useRef<DockHandle>(null);

  const loadSessions = useCallback(async () => {
    const page = await gw<{ sessions: SessionItem[] }>(
      "GET",
      "/v1/sessions?limit=50",
    );
    setSessions(page.sessions ?? []);
    return page.sessions ?? [];
  }, []);

  const loadPlan = useCallback(async (sessionId: string | null) => {
    if (!sessionId) return setPlan(null);
    try {
      const r = await gw<{ plan: TripPlanSnapshot | null }>(
        "GET",
        `/v1/session/${sessionId}/trip-draft`,
      );
      setPlan(
        r.plan && r.plan.skeleton?.length ? await withCommitted(r.plan) : null,
      );
    } catch {
      setPlan(null);
    }
  }, []);

  useEffect(() => {
    void loadSessions().then((list) => {
      const open = list.find((x) => !x.closedAt);
      if (open) setCurrent(open.sessionId);
    });
  }, [loadSessions]);

  useEffect(() => {
    void loadPlan(current);
  }, [current, loadPlan]);

  // 草案按人存，别处（另一段对话、另一个窗口）改了它，这里不会收到事件；回到窗口时重读一次。
  useEffect(() => {
    const onFocus = () => {
      void loadPlan(current);
      void loadSessions();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [current, loadPlan, loadSessions]);

  // 刚确认、沿途服务还在后台算：隔一会儿重读，算好了格子自己出现，不用车主刷新。
  const backfillPolls = useRef(0);
  const awaitingServices = plan?.status === "confirmed" && !plan.services;
  useEffect(() => {
    if (!awaitingServices) {
      backfillPolls.current = 0;
      return;
    }
    if (backfillPolls.current >= BACKFILL_POLL_MAX) return;
    const t = setTimeout(() => {
      backfillPolls.current += 1;
      void loadPlan(current);
    }, BACKFILL_POLL_MS);
    return () => clearTimeout(t);
  }, [awaitingServices, plan, current, loadPlan]);

  // 换了一份行程：选中的天与站对不上就放掉，不让面板指着一个已经不存在的点。
  useEffect(() => {
    setServiceSel(null);
    if (!plan) {
      setPanelOpen(false);
      setSpot(null);
      setDay(ALL_DAYS);
      return;
    }
    setDay((d) => (d > plan.days ? ALL_DAYS : d));
    setSpot((x) =>
      x &&
      plan.skeleton
        .find((d) => d.day === x.day)
        ?.spots.some((p) => p.name === x.name)
        ? x
        : null,
    );
  }, [plan]);

  const chat = useChat(current, {
    onTurnEnd: () => {
      void loadPlan(current);
      void loadSessions();
    },
    onTitle: () => void loadSessions(),
  });

  function openSession(sessionId: string) {
    setNotice(null);
    setHistoryOpen(false);
    setCurrent(sessionId);
  }

  async function newTrip() {
    const r = await gw<{ sessionId: string }>("POST", "/v1/session", {});
    setNotice(null);
    setPlan(null);
    setHistoryOpen(false);
    setView("map");
    setDockOpen(true);
    setCurrent(r.sessionId);
    void loadSessions();
  }

  /** 建一段新对话并把这句话排上：等它的事件流接上再发（`chat.queue`）。 */
  async function startWith(text: string) {
    const r = await gw<{ sessionId: string }>("POST", "/v1/session", {});
    chat.queue(r.sessionId, text);
    setCurrent(r.sessionId);
    void loadSessions();
  }

  async function sendOrStart(text: string) {
    setNotice(null);
    if (!current) return startWith(text);
    if ((await chat.send(text)) !== "expired") return;
    // 服务端按空闲把这段对话关了（409 session_expired，时长在服务端配置）。
    // 与两个端同一个处置：换一段新对话把同一句话发出去，不让车主的话丢掉。
    await startWith(text);
    setNotice("上一段对话停得太久，已经结束了；这句话发到了新的一段对话里。");
  }

  const stops = useMemo(() => (plan ? mapStops(plan) : []), [plan]);
  const seq = useMemo(
    () => (plan ? spotNumbers(plan) : new Map<string, number>()),
    [plan],
  );
  const ready = status.phase === "ready";
  const today = plan ? todayIndex(plan, new Date()) : undefined;
  const confirmed = plan !== null && isConfirmed(plan);
  const guide = useGuide(confirmed);
  // 选了某天的沿途服务，地图就聚到那一天（面板选了天时以面板为准）。
  const focusDay = panelOpen && day !== ALL_DAYS ? day : serviceSel?.day;
  const servicePois = useMemo(
    () =>
      plan && serviceSel
        ? selectedServicePois(plan, serviceSel.day, serviceSel.keys)
        : [],
    [plan, serviceSel],
  );
  const services = {
    selectedFor: (d: number) => (serviceSel?.day === d ? serviceSel.keys : []),
    onToggle: (d: number, key: ServiceCategoryKey) =>
      setServiceSel((cur) => {
        const keys = cur?.day === d ? cur.keys : [];
        const next = keys.includes(key)
          ? keys.filter((k) => k !== key)
          : [...keys, key];
        return next.length ? { day: d, keys: next } : null;
      }),
  };

  function openPanel(d: number, width: PanelWidth = "1x") {
    setView("map");
    setDay(d);
    setPanelWidth(width);
    setPanelOpen(true);
  }

  function locate(name: string) {
    // 2 倍面板盖住大半张图，推过去的点会落在它底下：先收回 1 倍，等面板让开再推镜头。
    setPanelWidth("1x");
    requestAnimationFrame(() => mapControl.current?.focusStop(name));
  }

  const otherSession =
    plan !== null && current !== null && !draftFromSession(plan, current);
  const panelNotice = otherSession
    ? `这份${isConfirmed(plan!) ? "行程" : "草案"}是在另一段对话里排的。草案每人只留最近的一份，这段对话里排过的已被它替换${isConfirmed(plan!) ? "。" : "；「定下来」定的就是这一份。"}`
    : undefined;

  const quickActions: QuickAction[] = plan
    ? [
        {
          label: "调整行程",
          icon: "edit",
          run: () => dock.current?.prefill("帮我调整一下行程："),
        },
        {
          label: today ? "查看今日安排" : "查看每日安排",
          icon: "calendar",
          run: () => openPanel(today ?? 1),
        },
      ]
    : [];

  const sessionTitle = sessions.find((x) => x.sessionId === current)?.title;

  return (
    <AppShell
      rail={
        <NavRail
          newDisabled={!ready}
          onNew={() => void newTrip()}
          onSettings={() => setSettingsOpen(true)}
          items={[
            {
              id: "map",
              label: "地图",
              icon: "pin",
              active: view === "map" && !historyOpen,
              onClick: () => (setHistoryOpen(false), setView("map")),
            },
            {
              id: "trip",
              label: "行程",
              icon: "calendar",
              active: view === "board" && !historyOpen,
              onClick: () => (setHistoryOpen(false), setView("board")),
            },
            {
              id: "chat",
              label: "对话",
              icon: "chat",
              active: dockOpen,
              onClick: () => setDockOpen((v) => !v),
            },
            {
              id: "history",
              label: "历史",
              icon: "clock",
              active: historyOpen,
              onClick: () => setHistoryOpen((v) => !v),
            },
          ]}
        />
      }
      status={
        <StatusBar
          status={status}
          busy={chat.busy}
          onOpenLogs={() => void host.openLogDir()}
        />
      }
    >
      <MapStage
        map={
          <TripMap
            ready={mapReady}
            stops={stops}
            planKey={plan ? `${plan.destination}-${stops.length}` : "none"}
            focusDay={focusDay}
            control={mapControl}
            servicePois={servicePois}
            onSpotClick={confirmed ? guide.openSpot : undefined}
          />
        }
        mini={
          stops.length > 1 ? (
            <MiniMap
              stops={stops}
              onRecenter={() => mapControl.current?.recenter()}
            />
          ) : undefined
        }
        summary={
          plan ? (
            <TripSummary
              plan={plan}
              day={day !== ALL_DAYS ? day : (today ?? 1)}
              busy={chat.busy}
              onSend={(t) => void sendOrStart(t)}
            />
          ) : (
            <TripSummaryEmpty onAsk={() => setDockOpen(true)} />
          )
        }
        aside={
          plan?.weather ? (
            <WeatherChip city={plan.destination} weather={plan.weather} />
          ) : undefined
        }
        actions={
          plan && !panelOpen ? (
            <Button
              variant="float"
              size="lg"
              shape="pill"
              icon="list"
              trailingIcon="chevron-right"
              onClick={() => openPanel(day)}
            >
              行程详情
            </Button>
          ) : undefined
        }
        controls={
          plan && !panelOpen ? (
            <MapControls
              onZoomIn={() => mapControl.current?.zoomIn()}
              onZoomOut={() => mapControl.current?.zoomOut()}
            />
          ) : undefined
        }
        panelWidth={panelWidth}
        panel={
          plan && panelOpen ? (
            <TripPanel
              plan={plan}
              width={panelWidth}
              onWidth={setPanelWidth}
              day={day}
              onDay={(d) => {
                setDay(d);
                setSpot(null);
              }}
              spot={spot}
              onSpot={setSpot}
              seqOf={(d, name) => seq.get(`${d}:${name}`)}
              notice={panelNotice}
              onClose={() => setPanelOpen(false)}
              onFullscreen={() => setView("board")}
              onLocate={locate}
              guide={guide}
              services={services}
            />
          ) : undefined
        }
      />

      {view === "board" &&
        (plan ? (
          <TripBoard
            plan={plan}
            title={sessionTitle ?? tripTitle(plan)}
            day={day}
            onDay={setDay}
            onExit={() => openPanel(day, panelWidth)}
            onClose={() => {
              setView("map");
              setPanelOpen(false);
            }}
            onAsk={() => setDockOpen(true)}
            onOpenDay={(d) => openPanel(d)}
            guide={guide}
          />
        ) : (
          <EmptyBoard onAsk={() => setDockOpen(true)} />
        ))}

      {historyOpen && (
        <HistoryPanel
          sessions={sessions}
          current={current}
          onOpen={openSession}
          onNew={() => void newTrip()}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      <GuideOverlay guide={guide} />

      {/* 全屏行程页与导览页上不留收起条（定稿 04），由页头的头像叫出来。 */}
      {((view === "map" && !guide.open) || dockOpen) && (
        <AssistantDock
          ref={dock}
          open={dockOpen}
          onOpenChange={setDockOpen}
          chat={chat}
          ready={ready}
          notice={notice}
          actions={quickActions}
          onSend={(t) => void sendOrStart(t)}
          onHistory={() => setHistoryOpen(true)}
        />
      )}

      {/* 与车机端同一个确认弹层（天序时间线、景点、住宿与估算、大交通、体检摘要），不另做一份。 */}
      {chat.permission && (
        <ConfirmSheet
          request={chat.permission}
          onDecide={(ok) => void chat.answerPermission(ok)}
        />
      )}
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
    </AppShell>
  );
}

function EmptyBoard({ onAsk }: { onAsk(): void }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: "var(--sa-z-page)",
        display: "grid",
        placeItems: "center",
        background: "var(--sa-color-surface)",
      }}
    >
      <Card
        padding="lg"
        style={{
          textAlign: "center",
          display: "grid",
          gap: "var(--sa-space-3)",
          justifyItems: "center",
        }}
      >
        <strong style={{ font: "var(--sa-text-title)" }}>还没有行程</strong>
        <span style={{ color: "var(--sa-color-text-secondary)" }}>
          说一句想去哪、玩几天，排好的行程会出现在这里
        </span>
        <Button variant="primary" shape="pill" icon="chat" onClick={onAsk}>
          和助手说
        </Button>
      </Card>
    </div>
  );
}
