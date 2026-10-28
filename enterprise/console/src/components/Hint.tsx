/**
 * 标题后的问号：把"为什么这么设计"收进 hover / 聚焦才出现的浮层。
 *
 * # 收起而不是删掉
 *
 * 设计说明保留判据，但常用读者主要看图；收进问号后，初读者按需展开，
 * 常用读者不必每次跳过。
 *
 * # 不用 title 属性
 *
 * 原生 `title` 延迟约 1 秒才出现、不能换行排版，且触屏与键盘用户看不到。
 * 这里用 `:hover` + `:focus-visible` 双触发，键盘 Tab 到问号也能看。
 *
 * # 纯 CSS 显隐
 *
 * 不挂 JS 状态：一页上有十几个问号，各自一个 useState 会带来无谓的重渲染，
 * CSS 的 :hover/:focus 已能表达当前指向。
 */

import type { ReactNode } from "react";

export function Hint({
  children,
  label = "查看说明",
  align = "center",
}: {
  children: ReactNode;
  /** 无障碍名称。默认够用；同一页有多个同名问号时传具体的。 */
  label?: string;
  /**
   * 浮层相对问号的对齐。缺省居中；浮层最宽 420px，居中挂在两头的列上会探出去：
   * 靠右边缘的列传 `right`（否则右半边被内容区裁掉），表格第一列传 `left`（否则左半边盖住侧边导航）。
   */
  align?: "center" | "left" | "right";
}): JSX.Element {
  return (
    <span className={align === "center" ? "hint" : `hint hint--${align}`}>
      {/*
        `type="button"` 不能省：本组件常落在表单/可点区域里，
        默认的 submit 会让点一下问号变成提交一次。
      */}
      <button type="button" className="hint-dot" aria-label={label}>
        ?
      </button>
      {/* role=note：补充说明而非对话框，读屏不把它当作需要关闭的元素 */}
      <span className="hint-pop" role="note">
        {children}
      </span>
    </span>
  );
}
