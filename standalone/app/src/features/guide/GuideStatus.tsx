/**
 * 导览的三处小件，状态文案一处定：
 *   GuideProgress  行程面板顶上的进度条「景点导览 3/7 已就绪 · 2 采集中」
 *   GuideBadge     时间轴行尾的小角标（就绪 / 采集中 / 未成功；未采不标）
 *   GuideAction    景点详情里的一行：状态 + 打开 / 获取
 */
import type { GuideJobsStatus, GuideJobState } from "@cabinhug/shared";

import { Badge, Button, Card, Icon } from "../../ui";
import s from "./GuideStatus.module.css";

export function GuideProgress({ jobs }: { jobs: GuideJobsStatus | null }) {
  if (!jobs || jobs.summary.total === 0) return null;
  const { total, ready, processing, pending, failed } = jobs.summary;
  const rest = [processing && `${processing} 采集中`, pending && `${pending} 排队`, failed && `${failed} 未成功`].filter(Boolean);
  return (
    <div className={s.progress} role="status" aria-label={`景点导览 ${ready}/${total} 已就绪`}>
      <Icon name="doc" size="sm" className={s.icon} />
      <span className={s.label}>景点导览</span>
      <span className={`${s.count} sa-num`}>
        {ready}/{total} 已就绪
      </span>
      {rest.length > 0 && <span className={s.rest}>{rest.join(" · ")}</span>}
      <span className={s.bar} aria-hidden="true">
        <span className={s.fill} style={{ width: `${(ready / total) * 100}%` }} />
      </span>
    </div>
  );
}

const BADGE: Partial<Record<GuideJobState, { tone: "ok" | "brand" | "neutral"; text: string }>> = {
  ready: { tone: "ok", text: "导览已就绪" },
  processing: { tone: "brand", text: "导览采集中" },
  pending: { tone: "brand", text: "导览排队中" },
  failed: { tone: "neutral", text: "导览未成功" },
};

export function GuideBadge({ state }: { state: GuideJobState | undefined }) {
  const b = state && BADGE[state];
  return b ? (
    <span className={s.badge}>
      <Badge tone={b.tone} size="sm">
        {b.text}
      </Badge>
    </span>
  ) : null;
}

export function GuideAction({
  confirmed,
  state,
  onOpen,
  onFetch,
}: {
  /** 行程定下来之前没有采集任务。 */
  confirmed: boolean;
  state: GuideJobState | undefined;
  onOpen(): void;
  onFetch(): void;
}) {
  const busy = state === "pending" || state === "processing";
  return (
    <Card variant="inset" padding="sm" className={s.action}>
      <Icon name="pin" className={s.icon} />
      <div className={s.actionText}>
        <strong>景点导览</strong>
        <span className={s.hint}>
          {!confirmed
            ? "行程定下来后，会逐个整理每个景点的游玩路线、停车与休憩信息"
            : state === "ready"
              ? "游玩路线、停车与休憩信息已整理好"
              : busy
                ? "正在整理，首次约需一分钟"
                : state === "failed"
                  ? "上次没整理成，可以再试一次"
                  : "还没整理这一站"}
        </span>
      </div>
      {confirmed &&
        (state === "ready" ? (
          <Button size="sm" variant="primary" onClick={onOpen}>
            打开导览
          </Button>
        ) : (
          <Button size="sm" disabled={busy} onClick={onFetch}>
            {busy ? "整理中…" : "获取导览"}
          </Button>
        ))}
    </Card>
  );
}
