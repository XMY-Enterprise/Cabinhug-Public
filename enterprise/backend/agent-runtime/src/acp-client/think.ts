/**
 * 垫片：实现在 `@cabinhug/acp`（ACR-035）。
 *
 * 旧路径保留为 re-export，导出符号与原实现一致，调用点与测试无需改动；
 * 回滚时 revert 迁移提交即可，import 回到本地实现。
 */

export { splitThinkBursts, THINK_GAP_MS, type ThinkBurst, type ThoughtTick } from "@cabinhug/acp";
