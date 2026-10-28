/**
 * 跨重启上下文冒烟（FL-14 AC-14-3）。
 *
 * 证明 ①Working 的上下文跨进程重启保留：
 * 跑一轮 → 重启 agent-runtime → 追问 → 上下文仍衔接。
 *
 * 用 fake 模型跑：这条断言要验的是检查点存储，不是模型能力，
 * 掺进真模型会让失败原因不唯一。
 *
 * 运行（根目录，需 PG）：
 *   corepack pnpm -w run smoke:restart
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { assertPortsFree, waitPortFree, waitPortBusy } from "./lib/ports";
import { ensureDevCredentials, login } from "./lib/login";
import { resolveTestDatabaseUrl } from "@cabinhug/db";
import type { EventEnvelope } from "@cabinhug/shared";

// 端口在一处定义，ENV 与探测都引它：两处各写一份的话，改了端口而探测还盯着旧的，
// 收尾自证会永远通过。
//
// 这组端口必须与 e2e-dualpath / e2e-upload 的 18797/18798 错开：本脚本的核心动作是
// 杀进程再重启，而 CI 里它紧跟在 e2e:dualpath 后面跑。共用端口时前一条 e2e 的 gateway
// 还没退干净，这边就 EADDRINUSE，报成本脚本收尾失败，根因却在上一条命令。
const GATEWAY_PORT = 18807;
const RUNTIME_PORT = 18808;
const GATEWAY = `http://localhost:${GATEWAY_PORT}`;
// 跑前登录换 token（见 lib/login.ts）。
let TOKEN = "";

function loadDotEnv(): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(
      new URL("../../../../.env", import.meta.url),
      "utf8",
    ).split("\n")) {
      const m = /^([A-Z0-9_]+)="?([^"]*)"?$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

const ENV = {
  // JWT 签名密钥显式给（公开的默认密钥等于没有鉴权）。
  CABINHUG_JWT_SECRET: "e2e-jwt-secret-0123456789abcdef",
  ...process.env,
  ...loadDotEnv(),
  CABINHUG_LLM: "fake", // 验的是检查点，不是模型
  ASR_ENGINE: "fake",
  CABINHUG_CHECKPOINTER: "pg",
  DATABASE_URL: resolveTestDatabaseUrl(),
  GATEWAY_PORT: String(GATEWAY_PORT),
  AGENT_RUNTIME_PORT: String(RUNTIME_PORT),
  AGENT_RUNTIME_URL: `http://localhost:${RUNTIME_PORT}`,
};

const authed = (init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
});

let lastEventId: string | null = null;
const checks: Array<[boolean, string]> = [];
const check = (ok: boolean, label: string) => {
  checks.push([ok, label]);
  console.log(`${ok ? "✓" : "✗"} ${label}`);
};

async function turn(sessionId: string, content: string): Promise<string> {
  const controller = new AbortController();
  const url = new URL(`${GATEWAY}/v1/session/${sessionId}/stream`);
  if (lastEventId) url.searchParams.set("lastEventId", lastEventId);
  const streamRes = await fetch(url, authed({ signal: controller.signal }));

  let text = "";
  const collector = (async () => {
    let buffer = "";
    for await (const chunk of streamRes.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += Buffer.from(chunk).toString("utf8");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        const env = JSON.parse(dataLine.slice(6)) as EventEnvelope;
        lastEventId = env.eventId;
        const ev = env.event;
        if (ev.type === "update" && ev.kind === "delta") text += ev.text;
        if (ev.type === "update" && ev.kind === "turn_end") {
          controller.abort();
          return text;
        }
      }
    }
    return text;
  })().catch((e: Error) => {
    if (e.name === "AbortError") return text;
    throw e;
  });

  await fetch(
    `${GATEWAY}/v1/session/${sessionId}/messages`,
    authed({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    }),
  );
  return collector;
}

/**
 * `detached: true` 不是为了后台运行，是为了能杀干净。
 *
 * `npx tsx src/index.ts` 起的是三层（npx 壳 → tsx → 真正 listen 的 node）。
 * `child.kill()` 只打到最外层那个 npx，最里层被 launchd 收养后继续占着端口
 * （与 内部开发指引 里「监护层已死、端口照常应答」同一形态）。
 *
 * detached 让子进程自成进程组，`process.kill(-pid)` 才能杀掉整组。
 */
function spawnRuntime(): ChildProcess {
  return spawn("npx", ["tsx", "src/index.ts"], {
    cwd: new URL("../../agent-runtime/", import.meta.url).pathname,
    env: ENV,
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
}

/** 杀掉整个进程组。子进程已退出时 `-pid` 会抛 ESRCH，吞掉即可。 */
function killTree(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // 组已经没了；再对单个 pid 补一刀，两者都失败就是真的已经退了
    try {
      child.kill(signal);
    } catch {
      /* 已退出 */
    }
  }
}

async function waitHealthy(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (await fetch(`${GATEWAY}/healthz`).catch(() => null)) return;
    await sleep(500);
  }
  throw new Error("gateway 未就绪");
}

