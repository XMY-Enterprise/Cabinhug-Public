/**
 * 演示大屏（FL-30 F-30-08）：
 * 两个区块，现在流到哪了 + 最近 30 分钟 KPI。
 *
 * # 只有两个区块，且都围绕"当前会话"
 *
 * 健康卡、四问表、审计表由各自的页面承载，大屏不复述。
 * 两个区块共享一个"当前会话"概念：流向图画谁，KPI 就圈到谁
 * （跟随实时时是最近活动的会话；锁定后是锁定的那个）。
 *
 * # fake 警示不算区块，是警报
 *
 * 运行形态不是全真实时，高亮横幅排在最前，防止在 Fake 模式下把演示讲成真实调用。
 * 全真实时它整条消失。
 *
 * # 每个数字都能追到来源
 *
 * 大屏不算任何新指标：四问的数字与回放页是同一个 `summarize` 算出来的，
 * 用量来自用量页的同一个仓储，按会话圈定也只是 where 里多了 sessionId。
 *
 * # 自动刷新
 *
 * 10 秒一次，能跟上对话节奏，又不致频繁闪烁。
 * "现在流到哪了"不走这条轮询，单走 SSE（见 LiveFlow）。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import NumberFlow, { type Format } from "@number-flow/react";
import { MeshGradient } from "@paper-design/shaders-react";

import { api, ApiError } from "../../api";
import { LiveFlow } from "./LiveFlow";

interface ToolCallStats {
  total: number;
  real: number;
  mock: number;
  /** 三分类（按工具注册表的 provider 判）：RAG 检索 / 模拟服务或模拟数据 / 自有工具。 */
  rag: number;
  mockService: number;
  own: number;
}

interface Answers {
  agentCount: number;
  hasParallelOverlap: boolean;
  longestInterruptMs: number | null;
  toolCalls: ToolCallStats;
  turns: number;
  answerChars: number;
}

interface UsageTotal {
  total?: {
    calls: number;
    costEstimate: number;
    promptTokens: number;
    completionTokens: number;
    /** 命中上下文缓存的输入 token；只有直连 DeepSeek 那条路给得出（见服务端注释）。 */
    cacheHitTokens: number;
    /** 未命中、因而写入缓存的输入 token。 */
    cacheMissTokens: number;
  };
}

/** LLM + 语音合成两笔的拆分。计费量与单价都来自服务端，前端不算价。 */
interface Cost {
  llm: number;
  ttsChars: number;
  ttsRequests: number;
  tts: number;
  total: number;
}

interface Overview {
  mode: { llm: string; asr: string; tools: string };
  window: { minutes: number; sessions: number };
  toolCalls: ToolCallStats;
  turns: number;
  usage: UsageTotal | null;
  cost: Cost;
  /** 传了 sessionId 才有：圈到那个会话的同一组数。 */
  scoped: { sessionId: string; answers: Answers; usage: UsageTotal | null; cost: Cost } | null;
}

const REFRESH_MS = 10_000;

/**
 * 背景氛围层（ACR-001，参数的真相源在 ./design-spec.md）。
 *
 * WebGL 起不来（远程桌面、老会议室机器）或用户要求减少动效时，
 * 整层不挂 canvas，只剩 CSS 渐变兜底；氛围层失效不影响数据层，也不弹错误。
 */
function Backdrop(): JSX.Element {
  const canShader = useMemo(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
    try {
      const probe = document.createElement("canvas");
      return probe.getContext("webgl2") !== null || probe.getContext("webgl") !== null;
    } catch {
      return false;
    }
  }, []);
  return (
    <div className="demo-backdrop" aria-hidden>
      {canShader && (
        <MeshGradient
          colors={["#0b1020", "#0969da", "#6e40c9", "#101828"]}
          distortion={0.8}
          swirl={0.6}
          speed={0.15}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        />
      )}
    </div>
  );
}

