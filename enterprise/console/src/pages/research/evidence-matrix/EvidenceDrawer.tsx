/**
 * 证据栏（Brief `evidence-matrix.brief.md` §3⑦）。
 *
 * # 节的顺序照设计稿，缺数据的节保留标题、写清在等什么
 *
 * 保留标题让读者知道这一页应有哪些内容，数据接上后也无需重排版。
 * 缺数据时不用示例数字占位：示例数字与真实证据无法区分。
 *
 * # 三种选中共用一个抽屉
 *
 * 格 / 整行 / 整列的差别只在「口径」那一行与「分解」那一节，其余节相同。
 * 共用一个组件保证"允许用途"这类合规文案只有一份、逐字一致。
 */

import { useEffect, useState } from "react";

import type { SelectionScope } from "@cabinhug/research/capabilities";
import type { RedTeamFinding } from "@cabinhug/research/red-team";

import {
  isLookup,
  railFor,
  runCapability,
  type CounterEvidenceList,
  type SegmentSlice,
  type SystemEventOverlap,
  type ThresholdSensitivity,
} from "../../../api/research-capability";
import { ApiError } from "../../../api";
import { LevelChip } from "../shell/LevelChip";
import type { MatrixDetail } from "../shell/model";
import type { ResearchInsight } from "../../../api/research-insight";
import { fetchChallenges, type ChallengeRecord } from "../../../api/research-challenge";
import { decideProposal, fetchProposals, type ProposalRow } from "../../../api/research-proposal";
import { AskPanel } from "./AskPanel";
import { isAskCapability, type AskCapabilityKey } from "./ask-model";
import { CapabilityRail } from "./CapabilityRail";
import { InsightList } from "./InsightCards";
import { behaviouralNote, confidenceRows, upgradeNeedsOf } from "./insight-model";
import { CounterEvidence, SegmentSlices, SystemEvents, Thresholds } from "./LookupPanels";
import { ProposalQueue } from "./ProposalQueue";
import { RunPanel } from "./RunPanel";

/** 置信 C 的五个分量，顺序与 `@cabinhug/research` 的 `confidenceOf` 一致。 */
const CONFIDENCE_FACTORS = ["Coverage", "Quality", "Agreement", "Triangulation", "Freshness"] as const;

/** 合规文案，与 Brief 逐字一致。 */
const USAGE_NOTE = "内部排序 · 原声已本地脱敏 · 禁止对外展示原文 · 回放记入操作审计";

function Pending({ what }: { what: string }): JSX.Element {
  return <p className="rm-dim rm-pending">{what}</p>;
}

/** 红队清单就地渲染而非弹窗：它说明"这一屏有什么问题"，与数字放在一起。 */
function RedTeamList({ findings }: { findings: RedTeamFinding[] }): JSX.Element {
  if (findings.length === 0) {
    // 空数组表示五条规则都没触发，不表示"查过了没事"，文案需体现这一区别。
    return <p className="rm-dim">五条规则都没触发。这不等于这一屏没问题，只等于这五条问不出问题。</p>;
  }
  return (
    <ul className="rm-redteam">
      {findings.map((x) => (
        <li key={x.rule} className={`is-${x.severity}`}>
          <p className="rm-redteam-msg">{x.message}</p>
          <p className="rm-dim rm-redteam-ev">{x.evidence}</p>
        </li>
      ))}
    </ul>
  );
}

/** 一次能力调用的界面状态。 */
type CapabilityRun =
  | { kind: "idle" }
  | { kind: "busy"; key: string }
  /**
   * `🔍` 层的结果。`result` 的形状由 `key` 决定，五条能力各有一种形状。
   * 按 key 分派时逐个断言（见 `lookupOf`），不以 `any` 传递：
   * 否则形状不符时会渲染成空白而不报错。
   */
  | { kind: "lookup"; key: string; result: unknown }
  | { kind: "run"; key: string; runId: string }
  | { kind: "error"; key: string; message: string };

/** 这次 `🔍` 结果是不是这条能力的。不是就回 null，让调用处什么都不渲染。 */
const lookupOf = <T,>(run: CapabilityRun, ...keys: string[]): T | null =>
  run.kind === "lookup" && keys.includes(run.key) ? (run.result as T) : null;

