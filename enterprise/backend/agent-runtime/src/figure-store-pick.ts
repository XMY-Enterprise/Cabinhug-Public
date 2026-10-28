/**
 * 图文索引按开关选后端（ACR-030）。
 *
 * # 单独成文件
 *
 * 这段逻辑决定生产走哪个存储，有三条分支：缺省回 pgvector、Qdrant 连不上时退回而不是崩、
 * 不认识的值告警而不是静默。抽出来注入依赖，三条分支各有一条断言；
 * 留在 `index.ts` 的启动流程里则无法单测"不认识的值"这类分支。
 *
 * # 降级方向
 *
 * 知识库是增强不是必需：Qdrant 没起时退回 pgvector，对话照常（只是少了那一档的延迟优势）。
 * runtime 不能因此起不来，所以这里永远返回一个可用的 store，不抛。
 */

import type { FigureStore } from "@cabinhug/rag";

export const FIGURE_STORE_KINDS = ["pgvector", "qdrant"] as const;
export type FigureStoreKind = (typeof FIGURE_STORE_KINDS)[number];

export interface PickFigureStoreDeps {
  /** 环境变量里写的值，未设时传 undefined。 */
  wanted: string | undefined;
  /** pgvector 实现，永远可用（它与 runtime 同生命周期）。 */
  pg: FigureStore;
  /**
   * 构造 Qdrant 实现并探活：可用时返回 `{ store, points }`，连不上返回 null。
   * 探活放在这里而不是调用方，是为了让"连不上"这条分支能在测试里被触发。
   */
  probeQdrant: () => Promise<{ store: FigureStore; points: number } | null>;
  warn?: (msg: string) => void;
}

export interface PickedFigureStore {
  store: FigureStore;
  /** 实际选中的后端，进启动日志：日志里要看得出是否退回。 */
  kind: FigureStoreKind;
  /** 给启动日志用的一行描述，含退回原因。 */
  label: string;
}

/**
 * 选后端。缺省 `pgvector`；要 `qdrant` 但探活失败时退回 pgvector 并告警；不认识的值按 pgvector 处理并告警。
 */
export async function pickFigureStore(deps: PickFigureStoreDeps): Promise<PickedFigureStore> {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const wanted = (deps.wanted ?? "pgvector").trim();

  if (wanted !== "qdrant") {
    if (wanted !== "pgvector") {
      warn(`[vision] CABINHUG_KB_FIGURES_STORE=${wanted} 不认识（只接受 ${FIGURE_STORE_KINDS.join(" / ")}），按 pgvector 处理`);
      return { store: deps.pg, kind: "pgvector", label: `pgvector（配的是 ${wanted}，不认识）` };
    }
    return { store: deps.pg, kind: "pgvector", label: "pgvector（库内 manual_figures）" };
  }

  const probed = await deps.probeQdrant().catch(() => null);
  if (!probed) {
    warn("[vision] Qdrant 连不上，图文索引退回 pgvector——对话不受影响，但这一档的延迟优势没有了");
    return { store: deps.pg, kind: "pgvector", label: "pgvector（本想用 qdrant，连不上退回来的）" };
  }
  return { store: probed.store, kind: "qdrant", label: `qdrant（${probed.points} 个 point）` };
}
