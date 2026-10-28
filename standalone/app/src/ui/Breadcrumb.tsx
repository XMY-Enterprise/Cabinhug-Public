/**
 * 面包屑：「⌂ 当前行程 / Day 2」「‹ 行程 / 上海到杭州三天行程」。
 * 有 `onClick` 的段可点，最后一段是当前位置、不可点。
 */
import { Fragment } from "react";

import { cx } from "./cx";
import { Icon, type IconName } from "./Icon";
import s from "./Breadcrumb.module.css";

export interface Crumb {
  label: string;
  onClick?: () => void;
}

export function Breadcrumb({
  items,
  icon,
  onIcon,
  bar,
}: {
  items: readonly Crumb[];
  icon?: IconName;
  /** 首图标可点（返回）。 */
  onIcon?: () => void;
  /** 放进一根浅底条里（面板顶部那种）。 */
  bar?: boolean;
}) {
  return (
    <nav className={cx(s.crumbs, bar && s.bar)} aria-label="位置">
      {icon &&
        (onIcon ? (
          <button type="button" className={s.iconBtn} onClick={onIcon} aria-label="返回">
            <Icon name={icon} size="sm" />
          </button>
        ) : (
          <Icon name={icon} size="sm" className={s.icon} />
        ))}
      {items.map((c, i) => (
        <Fragment key={`${i}-${c.label}`}>
          {i > 0 && <span className={s.sep}>/</span>}
          {c.onClick ? (
            <button type="button" className={s.link} onClick={c.onClick}>
              {c.label}
            </button>
          ) : (
            <span className={cx(s.item, i === items.length - 1 && s.current)}>{c.label}</span>
          )}
        </Fragment>
      ))}
    </nav>
  );
}
