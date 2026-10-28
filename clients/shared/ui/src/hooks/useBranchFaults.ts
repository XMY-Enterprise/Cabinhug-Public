/**
 * 分支失败的端上聚合（F-13-03/F-13-07）。
 *
 * # 职责
 *
 * fanout 的某条分支 failed/timeout 时，服务端会发 `update.branch`（带人话 `note`）。
 * 这里把 failed/timeout 聚合成本轮的"部分结果"清单，交给对话层渲染成结构化横幅，
 * 用户能否看到失败信息不依赖模型是否在正文里提到。真相源是事件里的结构化 status。
 *
 * # 只留 failed/timeout
 *
 * started/ok 是进展信息，进展的呈现是另一件事（且分支一多会刷屏）；
 * 本 hook 只管"哪些没拿到"。同一分支先 failed 后不会再来事件（fanout 每分支
 * 恰一条终态），按 (轮, agent) 去重只是防服务端重试补发。
 *
 * # 归属于哪一轮由 `turnId` 决定，不由清理时机决定
 *
 * `UpdateBranch.turnId` 透传到端上。若不按它归属，只能靠 `reset()`（换会话 / 用户发言）
 * 猜轮次边界，用户既没发下一句也没换会话时，横幅会把别一轮的失败挂在当前回答上方。
 *
 * `faults` 只给最新一轮那组；`reset()` 只负责内存卫生
 * （换会话时不保留上个会话的内容），不承担正确性。
 *
 * # 不进历史
 *
 * 与工具进展相同：桥接层不写缓存、这里只是内存态。
 */

import { useCallback, useMemo, useState } from "react";

export interface BranchFaultEvent {
  /** 这条失败属于哪一轮（`UpdateBranch.turnId`）。 */
  turnId: string;
  agent: string;
  status: "started" | "ok" | "failed" | "timeout";
  /** 服务端给的人话（"酒店安排超时未返回"）；null 时退化为 agent 名。 */
  note: string | null;
}

/** 已失败的分支：`(轮, agent) → 人话`，按到达顺序排。 */
export type BranchFaultState = ReadonlyArray<{ turnId: string; agent: string; text: string }>;

export const EMPTY_FAULTS: BranchFaultState = [];

/** 纯函数，便于单测。 */
export function applyBranchFault(state: BranchFaultState, e: BranchFaultEvent): BranchFaultState {
  if (e.status !== "failed" && e.status !== "timeout") return state;
  /*
   * 去重键是 (轮, agent) 而不是 agent：体检修复轮会对同一个 Agent 在同一轮里
   * 再发一次，那是同一轮的重复终态，该去重；跨轮的同名分支是两件事，
   * 只按 agent 去重会丢掉后一轮那条。
   */
  if (state.some((x) => x.agent === e.agent && x.turnId === e.turnId)) return state;
  return [...state, { turnId: e.turnId, agent: e.agent, text: e.note ?? e.agent }];
}

/**
 * 只留最新一轮那组。横幅讲的是"这轮答案缺了什么"，
 * 上一轮的缺失挂在这一轮的回答上方是假警报。
 *
 * 全同一轮时返回原引用，少一次重渲染（与 `applyBranchFault` 相同）。
 */
export function faultsOfCurrentTurn(state: BranchFaultState): BranchFaultState {
  if (state.length === 0) return state;
  const turnId = state[state.length - 1].turnId;
  if (state.every((f) => f.turnId === turnId)) return state;
  return state.filter((f) => f.turnId === turnId);
}

export function useBranchFaults(): {
  /**
   * 最新一轮失败分支的人话清单；空数组 = 没有要标识的（不渲染横幅）。
   * 过滤在这里做，消费方拿到的就是能直接渲染的那一组，组件不再判断轮次归属。
   */
  faults: BranchFaultState;
  /** 本会话收到的全部（含更早的轮次）。排障与测试用，不用于渲染。 */
  all: BranchFaultState;
  onBranch: (e: BranchFaultEvent) => void;
  /** 换会话时调用，不保留别的会话的缺失；轮次归属已由 turnId 保证。 */
  reset: () => void;
} {
  const [state, setState] = useState<BranchFaultState>(EMPTY_FAULTS);
  const onBranch = useCallback((e: BranchFaultEvent) => {
    setState((prev) => applyBranchFault(prev, e));
  }, []);
  const reset = useCallback(() => setState(EMPTY_FAULTS), []);
  const faults = useMemo(() => faultsOfCurrentTurn(state), [state]);
  // 返回值 memo，理由同 useToolProgress（裸字面量会让消费方的依赖链不稳定，
  // 订阅 effect 每次渲染整段重跑）。
  return useMemo(() => ({ faults, all: state, onBranch, reset }), [faults, state, onBranch, reset]);
}
