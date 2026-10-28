/**
 * graph/checkpointer —— ①Working 的持久化（FL-40 F-40-06 / FL-14 F-14-01）。
 *
 * 使用 LangGraph.js 的 PG Checkpointer（`@langchain/langgraph-checkpoint-postgres`），
 * 版本线与 `@langchain/core` / `@langchain/langgraph` 保持一致（§13-3）。
 *
 * HITL 要求"挂起等多久都不丢"（FL-04 F-04-05 / §8.4），
 * 这条承诺建立在检查点持久化上。
 */

import { MemorySaver } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

export type CheckpointerKind = "pg" | "memory";

export function resolveCheckpointerKind(env: NodeJS.ProcessEnv = process.env): CheckpointerKind {
  const raw = (env.CABINHUG_CHECKPOINTER ?? "pg").toLowerCase();
  return raw === "memory" ? "memory" : "pg";
}

export interface CheckpointerHandle {
  kind: CheckpointerKind;
  saver: BaseCheckpointSaver;
  /** 建表等一次性准备；memory 实现为 no-op。 */
  setup(): Promise<void>;
  /** 记录降级原因（PG 不可用时）。降级必须可见，不能静默变回内存。 */
  degradedReason?: string;
}

/**
 * 建检查点存储。
 *
 * PG 不可用时明确降级到内存并记录原因，服务照常启动：
 * 对话能力不因检查点存储不可用而整体失效（与 §8.2 input fail-open 同源）。
 * 降级意味着重启即丢上下文、挂起的 HITL 会丢，因此必须出现在日志与运维面上。
 */
export async function createCheckpointer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CheckpointerHandle> {
  const kind = resolveCheckpointerKind(env);

  if (kind === "memory") {
    return { kind: "memory", saver: new MemorySaver(), setup: async () => {} };
  }

  const url = env.DATABASE_URL;
  if (!url) {
    return {
      kind: "memory",
      saver: new MemorySaver(),
      setup: async () => {},
      degradedReason: "DATABASE_URL 未配置，检查点降级为内存（重启即丢上下文与挂起的 HITL）",
    };
  }

  try {
    const saver = PostgresSaver.fromConnString(url);
    return {
      kind: "pg",
      saver,
      setup: async () => {
        // 幂等建表；重复执行不破坏既有数据（迁移可重复执行）。
        await saver.setup();
      },
    };
  } catch (err) {
    return {
      kind: "memory",
      saver: new MemorySaver(),
      setup: async () => {},
      degradedReason: `PG 检查点不可用，降级为内存：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
