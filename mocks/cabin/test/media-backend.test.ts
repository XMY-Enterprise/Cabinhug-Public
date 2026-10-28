/**
 * mpg123 后端的协议解析：用一个假的 mpg123 复现真机上的时序。
 *
 * # 覆盖范围
 *
 * `media.test.ts` 跑的是静音后端，它不会汇报"这一曲播完了"，
 * 覆盖不到队列自动推进。本文件覆盖这条路径：
 *
 *   mpg123 自然播完会连发 `@P 3`（本曲结束）和 `@P 0`（停止）两条，
 *   二者是同一次结束。各算一次会导致一次播完连跳两首；两首的队列会绕回原点，
 *   表现为「第一首反复重放」。
 *
 * 两条可能落在不同的 stdout 分片里，中间隔一个事件循环回合，仅在同一分片内
 * 去重是不够的。因此假 mpg123 分两次 write 并跨 tick 发送。
 *
 * 真机是否出声不在本文件范围（见 §能力上报 与人工验证）。这里只验证：
 * 收到这串字节之后，队列走到哪一格。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

const fakeBinDir = mkdtempSync(join(tmpdir(), "mock-cabin-bin-"));
const fixtureDir = mkdtempSync(join(tmpdir(), "mock-cabin-media2-"));

/**
 * 假 mpg123：只实现遥控协议里实际依赖的几条。「一曲」压成 120ms。
 *
 * `MOCK_FAKE_END_LIMIT` 控制前几次 LOAD 会自然播完，之后的不结束。
 * 每一曲都循环播完时，「跳一格」和「跳两格」在 repeat=all 下会落到同一个游标，
 * 无法区分；限定结束次数，终态才唯一。
 */
const FAKE = `#!/usr/bin/env node
const LIMIT = Number(process.env.MOCK_FAKE_END_LIMIT ?? "99");
let ended = 0;
process.stdout.write("@R MPG123 (fake)\\n");
let timer = null;
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  const lines = buf.split("\\n");
  buf = lines.pop();
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("LOAD ")) {
      if (timer) clearTimeout(timer);
      process.stdout.write("@P 2\\n");
      process.stdout.write("@F 1 100 0.03 0.09\\n");
      if (ended >= LIMIT) continue;
      ended += 1;
      timer = setTimeout(() => {
        // 真机时序：先 @P 3，再单独一次 write 且跨一个 tick 发 @P 0。
        process.stdout.write("@P 3\\n");
        setImmediate(() => process.stdout.write("@P 0\\n"));
      }, 120);
    } else if (line === "STOP") {
      if (timer) clearTimeout(timer);
      process.stdout.write("@P 0\\n");
    } else if (line === "QUIT") {
      process.exit(0);
    }
  }
});
`;

process.env.MOCK_CABIN_AUDIO = "mpg123";
process.env.MOCK_CABIN_MEDIA_DIR = fixtureDir;
writeFileSync(join(fakeBinDir, "mpg123"), FAKE);
chmodSync(join(fakeBinDir, "mpg123"), 0o755);
// 探测与 spawn 都走 PATH，所以前置一个目录就能把真 mpg123 换掉。
process.env.PATH = `${fakeBinDir}:${process.env.PATH ?? ""}`;

const { createCabinServer, __resetAll, __resetPlayers } = await import("../src/index");

let server: Server;
let base = "";

before(async () => {
  writeFileSync(join(fixtureDir, "队列 - 第一首.mp3"), "");
  writeFileSync(join(fixtureDir, "队列 - 第二首.mp3"), "");
  server = createCabinServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

after(() => {
  server.close();
  __resetPlayers();
  __resetAll();
  rmSync(fakeBinDir, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
});

const post = async (path: string, body: unknown) => {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const view = async (id: string) =>
  (await (await fetch(`${base}/vehicles/${id}/media/player`)).json()) as Record<string, any>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询到期望状态，不用固定 sleep：`node --test` 多文件并行，
 * 每个文件还各自 spawn 子进程，固定等待在并行负载下会偶发不够，使用例变得不稳定。
 *
 * 正确态和错误态都是稳定终态（END_LIMIT 限定了结束次数），轮询可以收敛。
 */
async function waitUntil(
  probe: () => Promise<Record<string, any>>,
  ok: (v: Record<string, any>) => boolean,
  timeoutMs = 6_000,
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  let last = await probe();
  while (!ok(last) && Date.now() < deadline) {
    await sleep(25);
    last = await probe();
  }
  return last;
}

describe("mpg123 后端：一次播完只推进一格", () => {
  it("`@P 3` + 跨 tick 的 `@P 0` 只算一次结束（连跳两首的回归）", async () => {
    // 只让第一首自然播完，终态才唯一：跳一格停在 1，跳两格会绕回 0。
    process.env.MOCK_FAKE_END_LIMIT = "1";
    const id = (await post("/vehicles", { model: "Model Y" })).body.vehicleId as string;
    await post(`/vehicles/${id}/media/player`, { command: "select", query: "队列" });

    const start = await view(id);
    assert.equal(start.queue.length, 2);
    assert.equal(start.cursor, 0);
    assert.equal(start.backend.name, "mpg123");

    // 只有第一首会自然播完，所以正确态（停在 1）与 bug 态（绕回 0）都是稳定终态。
    const after1 = await waitUntil(() => view(id), (v) => v.cursor === 1);
    assert.equal(
      after1.cursor,
      1,
      "播完一首应当停在第 2 首；跳回 0 说明 @P 3 与 @P 0 被当成了两次结束",
    );
    // 再确认它停住了：错误态里 cursor 会瞬间掠过 1 再回到 0，单次读取可能恰好读到 1。
    await sleep(300);
    assert.equal((await view(id)).cursor, 1, "停在第 2 首之后不该再动——第 2 首不会自然播完");
    // 按队列里的第 2 首比，不写死曲名：曲库按中文拼音排序
    // （"第二首" 的 èr 排在 "第一首" 的 yī 前面）。
    assert.equal(after1.nowPlaying.title, start.queue[1].title);
  });

  it("repeat=off 时放完最后一首就停，不回卷", async () => {
    process.env.MOCK_FAKE_END_LIMIT = "2";
    const id = (await post("/vehicles", { model: "Model Y" })).body.vehicleId as string;
    await post(`/vehicles/${id}/media/player`, { command: "mode", repeat: "off" });
    await post(`/vehicles/${id}/media/player`, { command: "select", query: "队列" });
    const v = await waitUntil(() => view(id), (x) => x.status === "stopped");
    assert.equal(v.status, "stopped");
    // 停止后媒体源关回 off，UI 不再显示在放。
    assert.equal(v.source, "off");
  });

  it("主动 stop 的 `@P 0` 不算播完，不会顺势跳下一首", async () => {
    process.env.MOCK_FAKE_END_LIMIT = "0"; // 不自然结束，停止只可能来自 stop
    const id = (await post("/vehicles", { model: "Model Y" })).body.vehicleId as string;
    await post(`/vehicles/${id}/media/player`, { command: "select", query: "队列" });
    await post(`/vehicles/${id}/media/player`, { command: "stop" });
    await sleep(300);
    const v = await view(id);
    assert.equal(v.status, "stopped");
    assert.equal(v.cursor, 0, "stop 不该顺手推进游标");
  });

  it("有 mpg123 时能力表报「暂停可续播 + 音量实时」", async () => {
    const r = await (await fetch(`${base}/health`)).json();
    assert.equal(r.audio.backend, "mpg123");
    assert.equal(r.audio.canPauseResume, true);
    assert.equal(r.audio.canSetVolumeLive, true);
  });
});
