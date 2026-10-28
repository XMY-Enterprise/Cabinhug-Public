/**
 * [F-30-08] 会话检索的服务端筛选（`consoleSessionPage`）。连真实 PG。
 *
 * 「会话与对话」页与演示大屏的选择器用的是同一个接口、同一组条件，
 * 这几条筛选都在 SQL 一侧，只有连真库才验得到：
 *
 *  1. `nonEmpty` 在数据库里过滤：在应用层筛会让每页条数不足、翻页不准，
 *     假仓储里看不出来；
 *  2. 标题是 `contains`，没起名的会话一条都不命中（`title` 是 NULL）；
 *  3. 日期按 `createdAt` 且含端点：不含端点时选中某天会漏掉那一天的边界行。
 *
 * 前端那一半（人选的日期 → 本地整天的时间点）在
 * `enterprise/console/src/pages/sessions/filters.ts`，另有单测。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import { createChatRepository } from "../src/repositories/chat";
import { seedTestUsers } from "./helpers/seed-users";

const DATABASE_URL = process.env.DATABASE_URL;
const PREFIX = "test-console-sessions";
/**
 * 这几条断言要独占一个用户。
 *
 * `consoleSessionPage` 是跨用户的运营检索，库里可能有大量会话；
 * 不隔离时 `limit: 50` 取到的是全库最近 50 条，种子行可能不在其中，
 * 断言会因其他会话的写入而失败。
 */
const TEST_USER = "test-console-sessions-user";
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

