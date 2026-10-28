/**
 * 大屏的"现在流到哪了"（实时 + 可锁定到历史会话）。
 *
 * # 走实时总线而不是轮询仓储
 *
 * 轨迹仓储是缓冲 + 定时批量写的（在写入路径上 await 落库会把数据库延迟加到
 * 每一次 token 之间），读库最快也要等一个刷盘周期。这里走运行时的实时总线，
 * 与落库并列扇出，互不阻塞。
 *
 * # 三种"无内容"分开提示
 *
 *   · 没连上（网关或运行时不在）——标红；
 *   · 连着但暂时没有对话——正常，提示等待；
 *   · 连着、有会话、但这一轮很久没有新事件——需要关注。
 *
 * 合并成一句"暂无数据"会让故障看起来像正常状态。
 *
 * # 锁定会话：实时的归实时总线，历史的归回放接口
 *
 * 锁定的会话若仍在实时跟踪列表里，走实时路径（仍能看到它继续推进）；
 * 不在（历史会话）就取回放接口的轨迹逐轮回放，并标明这是回放而非实时，
 * 以免停住的图被读成"系统空闲"。
 * 两条路画的是同一张图、同一个 `projectRun`，不为回放另做一套投影。
 *
 * # 谁在推进那张图：两个来源，一个模式开关
 *
 *   · 实时主体 + `live` 模式 —— 图由新事件推进（最新一轮，来了就画）；
 *   · 其余一切 —— 图由回放引擎推进（`playback.ts` 按 cursor 逐条放）。
 *
 * 历史会话默认就在回放里（"回放每个 turn"）；实时会话默认跟随，
 * 控制条上的重播 / 暂停 / 点某一轮会把它临时切进回放，放完再回到跟随。
 * 判据全在 `playback.ts` 那个纯函数里，这里只负责挂表与接线。
 *
 * # 图一旦画出来就不再卸载
 *
 * 实时事件里混着会话外事件（`unknown` 兜底桶），会反复改变"最近活动的会话"，
 * 导致图被卸载再挂回、整页上下跳动。选谁来画的判据在 `live-model.ts`；
 * 这里另外保证画过一次之后保留最后一帧。
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { api, ApiError } from "../../api";
import { openEventStream, type StreamState } from "../../api/stream";
import { RunFlow } from "../workflow/RunFlow";
import { projectRun, type TraceLike } from "../workflow/projection";
import {
  EMPTY,
  ingest,
  mergeSessionTitles,
  sessionOf,
  type LiveState,
  type LiveTraceEvent,
} from "./live-model";
// 筛选参数与「会话与对话」页共用同一份（含日期 → 时间点的换算），保证两处口径一致。
import { hasFilters, sessionQuery } from "../sessions/filters";
import { PlaybackBar } from "./PlaybackBar";
import {
  advance,
  backToLive,
  currentTurn,
  livePlayback,
  playTurn,
  replayCurrent,
  replayPlayback,
  stepTurn,
  togglePlay,
  turnsOf,
  type Playback,
  type PlaybackTurn,
} from "./playback";

/** 超过这么久没有新事件，就不再说"正在跑"。 */
const IDLE_MS = 90_000;
/**
 * 会话标题表的复取间隔。
 *
 * 标题是首轮之后异步补写的，新会话暂无标题是常态，因此需要定时复取。
 * 20 秒一次：一个 groupBy + 一个 in 查询，比 KPI 的 10 秒轮询还轻。
 */
const TITLE_MS = 20_000;
/**
 * 显示中的会话还没有标题时的补取节奏，以及最多补几次。
 *
 * 新会话的标题在首轮结束之后才补写，这段时间按更短的间隔补取。
 * 次数有上限：`guide-*`、`__selfcheck__` 这类会话永远不会有标题。
 */
const TITLE_PENDING_MS = 5_000;
const TITLE_PENDING_TRIES = 3;
/**
 * 事件成批刷进状态的间隔。
 *
 * 一次 fan-out 几十条事件在几百毫秒内到齐，逐条 setState 就是几十次重渲染，
 * 每次都要重建整张图的节点与边。250ms 一批，人眼看不出延迟，重渲染少一个量级。
 */
