/**
 * 知识库管理（FL-24 的后台部分）。
 *
 * # 切分可见性
 *
 * §6 把解析与切分交给了 RAGFlow，这里保留的是可见性而非控制权。
 * 说明书里最有价值的内容（保养周期表、故障码表、操作步骤表）最容易被切坏，
 * 切坏之后检索仍会返回结果，只是结果无用，因此切分必须可见。
 *
 * # 状态以解析结果为准
 *
 * 状态一律到解析层面（F-24-04）：文件已上传但解析失败时，检索查不到任何内容，
 * 不能显示为"成功"。
 *
 * # 未接入时明确返回
 *
 * RAGFlow 是 Cloud 托管，未配置时返回明确的 `not_configured`，
 * 而不是空列表，以免与"知识库为空"混淆。
 */

import { Router, type Response } from "express";

import {
  DatasetAccessError,
  DATASETS,
  suspiciousChunks,
  summarizeRetrievalTest,
  type DatasetKey,
  type RagClient,
} from "@cabinhug/rag";

import type { ChatRepository } from "@cabinhug/db";

import { requireAnyRole, CONSOLE_READERS, type ConsoleRequest } from "../auth/console";

/** 后台以哪个身份访问数据集：admin 能看全部四个集，隔离规则本身不放宽。 */
const CONSOLE_AGENTS: Record<DatasetKey, string> = {
  "vehicle-manuals": "ownership",
  "repair-kb": "service",
  "car-catalog": "buying",
  "insurance-kb": "service",
};

function isDatasetKey(v: unknown): v is DatasetKey {
  return typeof v === "string" && v in CONSOLE_AGENTS;
}

