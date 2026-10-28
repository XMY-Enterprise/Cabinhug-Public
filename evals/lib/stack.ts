/**
 * 评测隔离栈（ACR-014：scenarios / risk 两个 runner 的共用部分）。
 *
 * 栈 = agent-runtime(18798) + gateway(18797) 两个子进程，不碰共享 dev 栈（8790/8791）。
 * 各 runner 的 ENV 组合刻意不同（scenarios 的 fake 档走 CABINHUG_TOOLS=mock，
 * risk 的 fake 档走真工具连本地 mock 服务，理由见各自 run.ts），所以本文件
 * 只收无分歧的部分：端口、基础 env、起停、健康等待、端口占用自检。
 *
 * # 两条规则
 *
 * 1. 起栈前必须 `assertPortsFree`：残留进程会照常应答，评测连上它测到的是上一次的档位，
 *    而报告里「档位由 runtime 自报」那行会给出错误的结论。
 * 2. 子进程自成进程组，按组收割：`npx tsx src/index.ts`
 *    是三层（npx 壳 → tsx → 真正 listen 的 node）。只 kill 顶层时最里层被 launchd
 *    收养继续占端口，下一轮 `--real` 的 runtime 可能自报 `LLM=fake`。
 *    detached + `kill(-pid)` 杀整棵。
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { bridgeLegacyEnv } from "../../enterprise/backend/shared/db/src/config/legacy-env";

// 旧名环境变量（ACR-051）：`source .env` 后只有旧名时先搬到新名，保证这里读到的密钥
// 与被拉起的服务（它们自己也桥接）是同一把。
bridgeLegacyEnv(process.env);

export const GATEWAY_PORT = 18797;
export const RUNTIME_PORT = 18798;
export const GATEWAY = `http://localhost:${GATEWAY_PORT}`;
export const RUNTIME = `http://localhost:${RUNTIME_PORT}`;

const ROOT = new URL("../..", import.meta.url).pathname;

/** 两个 runner 共同的基础 env；差异部分由调用方经 `overrides` 注入。 */
export function stackEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // 未 source .env 时的兜底（与 e2e 同一份 dev 库缺省）
    DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://carlife:carlife@localhost:55433/carlife",
    GATEWAY_PORT: String(GATEWAY_PORT),
    AGENT_RUNTIME_PORT: String(RUNTIME_PORT),
    AGENT_RUNTIME_URL: RUNTIME,
    CABINHUG_CONFIG_MASTER_KEY: process.env.CABINHUG_CONFIG_MASTER_KEY ?? "eval-master-key-0123456789abcdef",
    ASR_ENGINE: "fake",
    ...overrides,
  };
}

/** 起栈前确认 18797/18798 没人占；被占时拒跑，不出来源不明的数字。 */
export async function assertPortsFree(): Promise<void> {
  for (const [url, name] of [
    [`${GATEWAY}/healthz`, `网关 ${GATEWAY_PORT}`],
    [`${RUNTIME}/internal/health/runtime`, `runtime ${RUNTIME_PORT}`],
  ] as const) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (r.ok || r.status < 500) {
        throw new Error(
          `${name} 端口上已经有人在应答——隔离栈起不来，评测会连上那个残留进程并给出错误档位的数字。\n` +
            `先清掉：lsof -nP -ti :${GATEWAY_PORT} -ti :${RUNTIME_PORT} | xargs kill -9`,
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("端口上已经有人在应答")) throw e;
      /* 连不上 = 端口空闲 */
    }
  }
}

/** 起 runtime + gateway 两个子进程（detached 成组）；返回句柄交给 `killStack`。 */
export function bootStack(env: NodeJS.ProcessEnv, verbose: boolean): ChildProcess[] {
  const procs: ChildProcess[] = [];
  for (const cwd of ["enterprise/backend/agent-runtime/", "enterprise/backend/gateway/"]) {
    procs.push(
      spawn("npx", ["tsx", "src/index.ts"], {
        cwd: `${ROOT}${cwd}`,
        env,
        stdio: ["ignore", verbose ? "inherit" : "ignore", verbose ? "inherit" : "ignore"],
        detached: true,
      }),
    );
  }
  return procs;
}

/** 按进程组收割（见文件头第 2 条）。 */
export function killStack(procs: ChildProcess[], signal: NodeJS.Signals = "SIGTERM"): void {
  for (const p of procs) {
    if (p.pid === undefined) continue;
    try {
      process.kill(-p.pid, signal);
    } catch {
      /* 已经没了 */
    }
  }
}

export async function waitHealthy(url: string, name: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* 还没起 */
    }
    await sleep(500);
  }
  throw new Error(`${name} ${timeoutMs}ms 内未就绪`);
}

/**
 * 强制清扫两个端口上的监听进程（重启路径专用）：detached 组杀偶有漏网，残留会污染下一次 boot。
 *
 * 必须限定 `-sTCP:LISTEN`：`lsof -ti :18797` 会列出所有与该端口相关的进程，
 * 包括建立了连接的客户端，也就是 runner 自己；不限定时 runner 会把自己 kill -9，
 * 无声退出、不留退出码。
 */
export function sweepPorts(): void {
  for (const port of [GATEWAY_PORT, RUNTIME_PORT]) {
    try {
      execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t | xargs -r kill -9`, { stdio: "ignore" });
    } catch {
      /* 没有残留 */
    }
  }
}

/** 等两个端口都归于沉默（kill 后的收尸确认）。 */
export async function waitPortsFree(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let busy = false;
    for (const url of [`${GATEWAY}/healthz`, `${RUNTIME}/internal/health/runtime`]) {
      try {
        await fetch(url, { signal: AbortSignal.timeout(800) });
        busy = true;
      } catch {
        /* 拒连 = 空闲 */
      }
    }
    if (!busy) return;
    await sleep(400);
  }
  throw new Error("kill 后端口 10s 未释放——残留进程会毒化下一次 boot，宁可中止");
}
