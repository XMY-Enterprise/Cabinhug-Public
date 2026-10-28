/**
 * 内联的二次确认条。
 *
 * # 不用 `window.confirm`
 *
 * 确认条要能填 `reason`（进审计 detail），并写清后果（"该设备下一次刷新登录即失效"），
 * 原生 confirm 做不到。后台没有 modal 风格，因此做成就地展开的一条，与 `.id-form` 同形。
 *
 * # 一次只开一个
 *
 * 父组件持 `pendingId`，点另一行的按钮就切过去；本组件只负责展开态本身。
 */

import { useState } from "react";

/** 与网关 `console/identity.ts` 的 `MAX_REASON_LEN` 一致。 */
export const MAX_REASON_LEN = 200;

export function reasonTooLong(reason: string): boolean {
  return reason.trim().length > MAX_REASON_LEN;
}

export function ConfirmAction({
  title,
  consequence,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  /** 后果一句：执行后会发生什么。 */
  consequence: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: (reason?: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const [reason, setReason] = useState("");
  const tooLong = reasonTooLong(reason);
  return (
    <div className="confirm-action" role="alertdialog" aria-label={title}>
      <div className="confirm-action-title">{title}</div>
      <p className="confirm-action-consequence">{consequence}</p>
      <div className="confirm-action-row">
        <input
          value={reason}
          placeholder="理由（可选，≤200 字，进审计）"
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
        />
        <button type="button" className="btn btn-sm id-danger" disabled={busy || tooLong} onClick={() => onConfirm(reason.trim() || undefined)}>
          {busy ? "处理中…" : confirmLabel}
        </button>
        <button type="button" className="btn-link" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
      {tooLong ? <p className="error tiny">理由不能超过 {MAX_REASON_LEN} 字（现在 {reason.trim().length}）</p> : null}
    </div>
  );
}
