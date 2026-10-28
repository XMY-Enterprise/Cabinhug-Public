/**
 * 能力条。
 *
 * 判断都在 `rail-model.ts`，这里只渲染——那一半要被逐条断言，
 * 混入 JSX 就只能靠渲染快照验证，而快照对样式改动过于敏感。
 */

import { useState } from "react";

import type { SelectionScope } from "@cabinhug/research/capabilities";

import { railModel, type RailButton } from "./rail-model";

/**
 * 一个按钮。导出供渲染用例单独测试：
 * 未实现的能力常被「能点的排前面」挤进折叠起来的 `⋯` 里（收起时不渲染），
 * 经整条能力条断言 `disabled` 属性时可能变成空断言；单独测试这个组件，
 * 断言就不受哪条能力尚未实现的影响。
 */
export function RailBtn({ b, onRun }: { b: RailButton; onRun: (key: string) => void }): JSX.Element {
  return (
    <button
      type="button"
      className={`btn rm-cap${b.disabled ? " is-off" : ""}`}
      disabled={b.disabled}
      title={b.title}
      onClick={() => onRun(b.key)}
    >
      <span className="rm-cap-icon">{b.icon}</span>
      {b.label}
    </button>
  );
}

export function CapabilityRail({
  scope,
  suppressedReason,
  onRun,
  busy,
}: {
  scope: SelectionScope | null;
  suppressedReason: string | null;
  onRun: (key: string) => void;
  /** 正在跑的那条能力的 key；它自己显示成"跑着呢"，其余照常。 */
  busy?: string | null;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const model = railModel(scope, suppressedReason);

  if (model.kind === "empty") return null;

  /*
   * 抑制态：位置留着，按钮一个不出。
   * 整块不渲染的话，读的人会以为这一格和别的格一样、只是还没加载出来。
   */
  if (model.kind === "suppressed") {
    return (
      <div className="rm-cap-rail is-suppressed">
        <p className="rm-dim">{model.note}</p>
      </div>
    );
  }

  return (
    <div className="rm-cap-rail">
      {model.primary.map((b) => (
        <RailBtn key={b.id} b={busy === b.key ? { ...b, label: `${b.label}…`, disabled: true } : b} onRun={onRun} />
      ))}
      {model.overflow.length > 0 ? (
        <div className="rm-cap-more">
          <button
            type="button"
            className="btn-secondary rm-cap"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            title={`还有 ${model.overflow.length} 条`}
          >
            ⋯
          </button>
          {open ? (
            <div className="rm-cap-menu">
              {model.overflow.map((b) => (
                <RailBtn key={b.id} b={b} onRun={onRun} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
