/**
 * 车主自己的会话列表（`userSessionPage`，车机左栏 / 手机抽屉的数据源）。连真实 PG。
 *
 * 要验的是：没有任何消息的会话不进这个列表，且过滤发生在数据库里。
 *
 * 打开对话层就会建一条会话，没说话就退出的会话也留在库里；车机端与移动端不展示空白对话。
 * 过滤不能放在应用层，否则一页的条数会少于 limit、游标随之不准；假仓储验不出这一点，
 * 所以这组必须连真库。
 *
 * 两个视角的口径不同：运营的 `consoleSessionPage` 缺省仍然看得见空会话
 * （"建了但没说话"本身是要观察的现象），过滤需显式开 `nonEmpty`。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { PrismaClient } from "@prisma/client";

import { createChatRepository } from "../src/repositories/chat";
import { seedTestUsers } from "./helpers/seed-users";

const DATABASE_URL = process.env.DATABASE_URL;
const PREFIX = "test-user-sessions";
/** 独占一个账号：dev 库里有大量其他会话，隔离后断言不受其影响。 */
const TEST_USER = "test-user-sessions-user";
const MIN = 60_000;

if (!DATABASE_URL) {
  describe("车主自己的会话列表", () => {
    it("跳过：未设置 DATABASE_URL（这组测试必须连真库）", () => assert.ok(true));
  });
} else {
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  const repo = createChatRepository(prisma);
  const clean = async (): Promise<void> => {
    await prisma.message.deleteMany({ where: { sessionId: { startsWith: PREFIX } } });
    await prisma.session.deleteMany({ where: { id: { startsWith: PREFIX } } });
    await prisma.user.deleteMany({ where: { id: TEST_USER } });
  };

  const seed = async (id: string, agoMs: number, messages = 0): Promise<void> => {
    await seedTestUsers(prisma, [TEST_USER]);
    await prisma.session.create({ data: { id, userId: TEST_USER } });
    for (let i = 0; i < messages; i += 1) {
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
    const at = new Date(Date.now() - agoMs);
    await prisma.$executeRaw`
      UPDATE sessions SET created_at = ${at}, updated_at = ${at} WHERE id = ${id}`;
  };

  /** 三条空的夹在两条有对话的中间，确保"跳过空的"不依赖顺序。 */
  const seedFor = async (): Promise<void> => {
    await clean();
    await seed(`${PREFIX}-a`, 50 * MIN, 1);
    await seed(`${PREFIX}-b`, 40 * MIN);
    await seed(`${PREFIX}-c`, 30 * MIN);
    await seed(`${PREFIX}-d`, 20 * MIN);
    await seed(`${PREFIX}-e`, 10 * MIN, 2);
  };

  before(clean);
  after(async () => {
    await clean();
    await prisma.$disconnect();
  });

  describe("车主自己的会话列表", () => {
    it("空白会话（一条消息都没有）不出现在列表里", async () => {
      await seedFor();
      const page = await repo.userSessionPage({ userId: TEST_USER, limit: 50 });
      assert.deepEqual(
        page.sessions.map((s) => s.sessionId),
        [`${PREFIX}-e`, `${PREFIX}-a`],
        "只该剩下说过话的那两条，且按活跃时间倒序",
      );
      assert.ok(page.sessions.every((s) => s.messageCount > 0));
    });

    it("过滤在数据库侧：每页条数满额，不是取 N 条再筛", async () => {
      await seedFor();
      const first = await repo.userSessionPage({ userId: TEST_USER, limit: 1 });
      assert.equal(first.sessions.length, 1, "取一条就得给满一条，不能被空会话占掉名额");
      assert.equal(first.sessions[0].sessionId, `${PREFIX}-e`);
      assert.equal(first.hasMore, true);
      assert.ok(first.nextCursor, "有下一页就必须给游标");
      const second = await repo.userSessionPage({
        userId: TEST_USER,
        limit: 1,
        cursor: first.nextCursor!,
      });
      assert.equal(second.sessions[0]?.sessionId, `${PREFIX}-a`, "翻页不许跳过或重复");
      assert.equal(second.hasMore, false);
    });

    it("运营视角：`consoleSessionPage` 缺省看得见那三条空的", async () => {
      await seedFor();
      const page = await repo.consoleSessionPage({ limit: 50, userId: TEST_USER });
      assert.equal(page.sessions.length, 5, "两个视角的口径是刻意不同的，别顺手把这边也过滤了");
    });
  });
}
