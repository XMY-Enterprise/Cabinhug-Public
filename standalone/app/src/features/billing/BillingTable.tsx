/**
 * 所选那一家的明细：模型按 Agent 拆（带 token 与估算花费），审核按层拆，地图按接口族拆。
 * 列跟着数据走：哪一列整列都没有值就不出这一列，不摆一列横线。
 */
import type { BillingService } from "@cabinhug/shared";

import { formatMoney, formatTokens, rowLabel } from "../../billing";
import s from "./BillingTable.module.css";

export function BillingTable({ service }: { service: BillingService }) {
  const rows = service.rows;
  if (rows.length === 0) return <p className={s.empty}>这段时间没有{service.label}的调用。</p>;
  const tokens = rows.some((r) => r.promptTokens !== undefined);
  const cost = rows.some((r) => r.costEstimate !== undefined);
  const sum = (pick: (r: (typeof rows)[number]) => number | undefined) => rows.reduce((t, r) => t + (pick(r) ?? 0), 0);
  return (
    <table className={s.table}>
      <thead>
        <tr>
          <th>{service.id === "amap" ? "接口" : service.id === "aliyun" ? "审核" : "用途"}</th>
          <th className={s.num}>调用</th>
          {tokens && <th className={s.num}>输入 token</th>}
          {tokens && <th className={s.num}>输出 token</th>}
          {cost && <th className={s.num}>估算花费</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td title={r.key}>{rowLabel(service.id, r.key)}</td>
            <td className={`${s.num} sa-num`}>{r.calls}</td>
            {tokens && <td className={`${s.num} sa-num`}>{formatTokens(r.promptTokens)}</td>}
            {tokens && <td className={`${s.num} sa-num`}>{formatTokens(r.completionTokens)}</td>}
            {cost && <td className={`${s.num} sa-num`}>{formatMoney(r.costEstimate)}</td>}
          </tr>
        ))}
      </tbody>
      {rows.length > 1 && (
        <tfoot>
          <tr>
            <td>合计</td>
            <td className={`${s.num} sa-num`}>{sum((r) => r.calls)}</td>
            {tokens && <td className={`${s.num} sa-num`}>{formatTokens(sum((r) => r.promptTokens))}</td>}
            {tokens && <td className={`${s.num} sa-num`}>{formatTokens(sum((r) => r.completionTokens))}</td>}
            {cost && <td className={`${s.num} sa-num`}>{formatMoney(sum((r) => r.costEstimate))}</td>}
          </tr>
        </tfoot>
      )}
    </table>
  );
}
