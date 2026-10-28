/**
 * 车型清单 + 车型 ↔ 知识库关联关系端点。
 *
 * GET /v1/vehicle-catalog → 目录全量 + 每款关联到的资料 + 数据新鲜度
 *
 * # 缓存
 *
 * 计算一次要向 RAGFlow 发三次 `listDocuments`（实测整轮 1–2s），而索引只在
 * 传/删语料时变化，所以进程内缓存 10 分钟，避免建档向导每选一次车型都等待。
 *
 * # 三态
 *
 * 拉失败时返回上一次的结果并标 `stale`；从未成功过则标 `unavailable`。
 * "读不到"不折叠成"没有资料"：两者对用户的含义不同（"这款没有说明书"
 * 与"暂时读不到知识库"）。
 */

import { Router } from "express";
import type { Response } from "express";

import {
  VEHICLE_CATALOG,
  catalogModels,
  type KnowledgeCoverageState,
  type ModelKnowledgeLink,
  type VehicleKnowledge,
} from "@cabinhug/shared";
import { fetchModelCoverage, type CoverageIndex, type RagClient } from "@cabinhug/rag";

import type { AuthedRequest } from "../auth";

/** 索引变化只发生在传/删语料时，10 分钟足够新鲜。 */
export const COVERAGE_TTL_MS = 10 * 60 * 1000;

export interface CoverageSnapshot {
  index: CoverageIndex;
  fetchedAt: number;
  /** 读失败的数据集；它们对应的车型不会被记成"没资料"。 */
  failures: Array<{ dataset: string; reason: string }>;
  /** 不被任何已知车型匹配到的文档：传了却检索不到，运维要看见。 */
  invisible: string[];
}

export interface CoverageProvider {
  /** 当前快照；`undefined` = 从来没成功拉到过。 */
  get(): Promise<{ snapshot?: CoverageSnapshot; state: KnowledgeCoverageState; reason?: string }>;
}

/**
 * 带 TTL 与"过期用旧值"的覆盖提供者。
 *
 * 并发去重（`inflight`）：建档页打开时可能同时请求两三次，合并为一次刷新，
 * 避免并发向 RAGFlow 发六到九次 `listDocuments`。
 */
export function createCoverageProvider(
  ragClient: () => RagClient | undefined,
  ttlMs = COVERAGE_TTL_MS,
  now = () => Date.now(),
): CoverageProvider {
  let snapshot: CoverageSnapshot | undefined;
  let lastError: string | undefined;
  let inflight: Promise<void> | undefined;

  async function refresh(): Promise<void> {
    const client = ragClient();
    if (!client) {
      lastError = "知识库未接入（RAGFLOW_BASE_URL / RAGFLOW_API_KEY 未配置）";
      return;
    }
    try {
      const r = await fetchModelCoverage(client, catalogModels());
      // 三个数据集一个都没读到不算成功：此时 index 全空，存下来会把
      // "读不到"固化成"没有资料"。
      if (r.datasets.length === 0) {
        // reason 由端上直接显示，所以明确写出是知识库不可达，而不只是底层错误文本。
        const detail = r.failures[0]?.reason;
        lastError = detail ? `知识库不可达（${detail}）` : "知识库三个数据集都读不到";
        return;
      }
      snapshot = {
        index: r.index,
        fetchedAt: now(),
        failures: r.failures.map((f) => ({ dataset: f.dataset, reason: f.reason })),
        invisible: r.invisible,
      };
      lastError = undefined;
      if (r.invisible.length > 0) {
        console.warn(
          `[vehicle-catalog] ${r.invisible.length} 篇文档不含任何已知车型，限定车型时检索不到：${r.invisible.join("、")}`,
        );
      }
    } catch (e) {
      lastError = `知识库不可达（${String(e).split("\n")[0]!.slice(0, 160)}）`;
    }
  }

  return {
    async get() {
      const fresh = snapshot && now() - snapshot.fetchedAt < ttlMs;
      if (!fresh) {
        inflight ??= refresh().finally(() => {
          inflight = undefined;
        });
        await inflight;
      }
      if (!snapshot) return { state: "unavailable", reason: lastError ?? "知识库覆盖尚未取得" };
      if (lastError) return { snapshot, state: "stale", reason: lastError };
      return { snapshot, state: "live" };
    },
  };
}

function linksOf(snapshot: CoverageSnapshot | undefined, model: string): ModelKnowledgeLink[] {
  return (snapshot?.index.get(model) ?? []).map((l) => ({
    dataset: l.dataset,
    datasetName: l.datasetName,
    documents: l.documents,
  }));
}

/** 一辆车（或一个车型）的关联关系。`GET /v1/vehicles` 也用它。 */
export async function knowledgeFor(
  provider: CoverageProvider,
  model: string,
): Promise<VehicleKnowledge> {
  const { snapshot, state, reason } = await provider.get();
  return {
    model,
    links: state === "unavailable" ? [] : linksOf(snapshot, model),
    state,
    fetchedAt: snapshot?.fetchedAt,
    reason,
  };
}

export function createVehicleCatalogRouter(provider: CoverageProvider): Router {
  const router = Router();

  router.get("/v1/vehicle-catalog", async (_req: AuthedRequest, res: Response) => {
    const { snapshot, state, reason } = await provider.get();
    res.json({
      entries: VEHICLE_CATALOG.map((e) => ({
        brand: e.brand,
        model: e.model,
        links: state === "unavailable" ? [] : linksOf(snapshot, e.model),
      })),
      coverage: {
        state,
        fetchedAt: snapshot?.fetchedAt,
        reason,
        // 部分数据集读失败时列出是哪几个，与"全部读到"区分开。
        partialFailures: snapshot?.failures ?? [],
      },
    });
  });

  return router;
}
