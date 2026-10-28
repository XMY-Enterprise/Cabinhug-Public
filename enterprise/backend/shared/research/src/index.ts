/**
 * `@cabinhug/research`：研究面的纯函数库。
 *
 * # 零 IO、零依赖
 *
 * 分析单位怎么切、哪些证据不能采、四道门怎么判、置信怎么算、机会怎么排序，
 * 这些是研究面里需要反复复核的规则。保持纯函数让整套单测在几毫秒内跑完；
 * 与数据库、LLM、HTTP 耦合会让复核依赖外部服务。
 *
 * 所以本包不 import `@cabinhug/db` / `@cabinhug/guardrails` / `ai` / `@langchain/*`。
 * `check:arch` 的 `research-pure` 一条守这件事。
 *
 * 唯一的例外是 `node:crypto`（sha256 指纹）：它是纯计算，不碰外界。
 */

export * from "./types";
export * from "./passport";
export * from "./fingerprint";
export * from "./unitize";
export * from "./screen";
export * from "./population";
export * from "./suppression";
export * from "./gates";
export * from "./confidence";
export * from "./ods";
export * from "./agreement";
export * from "./system-events";
export * from "./capabilities";
export * from "./agent-note";
export * from "./red-team";
