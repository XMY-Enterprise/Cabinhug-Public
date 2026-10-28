/**
 * 会话行程只读端点（ACR-062）。
 *
 * `GET /v1/session/:id/trip-draft` —— 单机版桌面界面行程面板的数据源：「定下来」之前也要能画出
 * 逐天安排与地图。已确认的行程另有 `/v1/trip-plan/current`（读库）；草案只在编排层的图状态里，
 * 这里只代理 runtime 的 `/internal/trip-draft/:id`，不加工。与 `diagnosis.ts` 同形。
 *
 * 约定：还没排过行程是常态 → 200 `{plan:null}`；runtime 挂 → 502（读不到 ≠ 没有）；
 * 会话不存在或不属于请求者 → 404（不区分两者，免得成为探测会话存在与否的通道）。
 */

import { Router } from "express";
import type { Response } from "express";

import type { ChatRepository } from "@cabinhug/db";

import type { AuthedRequest } from "../auth";

function runtimeUrl(): string {
  return process.env.AGENT_RUNTIME_URL ?? "http://localhost:8788";
}

export function createTripDraftRouter(repo: Pick<ChatRepository, "sessionUserId">): Router {
  const router = Router();

  router.get("/v1/session/:id/trip-draft", async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const sessionId = String(req.params.id);
    // 行程是个人数据：会话必须属于请求者。
    if ((await repo.sessionUserId(sessionId)) !== req.userId) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    try {
      // 缺省档下行程按「人」存（ACR-036 的工作任务），runtime 要知道是谁；归属上面已经校验过。
      const r = await fetch(
        `${runtimeUrl()}/internal/trip-draft/${encodeURIComponent(sessionId)}?userId=${encodeURIComponent(req.userId)}`,
      );
      if (!r.ok) {
        res.status(502).json({ error: "runtime_unavailable" });
        return;
      }
      res.json(await r.json());
    } catch {
      res.status(502).json({ error: "runtime_unreachable" });
    }
  });

  return router;
}