export function DemoPage(): JSX.Element {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 当前会话：锁定优先，否则跟随 LiveFlow 正在画的那个。KPI 圈定跟着它走。
  const [pinned, setPinned] = useState<string | null>(null);
  const [autoSid, setAutoSid] = useState<string | undefined>(undefined);
  const activeSid = pinned ?? autoSid;
  // 投屏模式 = 原生 fullscreen：只放大排版、藏掉控制台 chrome，不增删任何内容区块。
  const sectionRef = useRef<HTMLElement | null>(null);
  const [cast, setCast] = useState(false);

  useEffect(() => {
    const onChange = () => setCast(document.fullscreenElement === sectionRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const load = useCallback(() => {
    const q = activeSid ? `?sessionId=${encodeURIComponent(activeSid)}` : "";
    api
      .get<Overview>(`/console/demo/overview${q}`)
      .then(setData)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.code : String(e)));
  }, [activeSid]);

  // 会话切换立即重取，不等下一个 10 秒——观众刚选完就该看到属于它的数。
  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const onAutoSession = useCallback((sid: string | undefined) => setAutoSid(sid), []);

  if (error) return <p className="error">加载失败：{error}</p>;
  if (!data) return <p className="muted">加载中…</p>;

  // unknown 也算"不是全真实"：取不到就不能标为真实，
  // 与"审核层未接入时显式标注"是同一条原则。
  const fake =
    data.mode.llm !== "real" || data.mode.asr !== "real" || data.mode.tools !== "real";
  const scoped = activeSid && data.scoped?.sessionId === activeSid ? data.scoped : null;

  // KPI 拆成数据再渲染，为的是能在渲染前求出「整排最长的那个数有多少字位」。
  // 工具按注册表 provider 分三类，模拟一类单列，以区分真实调用与模拟调用。
  const toolCalls = scoped ? scoped.answers.toolCalls : data.toolCalls;
  const usage = (scoped ? scoped.usage : data.usage)?.total;
  const cost = scoped ? scoped.cost : data.cost;
  const kpis: KpiProps[] = [
    {
      label: "轮次",
      value: scoped ? scoped.answers.turns : data.turns,
      note: scoped ? "本会话的对话轮数" : "窗口内各会话轮次合计",
    },
    { label: "RAG 检索", value: toolCalls.rag, note: "RAGFlow 知识库检索次数" },
    {
      label: "模拟服务调用",
      value: toolCalls.mockService,
      note:
        toolCalls.mockService > 0
          ? "打到模拟系统（经销商/车机）或模拟数据，讲解时须点明"
          : "为 0 才能说全真实",
      warn: toolCalls.mockService > 0,
    },
    { label: "自有工具调用", value: toolCalls.own, note: "地图 / 天气 / 记忆等自有能力" },
    // LLM 卡片自带 token 明细：调用次数是主数，输入/输出与缓存是它的补充，
    // 不拆成并列的卡片。
    {
      label: "LLM 调用",
      value: usage?.calls ?? 0,
      note: "经网关计量的次数",
      detail: <LlmTokenDetail total={usage} />,
    },
    // 语音与 LLM 的计费口径不同：它按字数算钱，次数只是补充
    {
      label: "语音合成",
      value: cost.ttsRequests,
      note: `${cost.ttsChars} 字 · 按字数计费`,
    },
    // 大屏只到分位，拆分与精确值见下方小字与用量页
    {
      label: "成本估算",
      value: cost.total,
      prefix: "¥",
      format: { minimumFractionDigits: 2, maximumFractionDigits: 2 },
      note: costNote(cost),
    },
  ];

  return (
    <section className="page demo" ref={sectionRef}>
      <Backdrop />
      <button
        type="button"
        className="demo-cast-btn"
        onClick={() => {
          if (document.fullscreenElement) void document.exitFullscreen();
          else void sectionRef.current?.requestFullscreen();
        }}
      >
        {cast ? "退出投屏" : "⛶ 投屏模式"}
      </button>
      <div className={fake ? "demo-main demo-main--fake" : "demo-main"}>
        {/* 标题并进 LiveFlow 的第一行，不单列区块标题、副标题与统计范围说明，
            大屏的高度优先给图和数字。 */}

        {/* fake 警示不是区块：不全真实才出现，出现时必须醒目（设计原则 3） */}
        {fake && (
          <div className="demo-mode demo-mode--fake">
            <span>LLM：{data.mode.llm}</span>
            <span>ASR：{data.mode.asr}</span>
            <span>工具：{data.mode.tools}</span>
            <strong>⚠️ 当前不是全真实链路，讲解时不要说“这是真实调用”</strong>
          </div>
        )}

        <div className="demo-flow-region">
          <LiveFlow title="演示大屏" pinned={pinned} onPinChange={setPinned} onAutoSession={onAutoSession} />
        </div>

        {/* KPI 直接跟在图下（统计范围 = 图上正在画的会话，topbar 里已写明是谁）。
            KPI 是前景层主体（ACR-002）：数位滚动只跟着真实数据变。

            字位数下在整排而不是每张卡上：同宽的卡各自收字号会大小不一。
            取最长的那个数当统一口径，字号一致且不溢出。用法见 styles.css 的 .demo-kpi strong。 */}
        <div
          className="demo-kpi-row"
          style={{ "--kpi-chars": Math.max(...kpis.map(kpiChars)) } as CSSProperties}
        >
          {kpis.map((kpi) => (
            <Kpi key={kpi.label} {...kpi} />
          ))}
        </div>
      </div>
    </section>
  );
}

/** 成本拆分一句话：两笔各多少、TTS 按多少字折的。单价与折算都在服务端（配置热改）。 */
function costNote(c: Cost): string {
  return `LLM ¥${c.llm.toFixed(4)} + 语音合成 ¥${c.tts.toFixed(4)}（按 ${c.ttsChars} 字折算）`;
}

/**
 * LLM 卡片的 token 明细。
 *
 * 缓存命中率的分母是有缓存数据的那部分输入（命中 + 未命中），不是 promptTokens：
 * 经 pi-acp 的调用拿不到缓存信息（token 本身也是估的），算进分母会让命中率
 * 随子 Agent 调用次数波动。两者都为 0 时整行不显示：没有数据不等于命中率 0%。
 */
function LlmTokenDetail({ total }: { total?: UsageTotal["total"] }): JSX.Element | null {
  if (!total) return null;
  const cacheable = total.cacheHitTokens + total.cacheMissTokens;
  return (
    <dl className="demo-kpi-detail">
      <div>
        <dt>输入</dt>
        <dd>{total.promptTokens.toLocaleString()}</dd>
      </div>
      <div>
        <dt>输出</dt>
        <dd>{total.completionTokens.toLocaleString()}</dd>
      </div>
      {cacheable > 0 ? (
        <>
          <div>
            <dt>缓存命中</dt>
            <dd>{total.cacheHitTokens.toLocaleString()}</dd>
          </div>
          <div>
            <dt>缓存写入</dt>
            <dd>{total.cacheMissTokens.toLocaleString()}</dd>
          </div>
          <div>
            <dt>命中率</dt>
            <dd>{((total.cacheHitTokens / cacheable) * 100).toFixed(1)}%</dd>
          </div>
        </>
      ) : (
        <div className="demo-kpi-detail-note">
          <dt>缓存</dt>
          <dd title="经 pi-acp 的调用拿不到缓存信息，不是「没命中」">无数据</dd>
        </div>
      )}
    </dl>
  );
}

interface KpiProps {
  label: string;
  value: number;
  note?: string;
  warn?: boolean;
  prefix?: string;
  format?: Format;
  /** 卡内补充数据（如 LLM 的 token 明细）。跟着主数走，不另开一张卡。 */
  detail?: JSX.Element | null;
}

/**
 * 主数渲染出来占几个字位。
 *
 * CSS 数不出字数，而字数决定宽度。`¥0.03` 是 5 位、
 * `5,033,516` 是 9 位，同一字号下后者宽近一倍；投屏一行七张卡时卡宽约 200px，
 * 超出部分被切掉（卡片 `overflow: hidden`，不换行也不滚动）。
 * 口径必须与 NumberFlow 实际渲染的字符串一致，它内部也是 `Intl.NumberFormat`。
 */
function kpiChars({ value, prefix, format }: KpiProps): number {
  return (prefix?.length ?? 0) + new Intl.NumberFormat(undefined, format).format(value).length;
}

/** 大 KPI（ACR-002）：数字走 NumberFlow 数位滚动；它自己会尊重 prefers-reduced-motion。 */
function Kpi({ label, value, note, warn, prefix, format, detail }: KpiProps): JSX.Element {
  return (
    <div className={warn ? "demo-kpi demo-kpi--warn" : "demo-kpi"}>
      <h3>{label}</h3>
      <strong>
        <NumberFlow value={value} prefix={prefix} format={format} />
      </strong>
      {note && <p className="muted">{note}</p>}
      {detail}
    </div>
  );
}
