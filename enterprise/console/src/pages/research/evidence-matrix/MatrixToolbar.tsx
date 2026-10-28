/**
 * 证据矩阵的工具条（Brief `evidence-matrix.brief.md` §3④）。
 *
 * 五件东西：`显示`分段器 ·`人群`下拉 ·`场景列设置` ·`密度`分段器 · 右端 `导出 CSV`。
 * 不放"生成报告"按钮：本页是读数页（Brief §2）。
 *
 * # 「百分比」档也带分母
 *
 * Brief 原则 1 是"任何位置不允许出现裸百分比"，而工具条上确实有一个叫「百分比」的档。
 * 两者不矛盾：这个分段器换的是哪个数占主位，不是"要不要分母"。
 * 两档都同时渲染 `n/N` 与 `%`，只交换字号与颜色。
 * 百分比档若只留 23%，这一屏的数字就都没有分母，违背本页"每个数字都带分母"的前提。
 *
 * # 「人群」是禁用的，且说得出在等什么
 *
 * 快照里没有分人群的格——`evidence-matrix` 的 `data` 只有 `scenes × rows`。
 * 可点但无效果的下拉会让人误以为已经筛选过，所以禁用并说明原因。
 */

import { useEffect, useRef, useState } from "react";

/** 单元格里 `n/N` 与 `%` 谁占主位。两档都出分母，理由见文件头。 */
export type MatrixDisplay = "count" | "percent";

/** 行高。紧凑档只改 padding，不减任何一项内容——五项缺一都不是这一页。 */
export type MatrixDensity = "compact" | "comfortable";

export interface MatrixToolbarProps {
  display: MatrixDisplay;
  onDisplay: (v: MatrixDisplay) => void;
  density: MatrixDensity;
  onDensity: (v: MatrixDensity) => void;
  scenes: ReadonlyArray<{ code: string; label: string }>;
  hiddenScenes: readonly string[];
  onHiddenScenes: (v: string[]) => void;
  onExportCsv: () => void;
}

function Seg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
}): JSX.Element {
  return (
    <span className="uz-seg">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={o.value === value ? "is-on" : undefined}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

/** 场景列的显隐。最后一列不许取消：空矩阵不是一个有意义的状态。 */
function SceneColumns({
  scenes,
  hidden,
  onChange,
}: {
  scenes: ReadonlyArray<{ code: string; label: string }>;
  hidden: readonly string[];
  onChange: (v: string[]) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const shownCount = scenes.length - hidden.length;

  return (
    <span className="rm-cols" ref={box}>
      <button type="button" className="rm-cols-btn" onClick={() => setOpen(!open)}>
        场景列设置
        {shownCount < scenes.length ? <b className="rm-cols-badge">{shownCount}</b> : null}
        <span className="rm-caret">▾</span>
      </button>
      {open ? (
        <div className="rm-cols-pop">
          {scenes.map((s) => {
            const on = !hidden.includes(s.code);
            // 只剩一列时不许再取消它
            const locked = on && shownCount <= 1;
            return (
              <label key={s.code} className={locked ? "is-locked" : undefined}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={locked}
                  onChange={() =>
                    onChange(on ? [...hidden, s.code] : hidden.filter((c) => c !== s.code))
                  }
                />
                {s.label}
              </label>
            );
          })}
          <p className="rm-cols-note">
            列的显隐只是取舍：格里的数与条形的归一化基准都不跟着变。
          </p>
        </div>
      ) : null}
    </span>
  );
}

export function MatrixToolbar(props: MatrixToolbarProps): JSX.Element {
  return (
    <>
      <span className="rm-tool-label">显示：</span>
      <Seg
        value={props.display}
        onChange={props.onDisplay}
        options={[
          { value: "count", label: "次数" },
          { value: "percent", label: "百分比" },
        ]}
      />

      <span className="rm-tool-label">人群：</span>
      <select
        className="rm-select"
        value="all"
        disabled
        title="分人群要快照按人群分别出格；evidence-matrix 的 data 目前只有 scenes × rows 一层"
        onChange={() => undefined}
      >
        <option value="all">全部车主</option>
      </select>

      <SceneColumns
        scenes={props.scenes}
        hidden={props.hiddenScenes}
        onChange={props.onHiddenScenes}
      />

      <span className="rm-tool-label">密度：</span>
      <Seg
        value={props.density}
        onChange={props.onDensity}
        options={[
          { value: "compact", label: "紧凑" },
          { value: "comfortable", label: "舒适" },
        ]}
      />

      <span className="rm-spacer" />
      {/* 本页是读数页，不放"生成报告"按钮（Brief §2 / §3④） */}
      <button type="button" className="btn-secondary" onClick={props.onExportCsv}>
        导出 CSV
      </button>
    </>
  );
}
