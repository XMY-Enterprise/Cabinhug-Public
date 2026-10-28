/**
 * HITL 跨层确认弹窗（FL-04 F-04-01/F-04-02，均 P0；
 * 真实 resume：F-04-08）。
 *
 * # 跨层
 *
 * 权限门挂起发生在用户可能已经切走的时候（§8.4：`interrupt()` 挂起那条内部 HTTP
 * 请求，等 resume）。确认弹窗层级高于 HUD 与对话层、不依赖当前在哪一层，
 * 因此用 overlay 而不是某一层内部的组件：挂在路由层级里的弹窗，
 * 用户切到 HUD 就看不见了，而那笔动作还挂着。
 *
 * # F-04-02：渲染动作明细，不只显示动作名
 *
 * 要显示门店、时间以及将提供给门店的信息（F-26-09）。后者由
 * `enterprise/backend/shared/tools` 的 `describeDisclosure()` 生成，前端只渲染、
 * 不自己拼，保证用户看到的与实际发出去的一致。
 *
 * # 直接使用契约类型 `PermissionRequest`
 *
 * SSE `permission` 事件的载荷就是 `PermissionRequest`，不另定义本地形状，
 * 避免两份形状漂移。
 *
 * # 决策只有一个出口 `onDecide(approved)`，弹层自己不碰网络
 *
 * 与车机 `ConfirmSheet` 同一形态：幂等在网关 HitlRelay；resume 没被接住时由外层传 `notice`。
 * 有 `notice` 就不显示两个出口：这一屏表达的是"刚才那次没生效"，不能静默收起。
 */
import type { PermissionRequest } from "@cabinhug/shared";
import { parseAuditDetails, stripAuditDetails } from "@cabinhug/shared";
import { AuditSection } from "@cabinhug/ui";

export interface ConfirmDialogProps {
  request: PermissionRequest | null;
  /** resume 发送中：双键禁用，防连点（连点本身也幂等，这只是手感）。 */
  busy?: boolean;
  /** 确认没被接住时的告知（见文件头）。 */
  notice?: string;
  onDismissNotice?: () => void;
  onDecide: (approved: boolean) => void;
}

export function ConfirmDialog({ request, busy, notice, onDismissNotice, onDecide }: ConfirmDialogProps) {
  if (!request) return null;

  // 体检行单独成区：摘要条 + 两段；其余明细逐行显示。
  const audit = parseAuditDetails(request.details);
  const rows = stripAuditDetails(request.details);

  return (
    <div className="hitl-overlay" role="dialog" aria-modal="true" aria-label={request.title}>
      <div className="hitl-panel">
        <h2 className="hitl-title">{request.title}</h2>

        {audit && <AuditSection summary={audit} />}

        <dl className="hitl-details">
          {rows.map((d, i) => (
            <div key={`${d.label}-${i}`} className="hitl-row">
              <dt>{d.label}</dt>
              <dd>{d.value}</dd>
            </div>
          ))}
          {/* 影响范围（如写入哪个日历账号）。契约里可为 null——那时不摆一行空的。 */}
          {request.scope && (
            <div className="hitl-row hitl-row--scope">
              <dt>影响范围</dt>
              <dd>{request.scope}</dd>
            </div>
          )}
        </dl>

        {/* 外发信息单独成块并加标题：混在动作明细里，用户不会意识到
            这几行的性质和"门店地址"完全不同（F-26-09）。 */}
        {request.disclosure.length > 0 && (
          <section className="hitl-disclosure">
            <h3>将提供给门店的信息</h3>
            <dl className="hitl-details">
              {request.disclosure.map((d, i) => (
                <div key={`${d.label}-${i}`} className="hitl-row">
                  <dt>{d.label}</dt>
                  <dd>{d.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        {notice && (
          <p className="hitl-notice" role="alert">
            {notice}
          </p>
        )}

        <div className="hitl-actions">
          {notice ? (
            <button type="button" className="is-primary hitl-actions__single" onClick={onDismissNotice}>
              知道了
            </button>
          ) : (
            <>
              {/* 拒绝在左、确认在右，且拒绝不用次要样式：
                  这是一个有后果的动作，两个选项平权呈现。 */}
              <button type="button" disabled={busy} onClick={() => onDecide(false)}>
                不了
              </button>
              <button type="button" className="is-primary" disabled={busy} onClick={() => onDecide(true)}>
                {busy ? "发送中…" : "确认"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
