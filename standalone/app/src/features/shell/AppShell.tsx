/**
 * 窗口骨架（四屏共用）：左导航栏 · 主区 · 底部状态栏。主区里放什么由页面决定，骨架不认识地图或行程。
 */
import type { ReactNode } from "react";

import s from "./AppShell.module.css";

export function AppShell({ rail, status, children }: { rail: ReactNode; status: ReactNode; children: ReactNode }) {
  return (
    <div className={s.shell}>
      <div className={s.rail}>{rail}</div>
      <main className={s.main}>{children}</main>
      <div className={s.status}>{status}</div>
    </div>
  );
}
