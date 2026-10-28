/**
 * stream —— SSE 下行通道。
 *
 * 两条流：
 *
 *  - `GET /v1/session/:id/stream`：按会话，讲这一段对话里发生了什么，带续传窗口。
 *  - `GET /v1/events`（ACR-031）：按账号，只说"你的会话列表变了，重拉一次"，无续传。
 *
 * `GET /v1/session/:id/stream`：`text/event-stream`，单向下行（§3，不用 WS）。
 * 事件格式：`id: <eventId>` + `data: <EventEnvelope JSON>`；
 * 续传：`Last-Event-ID` 头或 `lastEventId` query（会话内窗口，SessionBus）；
 * 心跳：15s 一条注释行，防中间设备断连（FL-08 F-08-11）。
 */

import { Router } from "express";
import type { Response } from "express";

import type { EventEnvelope, UserEventEnvelope } from "@cabinhug/shared";
import type { ChatRepository } from "@cabinhug/db";
import type { AuthedRequest } from "../auth";
import { isEphemeral, type SessionBus } from "./session-bus";
import type { UserBus } from "./user-bus";

const HEARTBEAT_MS = 15_000;

/**
 * 账号级通道的总开关（ACR-031 的回滚手段之一）。
 *
 * 默认开：没有客户端连它时，`publish` 只是一次无订阅者的 Map 查询，开销可忽略；
 * 默认关则端侧接入时"忘了开"的现象是什么都不发生，难以排查。
 * 置 `false` 时路由回 503、发射点短路，等于这条通道不存在。
 */
export function accountEventsEnabled(): boolean {
  return (process.env.ACCOUNT_EVENTS_ENABLED ?? "true").toLowerCase() !== "false";
}

export function createStreamRouter(repo: ChatRepository, bus: SessionBus, userBus?: UserBus): Router {
  const router = Router();

  router.get("/v1/session/:id/stream", async (req: AuthedRequest, res: Response) => {
    const sessionId = String(req.params.id);
    if (!(await repo.sessionExists(sessionId))) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");

    const lastEventId =
      req.header("last-event-id") ??
      (typeof req.query.lastEventId === "string" ? req.query.lastEventId : null);

    /*
     * 瞬时事件不写 `id:` 行（F-45-11）。
     *
     * 只把 filler 挡在 `log.buffer` 外还不够：浏览器 `EventSource` 会把每条
     * 带 `id:` 的事件记成 `lastEventId`。重连时带回一个不在窗口里的 id，
     * `subscribe` 的 `Number(envelope.eventId) > afterId` 会把它之后的真实事件
     * 也算作已收，导致重连后丢事件。
     */
    const send = (envelope: EventEnvelope) => {
      const idLine = isEphemeral(envelope.event) ? "" : `id: ${envelope.eventId}\n`;
      res.write(`${idLine}data: ${JSON.stringify(envelope)}\n\n`);
    };

    const unsubscribe = bus.subscribe(sessionId, lastEventId, send);
    const heartbeat = setInterval(() => res.write(": hb\n\n"), HEARTBEAT_MS);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  /**
   * 账号级事件流（ACR-031）：`GET /v1/events`。
   *
   * 它回答会话流回答不了的问题："我的另一个端刚做了什么"。没有这一层时，
   * 手机端聊完的对话不会出现在车机端的会话列表里，直到车机因别的原因重拉。
   *
   * 与上面那条流有三处不同，理由相同：本通道的事件不携带内容。
   *
   *  1. 不写 `id:` 行、不认 `Last-Event-ID`。晚到的刷新信号与刚到的作用相同，
   *     补发没有意义；端上重连时本来就要整拉一次。
   *  2. 连上先发一条 `connected`。"重连即对齐"是通道自带的语义，
   *     不依赖每个端各自实现"连上先拉一次"。
   *  3. 不校验会话存在。这里没有会话，订阅的键是人。
   */
  router.get("/v1/events", (req: AuthedRequest, res: Response) => {
    if (!userBus || !accountEventsEnabled()) {
      res.status(503).json({ error: "account_events_disabled" });
      return;
    }
    /*
     * 车辆级 token 未声明上车时没有"我的"可言，与 `/v1/sessions`、`/v1/attachments`
     * 同一口径。这里不回空流：否则端上会一直连着一条永远不来事件的流，
     * 表现为同步失效，而真实原因是没人声明在用车。
     */
    const userId = req.userId;
    if (!userId) {
      res.status(400).json({ error: "active_user_required" });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");

    const send = (envelope: UserEventEnvelope) => {
      res.write(`data: ${JSON.stringify(envelope)}\n\n`);
    };

    const unsubscribe = userBus.subscribe(userId, send);
    // 先订阅再对齐：反过来的话，这两步之间发生的变动会漏掉。
    send({ ts: Date.now(), event: { kind: "sessions_changed", reason: "connected" } });

    const heartbeat = setInterval(() => res.write(": hb\n\n"), HEARTBEAT_MS);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return router;
}