export function EvidenceDrawer({
  detail,
  onClose,
  scope,
  contractId,
  insights: insightsProp,
  currentInputsHash = null,
  onInsightsChanged,
}: {
  detail: MatrixDetail;
  onClose: () => void;
  /** 语义范围。能力条按它决定长什么样；为 null（越界）时整条不渲染。 */
  scope?: SelectionScope | null;
  contractId?: string;
  /**
   * 这一格的洞察卡。空数组表示还没归纳过，页签保持关闭。
   *
   * 由页面取数后传入：抽屉随选中格反复挂载卸载，在此取数会每换一格重查一次全量卡片。
   */
  insights?: ResearchInsight[];
  /** 此刻的口径。与卡上那份比，不等即「口径已变」（G5）。 */
  currentInputsHash?: string | null;
  /** C1 跑完之后回调，页面据此重取卡片，新卡无需刷新即可显示。 */
  onInsightsChanged?: () => void;
}): JSX.Element {
  const f = detail.facts;
  const insights = insightsProp ?? [];
  const insightCount = insights.length;
  const [run, setRun] = useState<CapabilityRun>({ kind: "idle" });
  /*
   * 「问它」面板不占用 `run` 状态，两者在页面上并存。
   * 否则点一条引用查原声时，面板与刚问出的笔记会被一起替换。
   */
  const [ask, setAsk] = useState<AskCapabilityKey | null>(null);
  /** 「证据详情」还是「相关洞察」。一张卡都没有时页签点不动，恒在前者。 */
  const [tab, setTab] = useState<"evidence" | "insights">("evidence");

  /*
   * 这一格每张卡的挑战记录，按 insightId 索引。
   *
   * 追问上限按卡计算；若扁平存放，追问轮数会按整格累计，
   * 一张卡问满后其他卡的追问框也会被禁用。
   */
  const [challenges, setChallenges] = useState<Record<string, ChallengeRecord[]>>({});
  /** 挑战记录重取的计数器。跑完一次 C6/C7 就 +1。 */
  const [chalTick, setChalTick] = useState(0);
  /** 正在被挑战的那张卡。非 null 时那张卡上的两个按钮按不动。 */
  const [busyInsight, setBusyInsight] = useState<string | null>(null);

  /*
   * 码提案队列只在兜底桶的行/格上取：队列是全局的，不属于某一格，
   * 在其他格上恒为空。
   */
  const [proposals, setProposals] = useState<ProposalRow[]>([]);
  const [propTick, setPropTick] = useState(0);
  const [propBusy, setPropBusy] = useState(false);
  const isCatchAll = detail.catchAll === true;
  useEffect(() => {
    if (!isCatchAll) return;
    let live = true;
    void fetchProposals()
      .then((rows) => {
        if (live) setProposals(rows);
      })
      .catch(() => {
        // 取数失败时保留空数组。错误提示由 `run.kind === "error"` 负责，此处不重复。
      });
    return () => {
      live = false;
    };
  }, [isCatchAll, propTick]);

  const onDecideProposal = (proposalId: string, decision: "accept" | "reject", rationale: string): void => {
    setPropBusy(true);
    void decideProposal(proposalId, decision, rationale)
      .then(() => setPropTick((n) => n + 1))
      .catch((err: unknown) => {
        const message = err instanceof ApiError ? err.code : err instanceof Error ? err.message : String(err);
        setRun({ kind: "error", key: "code-proposal-decided", message });
      })
      .finally(() => setPropBusy(false));
  };

  const insightKey = insights.map((i) => i.id).join(",");
  useEffect(() => {
    if (!insightKey) {
      setChallenges({});
      return;
    }
    let live = true;
    const ids = insightKey.split(",");
    void Promise.all(ids.map((id) => fetchChallenges(id).then((rs) => [id, rs] as const).catch(() => [id, []] as const)))
      .then((pairs) => {
        // 卸载或换格后不再 setState，避免晚到的结果覆盖新一格的数据。
        if (live) setChallenges(Object.fromEntries(pairs));
      });
    return () => {
      live = false;
    };
  }, [insightKey, chalTick]);

  /*
   * C2 的结果就地填进「反例」那一节，不在能力条下另出一份。
   * 快照计数与刚查出的句子是同一批证据，分两处显示会被读成两次不同的测量。
   */
  const counter = lookupOf<CounterEvidenceList>(run, "find-counter-evidence", "c2");
  const events = lookupOf<SystemEventOverlap>(run, "system-events", "c3");
  const slices = lookupOf<SegmentSlice>(run, "slice-by-segment", "c4");
  const thresholds = lookupOf<ThresholdSensitivity>(run, "threshold-sensitivity", "c5");
  const redTeam = lookupOf<RedTeamFinding[]>(run, "red-team", "c9");

  /*
   * 抽屉的 ①⑤⑥⑦⑨ 五节都从卡片取数。
   *
   * 多张卡时只出第一张的分量并注明是哪张：多张卡的分量取平均会得到
   * 一组不属于任何一张卡的数。
   */
  const firstCard = insights[0] ?? null;
  const upgrade = upgradeNeedsOf(insights);
  const behaviour = behaviouralNote(insights);

  const onRun = (key: string): void => {
    if (!scope || !contractId) return;
    /*
     * `💬 问它` 只开面板、不发请求：此时问题本身尚未输入，空问题会被服务端以 400 拒绝。
     */
    if (isAskCapability(key)) {
      setAsk(key);
      return;
    }
    setRun({ kind: "busy", key });
    void runCapability(key, scope, contractId)
      .then((res) => {
        if (isLookup(res)) setRun({ kind: "lookup", key, result: res.result });
        else setRun({ kind: "run", key, runId: res.runId });
      })
      .catch((err: unknown) => {
        /*
         * 服务端错误码原样显示。`capability_not_available` 表示后端判这一格为抑制
         * 而界面画出了按钮，是前后端判据分叉的唯一可见信号。
         */
        const message = err instanceof ApiError ? err.code : err instanceof Error ? err.message : String(err);
        setRun({ kind: "error", key, message });
      });
  };

  /**
   * C6 / C7：范围是一张卡，不是当前选中的格。
   *
   * 不复用 `onRun`：它把 `scope` 固定为抽屉当前的选中范围，服务端会收到 `cell` 范围
   * 并被 G1 闸门判为 `capability_not_available`。
   */
  const runOnCard = (key: string, insightId: string, extra: Record<string, unknown> = {}): void => {
    if (!contractId) return;
    setBusyInsight(insightId);
    setRun({ kind: "busy", key });
    void runCapability(key, { kind: "card", insightId }, contractId, extra)
      .then((res) => {
        if (isLookup(res)) setRun({ kind: "lookup", key, result: res.result });
        else setRun({ kind: "run", key, runId: res.runId });
      })
      .catch((err: unknown) => {
        /*
         * 错误码原样显示。`follow_up_limit_reached` 表示追问次数已用完，
         * 泛化成"操作失败"会让用户误以为是输入问题。
         */
        const message = err instanceof ApiError ? err.code : err instanceof Error ? err.message : String(err);
        setRun({ kind: "error", key, message });
        setBusyInsight(null);
      });
  };

  /** 挑战面的接线。三个回调须一起提供，缺任何一个都会出现无响应的按钮。 */
  const challengeWiring = {
    byInsight: challenges,
    onChallenge: (id: string) => runOnCard("challenge-card", id),
    onFollowUp: (id: string, angle: string) => runOnCard("follow-up", id, { angle }),
    busyInsightId: busyInsight,
  };

  return (
    <div className="rm-drawer">
      <div className="rm-drawer-tabs">
        <span className={`rm-tab${tab === "evidence" ? " is-on" : ""}`} onClick={() => setTab("evidence")}>
          证据详情
        </span>
        {/*
          相关洞察的条数来自洞察卡；没有卡时不显示括号，
          因为「（0）」无法区分"查过了没有"与"尚未接入"。
        */}
        <span
          className={`rm-tab${insightCount > 0 ? (tab === "insights" ? " is-on" : "") : " is-off"}`}
          title={insightCount > 0 ? undefined : "这一格还没有洞察卡——点能力条上的「归纳这一格」"}
          onClick={insightCount > 0 ? () => setTab("insights") : undefined}
        >
          相关洞察{insightCount > 0 ? `（${insightCount}）` : ""}
        </span>
        <button type="button" className="rm-drawer-close" onClick={onClose} aria-label="关闭">
          ×
        </button>
      </div>

      <div className="rm-drawer-body">
        <div className="rm-drawer-title">
          <strong>{detail.title}</strong>
          <LevelChip level="signal" />
        </div>
        <p className="rm-drawer-scope">{detail.scope}</p>
        {detail.undeliverable ? (
          <p className="rm-drawer-ban">落在硬禁范畴，标为不可交付——证据量照显，但不进 roadmap。</p>
        ) : null}
        {detail.catchAll ? (
          <p className="rm-drawer-ban">
            这是<b>兜底桶</b>，不是一件具体的事——它是「有明确诉求但归不上现有十个码」的合计。
            照着它派活会派出一个没有对象的需求；它真正该触发的动作是<b>补 codebook</b>。
          </p>
        ) : null}

        {detail.suppressedReason ? (
          <div className="rm-drawer-sec">
            <p className="rm-suppress-note">{detail.suppressedReason}</p>
          </div>
        ) : null}

        {/*
          能力条：标题与口径之下、「话语 × 行为」之上（设计稿 §5.1 的版式）。
          被抑制的格上它只出一句话、零按钮——那是 G1 在界面上的落点。
        */}
        {contractId ? (
          <CapabilityRail
            scope={scope ?? null}
            suppressedReason={detail.suppressedReason}
            onRun={onRun}
            busy={run.kind === "busy" ? run.key : null}
          />
        ) : null}

        {ask && scope && contractId ? (
          <div className="rm-drawer-sec rm-cap-out">
            <AskPanel
              /*
               * 换格即重挂面板，避免上一格的历史轮次接在新一格的问答下面。
               */
              key={`${ask}:${JSON.stringify(scope)}`}
              capability={ask}
              scope={scope}
              contractId={contractId}
              /*
               * 引用点开走这一格既有的 `🔍 找反例`，服务端没有按 unitId 单查的接口。
               * 这个范围上没有那条能力（卡片 / 整屏）时不传，引用显示为纯文本。
               */
              onCiteUnit={
                railFor(scope).some((c) => c.key === "find-counter-evidence")
                  ? () => onRun("find-counter-evidence")
                  : undefined
              }
            />
            <button type="button" className="btn-secondary rm-ask-close" onClick={() => setAsk(null)}>
              收起问答
            </button>
          </div>
        ) : null}
        {redTeam ? (
          <div className="rm-drawer-sec rm-cap-out">
            <h4>这一屏的红队清单</h4>
            <RedTeamList findings={redTeam} />
          </div>
        ) : null}
        {events ? (
          <div className="rm-drawer-sec rm-cap-out">
            <h4>这是我们自己干的吗</h4>
            <SystemEvents data={events} />
          </div>
        ) : null}
        {slices ? (
          <div className="rm-drawer-sec rm-cap-out">
            <h4>谁被漏掉了</h4>
            <SegmentSlices data={slices} />
          </div>
        ) : null}
        {thresholds ? (
          <div className="rm-drawer-sec rm-cap-out">
            <h4>换个阈值还成立吗</h4>
            <Thresholds data={thresholds} />
          </div>
        ) : null}
        {run.kind === "run" ? (
          <div className="rm-drawer-sec rm-cap-out">
            <RunPanel
              runId={run.runId}
              title={run.key}
              /*
               * 跑完之后按能力决定重取什么：C1 出卡（重取卡），
               * C6/C7 出挑战记录（重取记录）。挑战不改卡，因此不重取卡片。
               */
              onDone={() => {
                if (run.key === "summarize-cell") onInsightsChanged?.();
                else if (run.key === "propose-code") setPropTick((n) => n + 1);
                else setChalTick((n) => n + 1);
              }}
              // 成功与失败都解锁，否则一次失败会让那张卡的按钮保持禁用。
              onSettled={() => setBusyInsight(null)}
            />
          </div>
        ) : null}
        {run.kind === "error" ? (
          <div className="rm-drawer-sec rm-cap-out">
            <p className="rm-run-err">{run.key} 没跑成：{run.message}</p>
          </div>
        ) : null}

        {/*
          「相关洞察」页签。能力条保留在上方，切到卡片列表后仍可再次发起归纳。
        */}
        {tab === "insights" ? (
          <div className="rm-drawer-sec">
            <InsightList
              insights={insights}
              currentInputsHash={currentInputsHash}
              challenge={challengeWiring}
            />
          </div>
        ) : (
        <>
        {/* ① 话语 × 行为 */}
        <div className="rm-drawer-sec">
          <h4>话语 × 行为</h4>
          {f ? (
            <p className="rm-facts">
              话语 / <b>{f.n.toLocaleString("zh-CN")}</b> 条证据单元 · 分母{" "}
              <b>{f.N.toLocaleString("zh-CN")}</b>
              {/* 只有单格的 n/N 才是提及率；整行 / 整列是码次相加，出百分比会被读错 */}
              {f.rateMeaningful ? ` · ${Math.round(f.pct * 100)}%` : null}
              <span className="rm-dir rm-facts-dir">{f.glyph}</span>
              <span className={`rm-counter${f.counter === 0 ? " is-zero" : ""}`}>✗{f.counter}</span>
            </p>
          ) : null}
          {f && !f.rateMeaningful ? (
            <p className="rm-dim">
              这两个数是各格<b>相加</b>得来的：一轮可同时归入多个场景、也可挂多个需求码，
              所以它们都不是去重值，<b>相除不是提及率</b>——要看提及率请点具体的格。
            </p>
          ) : null}
          {/*
            行为侧由卡片的边界栏填。`synthesizeOne` 据实传 `present: false`
            （`CodedTurn` 不带行程指标），因此这一栏目前显示"没有行为侧对证"。
            界面只显示卡上的原文，不另行生成文案。
          */}
          {behaviour ? (
            <p className="rm-dim">{behaviour}</p>
          ) : (
            <Pending what="行为侧（对证的行程数与温度—续航对照）要等快照补 utterance / behavior 拆分，本页不自己算比率。归纳这一格之后，卡片的边界栏会说明三角验证成不成立。" />
          )}
        </div>

        {/*
          码提案队列只在兜底桶上出，对应兜底桶「补 codebook」这一动作。
        */}
        {isCatchAll ? (
          <div className="rm-drawer-sec">
            <h4>码提案</h4>
            <ProposalQueue rows={proposals} onDecide={onDecideProposal} busy={propBusy} />
          </div>
        ) : null}

        {/* ② 逐项分解：只有整行 / 整列选中时才有 */}
        {detail.breakdown.length > 0 ? (
          <div className="rm-drawer-sec">
            <h4>{detail.selection.kind === "row" ? "按场景分解" : "按需求码分解"}</h4>
            <table className="rm-break">
              <tbody>
                {detail.breakdown.map((b) => (
                  <tr key={b.label} className={b.suppressed ? "is-dim" : undefined}>
                    <td className="rm-break-label">{b.label}</td>
                    {b.suppressed ? (
                      <td className="rm-break-val" colSpan={2}>
                        样本不足
                      </td>
                    ) : (
                      <>
                        <td className="rm-break-val">
                          {b.n}/{b.N}
                        </td>
                        <td className="rm-break-pct">{Math.round(b.pct * 100)}%</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {/*
          ③ 典型原声保持 Pending。

          C2「找反例」只返回 `counterUnitIds`（工具只放行反例，`challenge/tools.ts`
          不提供"取典型成员"的分支）。把反例填进这一节会让与主流相反的声音
          顶着「典型」的标题出现，违反 §18.7「摘要即证据」。
          这一节需要按「需求码 × 场景」筛的逐条原声。
        */}
        <div className="rm-drawer-sec">
          <h4>典型原声</h4>
          <Pending what="逐条原声要按「需求码 × 场景」筛，而 /console/research/evidence 目前只能按 kind 与 counter 筛。C2「找反例」填不了这一节——它只取反例，顶着「典型」的标题出现会把结论读反。接上之后每条只出脱敏派生文本并带「已脱敏」徽章。" />
        </div>

        {/* ④ 反例：点「找反例」即时查出逐条句子 */}
        <div className="rm-drawer-sec">
          <h4>反例{f ? `（${f.counter}）` : ""}</h4>
          {counter ? (
            <CounterEvidence data={counter} />
          ) : f && f.counter === 0 ? (
            <p className="rm-dim">
              这一格 0 条反例。<b>0 不是好消息</b>——它更可能意味着没去找。
            </p>
          ) : (
            <Pending what="条数来自快照。点能力条上的「找反例」即时查出逐条句子（不写库）。" />
          )}
        </div>

        {/*
          ⑤ 置信构成由洞察卡填。多张卡时只出第一张的分量并注明是哪张，
          取平均会得到一组不属于任何一张卡的数。
        */}
        <div className="rm-drawer-sec">
          <h4>置信构成</h4>
          {firstCard ? (
            <>
              <ul className="rm-conf">
                {confidenceRows(firstCard.confidence).map((r) => (
                  <li key={r.key} className={r.lowest ? "is-lowest" : undefined}>
                    <span className="rm-conf-k">{r.label}</span>
                    <span className="uz-bar rm-conf-bar">
                      <i style={{ width: `${Math.round(r.value * 100)}%` }} />
                    </span>
                    <span className="rm-conf-v">{r.value.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
              <p className="rm-dim">
                来自「{firstCard.themeName || firstCard.themeId}」这张卡（C={firstCard.confidence.c.toFixed(2)}，
                最低项 <b>{firstCard.confidence.lowest}</b>）
                {insightCount > 1 ? `；这一格还有另外 ${insightCount - 1} 张卡，各自的分量在「相关洞察」里` : ""}
              </p>
              <p className="rm-dim">{firstCard.confidence.suggestion}</p>
              {/* 复编码一致率尚未测量，Agreement 据实算作 0，需在此说明 */}
              <p className="rm-dim">
                Agreement 另有一层：复编码一致率至今未测（M82-10），<b>据实算作 0</b> 而不是给一个中间值。
              </p>
            </>
          ) : (
            <>
              <ul className="rm-conf">
                {CONFIDENCE_FACTORS.map((k) => (
                  <li key={k}>
                    <span className="rm-conf-k">{k}</span>
                    <span className="uz-bar rm-conf-bar">
                      <i style={{ width: 0 }} />
                    </span>
                    <span className="rm-conf-v">—</span>
                  </li>
                ))}
              </ul>
              <Pending what="五个分量由 confidenceOf() 逐主题算，跟着洞察卡一起落库。这一格还没有卡——点能力条上的「归纳这一格」。" />
            </>
          )}
        </div>

        {/* ⑥ 升级到 Candidate 还缺：来自卡片的 upgrade_needs */}
        <div className="rm-drawer-sec">
          <h4>升级到 Candidate 还缺</h4>
          {upgrade.needs.length > 0 ? (
            <ul className="rm-needs">
              {upgrade.needs.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
          {/* 没有卡时如实说明，不用通用的「证据不足」代替 */}
          {upgrade.note ? <p className="rm-dim">{upgrade.note}</p> : null}
        </div>

        {/* ⑦ 已知偏差 */}
        <div className="rm-drawer-sec">
          <h4>已知偏差</h4>
          <p className="rm-dim">
            仅覆盖已授权车主——观察总体不等于市场总体，本页结论一律 Signal 级。
          </p>
          {/* 卡片自己的边界栏，原样显示 */}
          {behaviour ? <p className="rm-dim">{behaviour}</p> : null}
          <Pending what="其余偏差（如「冬季数据仅一个季度」）要读研究合同的 exclusions / freshness，而合同接口目前只回 id / title / status——洞察卡补不了这一处，它写的是这张卡自己的边界，不是这次研究声明的排除项。" />
        </div>

        {/* ⑧ 允许用途：政策而非数据，始终完整 */}
        <div className="rm-drawer-sec">
          <h4>允许用途</h4>
          <p className="rm-dim">{USAGE_NOTE}</p>
        </div>

        {/* ⑨ 责任人 / 复查日 */}
        <div className="rm-drawer-sec">
          <h4>责任人 / 复查日</h4>
          {firstCard ? (
            <p className="rm-dim">
              卡片归属：<b>{firstCard.owner}</b>
              {firstCard.reviewAt ? ` · 复查日 ${firstCard.reviewAt.slice(0, 10)}` : " · 还没定复查日"}
            </p>
          ) : null}
          {/*
            这一节保持 Pending：卡上的 owner 是 `research:unassigned` 常量
            （研究面没有登录态），不代表"这一格归谁"。责任人在研究合同上，
            而合同接口只回 id / title / status；用常量顶替会显示一个不存在的负责人。
          */}
          <Pending what="这一格归谁、什么时候复查，来自研究合同的 owner 与 reviewAt；合同接口目前只回 id / title / status。卡片上的 owner 是 research:unassigned 这个常量（研究面没有登录态），顶替不了它。" />
        </div>
        </>
        )}
      </div>

      <div className="rm-drawer-foot">
        <button type="button" className="btn" disabled title="逐条证据接口要先支持按码 × 场景筛">
          查看全部证据{f ? `（${f.n.toLocaleString("zh-CN")}）` : ""}
        </button>
        <button type="button" className="btn-secondary" disabled title="要先能定位到具体的证据单元">
          回放原声（记入审计）
        </button>
      </div>
    </div>
  );
}
