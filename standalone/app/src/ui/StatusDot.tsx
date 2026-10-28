/** 状态圆点：正常绿、进行中橙（呼吸）、失败红、未开始灰。 */
import { cx } from "./cx";
import s from "./StatusDot.module.css";

export type StatusTone = "ok" | "busy" | "danger" | "idle";

export function StatusDot({ tone, size = "sm" }: { tone: StatusTone; size?: "sm" | "md" }) {
  return <span className={cx(s.dot, s[tone], s[size])} aria-hidden="true" />;
}
