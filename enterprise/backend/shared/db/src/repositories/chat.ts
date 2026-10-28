/**
 * 会话与对话历史仓储（F-03-10 权威源）。
 *
 * 网关在事件产生时写入（用户消息 = 受理时；助手消息 = 轮次结束时），
 * 不依赖端上确认。查询侧供 `GET /v1/session/:id/messages` 与端上缓存回源。
 */

import { PrismaClient } from "@prisma/client";
import type { AttachmentRef, ChatMessage, CitedSource, HistoryPage } from "@cabinhug/shared";
import { memoryCollectionName } from "@cabinhug/memory";

export type ChatRepository = ReturnType<typeof createChatRepository>;

/** `messages.sources` 列（Json）读回契约形状；只收 name 与 url 都是字符串的条目。 */
function citedSourcesOf(raw: unknown): CitedSource[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: unknown) => {
    const s = item as { name?: unknown; url?: unknown } | null;
    return s && typeof s.name === "string" && typeof s.url === "string" ? [{ name: s.name, url: s.url }] : [];
  });
}

export function createChatRepository(prisma: PrismaClient) {
  return {
    /**
     * 建会话。`userId` 为 null = 访客会话（F-56-06）：
     * 它落库（审计需要看到"这辆车上发生过一次访客对话"），
     * 但因为归属为空，任何按 `userId = 我` 的历史查询都取不到它。
     */
    async createSession(
      sessionId: string,
      userId: string | null,
      deviceId?: string | null,
    ): Promise<void> {
      await prisma.session.create({
        data: { id: sessionId, userId, deviceId: deviceId ?? null },
      });
    },

    async sessionExists(sessionId: string): Promise<boolean> {
      const found = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { id: true },
      });
      return found !== null;
    },

    /**
     * 会话此刻的状态。
     *
     * 一次查询给全：网关每收一条消息都要查一遍，分三次查会多两次往返，
     * 且"存不存在"与"关没关"分开查会有中间态。
     *
     * `lastActiveAt` 直接用 `updatedAt`：`appendMessage` 在同一个事务里 bump 它
     * （见 `appendMessage` 的注释），所以它就是最后活跃时间，无需新增列。
     */
    async sessionState(
      sessionId: string,
    ): Promise<{ exists: boolean; closedAt: Date | null; lastActiveAt: Date | null }> {
      const row = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { closedAt: true, updatedAt: true },
      });
      if (!row) return { exists: false, closedAt: null, lastActiveAt: null };
      return { exists: true, closedAt: row.closedAt, lastActiveAt: row.updatedAt };
    },

    /**
     * 这个会话归谁。`null` = 访客会话；`undefined` = 会话不存在。
     *
     * # 发消息时查它，而不是用请求上下文里的 userId
     *
     * 车机是车辆级凭证，请求上下文里没有人（设计裁决 R4）："谁在用"由
     * 建会话时的上车声明确定，存在这一行里。用请求上下文时，
     * 车机上的每一轮对话都会因拿不到 userId 而落进无归属分支，隔离键失效。
     */
    async sessionUserId(sessionId: string): Promise<string | null | undefined> {
      const row = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { userId: true },
      });
      return row ? row.userId : undefined;
    },

    /**
     * 这个会话由哪台设备替哪个人建的。
     *
     * 比 `sessionUserId` 多回一个 deviceId，这个字段是安全边界：
     * 车机出示会话 id 来主张"我此刻代表这个人"，若不校验设备，
     * 出示任意一个别人的会话 id 就能冒充成那个人。
     *
     * `undefined` = 会话不存在；`userId: null` = 访客会话（不代表任何人）。
     */
    async sessionActor(
      sessionId: string,
    ): Promise<{ userId: string | null; deviceId: string | null } | undefined> {
      const row = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { userId: true, deviceId: true, closedAt: true },
      });
      if (!row) return undefined;
      // 已关闭的会话不再代表任何人：「退下」之后不能再用它读个人数据。
      if (row.closedAt) return { userId: null, deviceId: row.deviceId };
      return { userId: row.userId, deviceId: row.deviceId };
    },

    /**
     * 软关闭。幂等：已关闭的再关一次不报错、也不改 `closedAt`。
     *
     * 端上「退下」会被连点，网络重试也会重发；"关闭时刻"被后一次覆盖后，
     * 就无法确定这段对话何时结束。
     *
     * 返回最终的 `closedAt`（无论这次有没有真的写）。会话不存在返回 `null`。
     */
    async closeSession(sessionId: string, at: Date): Promise<Date | null> {
      const row = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { closedAt: true },
      });
      if (!row) return null;
      if (row.closedAt) return row.closedAt;
      // `updatedAt` 是 @updatedAt，这次写会把它推到现在，符合预期：
      // 关闭本身就是一次活动，且关闭之后 lastActiveAt 不再用于判过期。
      const updated = await prisma.session.update({
        where: { id: sessionId },
        data: { closedAt: at },
        select: { closedAt: true },
      });
      return updated.closedAt;
    },

    /**
     * 写一次会话标题。只写 `null → 有值` 这一次，之后再写全部无效。
     *
     * 网关在每一轮 `turn_end` 后都会检查是否需要生成标题，而检查与写入之间隔着
     * 一次 LLM 调用，两轮挨得近时两次调用会并发落地。
     * 用条件更新而不是先查后写：后者的竞态窗口覆盖整段 LLM 调用。
     *
     * 返回是否真的写入。`false` 有两种成因（已有标题 / 会话不存在），
     * 调用方的处理都是不再下发事件，所以不区分。
     */
    async setSessionTitle(sessionId: string, title: string): Promise<boolean> {
      /*
       * 裸 SQL 而不是 `updateMany`：起标题不是车主的活动，不能碰 `updatedAt`。
       *
       * `updatedAt` 是 `@updatedAt`，prisma 的任何 update 都会把它推到现在，
       * 而这一列身兼两职：列表的排序键（`orderBy updatedAt`）与空闲过期的判据
       * （`lastActiveAt` 就是它）。历史回补时，给旧会话补标题会让它变成"刚刚活跃"：
       * 排到列表最顶，并能重新通过空闲判定接收消息。
       *
       * 条件 `AND title IS NULL` 保持原语义：只写 null → 有值这一次。
       */
      const n = await prisma.$executeRaw`
        UPDATE sessions SET title = ${title} WHERE id = ${sessionId} AND title IS NULL
      `;
      return n > 0;
    },

    /** 这个会话有没有标题了。`undefined` = 会话不存在。 */
    async sessionTitle(sessionId: string): Promise<string | null | undefined> {
      const row = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { title: true },
      });
      return row ? row.title : undefined;
    },

    /**
     * 车主自己的会话列表（车机端左侧历史）。
     *
     * 与 `consoleSessionPage` 刻意不共用：那个是运营视角（可跨用户检索、
     * 带轮次统计、脱敏口径），这个是车主视角（只看自己的、只要够渲染一行的字段）。
     * 合成一个函数时，权限只靠调用点的一个参数守护，端上可能拿到别人的会话。
     *
     * 游标按 `updatedAt`（与排序同一列），不按 id：id 是随机的，
     * 按 id 翻页会乱序，在懒加载列表里表现为重复和丢失。
     *
     * # 没有消息的会话不进这个列表
     *
     * 点开对话层就会建一条会话，没说话就退出的那条也留在库里；车主视角里
     * 这类空白对话是噪声。运营视角相反，「建了但没说话」本身是要看的现象，
     * 所以 `consoleSessionPage` 缺省不过滤、由 `nonEmpty` 开关控制。
     *
     * 过滤写在 SQL 里（`messages: { some: {} }` = EXISTS），不是取回一页再筛：
     * 应用层筛会让每页条数不足、游标不准，部分会话无法翻到。
     */
    async userSessionPage(q: {
      userId: string;
      limit: number;
      /** 上一页最后一条的 `updatedAt`（ISO 字符串）。 */
      cursor?: string;
    }): Promise<{
      sessions: Array<{
        sessionId: string;
        title: string | null;
        createdAt: string;
        updatedAt: string;
        closedAt: string | null;
        messageCount: number;
      }>;
      hasMore: boolean;
      nextCursor: string | null;
    }> {
      const cursorAt = q.cursor ? new Date(q.cursor) : null;
      const rows = await prisma.session.findMany({
        where: {
          userId: q.userId,
          // 没有消息的会话不进车主的列表（理由见上）。
          messages: { some: {} },
          // 被清理（软删除）的不进车主的列表；行还在，控制台可恢复。
          deletedAt: null,
          ...(cursorAt && !Number.isNaN(cursorAt.getTime())
            ? { updatedAt: { lt: cursorAt } }
            : {}),
        },
        orderBy: { updatedAt: "desc" },
        take: q.limit + 1,
        select: {
          id: true,
          title: true,
          createdAt: true,
          updatedAt: true,
          closedAt: true,
          _count: { select: { messages: true } },
        },
      });
      const hasMore = rows.length > q.limit;
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return {
        sessions: page.map((s) => ({
          sessionId: s.id,
          title: s.title,
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
          closedAt: s.closedAt ? s.closedAt.toISOString() : null,
          messageCount: s._count.messages,
        })),
        hasMore,
        nextCursor: hasMore && last ? last.updatedAt.toISOString() : null,
      };
    },

    /** 幂等写入：同一 messageId 重复写入不报错、不产生第二条（补发/重试场景）。 */
    /**
     * `meta` 是只给运营控制台看的标注（引擎档位），刻意不进 `ChatMessage`
     * 契约：端上不需要这两个值，进契约会迫使车机与手机跟着改。
     */
    async appendMessage(
      message: ChatMessage,
      meta?: { asrEngine?: string | null; ttsEngine?: string | null },
    ): Promise<void> {
      await prisma.$transaction([
        prisma.message.upsert({
          where: { id: message.messageId },
          create: {
            id: message.messageId,
            sessionId: message.sessionId,
            turnId: message.turnId,
            role: message.role,
            source: message.source,
            content: message.content,
            ts: BigInt(message.ts),
            // 被打断的半句。缺省 false，绝大多数消息如此。
            cancelled: message.cancelled === true,
            asrEngine: meta?.asrEngine ?? null,
            ttsEngine: meta?.ttsEngine ?? null,
            // 引用来源：空数组与缺省同义，都不落。
            ...(message.sources?.length ? { sources: message.sources } : {}),
          },
          update: {},
        }),
        // 同时把会话标为活跃。
        //
        // `updatedAt` 是 `@updatedAt`，而追加消息只写 messages 表、不碰会话行；
        // 不在这里 bump 的话，它会一直等于创建时间。
        // 车机端长期复用同一个会话 id，按 `updatedAt` 排序的列表需要它反映最后活跃时间。
        prisma.session.update({
          where: { id: message.sessionId },
          data: { updatedAt: new Date(message.ts) },
        }),
      ]);
    },

    /**
     * 六类记忆的真实计数。
     *
     * 计数来自库，而不是写死的状态；后者会随代码演进变得不实。
     *
     * ①按检查点数（那是"有多少轮上下文活着"的直接证据）；
     * ②③⑥画像按 Mem0 的 category 分组；④⑥流水按各自的表。
     * ⑤在 Redis，不在这里数——由运行时自报（它才是持有连接的那一方）。
     */
    /**
     * 某一类记忆的具体内容。
     *
     * # 直接读 PG 而不是走 runtime
     *
     * 计数（`memoryCounts`）读的就是这几张表。列表若改从 runtime 经 Mem0 检索取，
     * 两者的口径会在过滤与分页上分叉，出现计数与明细条数不一致。
     * 同一个数字与它的明细必须同源。
     *
     * # 一律限量并按时间倒序
     *
     * 这一页用于查看存了什么，不是导出工具。⑥流水可达上万条，全取会卡死页面，
     * 前几十条足以判断存储内容。
     */
    /**
     * 触发过双路检索的轮次。
     *
     * # 判据是轨迹里的 merge 事件，不是"路由到了 ownership"
     *
     * 路由到用车/售后不等于跑了双路：问诊留档那一支直接返回、不查知识库
     * （见 `supervisor.ts` 的 archiveIntent 门）。只有跑完双路才会落
     * 带 `personalized` 的 merge，以产物为准，不以意图为准。
     *
     * 问题文本取同轮的用户消息；取不到就留空，由页面显示轮次 id 兜底，
     * 不用助手回复的开头充当问题。
     */
    async dualPathTurns(limit = 30): Promise<
      Array<{
        sessionId: string;
        turnId: string;
        at: number;
        question: string | null;
        personalized: boolean;
        ragChunks: number;
        usageUsable: boolean;
      }>
    > {
      const capped = Math.min(Math.max(limit, 1), 100);
      const rows = await prisma.$queryRawUnsafe<
        Array<{
          session_id: string;
          turn_id: string | null;
          at: bigint;
          data: Record<string, unknown>;
          question: string | null;
        }>
      >(
        `select t.session_id, t.turn_id, t.at, t.data,
                (select m.content from messages m
                  where m.turn_id = t.turn_id and m.role = 'user'
                  order by m.ts asc limit 1) as question
           from trace_events t
          where t.kind = 'merge'
            and t.data ? 'personalized'
            and t.turn_id is not null
          order by t.at desc
          limit ${capped}`,
      ).catch(() => []);

      return rows.map((r) => ({
        sessionId: r.session_id,
        turnId: r.turn_id ?? "",
        at: Number(r.at),
        question: r.question,
        personalized: r.data.personalized === true,
        ragChunks: typeof r.data.ragChunks === "number" ? r.data.ragChunks : 0,
        usageUsable: r.data.usageUsable === true,
      }));
    },

    /**
     * 某一轮双路的完整明细：两路各拿到什么、合成了什么、模型答了什么。
     *
     * 助手回复取同轮 `role='assistant'` 的那条，即实际发给用户的原文，
     * 不在这里重新生成：页面展示的是发生过的事。
     */
    async dualPathTurn(turnId: string): Promise<{
      sessionId: string;
      turnId: string;
      at: number;
      question: string | null;
      answer: string | null;
      detail: Record<string, unknown>;
    } | null> {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ session_id: string; at: bigint; data: Record<string, unknown> }>
      >(
        `select session_id, at, data from trace_events
          where kind = 'merge' and turn_id = $1 and data ? 'personalized'
          order by at desc limit 1`,
        turnId,
      ).catch(() => []);
      const hit = rows[0];
      if (!hit) return null;

      const msgs = await prisma.message.findMany({
        where: { turnId },
        orderBy: { ts: "asc" },
      });
      return {
        sessionId: hit.session_id,
        turnId,
        at: Number(hit.at),
        question: msgs.find((m) => m.role === "user")?.content ?? null,
        answer: msgs.find((m) => m.role === "assistant")?.content ?? null,
        detail: hit.data,
      };
    },

    async memoryItems(
      userId: string,
      key: string,
      limit = 20,
    ): Promise<Array<{ id: string; text: string; meta?: string; at?: string }>> {
      const capped = Math.min(Math.max(limit, 1), 100);

      if (key === "vehicle") {
        const rows = await prisma.vehicle.findMany({
          where: { ownerId: userId },
          orderBy: { purchasedAt: "desc" },
          take: capped,
        });
        return rows.map((v) => ({
          id: v.vin,
          text: `${v.model} · ${v.modelYear} 款`,
          meta: `${Math.round(v.odometerKm)} km · VIN ${v.vin}`,
          at: v.purchasedAt.toISOString(),
        }));
      }

      if (key === "usage") {
        const rows = await prisma.trip.findMany({
          where: { userId },
          orderBy: { startedAt: "desc" },
          take: capped,
        });
        return rows.map((t) => ({
          id: t.id,
          text: `${t.distanceKm.toFixed(1)} km${t.roadType ? ` · ${t.roadType}` : ""}`,
          meta: t.vin ?? undefined,
          at: t.startedAt.toISOString(),
        }));
      }

      // 其余三类都在 Mem0 的 pgvector 表里，按 payload 的 category 分。
      // 正文在 `data`，不是 `memory`，与写入侧一致。
      const allowed: Record<string, string> = {
        episodic: "episodic",
        preference: "preference",
        usagePattern: "usage_pattern",
      };
      const category = allowed[key];
      if (!category) return [];

      // 表名与建表的 Mem0 客户端同源（它来自可热改的配置，已按标识符校验）。
      const memoryTable = memoryCollectionName();
      const rows = await prisma
        .$queryRawUnsafe<Array<{ id: string; data: string | null; sub: string | null; prov: string | null; at: string | null }>>(
          `select id::text as id,
                  payload->>'data' as data,
                  payload->>'subType' as sub,
                  payload->>'provenance' as prov,
                  coalesce(payload->>'occurredAt', payload->>'createdAt') as at
             from ${memoryTable}
            where payload->>'user_id' = $1 and payload->>'category' = $2
            order by coalesce(payload->>'occurredAt', payload->>'createdAt') desc nulls last
            limit ${capped}`,
          userId,
          category,
        )
        .catch(() => []);

      return rows.map((r) => ({
        id: r.id,
        text: r.data ?? "（这条没有正文）",
        // provenance 必须显示：`simulated` 是演示种子数据，
        // 与真实记忆混看会把模拟数据当作证据。
        meta: [r.sub, r.prov].filter(Boolean).join(" · ") || undefined,
        at: r.at ?? undefined,
      }));
    },

    async memoryCounts(userId: string): Promise<Record<string, number>> {
      const memoryTable = memoryCollectionName();
      const [vehicles, trips, mem, checkpoints] = await Promise.all([
        prisma.vehicle.count({ where: { ownerId: userId } }),
        prisma.trip.count({ where: { userId } }),
        prisma.$queryRawUnsafe<Array<{ category: string; n: bigint }>>(
          `select payload->>'category' as category, count(*) as n
             from ${memoryTable}
            where payload->>'user_id' = $1
            group by 1`,
          userId,
        ).catch(() => [] as Array<{ category: string; n: bigint }>),
        prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `select count(*) as n from checkpoints`,
        ).catch(() => [{ n: 0n }]),
      ]);

      const byCategory = Object.fromEntries(mem.map((r) => [r.category, Number(r.n)]));
      return {
        working: Number(checkpoints[0]?.n ?? 0),
        episodic: byCategory.episodic ?? 0,
        preference: byCategory.preference ?? 0,
        vehicle: vehicles,
        usage: trips,
        usagePattern: byCategory.usage_pattern ?? 0,
      };
    },

    /**
     * 运营视角的会话检索。
     *
     * 与端上 `historyPage` 的区别：跨会话、按用户/时间筛选、带聚合计数。
     * 只读：本仓储不提供任何修改或删除用户对话内容的方法。
     */
    async consoleSessionPage(q: {
      limit: number;
      userId?: string;
      sessionId?: string;
      since?: Date;
      until?: Date;
      cursor?: string;
      /**
       * 只要有消息的会话。
       *
       * 没有消息的会话真实存在（上车声明、举证脚本、发送失败），运营视角需要
       * 看到它们，所以默认不过滤，由调用方按用途打开。
       * 演示大屏的选择器打开它：零消息的会话在那里没有可回放的内容。
       *
       * 走 `messages: { some: {} }` 让数据库过滤，不在应用层筛：
       * 应用层筛会让每页条数不足，翻页不准。
       */
      nonEmpty?: boolean;
      /**
       * 按标题模糊搜。
       *
       * 与 `sessionId` 的精确定位不同：手上有 id 时用那个，
       * 只记得"聊的是保养那段"时用这个。
       *
       * 没有标题的会话不会命中：标题在首轮之后旁路生成，
       * 尚未生成的会话 `title` 是 NULL，`contains` 判不到它。界面需说明这一点。
       */
      title?: string;
      /**
       * 附带每条会话的轨迹事件条数。
       *
       * 与 `messageCount` 不同：消息是"说了几句"，轨迹事件是"运行落了多少步"
       * （意图、路由、分支、工具调用、span…）。演示大屏的选择器用后者判断
       * 这条会话是否有可回放的内容。
       *
       * 统计的是整条会话（含不属于任何一轮的事件）；大屏回放控制条上的分母
       * 是当前那一轮的，两者只在单轮会话上相等。
       *
       * 默认关：它是一次额外的 groupBy，「会话与对话」页不需要这个数。
       * 只对这一页的 id 查（与 `recentSessions` 相反：那边按轨迹分组
       * 再补标题，这边按会话分页再补事件数）。
       */
      withTraceCounts?: boolean;
      /**
       * 已清理（软删除）的会话要不要：`exclude` 不要 / `include` 都要 / `only` 只要它们。
       *
       * 缺省 `exclude`，但给了 `sessionId` 时缺省 `include`：精确定位时，
       * 被清理过的会话也应能找到（详情页用 `sessionId` 取这一行的元信息）。
       */
      deleted?: "exclude" | "include" | "only";
    }): Promise<{
      sessions: Array<{
        sessionId: string;
        /**
         * 会话归属账号；`null` = 访客会话（车机上车声明选了访客模式，F-56-06）。
         *
         * 运营视角看得见它，车主视角看不见：`userSessionPage` 按 `userId = 我` 过滤，
         * NULL 不命中。展示层不得把 null 渲染成空字符串（像数据缺失），
         * 要明示为访客。
         */
        userId: string | null;
        /** 会话标题；`null` = 还没生成（首轮没跑完，或生成失败）。 */
        title: string | null;
        createdAt: string;
        updatedAt: string;
        /** 会话结束时刻；`null` = 仍在进行。 */
        closedAt: string | null;
        /** 清理时刻；`null` = 没被清理过。 */
        deletedAt: string | null;
        messageCount: number;
        turnCount: number;
        firstMessageAt: number | null;
        lastMessageAt: number | null;
        /**
         * 轨迹事件条数。只有传了 `withTraceCounts` 才有这个字段：
         * 缺席表示"没查"，`0` 表示"查了，没有"（轨迹按天清理过，或这条会话
         * 没有运行）。两者在选择器上含义不同，所以不合并成一个 0。
         */
        traceEvents?: number;
      }>;
      hasMore: boolean;
      nextCursor: string | null;
    }> {
      const cursorRow = q.cursor
        ? await prisma.session.findUnique({ where: { id: q.cursor } })
        : null;

      const deletedMode = q.deleted ?? (q.sessionId ? "include" : "exclude");

      const rows = await prisma.session.findMany({
        where: {
          ...(deletedMode === "exclude" ? { deletedAt: null } : {}),
          ...(deletedMode === "only" ? { deletedAt: { not: null } } : {}),
          ...(q.userId ? { userId: q.userId } : {}),
          ...(q.sessionId ? { id: q.sessionId } : {}),
          // 时间筛选按创建时间（"这段时间新开的会话"），
          // 游标与排序按活跃时间：两者用途不同，不混用一个字段。
          ...(q.since || q.until
            ? {
                createdAt: {
                  ...(q.since ? { gte: q.since } : {}),
                  ...(q.until ? { lte: q.until } : {}),
                },
              }
            : {}),
          ...(cursorRow ? { updatedAt: { lt: cursorRow.updatedAt } } : {}),
          // 只要有消息的（见入参注释）。不传时不过滤。
          ...(q.nonEmpty ? { messages: { some: {} } } : {}),
          // 标题模糊搜。`insensitive` 对中文无所谓，但英文标题（车型名之类）用得上。
          ...(q.title ? { title: { contains: q.title, mode: "insensitive" as const } } : {}),
        },
        // 按最后活跃排，不按创建时间：
        // 长会话是常态（端上复用 session id），按创建时间排会让最活跃的会话沉底。
        orderBy: { updatedAt: "desc" },
        take: q.limit + 1,
        include: {
          messages: { select: { turnId: true, ts: true } },
        },
      });

      const hasMore = rows.length > q.limit;
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];

      /*
       * 轨迹事件条数（可选）。只对这一页的 id 查，一次 groupBy。
       *
       * 轨迹按天清理（`TraceRepository.prune`），老会话可能有多轮对话却零条事件。
       * 查了但取不到的一律记 0，不留 undefined：undefined 专用于表示"没查"。
       */
      const traceCounts = new Map<string, number>();
      if (q.withTraceCounts && page.length > 0) {
        const grouped = await prisma.traceEvent.groupBy({
          by: ["sessionId"],
          where: { sessionId: { in: page.map((s) => s.id) } },
          _count: { _all: true },
        });
        for (const g of grouped) traceCounts.set(g.sessionId, g._count._all);
      }

      return {
        sessions: page.map((s) => {
          const tsList = s.messages.map((m) => Number(m.ts));
          return {
            sessionId: s.id,
            userId: s.userId,
            title: s.title,
            createdAt: s.createdAt.toISOString(),
            updatedAt: s.updatedAt.toISOString(),
            closedAt: s.closedAt ? s.closedAt.toISOString() : null,
            deletedAt: s.deletedAt ? s.deletedAt.toISOString() : null,
            messageCount: s.messages.length,
            turnCount: new Set(s.messages.map((m) => m.turnId)).size,
            firstMessageAt: tsList.length ? Math.min(...tsList) : null,
            lastMessageAt: tsList.length ? Math.max(...tsList) : null,
            /** 只有 `withTraceCounts` 时才有；见入参注释。 */
            ...(q.withTraceCounts ? { traceEvents: traceCounts.get(s.id) ?? 0 } : {}),
          };
        }),
        hasMore,
        nextCursor: hasMore && last ? last.id : null,
      };
    },

    /**
     * 按保留期清理历史（F-03-11）。
     *
     * `retentionDays <= 0` 表示长期保留 → 直接返回 0，不做任何删除。
     * 与记忆衰减无耦合：这里删的是"可翻阅历史"，不是模型上下文，
     * 也不是 Mem0 的 ②③⑥（那套衰减归 FL-21 / FL-32）。
     *
     * 调度归 FL-32（worker cron）；本方法只提供可调用的能力，
     * 当前没有定时器自动调它：删数据的任务在具备告警与留痕之前不自动运行（同 F-42-09）。
     */
    /**
     * 把"空闲超阈值、零消息、还没关闭"的会话批量落 `closed_at`。
     *
     * # 懒关闭覆盖不到零消息会话
     *
     * 网关的过期判定是懒关闭（`checkSessionUsable`：判出过期就顺手标记，
     * 但只在下一次访问该会话时发生）。零消息的会话通常没有下一次访问，
     * 会在按"未关闭"判活的列表里一直显示为活跃。
     *
     * # 只关不删
     *
     * 关掉的是"还能不能接着说"，行与消息一条不删，与 `closeSession` 的软关闭
     * 语义一致。删行会让"这辆车上发生过一次访客对话"这类审计证据消失。
     *
     * # 判据与网关同源
     *
     * 阈值由调用方传入（worker 读的是与网关同一个 `CABINHUG_SESSION_IDLE_MIN` /
     * `DEFAULT_SESSION_IDLE_MIN`）；边界方向也一致：严格大于才算过期，
     * 正好卡在阈值上的不动。两处判据必须一致。
     *
     * 返回 `scanned` 与 `closed` 两个数："扫到 0 条"与"关了 0 条"在告警上含义不同。
     * `remaining` 让调用方知道这一批之外还有没有（`limit` 避免长时间占用表）。
     */
    async closeIdleEmptySessions(opts: {
      idleMs: number;
      now?: Date;
      limit?: number;
    }): Promise<{ scanned: number; closed: number; remaining: number }> {
      const now = opts.now ?? new Date();
      const limit = opts.limit ?? 500;
      const cutoff = new Date(now.getTime() - opts.idleMs);
      const where = {
        closedAt: null,
        // 严格小于 cutoff = 空闲时长严格大于阈值（与网关的边界方向一致）。
        updatedAt: { lt: cutoff },
        messages: { none: {} },
      } as const;
      const rows = await prisma.session.findMany({
        where,
        orderBy: { updatedAt: "asc" },
        take: limit,
        select: { id: true },
      });
      if (rows.length === 0) return { scanned: 0, closed: 0, remaining: 0 };
      /*
       * 走裸 SQL 是为了不碰 `updated_at`，不是为了性能。
       *
       * `updatedAt` 是 `@updatedAt`：任何一次 `prisma.session.update*` 都会把它推到现在。
       * 单条 `closeSession` 如此是对的（车主点「退下」是一次活动），
       * 但批量收口不是活动，而是补记账。运营控制台、车机会话列表、演示大屏的选择器
       * 都按 `updatedAt desc` 排，推高 `updatedAt` 会让被关掉的旧空会话占满列表首屏。
       *
       * `closed_at is null` 留在 where 里：与网关的懒关闭并发时，
       * 已被那边关掉的不会被这边改成另一个时间戳。
       */
      const closed = await prisma.$executeRaw`
        UPDATE sessions
           SET closed_at = ${now}
         WHERE id = ANY(${rows.map((r) => r.id)}::text[])
           AND closed_at IS NULL`;
      const remaining = await prisma.session.count({ where });
      return { scanned: rows.length, closed, remaining };
    },

    /**
     * 清理一条会话（F-03-11）。软删除：只写 `deleted_at`，任何表一行不删。
     *
     * 与 `consoleSessionPage` 所述的只读约束不冲突：对话内容不变，
     * 只改变这条会话是否出现在列表里。
     *
     * 三条语义：
     *  - 顺手关会话：`closed_at` 为空才写（`COALESCE`），已关的保持原来的关闭时刻；
     *  - 幂等：已清理的再清一次不改 `deleted_at`，`changed: false`；
     *  - 不碰 `updated_at`：清理不是活动（理由同 `closeIdleEmptySessions`，所以走裸 SQL）。
     *
     * 会话不存在返回 `null`。
     */
    async softDeleteSession(
      sessionId: string,
      at: Date,
    ): Promise<{ deletedAt: Date; changed: boolean } | null> {
      const changed = await prisma.$executeRaw`
        UPDATE sessions
           SET deleted_at = ${at},
               closed_at = COALESCE(closed_at, ${at})
         WHERE id = ${sessionId}
           AND deleted_at IS NULL`;
      const row = await prisma.session.findUnique({
        where: { id: sessionId },
        select: { deletedAt: true },
      });
      if (!row || !row.deletedAt) return null;
      return { deletedAt: row.deletedAt, changed: changed > 0 };
    },

    /**
     * 恢复一条被清理的会话。只清 `deleted_at`，不复活 `closed_at`：
     * 恢复的是"看得见"，不是"接着说"。幂等；会话不存在返回 `null`。
     */
    async restoreSession(sessionId: string): Promise<{ changed: boolean } | null> {
      const changed = await prisma.$executeRaw`
        UPDATE sessions
           SET deleted_at = NULL
         WHERE id = ${sessionId}
           AND deleted_at IS NOT NULL`;
      if (changed > 0) return { changed: true };
      return (await prisma.session.findUnique({ where: { id: sessionId }, select: { id: true } }))
        ? { changed: false }
        : null;
    },

    /**
     * 分批清理。控制台「清理全部」与 worker 的按天自动清理共用这一个。
     *
     * `olderThan` 缺省 = 全部未清理的；给了就只动 `updated_at` 严格早于它的
     * （`updated_at` 就是最后活跃时间，见 `sessionState` 的注释）。
     * 形状与 `closeIdleEmptySessions` 一致：先取一批 id、再一条裸 SQL、如实报 `remaining`；
     * `limit` 避免会话量大时长时间占用表。
     */
    async softDeleteSessions(
      opts: { olderThan?: Date; now?: Date; limit?: number } = {},
    ): Promise<{ scanned: number; deleted: number; remaining: number }> {
      const now = opts.now ?? new Date();
      const limit = opts.limit ?? 500;
      const where = {
        deletedAt: null,
        ...(opts.olderThan ? { updatedAt: { lt: opts.olderThan } } : {}),
      };
      const rows = await prisma.session.findMany({
        where,
        orderBy: { updatedAt: "asc" },
        take: limit,
        select: { id: true },
      });
      if (rows.length === 0) return { scanned: 0, deleted: 0, remaining: 0 };
      const deleted = await prisma.$executeRaw`
        UPDATE sessions
           SET deleted_at = ${now},
               closed_at = COALESCE(closed_at, ${now})
         WHERE id = ANY(${rows.map((r) => r.id)}::text[])
           AND deleted_at IS NULL`;
      const remaining = await prisma.session.count({ where });
      return { scanned: rows.length, deleted, remaining };
    },

    /** 会话计数。控制台「清理全部」弹确认时报数用；`deleted` 缺省数未清理的。 */
    async countSessions(opts: { deleted?: boolean } = {}): Promise<number> {
      return prisma.session.count({
        where: opts.deleted ? { deletedAt: { not: null } } : { deletedAt: null },
      });
    },

    async purgeHistoryOlderThan(retentionDays: number): Promise<number> {
      if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
      const cutoff = BigInt(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
      const { count } = await prisma.message.deleteMany({ where: { ts: { lt: cutoff } } });
      return count;
    },

    /** 会话是否已有消息，用于区分"新会话"与"进程重启后 ①Working 丢失"。 */
    async messageCount(sessionId: string): Promise<number> {
      return prisma.message.count({ where: { sessionId } });
    },

    /** 游标向前分页；返回按 ts 正序（契约 HistoryPage 语义）。 */
    /**
     * 控制台专用分页：与 `historyPage` 同一批数据，多带引擎标注。
     *
     * 单开一个方法而不是给 `historyPage` 加参数：那个的返回类型是端云契约
     * `HistoryPage`，加字段要改 `contracts` 与 ts-rs 的 Rust 源，
     * 进而波及车机与手机，而端上不使用这两个标注。
     */
    /**
     * 单条消息（控制台试听用）。
     *
     * 与 `consoleHistoryPage` 返回同一形状，但不分页：试听端点只需要
     * 「这条是谁说的、说了什么、当时哪个档」，不必取整页消息。
     * content 是未脱敏原文：合成要用它发音，调用方在取它之前
     * 已经写过一条与 reveal 同级的审计（见 console/message-audio.ts）。
     */
    async consoleMessage(
      messageId: string,
    ): Promise<(ChatMessage & { asrEngine: string | null; ttsEngine: string | null }) | null> {
      const r = await prisma.message.findUnique({ where: { id: messageId } });
      if (!r) return null;
      return {
        messageId: r.id,
        sessionId: r.sessionId,
        turnId: r.turnId,
        role: r.role as ChatMessage["role"],
        source: r.source as ChatMessage["source"],
        content: r.content,
        ts: Number(r.ts),
        cancelled: r.cancelled,
        asrEngine: r.asrEngine,
        ttsEngine: r.ttsEngine,
      };
    },

    async consoleHistoryPage(
      sessionId: string,
      opts: { before?: string; limit: number },
    ): Promise<{
      messages: Array<ChatMessage & { asrEngine: string | null; ttsEngine: string | null }>;
      hasMore: boolean;
      nextBefore: string | null;
    }> {
      const before = opts.before
        ? await prisma.message.findUnique({ where: { id: opts.before } })
        : null;
      const rows = await prisma.message.findMany({
        where: { sessionId, ...(before ? { ts: { lt: before.ts } } : {}) },
        orderBy: { ts: "desc" },
        take: opts.limit + 1,
      });
      const hasMore = rows.length > opts.limit;
      const page = rows.slice(0, opts.limit);
      const oldest = page[page.length - 1];
      return {
        messages: page.reverse().map((r) => ({
          messageId: r.id,
          sessionId: r.sessionId,
          turnId: r.turnId,
          role: r.role as ChatMessage["role"],
          source: r.source as ChatMessage["source"],
          content: r.content,
          ts: Number(r.ts),
          cancelled: r.cancelled,
          asrEngine: r.asrEngine,
          ttsEngine: r.ttsEngine,
        })),
        hasMore,
        nextBefore: hasMore && oldest ? oldest.id : null,
      };
    },

    async historyPage(
      sessionId: string,
      opts: { before?: string; limit: number },
    ): Promise<HistoryPage> {
      const before = opts.before
        ? await prisma.message.findUnique({ where: { id: opts.before } })
        : null;

      const rows = await prisma.message.findMany({
        where: {
          sessionId,
          ...(before ? { ts: { lt: before.ts } } : {}),
        },
        orderBy: { ts: "desc" },
        take: opts.limit + 1,
      });

      const hasMore = rows.length > opts.limit;
      const page = rows.slice(0, opts.limit);
      const oldest = page[page.length - 1];

      /*
       * 附件引用（F-03-08）：按本页用户消息的 turnId 一次取回，挂到用户消息上。
       * 只带元数据不带字节——端上拿句柄经 `GET /v1/attachments/:handle` 取原件（那条路比对归属）。
       * 只挂已绑轮的（`turnId` 非空）：传了没发的附件不属于任何一条消息。
       */
      const turnIds = [...new Set(page.filter((r) => r.role === "user").map((r) => r.turnId))];
      const attachmentRows = turnIds.length
        ? await prisma.attachment.findMany({
            where: { turnId: { in: turnIds }, kind: { in: ["image", "video"] } },
            orderBy: { createdAt: "asc" },
            select: { id: true, turnId: true, kind: true, contentType: true, bytes: true, filename: true },
          })
        : [];
      const attachmentsByTurn = new Map<string, AttachmentRef[]>();
      for (const a of attachmentRows) {
        if (!a.turnId) continue;
        const list = attachmentsByTurn.get(a.turnId) ?? [];
        list.push({
          attachmentId: a.id,
          kind: a.kind as AttachmentRef["kind"],
          handle: a.id,
          contentType: a.contentType,
          bytes: a.bytes,
          ...(a.filename ? { filename: a.filename } : {}),
        });
        attachmentsByTurn.set(a.turnId, list);
      }

      return {
        messages: page.reverse().map((r) => {
          const attachments = r.role === "user" ? attachmentsByTurn.get(r.turnId) : undefined;
          const sources = citedSourcesOf(r.sources);
          return {
            messageId: r.id,
            sessionId: r.sessionId,
            turnId: r.turnId,
            role: r.role as ChatMessage["role"],
            source: r.source as ChatMessage["source"],
            content: r.content,
            ts: Number(r.ts),
            cancelled: r.cancelled,
            ...(attachments?.length ? { attachments } : {}),
            ...(sources.length ? { sources } : {}),
          };
        }),
        hasMore,
        nextBefore: hasMore && oldest ? oldest.id : null,
      };
    },
  };
}
