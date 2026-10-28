/**
 * 待建设页。
 *
 * 显示清单编号而不是只写"暂无数据"，使"这一块还没做"
 * 与"这一块坏了"在界面上可区分。
 */
export function PendingPage({
  title,
  owner,
  what,
}: {
  title: string;
  owner: string;
  what: string;
}): JSX.Element {
  return (
    <div className="page">
      <h1>{title}</h1>
      <div className="pending-card">
        <span className="pending-tag">待建设</span>
        <p>{what}</p>
        <p className="muted">
          归属清单：<code>{owner}</code>。本期不包含该功能，页面可达是为了让路由与权限先就位。
        </p>
      </div>
    </div>
  );
}