if (!DATABASE_URL) {
  describe("会话检索的服务端筛选", () => {
    it("跳过：未设置 DATABASE_URL（这组测试必须连真库）", () => assert.ok(true));
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const repo = createChatRepository(prisma);
  const clean = async (): Promise<void> => {
    await prisma.traceEvent.deleteMany({ where: { sessionId: { startsWith: PREFIX } } });
    await prisma.message.deleteMany({ where: { sessionId: { startsWith: PREFIX } } });
    await prisma.session.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.user.deleteMany({ where: { id: TEST_USER } });
  };

  /** 建一条会话并把它的 created/updated 挪到 `agoMs` 之前（`@updatedAt` 只能用裸 SQL 绕开）。 */
  const seed = async (
    id: string,
    agoMs: number,
    opts: { messages?: number; owned?: boolean; traceEvents?: number } = {},
  ): Promise<void> => {
    // 账号用仓库既有的播种助手（外键要求"会话的归属必须是一个账号"）。
    if (opts.owned) await seedTestUsers(prisma, [TEST_USER]);
    await prisma.session.create({ data: { id, userId: opts.owned ? TEST_USER : null } });
    for (let i = 0; i < (opts.messages ?? 0); i += 1) {
      await prisma.message.create({
        data: {
          id: `${id}-m${i}`,
          sessionId: id,
          turnId: `${id}-t`,
          role: "user",
          source: "text",
          content: "x",
          ts: BigInt(Date.now()),
        },
      });
    }
    for (let i = 0; i < (opts.traceEvents ?? 0); i += 1) {
      await prisma.traceEvent.create({
        data: {
          id: `${id}-tr${i}`,
          sessionId: id,
          turnId: `${id}-t`,
          kind: "span",
          at: BigInt(Date.now()),
          data: {},
        },
      });
    }
    const at = new Date(Date.now() - agoMs);
    await prisma.$executeRaw`
      UPDATE sessions SET created_at = ${at}, updated_at = ${at} WHERE id = ${id}`;
  };

  before(clean);
  after(async () => {
    await clean();
    await prisma.$disconnect();
  });

  /**
   * [F-30-08] 只列"说过话的会话"（演示大屏的选择器用）。
   *
   * 这条也必须连真库：要验的是数据库在过滤，而不是应用层筛完之后每页条数不足。
   */
  describe("只列说过话的会话（nonEmpty）", () => {
    const seedFor = async (): Promise<void> => {
      await clean();
      // 三条空的夹在两条有对话的中间，确保"跳过空的"不依赖顺序。
      await seed(`${PREFIX}-p1`, 50 * MIN, { messages: 1, owned: true });
      await seed(`${PREFIX}-p2`, 40 * MIN, { owned: true });
      await seed(`${PREFIX}-p3`, 30 * MIN, { owned: true });
      await seed(`${PREFIX}-p4`, 20 * MIN, { owned: true });
      await seed(`${PREFIX}-p5`, 10 * MIN, { messages: 2, owned: true });
    };

    it("默认不过滤：运营视角要看得见「建了但没说话」的会话", async () => {
      await seedFor();
      const page = await repo.consoleSessionPage({ limit: 50, userId: TEST_USER });
      assert.equal(page.sessions.length, 5);
    });

    it("`nonEmpty` 打开后只剩说过话的那两条", async () => {
      await seedFor();
      const page = await repo.consoleSessionPage({ limit: 50, userId: TEST_USER, nonEmpty: true });
      assert.deepEqual(
        page.sessions.map((x) => x.sessionId).sort(),
        [`${PREFIX}-p1`, `${PREFIX}-p5`],
      );
      assert.ok(page.sessions.every((x) => x.messageCount > 0), "剩下的每条都得有消息");
    });

    it("过滤发生在数据库侧：一页就是一页，不是取 N 条再筛剩几条", async () => {
      await seedFor();
      const page = await repo.consoleSessionPage({ limit: 1, userId: TEST_USER, nonEmpty: true });
      // limit=1 且总共有 2 条命中 → 这一页恰好 1 条，且还有下一页。
      assert.equal(page.sessions.length, 1);
      assert.equal(page.hasMore, true);
      assert.ok(page.nextCursor, "有下一页就必须给游标");
      const next = await repo.consoleSessionPage({
        limit: 1,
        userId: TEST_USER,
        nonEmpty: true,
        cursor: page.nextCursor ?? undefined,
      });
      assert.equal(next.sessions.length, 1);
      assert.notEqual(next.sessions[0].sessionId, page.sessions[0].sessionId);
    });
  });

  /**
   * [F-30-08] 标题模糊搜与日期范围（两个页面共用的筛选）。
   *
   * 日期那两条要验的是边界：接口按 `createdAt` 的 `gte` / `lte` 筛，
   * 而"选了 8-31"在前端已经被换算成本地当天的 00:00 与 23:59:59.999
   * （见 `enterprise/console/src/pages/sessions/filters.ts`）。这里验接口一侧
   * 拿到那两个时间点之后的筛选含端点。
   */
  describe("标题模糊搜与日期范围", () => {
    const seedTitled = async (id: string, agoMs: number, title: string | null): Promise<void> => {
      await seed(id, agoMs, { messages: 1, owned: true });
      if (title !== null) await prisma.session.update({ where: { id }, data: { title } });
    };

    it("标题按包含匹配；没起名的会话一条都不命中", async () => {
      await clean();
      await seedTitled(`${PREFIX}-t1`, 50 * MIN, "保养预约门店选择");
      await seedTitled(`${PREFIX}-t2`, 40 * MIN, "广州四天行程规划");
      await seedTitled(`${PREFIX}-t3`, 30 * MIN, null);

      const hit = await repo.consoleSessionPage({ limit: 50, userId: TEST_USER, title: "保养" });
      assert.deepEqual(hit.sessions.map((x) => x.sessionId), [`${PREFIX}-t1`]);

      // 没起名的那条：任何标题搜都搜不到它（`contains` 判不到 NULL）。
      const none = await repo.consoleSessionPage({ limit: 50, userId: TEST_USER, title: "行程" });
      assert.deepEqual(none.sessions.map((x) => x.sessionId), [`${PREFIX}-t2`]);
    });

    it("标题搜不区分大小写（英文车型名用得上）", async () => {
      await clean();
      await seedTitled(`${PREFIX}-t4`, 20 * MIN, "Model Y 续航里程估算");
      const page = await repo.consoleSessionPage({ limit: 50, userId: TEST_USER, title: "model y" });
      assert.deepEqual(page.sessions.map((x) => x.sessionId), [`${PREFIX}-t4`]);
    });

    it("日期范围按创建时间筛，且含端点", async () => {
      await clean();
      await seedTitled(`${PREFIX}-d-old`, 3 * DAY, "三天前");
      await seedTitled(`${PREFIX}-d-mid`, 2 * DAY, "两天前");
      await seedTitled(`${PREFIX}-d-new`, 1 * DAY, "一天前");

      const mid = await prisma.session.findUniqueOrThrow({
        where: { id: `${PREFIX}-d-mid` },
        select: { createdAt: true },
      });
      // 起止都正好压在中间那条的创建时刻上：含端点时它必须被选中。
      const page = await repo.consoleSessionPage({
        limit: 50,
        userId: TEST_USER,
        since: mid.createdAt,
        until: mid.createdAt,
      });
      assert.deepEqual(page.sessions.map((x) => x.sessionId), [`${PREFIX}-d-mid`]);
    });

    it("只给起 / 只给止各自成立", async () => {
      await clean();
      await seedTitled(`${PREFIX}-d1`, 3 * DAY, "旧");
      await seedTitled(`${PREFIX}-d2`, 1 * DAY, "新");
      const cut = new Date(Date.now() - 2 * DAY);

      const after = await repo.consoleSessionPage({ limit: 50, userId: TEST_USER, since: cut });
      assert.deepEqual(after.sessions.map((x) => x.sessionId), [`${PREFIX}-d2`]);

      const before = await repo.consoleSessionPage({ limit: 50, userId: TEST_USER, until: cut });
      assert.deepEqual(before.sessions.map((x) => x.sessionId), [`${PREFIX}-d1`]);
    });

    it("标题 + 日期 + nonEmpty 叠加是与关系，不是任选其一", async () => {
      await clean();
      await seedTitled(`${PREFIX}-c1`, 1 * DAY, "保养预约");
      await seedTitled(`${PREFIX}-c2`, 3 * DAY, "保养提醒");
      await seed(`${PREFIX}-c3`, 1 * DAY, { owned: true }); // 空会话，且没标题
      const page = await repo.consoleSessionPage({
        limit: 50,
        userId: TEST_USER,
        title: "保养",
        since: new Date(Date.now() - 2 * DAY),
        nonEmpty: true,
      });
      assert.deepEqual(page.sessions.map((x) => x.sessionId), [`${PREFIX}-c1`]);
    });
  });

  /**
   * [F-30-08] 轨迹事件条数（`withTraceCounts`）。
   *
   * 演示大屏的选择器靠它判断会话是否有可回放内容，即回放控制条上
   * "事件 10/30" 里的 30。要验的两件事都在 SQL 一侧：
   * 只对这一页的 id 查，以及取不到时是 0 而不是缺席。
   */
  describe("轨迹事件条数（withTraceCounts）", () => {
    it("按会话统计，且只统计这条会话自己的", async () => {
      await clean();
      await seed(`${PREFIX}-e1`, 10 * MIN, { messages: 1, owned: true, traceEvents: 7 });
      await seed(`${PREFIX}-e2`, 20 * MIN, { messages: 1, owned: true, traceEvents: 3 });
      const page = await repo.consoleSessionPage({
        limit: 50,
        userId: TEST_USER,
        withTraceCounts: true,
      });
      const byId = new Map(page.sessions.map((x) => [x.sessionId, x.traceEvents]));
      assert.equal(byId.get(`${PREFIX}-e1`), 7);
      assert.equal(byId.get(`${PREFIX}-e2`), 3);
    });

    it("没有轨迹的记 0，不是缺席：展示层需区分「没有」与「没查」", async () => {
      await clean();
      await seed(`${PREFIX}-e3`, 10 * MIN, { messages: 1, owned: true });
      const page = await repo.consoleSessionPage({
        limit: 50,
        userId: TEST_USER,
        withTraceCounts: true,
      });
      assert.equal(page.sessions[0].traceEvents, 0);
    });

    it("不传就不加字段：「会话与对话」页不为此多跑一次 groupBy", async () => {
      await clean();
      await seed(`${PREFIX}-e4`, 10 * MIN, { messages: 1, owned: true, traceEvents: 5 });
      const page = await repo.consoleSessionPage({ limit: 50, userId: TEST_USER });
      assert.equal("traceEvents" in page.sessions[0], false);
    });

    it("翻页时只统计当页那几条，不把别页的算进来", async () => {
      await clean();
      await seed(`${PREFIX}-f1`, 10 * MIN, { messages: 1, owned: true, traceEvents: 4 });
      await seed(`${PREFIX}-f2`, 20 * MIN, { messages: 1, owned: true, traceEvents: 9 });
      const first = await repo.consoleSessionPage({
        limit: 1,
        userId: TEST_USER,
        withTraceCounts: true,
      });
      assert.equal(first.sessions.length, 1);
      assert.equal(first.sessions[0].sessionId, `${PREFIX}-f1`);
      assert.equal(first.sessions[0].traceEvents, 4);
      const next = await repo.consoleSessionPage({
        limit: 1,
        userId: TEST_USER,
        withTraceCounts: true,
        cursor: first.nextCursor ?? undefined,
      });
      assert.equal(next.sessions[0].sessionId, `${PREFIX}-f2`);
      assert.equal(next.sessions[0].traceEvents, 9);
    });
  });
}
