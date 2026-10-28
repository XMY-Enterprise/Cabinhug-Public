/**
 * 记忆浏览。
 *
 * 本路由做两件事：
 *   1. 转发 runtime 的 ①Working（LangGraph 图状态）只读查询（协议转换，网关不含业务逻辑，§3）
 *   2. 提供六类分区的元信息，让"哪一类还没有数据"成为界面上的明示事实
 *
 * 对话历史不作为情景记忆展示：§7 里两者是不同的东西，混用后无法区分历史与记忆。
 */

import { Router } from "express";
import type { Response } from "express";

import type { AuditRepository, ChatRepository } from "@cabinhug/db";
import { MEMORY_TAXONOMY } from "@cabinhug/memory";

import { requireAnyRole, CONSOLE_READERS, type ConsoleRequest } from "../auth/console";
import { auditAction, auditLocals } from "./audit";
import { redact } from "./redact";

interface RuntimeWorkingState {
  status: "active" | "expired" | "empty";
  threadId: string | null;
  lastActiveMs: number | null;
  turnCount: number;
  messages: Array<{ role: string; content: string }>;
}

/** 对外多一种状态：`unavailable` = 进程重启导致内存检查点丢失（§13-3 的可见后果）。 */
type ConsoleWorkingStatus = RuntimeWorkingState["status"] | "unavailable";

/** 只对字符串叶子脱敏，结构与数字原样——见 `/console/memory/cache/entry` 的注释。 */
export function redactDeep(v: unknown): unknown {
  if (typeof v === "string") return redact(v).text;
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = redactDeep(x);
    return out;
  }
  return v;
}

