/**
 * 左导航栏：品牌、新行程、去处、设置。
 *
 * 只放单机版有的去处（ARCH-002）：没有「收藏」——单机版没有收藏能力，关掉的能力不显示。
 */
import { SPRITES } from "@cabinhug/ui";

import { Button, cx, Icon, type IconName } from "../../ui";
import s from "./NavRail.module.css";

export interface NavItem {
  id: string;
  label: string;
  icon: IconName;
  active?: boolean;
  onClick(): void;
}

export function NavRail({
  items,
  onNew,
  onSettings,
  newDisabled,
}: {
  items: readonly NavItem[];
  onNew(): void;
  onSettings(): void;
  newDisabled?: boolean;
}) {
  return (
    <nav className={s.rail} aria-label="主导航">
      <div className={s.brand}>
        <img src={SPRITES.light.assistant} alt="" className={s.avatar} draggable={false} />
        <span className={s.name}>Cabinhug</span>
      </div>
      <Button variant="primary" shape="circle" size="lg" icon="plus" label="新行程" disabled={newDisabled} onClick={onNew} />
      <ul className={s.items}>
        {items.map((it) => (
          <li key={it.id}>
            <NavButton {...it} />
          </li>
        ))}
      </ul>
      <NavButton id="settings" label="设置" icon="settings" onClick={onSettings} />
    </nav>
  );
}

function NavButton({ label, icon, active, onClick }: NavItem) {
  return (
    <button type="button" className={cx(s.item, active && s.active)} aria-current={active ? "page" : undefined} onClick={onClick}>
      <Icon name={icon} size="lg" />
      <span>{label}</span>
    </button>
  );
}