export function createKnowledgeRouter(
  getClient: () => RagClient | undefined,
  /** 运行时地址：双路探针在 runtime 侧（那边才有工具句柄），网关只转发。 */
  runtimeUrl?: string,
  /** 会话仓储：双路轮次的清单与明细都从轨迹 + 对话历史里读。 */
  chat?: ChatRepository,
): Router {
  const router = Router();

  /**
   * 触发过双路的轮次清单。
   *
   * 展示真实发生过的那一轮而不是现场重跑：知识库与用车数据都在变，
   * 重跑的检索结果未必与当时相同，不能作为当时的证据。
   */
  router.get(
    "/console/knowledge/dual-turns",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      if (!chat) {
        res.status(503).json({ error: "chat_unconfigured" });
        return;
      }
      const limit = Number(req.query.limit ?? 30);
      res.json({ turns: await chat.dualPathTurns(Number.isFinite(limit) ? limit : 30) });
    },
  );

  /**
   * 对照答案：同一轮的上下文去掉用车数据那一节再答一次。
   *
   * 按需生成：一次 LLM 调用十几秒且计费，不在打开页面时执行。
   * 上下文取轨迹里留存的那份，不重跑检索，见 runtime 侧的说明。
   */
  router.post(
    "/console/knowledge/dual-turns/:turnId/contrast",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      if (!chat || !runtimeUrl) {
        res.status(503).json({ error: "unconfigured" });
        return;
      }
      const turn = await chat.dualPathTurn(String(req.params.turnId));
      const context = typeof turn?.detail?.context === "string" ? turn.detail.context : "";
      if (!turn || !context) {
        // 旧轮次没留上下文，无法生成对照；明确返回，不给编造的答案。
        res.status(404).json({ error: "context_not_recorded" });
        return;
      }
      try {
        const upstream = await fetch(`${runtimeUrl}/internal/dual-path/contrast`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ context, question: turn.question ?? "" }),
        });
        res.status(upstream.status).type("application/json").send(await upstream.text());
      } catch (err) {
        console.error("[console] 对照答案转发失败", err);
        res.status(502).json({ error: "runtime_unreachable" });
      }
    },
  );

  /** 单轮明细：两路各拿到什么、合成了什么、模型真实答了什么。 */
  router.get(
    "/console/knowledge/dual-turns/:turnId",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      if (!chat) {
        res.status(503).json({ error: "chat_unconfigured" });
        return;
      }
      const r = await chat.dualPathTurn(String(req.params.turnId));
      if (!r) {
        res.status(404).json({ error: "turn_not_found" });
        return;
      }
      res.json(r);
    },
  );

  /**
   * 双路检索对照。
   *
   * 单路检索测试回答"知识库里有没有这段"；这一条回答：
   * 同一个提问，只查手册与加上这辆车的数据，喂给模型的内容差在哪。
   */
  router.post(
    "/console/knowledge/dual-path",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
    if (!runtimeUrl) {
      res.status(503).json({ error: "runtime_unconfigured" });
      return;
    }
    try {
      const upstream = await fetch(`${runtimeUrl}/internal/dual-path/probe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req.body ?? {}),
      });
      const text = await upstream.text();
      // 原样透传状态码与体：runtime 的 400（缺 query）与 502（检索失败）
      // 含义不同，合并成 500 会让页面无法区分责任方。
      res.status(upstream.status).type("application/json").send(text);
    } catch (err) {
      console.error("[console] 双路探针转发失败", err);
      res.status(502).json({ error: "runtime_unreachable" });
      }
    },
  );

  const withClient = (
    res: Response,
    fn: (c: RagClient) => Promise<unknown>,
  ): Promise<void> => {
    const client = getClient();
    if (!client) {
      res.status(503).json({
        error: "not_configured",
        reason: "RAGFlow 未接入（RAGFLOW_BASE_URL / API_KEY / dataset id 未配置）。此时双路检索只剩⑥那一路。",
      });
      return Promise.resolve();
    }
    return fn(client)
      .then((body) => {
        res.json(body);
      })
      .catch((err: unknown) => {
        // 跨集访问被拒是规则生效而非故障，单独给 403 以便页面区分。
        if (err instanceof DatasetAccessError) {
          res.status(403).json({ error: "dataset_forbidden", reason: err.message });
          return;
        }
        res.status(502).json({ error: "ragflow_error", reason: String(err) });
      });
  };

  /** 三个数据集的定义——含 provenance：`repair-kb` 是模拟数据，展示时必须标注（F-24-11）。 */
  router.get("/console/knowledge/datasets", requireAnyRole(CONSOLE_READERS), (_req, res: Response) => {
    res.json({
      datasets: DATASETS.map((d) => ({
        key: d.key,
        name: d.name,
        consumers: d.consumers,
        provenance: d.provenance,
        configured: getClient() !== undefined,
      })),
    });
  });

  router.get(
    "/console/knowledge/:dataset/documents",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const dataset = req.params.dataset;
      if (!isDatasetKey(dataset)) {
        res.status(400).json({ error: "unknown_dataset" });
        return;
      }
      await withClient(res, async (c) => ({
        documents: await c.listDocuments(dataset, CONSOLE_AGENTS[dataset]),
      }));
    },
  );

  /**
   * 切分预览 + 质量提示。
   *
   * 提示不是判定（`suspiciousChunks` 的原文）：只把最可能出问题的位置挑出来
   * 供人优先查看，切分质量最终由人判断。
   */
  router.get(
    "/console/knowledge/:dataset/documents/:documentId/chunks",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const dataset = req.params.dataset;
      if (!isDatasetKey(dataset)) {
        res.status(400).json({ error: "unknown_dataset" });
        return;
      }
      await withClient(res, async (c) => {
        const chunks = await c.listChunks(dataset, String(req.params.documentId), CONSOLE_AGENTS[dataset]);
        return { chunks, suspicious: suspiciousChunks(chunks) };
      });
    },
  );

  /**
   * 上传文档并触发解析。
   *
   * 用原始 body + 头部元数据，与附件上传同一形态，但两者是两条独立通路：
   * 附件是用户拍的照片（进对象存储），这里是知识库资料（进 RAGFlow）。
   * 用户上传的内容不得进入知识库，所以没有从附件转存到这里的通路。
   */
  router.post(
    "/console/knowledge/:dataset/documents",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const dataset = req.params.dataset;
      if (!isDatasetKey(dataset)) {
        res.status(400).json({ error: "unknown_dataset" });
        return;
      }
      const nameHeader = req.headers["x-filename"];
      const raw = Array.isArray(nameHeader) ? nameHeader[0] : nameHeader;
      let name = "upload";
      if (raw) {
        // 与附件上传同一约定：中文文件名走 percent-encoding，
        // HTTP 头是 ByteString，直接放中文会在客户端抛错。
        try {
          name = decodeURIComponent(raw);
        } catch {
          name = raw;
        }
      }

      const chunks: Buffer[] = [];
      for await (const c of req as unknown as AsyncIterable<Buffer>) chunks.push(c);
      const bytes = Buffer.concat(chunks);
      if (bytes.length === 0) {
        res.status(400).json({ error: "empty_file" });
        return;
      }

      await withClient(res, async (c) =>
        c.uploadDocument(dataset, CONSOLE_AGENTS[dataset], {
          name,
          bytes,
          contentType: String(req.headers["content-type"] ?? "application/octet-stream").split(";")[0],
        }),
      );
    },
  );

  /**
   * 检索测试（F-24-06），判断资料是否可用的标准。
   *
   * 零命中不是错误而是信息：它说明当前知识库答不了这个问题。
   */
  router.get(
    "/console/knowledge/:dataset/retrieval-test",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const dataset = req.params.dataset;
      const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
      if (!isDatasetKey(dataset)) {
        res.status(400).json({ error: "unknown_dataset" });
        return;
      }
      if (!query) {
        res.status(400).json({ error: "empty_query" });
        return;
      }
      await withClient(res, async (c) =>
        summarizeRetrievalTest(
          query,
          // 不传 topK，用检索侧的生产默认值（`DEFAULT_PAGE_SIZE`），
          // 让运营看到的条数与用户实际拿到的一致（F-24-06）。
          await c.retrieve({ dataset, query, agent: CONSOLE_AGENTS[dataset] }),
        ),
      );
    },
  );

  return router;
}