const FLUSH_MS = 250;
/**
 * 回放推进的心跳。
 *
 * 比 `MIN_GAP` 密一档即可：真正的节奏由 `gapBefore` 定，心跳只负责询问是否放下一条。
 * 与事件刷新（250ms）分开：那条用于减少重渲染，这条用于让回放连续。
 */
const TICK_MS = 60;
/**
 * 历史会话一次取多少条事件。
 *
 * 500 条约等于最近十几轮，足以回放会话的近况；完整历史在回放页。
 */
const REPLAY_LIMIT = 500;
/** 空轮次列表的常量：每次渲染新建一个 `[]` 会让下游的 memo 全部失效。 */
const EMPTY_TURNS: PlaybackTurn[] = [];
/** 会话列表一次取多少条（弹窗与标题表共用）。与"会话与对话"页的每页条数一致。 */
const SESSION_PAGE = 20;

/**
 * 会话选择弹窗的一行。
 *
 * 来源是 `/console/sessions`（与"会话与对话"页同一个接口）而不是轨迹表：
 * 轨迹表按 `sessionId` 分组，混有 `unknown` 兜底桶、`system:worker`、
 * `guide-*` 导览任务、`__selfcheck__` 自检，它们都不是会话，也画不出路径。
 */
interface SessionRow {
  sessionId: string;
  /** 会话标题；`null` = 尚未生成。 */
  title: string | null;
  /** `null` = 访客会话（车机上车声明选了访客模式），渲染时需明示而非留空。 */
  userId: string | null;
  turnCount: number;
  messageCount: number;
  updatedAt: string;
  lastMessageAt: number | null;
  /**
   * 轨迹事件条数（`withTraceCounts=1` 才有）。
   *
   * 与"轮次"不同：轮次是对话来回数，事件是运行落下的步数
   * （意图、路由、分支、工具调用、span…），决定这条会话有没有内容可回放。
   *
   * 它是整条会话的总数，而回放控制条上"事件 8/13"的分母是当前这一轮的。
   * 单轮会话两者相同，多轮会话则是"这一轮的 ≤ 列表里的"。
   *
   * `0` 与缺席含义不同：`0` 表示查了且没有（轨迹按天清理过），
   * 缺席表示未查询。因此渲染时判 `=== undefined`，不用 `|| 0`。
   */
  traceEvents?: number;
}

/** 历史会话的全部轮次（来自回放接口，非实时）。 */
interface ReplayTurns {
  sessionId: string;
  turns: PlaybackTurn[];
  redacted: boolean;
}

