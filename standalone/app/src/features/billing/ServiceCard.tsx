/**
 * 一家服务一张卡（照控制台财务页：卡片就是选择器，下面的明细表跟着切）。
 *
 * 大数字是「本期花了多少」：有单价的写估算金额；没有单价的写不出钱，高德写今天的额度用量，
 * 阿里云写调用次数——不编一个金额。余额是供应商现查的，与上面的估算分两行摆，口径不同、不互相推算。
 */
import type { BillingService } from "@cabinhug/shared";

import { balanceText, formatMoney, quotaRatio } from "../../billing";
import { cx, Icon, type IconName } from "../../ui";
import s from "./ServiceCard.module.css";

const ICON: Record<string, IconName> = { deepseek: "chat", aliyun: "shield", amap: "pin" };

export function ServiceCard({
  service,
  selected,
  onSelect,
}: {
  service: BillingService;
  selected: boolean;
  onSelect(): void;
}) {
  const ratio = quotaRatio(service);
  const balance = balanceText(service);
  const level = ratio === undefined ? undefined : ratio >= 0.9 ? "danger" : ratio >= 0.7 ? "warn" : "ok";
  return (
    <button type="button" className={cx(s.card, selected && s.selected)} aria-pressed={selected} onClick={onSelect}>
      <header className={s.head}>
        <span className={s.icon}>
          <Icon name={ICON[service.id] ?? "database"} />
        </span>
        <span className={s.titles}>
          <span className={s.name}>{service.label}</span>
          <span className={s.role}>{service.role}</span>
        </span>
      </header>

      {service.costEstimate !== undefined ? (
        <div className={s.figure}>
          <span className={`${s.big} sa-num`}>{formatMoney(service.costEstimate)}</span>
          <span className={s.unit}>估算花费</span>
        </div>
      ) : service.quota ? (
        <div className={s.figure}>
          <span className={`${s.big} sa-num`}>
            {service.quota.used}
            <span className={s.of}> / {service.quota.limit}</span>
          </span>
          <span className={s.unit}>今日地点搜索</span>
        </div>
      ) : (
        <div className={s.figure}>
          <span className={`${s.big} sa-num`}>{service.calls}</span>
          <span className={s.unit}>次调用</span>
        </div>
      )}

      {ratio !== undefined && (
        <div className={s.meter} role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={ratio} aria-label="今日额度">
          <span className={cx(s.fill, level && s[level])} style={{ width: `${Math.round(ratio * 100)}%` }} />
        </div>
      )}

      <dl className={s.facts}>
        <div>
          <dt>调用</dt>
          <dd className="sa-num">{service.calls} 次</dd>
        </div>
        {balance !== undefined && (
          <div>
            <dt>账户余额</dt>
            <dd className={cx("sa-num", service.balance?.status !== "ok" && s.muted)}>{balance}</dd>
          </div>
        )}
      </dl>
      {service.balance?.status === "failed" && service.balance.note && <p className={s.error}>{service.balance.note}</p>}
    </button>
  );
}
