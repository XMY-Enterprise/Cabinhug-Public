/**
 * 购车候选与成本的只读端点（F-15-14）。
 *
 * `GET /v1/session/:id/buying`：手机端购车页的唯一入口。
 *
 * # 端点而不是解析回答文本
 *
 * 解析自然语言会随模型措辞漂移。候选与成本在编排层已经是结构化的
 * （`buyingPlan` / `costPlan` 在图状态里），页面读结构，不读文字。
 *
 * # 代理 runtime 而不是查库
 *
 * 行程端点查 PG，因为行程确认后会落库。购车候选不落库，只存在于检查点里，
 * 所以这里代理到 runtime 的只读接口，而不是查仓储。
 *
 * # 网关红线
 *
 * 只做 鉴权 → 转发 → 原样返回，不做任何加工，
 * 保证页面显示的与编排层算的一致。
 *
 * 没有结果返回 `200 {plan: null, cost: null}` 而不是 404：
 * "还没比过车"是常态不是异常，404 会被端上当异常反复告警（与行程端点同一取向）。
 */

import { Router } from "express";
import type { Response } from "express";

import type { ChatRepository } from "@cabinhug/db";

import type { AuthedRequest } from "../auth";

function runtimeUrl(): string {
  return process.env.AGENT_RUNTIME_URL ?? "http://localhost:8788";
}

export function createBuyingRouter(repo: ChatRepository): Router {
  const router = Router();

  router.get("/v1/session/:id/buying", async (req: AuthedRequest, res: Response) => {
    if (!req.userId) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const sessionId = String(req.params.id);
    // 会话不存在与"会话里还没比过车"不同：前者是调用方 id 错误，后者是常态。
    // 合并成一个响应时，端上无法区分"该重新建会话"与"该先问一句"。
    if (!(await repo.sessionExists(sessionId))) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }

    try {
      const r = await fetch(`${runtimeUrl()}/internal/buying/${encodeURIComponent(sessionId)}`);
      if (!r.ok) {
        res.status(502).json({ error: "runtime_unavailable" });
        return;
      }
      // 原样返回。不在这里补默认值、不做单位换算、不排序。
      res.json(await r.json());
    } catch {
      // runtime 不可达时明确报"读不到"而不是"没有"，
      // 后者会让用户以为刚比过的车没了（同 ③偏好那条规则）。
      res.status(502).json({ error: "runtime_unreachable" });
    }
  });

  return router;
}
