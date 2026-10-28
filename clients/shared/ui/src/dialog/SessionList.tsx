/**
 * 对话层的会话历史列表（两端共用）。
 *
 * 车机上是左栏，手机上折成顶部抽屉；排布由 `DialogScreen` 的 `railMode` 决定，
 * 本组件不知道自己在哪一端。
 *
 * # 列表项显示标题而不是首句
 *
 * 首句在驾驶态里读不完，截成半句后各条难以区分。标题是首轮结束后由旁路
 * 起的名字（≤15 字），拿不到时才回落到时间。
 *
 * # 懒加载而不是一次拉全
 *
 * 一次 20 条，触底再要下一页。车主的会话只增不减（软关闭不删，§7① 的取舍），
 * 长期使用后可达数千条，一次拉全会拖慢对话层的打开。
 *
 * # 「能不能接着聊」是列表这一侧算的
 *
 * 判据与服务端同一条（`closedAt` 为空 且 空闲未超阈值，严格大于）。
 * 端上不判的话，过期会话照常给出输入框，发出后才拿到 409 并换成新会话，
 * 车主会误以为在续上一段对话。
 */

import { useEffect, useRef } from "react";

import { IDLE_MS } from "./session-lifecycle";

export interface SessionBrief {
  sessionId: string;
  /** 旁路生成的标题；`null` = 还没起出来（首轮没跑完 / 生成失败）。 */
  title: string | null;
  createdAt: string;
  updatedAt: string;
  /** 软关闭时刻；`null` = 还没关。 */
  closedAt: string | null;
  messageCount: number;
}

/**
 * 这条会话还能不能接着说。
 *
 * 与 `enterprise/backend/gateway/src/http/index.ts` 的 `checkSessionUsable` 同一条判据，
 * 包括边界方向（严格大于：正好卡在阈值上算没过期）。两处不一致的表现是
 * 端上给了输入框、服务端回 409。
 */
export function sessionResumable(s: SessionBrief, now: number, idleMs = IDLE_MS): boolean {
  if (s.closedAt !== null) return false;
  return now - new Date(s.updatedAt).getTime() <= idleMs;
}

/**
 * 一条会话在列表里占的两行文本：标题位、以及它下面那行还剩什么。
 *
 * 无标题时下面那行没有时间：标题位已回落成时间，再写一遍会上下两行重复。
 *
 * 导出供 `test/session-row-no-echo.test.ts` 测试：本包没有 jsdom，测试渲染不了组件，
 * 只能测取值这一步，所以组件里那两行必须直接用它，不另写一份。
 */
export function sessionRowText(s: SessionBrief, now: number): { title: string; when?: string } {
  const when = whenLabel(s.updatedAt, now);
  return s.title ? { title: s.title, when } : { title: when };
}

/** 没有标题时的替代显示：说时间，不编内容。 */
function whenLabel(iso: string, now: number): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "未知时间";
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) return `今天 ${hm}`;
  const yesterday = new Date(now - 86400000).toDateString() === d.toDateString();
  if (yesterday) return `昨天 ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/**
 * 「没占满一屏就再要一页」该不该触发。
 *
 * 列表没被布局时（`clientHeight === 0`）一律不要。
 *
 * 手机上会话历史是收起的抽屉（`<details>` 未展开），列表的 `clientHeight` 与
 * `scrollHeight` 都是 0，`0 <= 0` 成立会请求下一页；`sessions` 一变 effect 重跑，
 * 会一路翻到 `hasMore` 为 false，把全部会话拉下来。
 *
 * 车机的左栏常驻可见，`clientHeight > 0`，不受这条影响。
 */
export function shouldPrefetchMore(
  box: { clientHeight: number; scrollHeight: number },
  loading: boolean,
  hasMore: boolean,
): boolean {
  if (loading || !hasMore) return false;
  if (box.clientHeight === 0) return false;
  return box.scrollHeight <= box.clientHeight;
}

export interface SessionListProps {
  sessions: SessionBrief[];
  /** 此刻屏幕上摊着的那条会话（可能是当前会话，也可能是正在回看的历史）。 */
  activeSessionId: string | null;
  /** 还有没有下一页。没有时不再触发加载，也不显示"加载中"。 */
  hasMore: boolean;
  loading: boolean;
  error?: string | null;
  onSelect: (s: SessionBrief) => void;
  onLoadMore: () => void;
  /**
   * 主动开一段新对话。不传就不渲染按钮（浏览器 mock 环境建不了会话）。
   *
   * 会话闲置 30 分钟会被服务端软关闭；本按钮让用户在对话层内主动另起一段，
   * 不必回 HUD 层「退下」。
   */
  onNew?: () => void;
}

export function SessionList({
  sessions,
  activeSessionId,
  hasMore,
  loading,
  error,
  onSelect,
  onLoadMore,
  onNew,
}: SessionListProps) {
  const now = Date.now();
  const listRef = useRef<HTMLDivElement>(null);

  /*
   * 触底加载。另有一道"没占满就再要一页"（下面的 effect）：
   * 车机屏很高，20 条经常填不满一屏，填不满就滚不动、触底事件不会触发，
   * 列表会停在第一页。
   */
  const onScroll = () => {
    const el = listRef.current;
    if (!el || loading || !hasMore) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) onLoadMore();
  };

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (!shouldPrefetchMore(el, loading, hasMore)) return;
    onLoadMore();
  }, [sessions, loading, hasMore, onLoadMore]);

  return (
    <aside className="dlg-sessions" aria-label="会话历史">
      <div className="dlg-sessions__head">
        {/* 计数与手机端抽屉的摘要行同一算法（`DialogScreen.tsx`）：报的是已加载的条数。 */}
        <span>会话历史{sessions.length > 0 ? ` · ${sessions.length}` : ""}</span>
        {onNew && (
          <button
            type="button"
            className="dlg-sessions__new"
            onClick={onNew}
            aria-label="新建对话"
          >
            ＋ 新建对话
          </button>
        )}
      </div>
      <div className="dlg-sessions__list" ref={listRef} onScroll={onScroll}>
        {sessions.length === 0 && !loading && !error && (
          <div className="dlg-sessions__empty">还没有会话记录。</div>
        )}
        {sessions.map((s) => {
          const active = s.sessionId === activeSessionId;
          const resumable = sessionResumable(s, now);
          const row = sessionRowText(s, now);
          return (
            <button
              key={s.sessionId}
              type="button"
              className={`dlg-sessions__item ${active ? "is-active" : ""}`}
              aria-current={active ? "true" : undefined}
              onClick={() => onSelect(s)}
            >
              <span className="dlg-sessions__title">{row.title}</span>
              {(row.when || !resumable) && (
                <span className="dlg-sessions__meta">
                  {row.when}
                  {/*
                    只标"已结束"，不标"进行中"：车主要分辨的是
                    "这条点进去还能不能接着说"。
                  */}
                  {!resumable && <span className="dlg-sessions__badge">已结束</span>}
                </span>
              )}
            </button>
          );
        })}
        {loading && <div className="dlg-sessions__hint">加载中…</div>}
        {/*
          出错要显示出来，不静默停在半页，否则用户会以为会话丢了。
        */}
        {error && <div className="dlg-sessions__hint dlg-sessions__hint--error">{error}</div>}
      </div>
    </aside>
  );
}
