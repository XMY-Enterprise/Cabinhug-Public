/**
 * 助手窗的位置与大小：锚在主区左下角，拖标题栏挪、拖右下角改大小，始终夹在主区里。
 *
 * 位置存成「相对左下锚点的位移」而不是绝对坐标：窗口缩放后锚点跟着走，窗不会被甩到屏外。
 * 记在本机（localStorage）只为下次打开还在老地方；读写失败（隐私模式）就用缺省，不影响使用。
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

export interface DockBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

const KEY = "cabinhug.standalone.dock";
const GUTTER = 16;
const MIN_W = 360;
const MIN_H = 320;
export const DEFAULT_BOX: DockBox = { x: 0, y: 0, w: 440, h: 400 };

function load(): DockBox {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as DockBox | null;
    if (v && [v.x, v.y, v.w, v.h].every(Number.isFinite)) return v;
  } catch {
    /* 读不到就用缺省 */
  }
  return DEFAULT_BOX;
}

function save(box: DockBox): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(box));
  } catch {
    /* 存不下只是下次回到缺省位置 */
  }
}

/** 把盒子夹进 `pw × ph` 的主区：左下锚点在 (GUTTER, ph - GUTTER)。 */
export function clampBox(b: DockBox, pw: number, ph: number): DockBox {
  if (pw <= 0 || ph <= 0) return b;
  const w = Math.min(Math.max(b.w, MIN_W), pw - 2 * GUTTER);
  const h = Math.min(Math.max(b.h, MIN_H), ph - 2 * GUTTER);
  const x = Math.min(Math.max(b.x, -GUTTER), pw - GUTTER - w);
  const y = Math.min(Math.max(b.y, GUTTER + h - ph), GUTTER);
  return { x, y, w, h };
}

export function useDockBox(el: RefObject<HTMLElement>) {
  const [box, setBox] = useState<DockBox>(load);
  const drag = useRef<{ mode: "move" | "resize"; sx: number; sy: number; start: DockBox } | null>(null);

  const parentSize = useCallback((): [number, number] => {
    const p = el.current?.offsetParent as HTMLElement | null;
    return p ? [p.clientWidth, p.clientHeight] : [0, 0];
  }, [el]);

  const commit = useCallback(
    (next: DockBox) => {
      const [pw, ph] = parentSize();
      setBox(clampBox(next, pw, ph));
    },
    [parentSize],
  );

  // 主区尺寸变了（窗口缩放、导航切换）就重新夹一次。
  useEffect(() => {
    const p = el.current?.offsetParent;
    if (!p) return;
    const ro = new ResizeObserver(() => setBox((b) => clampBox(b, (p as HTMLElement).clientWidth, (p as HTMLElement).clientHeight)));
    ro.observe(p);
    return () => ro.disconnect();
  }, [el]);

  useEffect(() => {
    save(box);
  }, [box]);

  const begin = (mode: "move" | "resize") => (e: ReactPointerEvent<HTMLElement>) => {
    // 标题栏上的按钮照常点，不当成拖动的开始。
    if (mode === "move" && (e.target as HTMLElement).closest("button")) return;
    drag.current = { mode, sx: e.clientX, sy: e.clientY, start: box };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    // 锚在底边：往下拉高时顶边不动，所以位移跟着下移同样的量。
    commit(
      d.mode === "move"
        ? { ...d.start, x: d.start.x + dx, y: d.start.y + dy }
        : { ...d.start, w: d.start.w + dx, h: d.start.h + dy, y: d.start.y + dy },
    );
  };

  const end = () => {
    drag.current = null;
  };

  const maximize = () => {
    const [, ph] = parentSize();
    commit({ x: 0, y: 0, w: 560, h: ph });
  };

  const ph = parentSize()[1];
  return {
    box,
    maximized: ph > 0 && box.h >= ph - 2 * GUTTER - 1,
    restore: () => commit(DEFAULT_BOX),
    maximize,
    moveHandlers: { onPointerDown: begin("move"), onPointerMove, onPointerUp: end, onPointerCancel: end },
    resizeHandlers: { onPointerDown: begin("resize"), onPointerMove, onPointerUp: end, onPointerCancel: end },
  };
}
