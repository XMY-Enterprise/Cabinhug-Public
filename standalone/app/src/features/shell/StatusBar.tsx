/**
 * 底部状态栏：本机服务是不是在跑、此刻在不在规划、日志在哪。
 *
 * 每一格都读宿主真实的启动步骤（`HostStatus.steps`），名字照宿主的写——
 * 不另起「编排服务」「工具服务」这类宿主里没有的名字。
 */
import { Icon, StatusDot, type IconName, type StatusTone } from "../../ui";
import type { HostStatus, HostStep } from "../../types";
import s from "./StatusBar.module.css";

/** 状态栏挑出来的三步：车主关心的是"能不能规划"，迁移、账号这类一次性步骤不上栏。 */
const SHOWN: ReadonlyArray<{ id: string; icon: IconName; ok: string }> = [
  { id: "agent-runtime", icon: "network", ok: "正常" },
  { id: "gateway", icon: "route", ok: "就绪" },
  { id: "database", icon: "database", ok: "已连接" },
];

const STATE_TEXT: Record<HostStep["state"], string> = { waiting: "等待", running: "启动中", done: "", failed: "失败" };

function overall(status: HostStatus): { tone: StatusTone; text: string } {
  if (status.phase === "ready") return { tone: "ok", text: "本地 Agent 运行中" };
  if (status.phase === "failed") return { tone: "danger", text: status.message ?? "本地服务启动失败" };
  if (status.phase === "starting") return { tone: "busy", text: "本地服务启动中…" };
  return { tone: "idle", text: status.message ?? "本地服务未运行" };
}

export function StatusBar({ status, busy, onOpenLogs }: { status: HostStatus; busy: boolean; onOpenLogs(): void }) {
  const head = overall(status);
  return (
    <footer className={s.bar}>
      <span className={s.head}>
        <StatusDot tone={head.tone} size="md" />
        {head.text}
      </span>
      {SHOWN.map((x) => {
        const step = status.steps.find((st) => st.id === x.id);
        if (!step) return null;
        return (
          <span key={x.id} className={s.cell} title={step.detail ?? undefined}>
            <Icon name={x.icon} className={s.icon} />
            {step.label}
            <span className={s[step.state]}>{step.state === "done" ? x.ok : STATE_TEXT[step.state]}</span>
          </span>
        );
      })}
      <span className={s.spacer} />
      <span className={s.cell}>
        <Icon name="wave" className={s.icon} />
        当前任务：<span className={busy ? s.running : undefined}>{busy ? "正在规划…" : "空闲"}</span>
      </span>
      <button type="button" className={s.link} onClick={onOpenLogs}>
        运行日志
        <Icon name="chevron-right" size="sm" />
      </button>
    </footer>
  );
}
