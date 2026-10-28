/**
 * 会话检索的筛选参数（「会话与对话」页与演示大屏的选择器共用同一份）。
 *
 * # 日期换算
 *
 * `<input type="date">` 给的是 `2026-08-31` 这样的日期串，而接口要的是时间点。
 * `new Date("2026-08-31")` 按规范是 UTC 零点：东八区选 8-31 时实际从北京时间
 * 8-31 08:00 起筛；把它当作 `lte` 边界则截到 8-31 零点，当天的会话一条都不在结果里。
 *
 * 所以两侧都在本地时区上取整天：起 = 当天 00:00:00.000，止 = 当天 23:59:59.999。
 */

/** 日期串（`YYYY-MM-DD`）→ 本地当天 00:00:00.000 的 ISO 时间点；空串返回 undefined。 */
export function dayStartIso(day: string): string | undefined {
  const parts = splitDay(day);
  if (!parts) return undefined;
  const [y, m, d] = parts;
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

/** 日期串 → 本地当天 23:59:59.999 的 ISO 时间点；空串返回 undefined。 */
export function dayEndIso(day: string): string | undefined {
  const parts = splitDay(day);
  if (!parts) return undefined;
  const [y, m, d] = parts;
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
}

function splitDay(day: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // 不接受 2026-13-40 这类非法日期：`new Date` 会把它顺延成另一天。
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const probe = new Date(y, mo - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return null;
  return [y, mo, d];
}

export interface SessionFilters {
  /** 归属账号，精确。 */
  userId?: string;
  /** 会话 id，精确定位（接口按等值查，不是模糊搜）。 */
  sessionId?: string;
  /** 标题，模糊。没起名的会话不会命中（标题在首轮之后生成）。 */
  title?: string;
  /** 起始日（`YYYY-MM-DD`，本地时区当天 00:00 起）。按会话创建时间筛。 */
  since?: string;
  /** 截止日（`YYYY-MM-DD`，本地时区当天 23:59:59.999 止）。 */
  until?: string;
  /**
   * 只看说过话的会话（去掉「建了但没说话」的空白对话）。
   *
   * 缺省关闭，与车主端相反：点开对话层就会建一条会话，那些空白对话
   * 在车机 / 手机的列表里是噪声（那一侧 `userSessionPage` 直接不返回），
   * 而运营需要看到"建了多少、其中多少条一句没说"。
   */
  nonEmpty?: boolean;
  /**
   * 被清理（软删除）的会话要不要：`include` 连它们一起看 / `only` 只看它们。
   *
   * 缺省不带：清理的本意是让它们从列表里退场。清理不删任何东西，
   * 运营要能把清错的那条找回来（「只看已清理」里点恢复）。
   * 演示大屏的选择器不传它：那里是挑「放哪一段」的，被清理的不该再被挑中。
   */
  deleted?: "include" | "only";
}

/**
 * 拼查询串。空白一律当没填：`trim()` 后为空的条件不进 URL，
 * 只含空格的输入框不构成筛选条件。
 */
export function sessionQuery(
  f: SessionFilters,
  extra: Record<string, string> = {},
): URLSearchParams {
  const q = new URLSearchParams(extra);
  const put = (k: string, v?: string): void => {
    const t = v?.trim();
    if (t) q.set(k, t);
  };
  put("userId", f.userId);
  put("sessionId", f.sessionId);
  put("title", f.title);
  put("since", f.since ? dayStartIso(f.since) : undefined);
  put("until", f.until ? dayEndIso(f.until) : undefined);
  // 布尔只在"开"的时候进 URL：`nonEmpty=0` 与不传是同一件事，接口只认 "1"/"true"。
  if (f.nonEmpty) q.set("nonEmpty", "1");
  // 只认这两个值；缺省（未清理）不进 URL——与不传是同一件事。
  if (f.deleted === "include" || f.deleted === "only") q.set("deleted", f.deleted);
  return q;
}

/** 有没有任何筛选条件（决定「清空」按钮出不出现、空态说哪一句）。 */
export function hasFilters(f: SessionFilters): boolean {
  if (f.nonEmpty || f.deleted) return true;
  return [f.userId, f.sessionId, f.title, f.since, f.until].some((v) => Boolean(v?.trim()));
}
