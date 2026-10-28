/**
 * 回复引用的数据来源（天气等第三方数据的署名）。
 *
 * 放在助手气泡正文之后、单独一行：署名不与回答正文混排，也不进口播
 * （TTS 只读 `ChatMessage.content`，来源在 `sources` 字段里）。
 * 链接行为与 HUD 提示卡的天气署名一致（新窗口打开官网）。
 */

import type { CitedSource } from "@cabinhug/shared";

export function CitedSources({ sources }: { sources?: CitedSource[] | null }) {
  if (!sources || sources.length === 0) return null;
  return (
    <div className="dlg-sources">
      <span className="dlg-sources__label">引用来源：</span>
      {sources.map((s, i) => (
        <span key={s.url}>
          {i > 0 && "、"}
          <a className="dlg-sources__link" href={s.url} target="_blank" rel="noreferrer">
            {s.name}
          </a>
        </span>
      ))}
    </div>
  );
}
