/**
 * 引导配合（设计 UI-01 v1.1 第 3 步）：观察卡 + Agent 发起的交互卡，挂在对话列表末尾（`DialogScreen.trailing`）。
 *
 * 全部读结构化报告（`DiagnosisReport`），不解析回答文本。
 * 补拍与追问由 `prompts.tsx` 的五型卡片呈现：出哪几张、什么顺序由服务端的预算器定
 * （`report.prompts`），这里只负责把观察卡摆在它们上面。
 */
import { lampArt } from "./lamps";
import { PromptCards } from "./prompts";
import type { DiagnosisObservedItem, DiagnosisReport } from "./types";

import "./diagnosis.css";

const COLOR_ZH: Record<string, string> = { red: "红色", amber: "琥珀色", green: "绿色", blue: "蓝色", white: "白色", gray: "灰色", black: "黑色", unknown: "颜色未定" };
const CLASS_ZH: Record<string, string> = { fault: "故障类", reminder: "提醒类", status: "状态类" };

function itemCaption(it: DiagnosisObservedItem): string {
  const parts = [COLOR_ZH[it.color] ?? it.color];
  if (it.class) parts.push(CLASS_ZH[it.class] ?? it.class);
  if (it.manualAnchor) parts.push(it.manualAnchor);
  else parts.push("未能与手册完全对上");
  return parts.join(" · ");
}

/**
 * 那枚灯长什么样。
 *
 * 优先用手册里那张图（`lampArt`，按 `symbolId` 取）：车主要分辨的正是符号本身，
 * 统一的三角感叹号会让「安全带未系」和「胎压报警」在屏幕上无法区分。
 *
 * 取不到才回落到按颜色着色的三角块：目录里新增一个符号时，端上少一枚图标，
 * 而不是留一个破图。回落不画具体形状：端上画一个相似的图形等于在手册之外
 * 另立一个真相源，观察层不这样做。
 */
function LampGlyph({ item }: { item: DiagnosisObservedItem }) {
  const art = lampArt(item.symbolId);
  const tone = item.color === "red" ? "var(--hud-danger)" : item.color === "amber" ? "var(--hud-amber)" : "var(--hud-text-muted)";
  return (
    <span className="dx-lamp" aria-hidden="true">
      {art ? (
        <img className="dx-lamp__art" src={art} alt="" draggable={false} />
      ) : (
        <svg viewBox="0 0 24 24">
          <path d="M12 3l9 16H3z" fill={tone} />
          <path d="M12 9v5M12 16.5v.5" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )}
    </span>
  );
}

type Observation = NonNullable<DiagnosisReport["observation"]>;

/**
 * 卡的标题。三种结果各有各的说法，不合并：
 * 「没读出来」是图坏了，「没认出符号」是图正常但没认出符号；
 * 后者不能显示成「看到了 0 盏亮着的灯」。
 */
function cardTitle(obs: Observation, lit: number): string {
  if (obs.unreadable) return "这张照片没读出来";
  if (obs.items.length === 0) return obs.alerts.length > 0 ? "读到了车机警报" : "这张没认出仪表上的符号";
  return `看到了 ${lit || obs.items.length} 盏亮着的灯`;
}

/**
 * 一条符号都没有时那句话。说明是「没认出来」而不是「车上没有」，
 * 车上可能正亮着一盏红灯。
 *
 * 这里不说「该怎么补拍」：那一句归服务端出的拍照卡（`captureFromRetakeHints`），
 * 就在这张卡下面；端上再拼一句会让同一句话出现两遍。
 */
function emptyNote(obs: Observation): string {
  return obs.unreadable ? "图片没能解出内容，换一张再试。" : "这不代表车上没有提示灯，只是这张没能和手册图标对上。";
}

/**
 * 说明行。疑似的那条写成条件句（`若是「X」：…`）。
 *
 * 疑似候选的手册原文原样贴出时，整段原文的份量会盖过旁边的「疑似」徽章，
 * 读起来像一条确定的结论。条件句保留信息，又不替手册下结论。
 */
function descLine(it: DiagnosisObservedItem): string {
  return it.suspected && it.name ? `若是「${it.name}」：${it.description}` : String(it.description);
}

export function ObservationCard({ report, onOpenReport }: { report: DiagnosisReport; onOpenReport?: () => void }) {
  const obs = report.observation;
  if (!obs) return null;
  const lit = obs.items.filter((it) => it.state === "lit").length;
  // 一条都没有时也要有个说法：见 `emptyNote`。
  const empty = obs.items.length === 0 && obs.alerts.length === 0;
  return (
    <section className="dx-card" data-testid="dx-observation">
      <header className="dx-card__head">
        <b className="dx-card__title">{cardTitle(obs, lit)}</b>
        {onOpenReport && (
          <button type="button" className="dx-link" onClick={onOpenReport}>
            查看报告 ›
          </button>
        )}
      </header>
      {obs.items.map((it, i) => (
        <div className="dx-item" key={`${it.name ?? "?"}-${i}`}>
          <LampGlyph item={it} />
          <span className="dx-item__text">
            <b>{it.suspected ? `疑似：${it.name ?? "未知符号"}` : (it.name ?? "未能对上的符号")}</b>
            <span>{itemCaption(it)}</span>
            {/* 手册原文说明。分类与锚点是"它属于哪一类、去哪查"，这一行是"它是什么意思"。 */}
            {it.description && <span className="dx-item__desc">{descLine(it)}</span>}
          </span>
          <span className={`dx-chip ${it.suspected || !it.name ? "dx-chip--amber" : "dx-chip--ok"}`}>{it.suspected || !it.name ? "疑似" : "已对上手册"}</span>
        </div>
      ))}
      {empty && <p className="dx-card__note">{emptyNote(obs)}</p>}
      {obs.alerts.length > 0 && (
        <p className="dx-card__note">读到 {obs.alerts.length} 条车机警报：{obs.alerts.map((a) => a.code).join("、")}</p>
      )}
    </section>
  );
}

export interface DiagnosisCardsProps {
  report: DiagnosisReport;
  onRetake: () => void;
  onAnswer: (text: string) => void;
  onOpenReport: () => void;
}

/**
 * 按 Brief 顺序：观察 → 交互卡（拍照 → 引导 → 提问，顺序由服务端给）。
 * 这一轮没有照片（比如答完追问的那一轮）时观察卡不在，「查看报告」由一行小卡承接，
 * 否则报告只能从主页那张卡的状态行进入。
 */
export function DiagnosisCards({ report, onRetake, onAnswer, onOpenReport }: DiagnosisCardsProps) {
  return (
    <div className="dx-cards" data-testid="dx-cards">
      {report.observation ? (
        <ObservationCard report={report} onOpenReport={onOpenReport} />
      ) : (
        <section className="dx-card dx-card--row" data-testid="dx-report-row">
          <span className="dx-card__title">诊断报告已更新</span>
          <button type="button" className="dx-link" onClick={onOpenReport}>
            查看报告 ›
          </button>
        </section>
      )}
      {/* `key={report.at}`：新一轮的报告 = 新的一组卡，选中态与「已发送」随之清掉。 */}
      <PromptCards key={report.at} prompts={report.prompts} onAnswer={onAnswer} onCapture={onRetake} />
    </div>
  );
}