export function createMemoryRouter(
  runtimeUrl: string,
  chat: ChatRepository,
  audit: AuditRepository,
): Router {
  const router = Router();

  router.get(
    "/console/memory/taxonomy",
    requireAnyRole(CONSOLE_READERS),
    (_req: ConsoleRequest, res: Response) => {
      res.json({ categories: MEMORY_TAXONOMY });
    },
  );

  /**
   * 六类记忆总览：接线状态 + 真实计数。
   *
   * 两者回答不同的问题，必须一起给：
   *  - `wired`（来自运行时自报）= "我们做了没有"；
   *  - `count`（来自库里数出来）= "这个用户有没有"。
   *
   * 两者合并成一句"未接入"时，"没做"与"没数据"无法区分。
   */
  router.get(
    "/console/memory/overview",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const userId = typeof req.query.userId === "string" ? req.query.userId : "demo-user";

      let wiring: unknown[] = [];
      let cache: Record<string, number> | undefined;
      let runtimeReachable = true;
      try {
        const upstream = await fetch(`${runtimeUrl}/internal/health/runtime`);
        if (!upstream.ok) throw new Error(`status=${upstream.status}`);
        const h = (await upstream.json()) as {
          health?: { memory?: unknown[]; cache?: Record<string, number> };
        };
        wiring = h.health?.memory ?? [];
        // ⑤的运行数据：Redis 里不统计条数，命中率反映缓存是否起作用。
        cache = h.health?.cache;
      } catch (err) {
        console.error("[console] 读取记忆接线状态失败", err);
        // 读不到运行时时不填"未接入"：读不到运行时与"运行时说未接入"不同，
        // 前者是我们看不见，后者是它确实没接，页面要能分开说。
        runtimeReachable = false;
      }

      const counts = await chat.memoryCounts(userId).catch((err) => {
        console.error("[console] 记忆计数失败", err);
        return null;
      });

      res.json({ userId, runtimeReachable, wiring, counts, cache });
    },
  );

  /**
   * 某一类记忆的具体内容。
   *
   * 只报条数回答不了"存的是不是我想的那种东西"，这一页需要给出条目本身。
   *
   * 与 `overview` 的计数同源（都读 PG，见 `memoryItems` 的说明），
   * 保证计数与列出的条目数一致。
   */
  router.get(
    "/console/memory/items/:userId",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const userId = String(req.params.userId);
      const key = typeof req.query.key === "string" ? req.query.key : "";
      const limit = Number(req.query.limit ?? 20);
      try {
        const items = await chat.memoryItems(userId, key, Number.isFinite(limit) ? limit : 20);
        res.json({ userId, key, items });
      } catch (err) {
        console.error(`[console] 读取 ${key} 明细失败 user=${userId}`, err);
        res.status(502).json({ error: "memory_unavailable" });
      }
    },
  );

  /**
   * ⑤环境缓存：分页浏览。
   *
   * ⑤不进 Mem0、不参与衰减，只给数字时无法判断内容，因此提供分页浏览。
   *
   * 必须经 runtime 转发：Redis 的连接握在 runtime 手上（⑤由它装配注入），
   * 网关自己读不到。这与 §3 "网关只做协议转换"一致。
   */
  router.get(
    "/console/memory/cache",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const q = new URLSearchParams();
      for (const k of ["offset", "limit", "namespace"]) {
        const v = req.query[k];
        if (typeof v === "string" && v !== "") q.set(k, v);
      }
      try {
        const upstream = await fetch(`${runtimeUrl}/internal/memory/cache?${q.toString()}`);
        if (!upstream.ok) throw new Error(`status=${upstream.status}`);
        const body = (await upstream.json()) as {
          wired: boolean;
          entries?: Array<{ preview: string; title?: string; summary?: string }>;
        };
        /*
         * 预览过一道脱敏。
         *
         * ⑤存的是外部世界的事实（天气/路况/充电价），键上刻意不含 userId，
         * 按设计不含个人信息；脱敏成本几乎为零，仍与①Working 用同一套规则兜底。
         */
        if (Array.isArray(body.entries)) {
          body.entries = body.entries.map((e) => ({
            ...e,
            preview: redact(e.preview).text,
            ...(e.title !== undefined ? { title: redact(e.title).text } : {}),
            ...(e.summary !== undefined ? { summary: redact(e.summary).text } : {}),
          }));
        }
        res.json(body);
      } catch (err) {
        console.error("[console] 读取 ⑤环境缓存失败", err);
        // 不回空列表，理由同 ③偏好那条：空列表会被读成"缓存里没东西"。
        res.status(502).json({ error: "runtime_unreachable" });
      }
    },
  );

  /**
   * ⑤单条详情：控制台点开条目看完整值。
   *
   * 键走 query（理由见 runtime 侧注释）。全值逐字段脱敏：值是 JSON 对象，
   * 对整段文本跑规则会把星号写进数字字段（坐标、adcode），导致 JSON 解析失败；
   * 只对字符串叶子跑，结构不动。
   */
  router.get(
    "/console/memory/cache/entry",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const key = typeof req.query.key === "string" ? req.query.key : "";
      if (!key) {
        res.status(400).json({ error: "key_required" });
        return;
      }
      try {
        const upstream = await fetch(`${runtimeUrl}/internal/memory/cache/entry?key=${encodeURIComponent(key)}`);
        if (upstream.status === 404) {
          res.status(404).json({ wired: true, found: false });
          return;
        }
        if (!upstream.ok) throw new Error(`status=${upstream.status}`);
        const body = (await upstream.json()) as { entry?: { value: unknown } };
        if (body.entry) body.entry = { ...body.entry, value: redactDeep(body.entry.value) };
        res.json(body);
      } catch (err) {
        console.error("[console] 读取 ⑤环境缓存单条失败", err);
        res.status(502).json({ error: "runtime_unreachable" });
      }
    },
  );

  /**
   * ③偏好：列出与删除（F-21-11）。
   *
   * 删除路径是写入的前置条件：③是慢衰减、不硬删的那一类，
   * 系统能自己往里写，用户就必须能把写错的拿掉，否则出错时无法收敛。
   *
   * 只读列表给 CONSOLE_READERS；删除是改用户的记忆，进审计（§8.5 同一原则）。
   */
  router.get(
    "/console/memory/preferences/:userId",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const userId = String(req.params.userId);
      try {
        const upstream = await fetch(
          `${runtimeUrl}/internal/memory/preferences/${encodeURIComponent(userId)}`,
        );
        if (!upstream.ok) throw new Error(`status=${upstream.status}`);
        res.json(await upstream.json());
      } catch (err) {
        console.error(`[console] 读取 ③偏好失败 user=${userId}`, err);
        // 不返回空列表：空列表会被读成"这个用户没有偏好"，与"读取失败"不同。
        res.status(502).json({ error: "runtime_unreachable" });
      }
    },
  );

  /**
   * 删除一条③偏好。先写审计再执行，与 `memory.reveal` 同一套规则：
   * 删除不可逆，审计写不进去就不执行，保证每次删除都可追溯到操作人。
   */
  router.delete(
    "/console/memory/preferences/:userId/:memoryId",
    auditAction("memory.preference.delete"),
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const userId = String(req.params.userId);
      const memoryId = String(req.params.memoryId);

      try {
        await audit.recordStrict({
          actor: req.console?.subject ?? "unknown",
          actorRole: req.console!.role,
          action: "memory.preference.delete",
          result: "ok",
          target: `${userId}/${memoryId}`,
          detail: { category: 3, scope: "preference" },
          sessionId: null,
          ip: req.ip ?? null,
        });
      } catch (err) {
        console.error(`[console] 删除审计写入失败，拒绝执行 user=${userId} id=${memoryId}`, err);
        res.status(503).json({ error: "audit_unavailable" });
        return;
      }
      auditLocals(res).auditHandled = true;

      try {
        const upstream = await fetch(
          `${runtimeUrl}/internal/memory/preferences/${encodeURIComponent(userId)}/${encodeURIComponent(memoryId)}`,
          { method: "DELETE" },
        );
        if (!upstream.ok) throw new Error(`status=${upstream.status}`);
        res.json({ deleted: true });
      } catch (err) {
        console.error(`[console] 删除 ③偏好失败 user=${userId} id=${memoryId}`, err);
        res.status(502).json({ error: "runtime_unreachable" });
      }
    },
  );

  router.get(
    "/console/memory/working/:sessionId",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const sessionId = String(req.params.sessionId);

      let state: RuntimeWorkingState;
      try {
        const upstream = await fetch(`${runtimeUrl}/internal/memory/working/${sessionId}`);
        if (!upstream.ok) throw new Error(`status=${upstream.status}`);
        state = (await upstream.json()) as RuntimeWorkingState;
      } catch (err) {
        console.error(`[console] 读取 ①Working 失败 session=${sessionId}`, err);
        res.status(502).json({ error: "runtime_unreachable" });
        return;
      }

      // runtime 无法区分"新会话"与"重启后丢失"（内存检查点），
      // 由 PG 的消息数补全这一判定。
      let status: ConsoleWorkingStatus = state.status;
      if (status === "empty" && (await chat.messageCount(sessionId)) > 0) {
        status = "unavailable";
      }

      res.json({
        sessionId,
        status,
        threadId: state.threadId,
        lastActiveMs: state.lastActiveMs,
        turnCount: state.turnCount,
        revealed: false,
        messages: state.messages.map((m) => {
          const r = redact(m.content);
          return { role: m.role, content: r.text, redacted: r.redacted };
        }),
        storage: "LangGraph 图状态（POC 期内存检查点，§13-3）",
      });
    },
  );

  // 提权查看 ①Working 原文：与会话 reveal 同一套规则（先写审计再放行）
  router.post(
    "/console/memory/working/:sessionId/reveal",
    auditAction("memory.reveal"),
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const sessionId = String(req.params.sessionId);
      try {
        await audit.recordStrict({
          actor: req.console?.subject ?? "unknown",
          actorRole: req.console!.role,
          action: "memory.reveal",
          result: "ok",
          target: sessionId,
          detail: { category: 1, scope: "working" },
          sessionId,
          ip: req.ip ?? null,
        });
      } catch (err) {
        console.error(`[console] memory.reveal 审计写入失败，拒绝放行 session=${sessionId}`, err);
        res.status(503).json({ error: "audit_unavailable" });
        return;
      }
      auditLocals(res).auditHandled = true;

      try {
        const upstream = await fetch(`${runtimeUrl}/internal/memory/working/${sessionId}`);
        if (!upstream.ok) throw new Error(`status=${upstream.status}`);
        const state = (await upstream.json()) as RuntimeWorkingState;
        res.json({ sessionId, revealed: true, ...state });
      } catch (err) {
        console.error(`[console] 读取 ①Working 失败 session=${sessionId}`, err);
        res.status(502).json({ error: "runtime_unreachable" });
      }
    },
  );

  return router;
}
