/**
 * 单选组：一排选项选一个。两种外观——
 *
 *   switch  一根衬底槽里的小开关（1x / 2x）：选中是橙渐变实心
 *   tabs    分开的描边页签（全部 / Day 1 / Day 2、每日安排 / 住宿信息）：
 *           `tone="solid"` 选中是橙实心，`tone="soft"` 是浅橙底橙字——同一行里有两组页签时，
 *           次要那组用 soft，免得两块实心橙抢主次
 */
import { cx } from "./cx";
import { Icon, type IconName } from "./Icon";
import s from "./Segmented.module.css";

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: string;
  icon?: IconName;
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  variant = "tabs",
  tone = "solid",
  stretch,
  label,
}: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange(value: T): void;
  variant?: "switch" | "tabs";
  tone?: "solid" | "soft";
  /** 选项均分整行宽度（1 倍面板的天页签）。 */
  stretch?: boolean;
  /** 读屏名。 */
  label: string;
}) {
  return (
    <div className={cx(s.group, s[variant], stretch && s.stretch)} role="tablist" aria-label={label}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="tab"
            aria-selected={on}
            className={cx(s.option, on && s.on, on && s[tone])}
            onClick={() => onChange(o.value)}
          >
            {o.icon && <Icon name={o.icon} size="sm" />}
            <span className="sa-num">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