async function main(): Promise<void> {
  // spawn 之前先探端口。本脚本另有 waitPortFree，那是"重启后等它退干净"，
  // 与"开跑前确认没人占"是两件事：前者管自己造的进程，后者管别人留下的。
  await assertPortsFree([
    [GATEWAY_PORT, "gateway"],
    [RUNTIME_PORT, "agent-runtime"],
  ]);

  let runtime = spawnRuntime();
  // 与 runtime 同样 detached：gateway 也是三层，一样杀不干净（见 spawnRuntime）
  const gateway = spawn("npx", ["tsx", "src/index.ts"], {
    cwd: new URL("../", import.meta.url).pathname,
    env: ENV,
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });

  try {
    await waitHealthy();
    await sleep(1500);

    // 先把测试库的开发账号解锁，再登录换 token。
    await ensureDevCredentials(ENV.DATABASE_URL);
    TOKEN = (await login(GATEWAY)).accessToken;

    const { sessionId } = (await (
      await fetch(`${GATEWAY}/v1/session`, authed({ method: "POST" }))
    ).json()) as { sessionId: string };

    const r1 = await turn(sessionId, "我明天要开电动车从深圳去黄山。");
    check(r1.length > 0, "第一轮有回复");

    /*
     * ── 重启 agent-runtime（gateway 不动，模拟只有编排进程重启的场景）
     *
     * 重启必须可证伪：记下旧 pid → 杀整组 → 等端口真的空出来 →
     * 重起 → 等端口重新被听起来 → 断言 pid 变了。任一步不成立就抛，不靠 sleep。
     * 只 kill npx 壳时真正 listen 的 node 仍活着，新进程撞 EADDRINUSE 退出，
     * 后面"重启后仍能…"的断言就没有经历过重启（ADR-002）。
     */
    const oldPid = runtime.pid;
    killTree(runtime);
    await waitPortFree(RUNTIME_PORT, "重启前 agent-runtime 未退出");
    runtime = spawnRuntime();
    await waitPortBusy(RUNTIME_PORT, "重启后 agent-runtime 未起来");
    await sleep(1500); // 端口起来到图装配完还有一小段
    check(
      runtime.pid !== undefined && runtime.pid !== oldPid,
      `**agent-runtime 真的换了进程**（${oldPid} → ${runtime.pid}）——` +
        `旧实现里这一条是 check(true)，永远为真`,
    );

    // ── 轨迹落库：回放页读的是历史会话，
    //    进程重启后还能读到，才说明"回放不是重跑"这条铁律有数据支撑。
    const replay = (await (
      await fetch(`${GATEWAY}/console/replay/${sessionId}`, {
        headers: { authorization: "Bearer admin-token" },
      })
    ).json()) as {
      timeline?: Array<{ kind: string; data?: Record<string, unknown> }>;
      answers?: { toolCalls?: { total: number } };
    };
    check(
      (replay.timeline?.length ?? 0) > 0,
      "**重启后仍能回放第一轮的轨迹**——轨迹落库了，不在内存里（M9-01）",
    );

    // ── 分跳耗时（F-44-04）。重点是按真会话 id 查得到：
    //    深处的 span（LLM、工具、ACP）手上只有 threadId（`sess-x#<ts>`），
    //    换算错就会落到另一个会话键下，回放页一条都读不到，
    //    而页面上"没有耗时"与"这次真的没有那些跳"无法区分。
    const spans = (replay.timeline ?? []).filter((e) => e.kind === "span");
    const spanNames = spans.map((e) => String(e.data?.name ?? ""));
    check(
      spans.length > 0,
      "**分跳耗时按真会话 id 查得到**（TD-08 任务 1 的回归）",
    );
    check(
      spanNames.some((n) => n.startsWith("node.")),
      "图节点耗时在（经 configurable.onTrace 出来的那条）",
    );
    check(
      spanNames.some((n) => n.startsWith("llm.") && !n.endsWith(".ttft")),
      "LLM 调用耗时在（经模块级 sink 出来的那条——与上一条**必须同一个会话键**）",
    );
    check(
      spanNames.some((n) => n.endsWith(".ttft")),
      "**首 token 延迟单列**——它才是用户等的那个数（AC-08-4）",
    );
    // 前置 `spans.length > 0`：否则 0 条 span 会让这条空过，
    // 而"每一条都没问题"与"一条都没有"必须区分。
    check(
      spans.length > 0 && !spans.some((e) => e.data?.keyFallback === true),
      "没有 keyFallback：每一条 span 都换算到了真会话，没有落在孤儿键下",
    );

    const r2 = await turn(sessionId, "我刚才说要去哪里？");
    console.log(`\n[重启后] ${r2}\n`);
    // Fake 模型的回复固定引用「首轮输入」——它出现即证明图状态被从 PG 读回来了。
    check(
      r2.includes("黄山"),
      "**跨重启上下文未丢**：重启后仍能引用第一轮内容（①Working 落 PG，AC-14-3）",
    );
  } finally {
    killTree(runtime);
    killTree(gateway);
    /*
     * 收尾自证：两个端口都得真的空出来，否则下一次跑必然撞 EADDRINUSE。
     * 宁可让本次红，也不静默留下孤儿进程影响下一次。
     */
    for (const [port, name] of [
      [GATEWAY_PORT, "gateway"],
      [RUNTIME_PORT, "agent-runtime"],
    ] as const) {
      try {
        await waitPortFree(port, `收尾：${name} 未退出`, 20);
      } catch (e) {
        // 先补 SIGKILL 再判死：SIGTERM 收不掉的偶尔能被 KILL 收掉
        killTree(name === "gateway" ? gateway : runtime, "SIGKILL");
        try {
          await waitPortFree(port, `收尾：${name} 连 SIGKILL 都没收掉`, 12);
        } catch (e2) {
          check(false, String(e2));
        }
      }
    }
  }

  const failed = checks.filter(([ok]) => !ok).length;
  console.log(
    `\n跨重启冒烟：${checks.length - failed} passed, ${failed} failed`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

void main();
