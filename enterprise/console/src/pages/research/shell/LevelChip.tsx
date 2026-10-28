/**
 * 等级徽章。
 *
 * 默认是 Signal：已授权车主不能代表市场（Brief 原则 4）。
 * 徽章本身不解释原因，"升级到 Candidate 还缺什么"在证据栏里说明。
 */

export type Level = "signal" | "candidate" | "validated";

const LABEL: Record<Level, string> = { signal: "Signal", candidate: "Candidate", validated: "Validated" };
/** Signal 用 warn：它是"值得注意但证据不足"，不是一个可以直接引用的结论。 */
const TONE: Record<Level, string> = { signal: "uz-chip--warn", candidate: "uz-chip--accent", validated: "uz-chip--ok" };

export function LevelChip({ level }: { level: Level }): JSX.Element {
  return <span className={`uz-chip ${TONE[level]}`}>{LABEL[level]}</span>;
}
