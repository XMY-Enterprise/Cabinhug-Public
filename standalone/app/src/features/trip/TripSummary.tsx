/**
 * 行程概要卡（定稿顶部居中）：第一行「上海 → 杭州 · 3天2晚 · 10/24–10/26 · 已确认」，
 * 第二行当前这一天的几格指标。右侧的 ⌄ 收起第二行。草案态在这里给「定下来 / 重新排」。
 */
import { useState } from "react";

import type { TripPlanSnapshot } from "@cabinhug/shared";

import { Badge, Button, Card, Stat, StatRow } from "../../ui";
import { dateRangeLabel, dayHeadline, driveSummary, durationLabel, isConfirmed, nextStopOf } from "../../trip";
import s from "./TripSummary.module.css";

export function TripSummary({
  plan,
  day,
  busy,
  onSend,
}: {
  plan: TripPlanSnapshot;
  /** 第二行讲的是哪一天（面板选中的那天，否则今天或第 1 天）。 */
  day: number;
  busy: boolean;
  onSend(text: string): void;
}) {
  const [open, setOpen] = useState(true);
  const confirmed = isConfirmed(plan);
  const range = dateRangeLabel(plan);
  const d = plan.skeleton.find((x) => x.day === day);
  const next = nextStopOf(plan, day, new Date());
  const drive = driveSummary(plan);
  return (
    <Card variant="float" padding="lg" className={s.card} data-map-topbar="">
      <div className={s.head}>
        <h1 className={s.route}>{plan.origin ? `${plan.origin} → ${plan.destination}` : plan.destination}</h1>
        <span className={`${s.meta} sa-num`}>
          {durationLabel(plan)}
          {range ? ` · ${range}` : ""}
        </span>
        <Badge tone={confirmed ? "ok" : "pending"}>{confirmed ? "已确认" : "草案 · 未保存"}</Badge>
        <span className={s.spacer} />
        {!confirmed && (
          <>
            <Button variant="primary" shape="pill" disabled={busy} onClick={() => onSend("就这样定了")}>
              定下来
            </Button>
            <Button shape="pill" disabled={busy} onClick={() => onSend("重新排一下")}>
              重新排
            </Button>
          </>
        )}
        <Button
          shape="circle"
          icon={open ? "chevron-down" : "chevron-up"}
          label={open ? "收起概要" : "展开概要"}
          onClick={() => setOpen((v) => !v)}
        />
      </div>
      {open && (
        <StatRow>
          {d && (
            <Stat icon="calendar">
              Day {d.day} · {dayHeadline(d)}
            </Stat>
          )}
          {next && (
            <Stat icon="bolt" label={next.label}>
              {next.name}
            </Stat>
          )}
          {drive.outboundKm && <Stat icon="car">{drive.outboundKm}</Stat>}
          {drive.outbound && (
            <Stat icon="clock" label="去程">
              {drive.outbound}
            </Stat>
          )}
        </StatRow>
      )}
    </Card>
  );
}

/** 还没有行程时概要卡的位置：一句怎么开始，和一个叫出助手的入口。 */
export function TripSummaryEmpty({ onAsk }: { onAsk(): void }) {
  return (
    <Card variant="float" padding="lg" className={s.card}>
      <div className={s.head}>
        <h1 className={s.route}>想去哪儿？</h1>
        <span className={s.meta}>说一句想去哪、玩几天，行程会出现在地图上</span>
        <span className={s.spacer} />
        <Button variant="primary" shape="pill" icon="chat" onClick={onAsk}>
          和助手说
        </Button>
      </div>
    </Card>
  );
}