export function LiveFlow({
  title,
  pinned,
  onPinChange,
  onAutoSession,
}: {
  /** 页面标题。与连接状态、会话信息合并成同一行。 */
  title: string;
  /** 锁定到的会话；null = 跟随实时最近活动。 */
  pinned: string | null;
  onPinChange: (sessionId: string | null) => void;
  /** 跟随模式下当前画的是哪个会话——父层拿它去圈 KPI。 */
  onAutoSession: (sessionId: string | undefined) => void;
}): JSX.Element {
  const [state, apply] = useReducer(
    (prev: LiveState, batch: readonly LiveTraceEvent[]) => ingest(prev, batch, Date.now()),
    EMPTY,
  );
  const [stream, setStream] = useState<{ s: StreamState; detail?: string }>({ s: "connecting" });
  const [now, setNow] = useState(() => Date.now());
  const [picker, setPicker] = useState(false);
  const [replay, setReplay] = useState<
    { kind: "idle" } | { kind: "loading" } | { kind: "empty" } | { kind: "error"; detail: string } | { kind: "ok"; data: ReplayTurns }
  >({ kind: "idle" });
  const pending = useRef<LiveTraceEvent[]>([]);
  // 会话 → 标题。实时总线只给 id，标题另取（见 mergeSessionTitles 的说明）。
  const [titles, setTitles] = useState<Record<string, string>>({});

  useEffect(() => {
    const flush = setInterval(() => {
      if (pending.current.length === 0) return;
      const batch = pending.current;
      pending.current = [];
      apply(batch);
    }, FLUSH_MS);

    const handle = openEventStream<LiveTraceEvent>("/console/trace/stream", {
      onEvent: (e) => pending.current.push(e),
      onState: (s, detail) => setStream({ s, detail }),
    });
    return () => {
      clearInterval(flush);
      handle.close();
    };
  }, []);

  // "多久没有新事件"需要独立时钟：仅靠事件驱动时，没有事件就不会刷新。
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 2_000);
    return () => clearInterval(t);
  }, []);

  /** 并入一批行的标题（弹窗与定时复取共用同一条路）。 */
  const mergeTitles = useCallback((rows: SessionRow[]) => {
    setTitles((prev) => mergeSessionTitles(prev, rows));
  }, []);
  /**
   * 取一次会话标题表。
   *
   * 取不到时不报错、不占版面：标题是辅助信息，告警位置留给"实时通道断开"。
   */
  const pullTitles = useCallback(() => {
    api
      .get<{ sessions: SessionRow[] }>(`/console/sessions?limit=${SESSION_PAGE}`)
      .then((r) => mergeTitles(r.sessions))
      .catch(() => undefined);
  }, [mergeTitles]);

  // 锁定时优先在实时列表里找它；找不到才算历史会话。
  const liveSession = useMemo(() => sessionOf(state, pinned ?? undefined), [state, pinned]);
  const liveTurns = useMemo(() => turnsOf(liveSession?.events ?? []), [liveSession]);
  const autoSid = useMemo(() => sessionOf(state)?.sessionId, [state]);

  // 跟随模式画的是谁，如实报给父层（KPI 圈定跟着它走）。
  useEffect(() => {
    onAutoSession(autoSid);
  }, [autoSid, onAutoSession]);

  // 锁定的会话不在实时列表里 → 拉回放。锁定变化就重拉；回到跟随就清掉。
  const needReplay = pinned !== null && liveTurns.length === 0;
  useEffect(() => {
    if (!needReplay || pinned === null) {
      setReplay({ kind: "idle" });
      return;
    }
    let dead = false;
    setReplay({ kind: "loading" });
    api
      .get<{ timeline: Array<TraceLike>; redacted: boolean; hasMore: boolean }>(
        `/console/replay/${encodeURIComponent(pinned)}?limit=${REPLAY_LIMIT}`,
      )
      .then((r) => {
        if (dead) return;
        const all = turnsOf(r.timeline);
        if (all.length === 0) {
          setReplay({ kind: "empty" });
          return;
        }
        /*
         * 取的是最近 REPLAY_LIMIT 条事件（仓储按时间倒序取再反转）。
         * 还有更多时，最老的一轮通常只剩后半截，回放会画出不存在的路径，因此丢弃。
         * 只剩一轮时保留，topbar 会说明它被截断。
         */
        const truncated = r.hasMore && all.length > 1;
        setReplay({
          kind: "ok",
          data: {
            sessionId: pinned,
            turns: truncated ? all.slice(1) : all,
            redacted: r.redacted,
          },
        });
      })
      .catch((e: unknown) => {
        if (!dead) setReplay({ kind: "error", detail: e instanceof ApiError ? e.code : String(e) });
      });
    return () => {
      dead = true;
    };
  }, [needReplay, pinned]);

  // ── 当前主体：放谁的哪些轮次。历史会话走回放接口，其余都走实时缓冲。
  const historical = needReplay;
  const turns = historical
    ? replay.kind === "ok" && replay.data.sessionId === pinned
      ? replay.data.turns
      : EMPTY_TURNS
    : liveTurns;
  const turnsRef = useRef<PlaybackTurn[]>(turns);
  turnsRef.current = turns;

  /**
   * 回放状态。换主体就整个重置：历史会话从第一轮开始逐轮放，
   * 实时会话回到跟随最新；上一个会话的 cursor 对新会话无意义。
   *
   * 跟随模式下"最近活动的会话"变了也算换主体：正在插播的重播会被打断，
   * 回到跟随新会话，状态标签随即翻回"跟随最新轮次"。跟随模式的语义就是展示最新的那段。
   */
  const [pb, setPb] = useState<Playback>(() => livePlayback(Date.now()));
  const subject = `${historical ? "replay" : "live"}:${pinned ?? autoSid ?? ""}`;
  const lastSubject = useRef(subject);
  useEffect(() => {
    if (lastSubject.current === subject) return;
    lastSubject.current = subject;
    setPb(
      historical
        ? replayPlayback(turnsRef.current, Date.now())
        : livePlayback(Date.now()),
    );
  }, [subject, historical]);

  // 心跳：只在真的要推进时挂表（live 模式与暂停时不挂）。
  useEffect(() => {
    if (pb.mode === "live" || !pb.playing) return;
    const t = setInterval(() => setPb((p) => advance(p, turnsRef.current, Date.now())), TICK_MS);
    return () => clearInterval(t);
  }, [pb.mode, pb.playing]);

  const turn = currentTurn(pb, turns);
  const shownEvents = useMemo(() => {
    if (!turn) return [];
    return pb.mode === "live" ? turn.events : turn.events.slice(0, pb.cursor);
  }, [turn, pb.mode, pb.cursor]);
  // "多久没有新事件"只对实时主体有意义，历史会话不会再推进。
  const idleMs = !historical && liveSession ? now - liveSession.lastTurnAt : 0;
  const idle = !historical && (!turn || idleMs > IDLE_MS);
  const run = useMemo(
    () =>
      projectRun(shownEvents, {
        // 回放途中让当前节点保持呼吸；放完（或实时里很久没动静）就停下来。
        live: pb.mode === "live" ? !idle : pb.cursor < (turn?.events.length ?? 0),
      }),
    [shownEvents, idle, pb.mode, pb.cursor, turn],
  );

  const connected = stream.s === "open";
  // topbar 上正在报的是哪个会话：跟随时是图上那个，锁定时就是锁定的那个。
  const shownSid = pinned ?? liveSession?.sessionId;
  const shownTitle = shownSid ? titles[shownSid] : undefined;

  /**
   * 标题表：挂载即取、定时复取，换了会话再补取一次。
   *
   * 换会话时的补取服务于跟随模式：会话随时会换，不补取的话新会话的标题
   * 要等到下一个 20 秒周期才显示，topbar 在此期间只有 id。
   */
  useEffect(() => {
    pullTitles();
  }, [pullTitles, shownSid]);
  useEffect(() => {
    const t = setInterval(pullTitles, TITLE_MS);
    return () => clearInterval(t);
  }, [pullTitles]);

  // 还没有标题的那几次补取（见 TITLE_PENDING_MS）。换会话就重新计次。
  const [pendingTries, setPendingTries] = useState(0);
  useEffect(() => setPendingTries(0), [shownSid]);
  useEffect(() => {
    if (!shownSid || shownTitle || pendingTries >= TITLE_PENDING_TRIES) return;
    const t = setTimeout(() => {
      pullTitles();
      setPendingTries((n) => n + 1);
    }, TITLE_PENDING_MS);
    return () => clearTimeout(t);
  }, [shownSid, shownTitle, pendingTries, pullTitles]);

  return (
    <>
      {/* 标题、连接状态、切换入口、跟踪计数、会话信息合成一行，把纵向空间留给流程图 */}
      <div className="demo-topbar">
        <h1>{title}</h1>
        <span className={connected ? "banner inline" : "banner banner-warn inline"}>
          {connected
            ? "实时轨迹：已连接"
            : stream.s === "connecting"
              ? "实时轨迹：连接中…"
              : `实时轨迹：已断开${stream.detail ? `（${stream.detail}）` : ""}——正在退避重连`}
        </span>
        <button type="button" className="demo-pick-btn" onClick={() => setPicker(true)}>
          {/* 按钮上有标题就报标题（与弹窗、下面那行同一取向）；完整 id 在下面那行。 */}
          ⇄ {pinned ? `已锁定 ${short(shownTitle ?? pinned)}` : "跟随实时 · 切换会话"}
        </button>
        {connected ? (
          <span className="muted tiny" title="会话外事件：ACP 冷启动、旁路垫场等不属于任何一轮的事件">
            跟踪 {state.sessions.length} 个会话
            {state.orphanCount > 0 ? ` · ${state.orphanCount} 条会话外事件` : ""}
          </span>
        ) : null}
        {!historical ? (
          // ── 实时主体（跟随 / 锁定到一个还在动的会话）：三种无内容状态分别提示
          !turn ? (
            <span className="muted tiny">
              {pinned === null ? "跟随实时" : "已锁定"} ·
              连着，还没有任何轮次开始。跑一次对话即可看到它在图上流动。
            </span>
          ) : (
            /*
             * 当前跟随的会话与轮次 id 写在 topbar 上：图上只有节点与边，
             * 而这两个 id 是去回放页 / 日志排查的入口。
             */
            <span className="muted tiny">
              <strong>{pinned === null ? "跟随实时" : "已锁定"}</strong> · 会话{" "}
              <SessionTag id={shownSid ?? ""} title={shownTitle} />
              {" "}· {pb.mode === "live" ? "最新一轮" : "回放"} <code>{turn.turnId}</code>
              {pb.mode !== "live"
                ? ""
                : run.finished
                  ? " · 本轮已收口"
                  : idle
                    ? " · 已很久没有新事件"
                    : " · 进行中"}
              {state.anyRedacted ? " · 含已脱敏内容" : ""}
            </span>
          )
        ) : replay.kind === "loading" ? (
          <span className="muted tiny">
            正在取会话 <SessionTag id={pinned ?? ""} title={shownTitle} /> 的轨迹…
          </span>
        ) : replay.kind === "error" ? (
          <span className="error tiny">
            取不到会话 <SessionTag id={pinned ?? ""} title={shownTitle} /> 的轨迹：{replay.detail}
          </span>
        ) : replay.kind === "empty" ? (
          <span className="muted tiny">
            会话 <SessionTag id={pinned ?? ""} title={shownTitle} /> 没有任何完整轮次，图上没有可画的路径。
          </span>
        ) : (
          <span className="muted tiny">
            <strong>历史会话回放（非实时）</strong> · 会话{" "}
            <SessionTag id={pinned ?? ""} title={shownTitle} />
            {turn ? (
              <>
                {" "}· 正在放 <code>{turn.turnId}</code>
              </>
            ) : null}
            {replay.kind === "ok" && replay.data.redacted ? " · 含已脱敏内容" : ""}
          </span>
        )}
      </div>

      {!connected ? (
        <p className="error">
          实时通道没连上——<strong>下面这张图不代表"系统很闲"，它只是停在最后一帧</strong>。
          先确认网关与 agent-runtime 都在（<code>dev:status</code>）。
        </p>
      ) : null}

      {/* 仅在跟随实时时有意义：回放中"没有新事件"表示回放放完，不是卡住。 */}
      {idle && pb.mode === "live" && pinned === null && turn && !run.finished ? (
        <p className="error">
          这一轮已经 {Math.round(idleMs / 1000)} 秒没有新事件，也没有收口——
          停在上面亮着的最后一步。这是值得盯的那种安静。
        </p>
      ) : null}

      {/*
        回放控制条始终挂载（零轮次时是一排禁用按钮）：
        它同时标明当前是否为实时，这在没有轮次时同样需要。
      */}
      <PlaybackBar
        turns={turns}
        pb={pb}
        live={!historical}
        onPlayPause={() => setPb((p) => togglePlay(p, turnsRef.current, Date.now()))}
        onStep={(d) => setPb((p) => stepTurn(p, turnsRef.current, d, Date.now()))}
        onReplay={() => setPb((p) => replayCurrent(p, turnsRef.current, Date.now()))}
        onLoop={() => setPb((p) => ({ ...p, loop: !p.loop }))}
        onPickTurn={(id) =>
          setPb((p) => playTurn(p, id, Date.now(), { returnToLive: !historical }))
        }
        onBackToLive={() => setPb((p) => backToLive(p, Date.now()))}
      />

      {/*
        无条件挂载。没有可画的轮次时是一张全暗的空图，保持版面高度不变。
      */}
      {/* 投屏态由外层 flex 把剩余视口高度交给流程图，避免固定高度把 KPI 推到下一页。 */}
      {/* 大屏定倍 0.67 + 左上角对齐，不用 fitView：大屏读者离屏幕远，
          字号需为定值，不随窗口大小变（fitView 在 1366 宽下算到 0.36）。
          装不下的右下角靠拖动查看。 */}
      <RunFlow run={run} fit zoom={0.67} className="demo-run-flow" />

      {picker ? (
        <SessionPicker
          liveIds={state.sessions.map((s) => s.sessionId)}
          pinned={pinned}
          // 弹窗取到的行并进标题表，topbar 不必等下一次复取。
          onRows={mergeTitles}
          onClose={() => setPicker(false)}
          onPick={(sid) => {
            onPinChange(sid);
            setPicker(false);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * 会话选择弹窗。
 *
 * # 只摆"会话"，与"会话与对话"页同一个概念
 *
 * 列表来自 `/console/sessions`，与该页口径一致（同一张 `sessions` 表、
 * 同样按最后活跃排序、同样的标题与轮次口径）。不用轨迹表的 `groupBy sessionId`：
 * 其中的 `unknown` 兜底桶、`system:worker`、`guide-*` 导览任务、`__selfcheck__` 自检
 * 都不是会话。
 *
 * 列表里可能出现还没有轨迹的会话；选中后 topbar 会提示"没有可回放的轮次"。
 *
 * 正在被实时跟踪的会话会标出，锁定后仍能看到它继续推进。
 */
function SessionPicker({
  liveIds,
  pinned,
  onRows,
  onClose,
  onPick,
}: {
  liveIds: string[];
  pinned: string | null;
  /** 取到的行报给父层（它据此在 topbar 上显示标题）。 */
  onRows: (rows: SessionRow[]) => void;
  onClose: () => void;
  onPick: (sessionId: string | null) => void;
}): JSX.Element {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** 筛选条件：与「会话与对话」页同一组（用户 / 会话 id / 标题 / 建于起止）。 */
  const [userId, setUserId] = useState("");
  const [keyword, setKeyword] = useState("");
  const [title, setTitle] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const filters = { userId, sessionId: keyword, title, since, until };
  /**
   * 分页游标栈，存每一页的起点而不是页码：接口是游标式的
   * （`nextCursor` 指向下一页的第一条），没有 offset。
   * 存起点才能向前翻页；栈长度即当前页码。与「会话与对话」页同一形态。
   */
  const [stack, setStack] = useState<Array<string | undefined>>([undefined]);
  const [next, setNext] = useState<string | null>(null);
  const cursor = stack[stack.length - 1];

  const report = useRef(onRows);
  report.current = onRows;

  const load = useCallback(() => {
    /*
     * `nonEmpty=1`：只列有消息的会话，零消息的会话没有可回放的内容。
     *
     * 过滤放在服务端：前端过滤会让每页条数不足，翻页也不准。
     * 「会话与对话」页不带这个参数，运营视角需要看到零消息的会话
     * （上车声明、举证脚本、发送失败都会留下一条）。
     */
    const q = sessionQuery(
      { userId, sessionId: keyword, title, since, until },
      { limit: String(SESSION_PAGE), nonEmpty: "1", withTraceCounts: "1" },
    );
    if (cursor) q.set("cursor", cursor);
    setLoading(true);
    setError(null);
    api
      .get<{ sessions: SessionRow[]; hasMore: boolean; nextCursor: string | null }>(
        `/console/sessions?${q}`,
      )
      .then((r) => {
        setRows(r.sessions);
        setNext(r.hasMore ? r.nextCursor : null);
        report.current(r.sessions);
      })
      .catch((e: unknown) => setError(e instanceof ApiError ? e.code : String(e)))
      .finally(() => setLoading(false));
  }, [userId, keyword, title, since, until, cursor]);

  /*
   * 边打字边查，去抖 300ms。
   *
   * 弹窗常用于粘贴 `sess-` 开头的 id，不去抖会产生一串排队请求。
   * 翻页（cursor 变）也走这条。
   */
  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  /**
   * 改筛选条件就回到第一页。
   *
   * 旧游标在新结果集里通常不存在，沿用会得到空页，被误读为筛选无结果。
   */
  const resetPaging = (): void => {
    setStack([undefined]);
    setNext(null);
  };

  return (
    <div className="demo-modal-overlay" onClick={onClose}>
      <div className="demo-modal" role="dialog" aria-label="选择会话" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>选择会话</h3>
          <button type="button" className="demo-pick-btn" onClick={onClose}>关闭</button>
        </header>

        {/*
          显式说明过滤条件：只列有消息的会话，避免用户找不到已建的会话。
        */}
        <p className="muted tiny demo-modal-note">
          只列说过话的会话；建了但一句没说的去「会话与对话」页看。
        </p>

        {/* 筛选：与「会话与对话」页同一组条件、同一套语义（会话 id 是精确定位，不是模糊搜） */}
        <div className="demo-filters">
          <label className="demo-field">
            <span>用户</span>
            <input
              value={userId}
              onChange={(e) => {
                setUserId(e.target.value);
                resetPaging();
              }}
              placeholder="userId"
            />
          </label>
          <label className="demo-field">
            <span>会话 ID（精确定位）</span>
            <input
              value={keyword}
              onChange={(e) => {
                setKeyword(e.target.value);
                resetPaging();
              }}
              placeholder="sess-…"
            />
          </label>
          {/*
            标题模糊搜，与上面的 id 精确定位互补。未生成标题的会话搜不到
            （标题在首轮之后生成），空结果时下方会说明。
          */}
          <label className="demo-field">
            <span>标题（模糊）</span>
            <input
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                resetPaging();
              }}
              placeholder="保养、行程…"
            />
          </label>
          {/* 日期范围按创建时间筛（与接口口径一致），本地时区整天，见 ../sessions/filters。 */}
          <label className="demo-field demo-field--day">
            <span>建于（起）</span>
            <input
              type="date"
              value={since}
              max={until || undefined}
              onChange={(e) => {
                setSince(e.target.value);
                resetPaging();
              }}
            />
          </label>
          <label className="demo-field demo-field--day">
            <span>建于（止）</span>
            <input
              type="date"
              value={until}
              min={since || undefined}
              onChange={(e) => {
                setUntil(e.target.value);
                resetPaging();
              }}
            />
          </label>
          {hasFilters(filters) && (
            <button
              type="button"
              className="demo-pick-btn"
              onClick={() => {
                setUserId("");
                setKeyword("");
                setTitle("");
                setSince("");
                setUntil("");
                resetPaging();
              }}
            >
              清空
            </button>
          )}
        </div>

        {/*
          「跟随实时」不是一条会话，不进列表、不受筛选与翻页影响，固定在此处，
          保证任何一页都能回到实时。
        */}
        <button
          type="button"
          className={pinned === null ? "demo-session-row demo-session-row--current" : "demo-session-row"}
          onClick={() => onPick(null)}
        >
          <span>跟随实时</span>
          <span className="muted tiny">自动画最近活动的会话（默认）</span>
        </button>

        <div className="demo-modal-list">
          {error ? (
            <p className="error">取不到会话列表：{error}</p>
          ) : rows === null ? (
            <p className="muted">加载中…</p>
          ) : rows.length === 0 ? (
            /*
             * 空结果时说明过滤条件：按 id 精确定位一条零消息会话会得到"没有匹配"，
             * 需提示该会话可能存在但被过滤。
             */
            <p className="muted">
              {hasFilters(filters) ? "没有匹配的会话" : "还没有任何会话"}
              ——注意这里<b>只列说过话的</b>，建了但一句没说的不在这里，去「会话与对话」页看。
              {title.trim() ? "标题是首轮之后才生成的，还没起名的会话也搜不到。" : ""}
            </p>
          ) : (
            rows.map((r) => (
              <button
                key={r.sessionId}
                type="button"
                className={
                  pinned === r.sessionId
                    ? "demo-session-row demo-session-row--current"
                    : "demo-session-row"
                }
                onClick={() => onPick(r.sessionId)}
              >
                {/*
                  有标题就把标题当主行、id 降到副行。
                  id 保留：标题会重名，且后续常需拿 id 查轨迹。
                */}
                <span className={r.title ? "" : "mono"}>{r.title ?? r.sessionId}</span>
                <span className="muted tiny">
                  {r.title ? <code className="mono">{r.sessionId}</code> : null}
                  {r.title ? " · " : ""}
                  {/* 列表已由服务端滤掉零消息的会话（`nonEmpty=1`），这里的轮次恒 > 0。 */}
                  {r.turnCount} 轮 ·{" "}
                  {/*
                    轨迹事件条数：这条点进去能放多少步。
                    `0` 显示为"无轨迹"而不是"0 条事件"：轨迹按天清理
                    （`TraceRepository.prune`），老会话有轮次而无事件是常态，含义是无可回放。
                  */}
                  {r.traceEvents === undefined
                    ? null
                    : r.traceEvents > 0
                      ? `${r.traceEvents} 条事件 · `
                      : "无轨迹 · "}
                  {new Date(r.lastMessageAt ?? r.updatedAt).toLocaleTimeString()}
                  {/* 访客会话要明说，不能渲染成空（与会话与对话页同一口径）。 */}
                  {r.userId ? "" : " · 访客"}
                  {liveIds.includes(r.sessionId) ? " · ● 实时跟踪中" : ""}
                </span>
              </button>
            ))
          )}
        </div>

        {/*
          翻页条仅在列表非空时显示，空结果下的翻页按钮会被误读为还有其他页
          （与会话与对话页同一取向）。
        */}
        {rows && rows.length > 0 && (stack.length > 1 || next) ? (
          <div className="demo-pager">
            <button
              type="button"
              className="demo-pick-btn"
              disabled={stack.length === 1 || loading}
              onClick={() => setStack((st) => st.slice(0, -1))}
            >
              ← 上一页
            </button>
            {/*
              只显示"第 N 页"，不显示总页数：游标式接口拿不到总数。
              同理不做页码跳转，那需要 offset。
            */}
            <span className="muted tiny">
              第 {stack.length} 页 · 每页 {SESSION_PAGE} 条{loading ? " · 取数中…" : ""}
            </span>
            <button
              type="button"
              className="demo-pick-btn"
              disabled={!next || loading}
              onClick={() => setStack((st) => [...st, next ?? undefined])}
            >
              下一页 →
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 会话在 topbar 上的一处呈现：有标题就显示标题，id 始终保留。
 *
 * 与选择弹窗同一取向：标题会重名，且 id 是去回放页排查的入口，因此标题排在 id 之前而不替换它。
 */
function SessionTag({ id, title }: { id: string; title?: string }): JSX.Element {
  return (
    <>
      {title ? <b className="demo-session-title">{title}</b> : null}
      {title ? " " : null}
      <code>{id}</code>
    </>
  );
}

/** 按钮上放不下整串时截断；完整值在其下方那行。 */
function short(text: string): string {
  return text.length > 14 ? `${text.slice(0, 12)}…` : text;
}
