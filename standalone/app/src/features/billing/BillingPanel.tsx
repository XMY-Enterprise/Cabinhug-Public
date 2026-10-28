/**
 * 设置 · 费用明细（ACR-066）：上面一排服务卡（照控制台财务页，卡片当选择器），下面是所选那一家的明细。
 *
 * 单机版是 BYOK，花的是车主自己的钱：估算花费是本机记的账，余额是供应商现查的，两者口径不同，
 * 页面上分开摆、不互相推算。后台导览预采集的用量记在占位会话下，只有本机只有一个账号时才算进来，
 * 页脚如实交代算没算。
 */
import { useState } from "react";

import { BILLING_RANGES, type BillingRange } from "@cabinhug/shared";

import { formatMoney, RANGE_LABEL } from "../../billing";
import { Button, Callout, cx, Segmented } from "../../ui";
import { BillingTable } from "./BillingTable";
import s from "./BillingPanel.module.css";
import { ServiceCard } from "./ServiceCard";
import type { BillingApi } from "./useBilling";

const RANGE_OPTIONS = BILLING_RANGES.map((r) => ({ value: r, label: RANGE_LABEL[r] }));

function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function BillingPanel({ billing }: { billing: BillingApi }) {
  const { state, range } = billing;
  const [selected, setSelected] = useState("deepseek");
  const data = state.kind === "ready" || state.kind === "loading" ? state.data : undefined;
  const service = data?.services.find((x) => x.id === selected) ?? data?.services[0];

  return (
    <div className={s.panel}>
      <div className={s.bar}>
        <div className={s.total}>
          <span className={s.totalLabel}>{RANGE_LABEL[range]}估算花费</span>
          <span className={`${s.totalValue} sa-num`}>{data ? formatMoney(data.totalCostEstimate) : "—"}</span>
        </div>
        <Segmented<BillingRange>
          label="时间段"
          options={RANGE_OPTIONS}
          value={range}
          onChange={billing.setRange}
          tone="soft"
        />
        <Button variant="ghost" size="sm" icon="refresh" onClick={billing.refresh} disabled={state.kind === "loading"}>
          {state.kind === "loading" ? "查询中…" : "刷新"}
        </Button>
      </div>

      {state.kind === "error" && (
        <Callout tone="warn" title="读不到费用明细">
          {state.message}。本地服务起来后点「刷新」。
        </Callout>
      )}

      {!data && state.kind === "loading" && (
        <div className={s.grid} aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className={s.skeleton} />
          ))}
        </div>
      )}

      {data && (
        <>
          <div className={cx(s.grid, state.kind === "loading" && s.stale)}>
            {data.services.map((x) => (
              <ServiceCard key={x.id} service={x} selected={x.id === service?.id} onSelect={() => setSelected(x.id)} />
            ))}
          </div>

          {service && (
            <section className={s.detail} aria-label={`${service.label} 明细`}>
              <header className={s.detailHead}>
                <h3 className={s.detailTitle}>{service.label} · 明细</h3>
                {service.id === "amap" ? (
                  <span className={s.scope}>北京时间 {service.quota?.day ?? "今天"}</span>
                ) : (
                  <span className={s.scope}>{RANGE_LABEL[range]}</span>
                )}
              </header>
              <BillingTable service={service} />
              {service.note && <p className={s.note}>{service.note}</p>}
            </section>
          )}

          <p className={s.foot}>
            {data.background === "included"
              ? "已含后台任务（景点导览预采集、导航规划）的用量。"
              : "本机不止一个账号，后台任务（景点导览预采集、导航规划）的用量归不到个人，没有算进来。"}
            估算花费按本机记的 token 与配置单价算，只能说「至少花了这么多」，以各家账单为准。更新于 {clock(data.generatedAt)}。
          </p>
        </>
      )}
    </div>
  );
}
