/**
 * 演示前检查单（FL-43 F-43-11）。
 *
 * 回答 `dev:status` 回答不了的问题：现在能不能开始演示。
 *
 * # 只读，不代跑修复
 *
 * 每一项只检查、只给修复命令，不自己动手。代跑会让它成为第二个 `dev:bootstrap`，
 * 两者随之漂移；演示前需要知道的是"哪里不对"。
 *
 * # 覆盖的失效模式
 *
 * 均来自内部开发指引 的「已知坑」：
 *
 * | 事故 | 现场表现 | 本脚本怎么抓 |
 * |---|---|---|
 * | `mock-dealer` 没起 | 助手回复「门店系统没连上」，与产品故障无法区分 | 单独一项探它的 `/health` |
 * | 只起了 `cockpit` 没起 `cockpit-app` | 端口有应答、状态表显示"正常"，屏幕上没有界面 | 两个目标分别检查，缺一即 ✗ |
 * | 监护层已死 | 端口照常应答，改代码却再也不生效 | 复用 `dev.sh status` 的判定（它按 cwd 认进程，`pgrep` 找不到最里层那个） |
 * | `.env` 没 source / 缺 master key | 服务起不来，或起来了但配置层是空的 | 直接读 `.env` 查必填键 |
 *
 * # 与 `dev:bootstrap` / `dev:status` 的分工
 *
 * `dev:bootstrap` 是"把它弄好"，`dev:status` 是"进程在不在"，本脚本是"能不能演示"——
 * 后者要看的东西前两者都不看：种子数据在不在、当前是哪一档（fake 还是真实 LLM）、
 * 迁移落没落全。
 *
 * 用法：
 *   corepack pnpm demo:verify
 *   corepack pnpm demo:verify -- --json   # 机器可读
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { bridgeLegacyEnv } from "../../../enterprise/backend/shared/db/src/config/legacy-env";


const ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** 一句修复提示：给命令，不给"请检查配置"。 */
  fix?: string;
  /** 只报事实、不参与判定（如"当前是 fake 档"）。 */
  info?: boolean;
}

export interface DevStatusRow {
  target: string;
  port: string;
  pid: string;
  state: string;
}

export interface ComposeRow {
  service: string;
  state: string;
  health: string;
}

/** 全部外部观察都从这里进来——单测把它换成桩，就能不起任何服务地验判定。 */
export interface Probes {
  envFile(): Record<string, string> | undefined;
  composePs(): ComposeRow[] | undefined;
  devStatus(): DevStatusRow[] | undefined;
  http(url: string): Promise<{ status: number; body: string } | undefined>;
  migrationsApplied(): Promise<number | undefined>;
  migrationsOnDisk(): number;
  /** 新 clone 上 Prisma 客户端不会自动生成；先查它，否则后面碰库的项都会报"连不上库"。 */
  prismaClientGenerated(): boolean;
  seedStatus(): Promise<Array<{ name: string; ok: boolean; detail: string }> | undefined>;
}

/** 演示必须在跑的宿主服务。`cockpit` 与 `cockpit-app` 两个都要，单起前者是白屏。 */
export const REQUIRED_TARGETS = [
  "gateway",
  "runtime",
  "mock-dealer",
  "mock-cabin",
  "mock-repair",
  "web",
  "cockpit",
  "cockpit-app",
] as const;

/** compose 里演示要用到的三个（`local-asr` 只在 `ASR_ENGINE=mock` 时才要，不强制）。 */
export const REQUIRED_CONTAINERS = ["postgres", "redis", "minio"] as const;

export async function runChecks(p: Probes): Promise<CheckResult[]> {
  const out: CheckResult[] = [];

  // ── ① .env 与必填键 ────────────────────────────────────
  const env = p.envFile();
  if (!env) {
    out.push({
      name: ".env 存在",
      ok: false,
      detail: "仓库根没有 .env",
      fix: "cp .env.example .env，再按 DEMO.md 填两个必填键",
    });
  } else {
    out.push({ name: ".env 存在", ok: true, detail: "已读到" });
    const db = env.DATABASE_URL ?? "";
    out.push({
      name: "DATABASE_URL",
      ok: db.startsWith("postgresql://"),
      detail: db ? "已配置" : "缺失",
      fix: "DATABASE_URL=postgresql://carlife:carlife@localhost:55433/carlife",
    });
    /*
     * 两把钥匙分开管理（轮换周期与泄露影响面不同）。
     * 两者缺失或过短都会让 gateway 与 runtime 起不来，表现为 `dev:bootstrap`
     * 卡在 readiness、`/healthz` 无响应，离原因很远。
     */
    for (const [key, hint] of [
      ["CABINHUG_CONFIG_MASTER_KEY", "openssl rand -hex 16 生成后写进 .env（只加密本地配置，不是产品密钥）"],
      ["CABINHUG_PII_MASTER_KEY", "openssl rand -hex 32 生成后写进 .env（加密成员联系人等个人信息，与上一把独立）"],
    ] as const) {
      const value = env[key] ?? "";
      out.push({
        name: key,
        // 长度是硬要求：不足 16 字符服务直接起不来。
        ok: value.length >= 16,
        detail: value ? `${value.length} 字符` : "缺失",
        fix: hint,
      });
    }
  }

  // ── ② 容器 ────────────────────────────────────────────
  const ps = p.composePs();
  if (!ps) {
    out.push({
      name: "Docker 容器",
      ok: false,
      detail: "拿不到 compose 状态（Docker 没起？）",
      fix: "开 Docker Desktop 后 corepack pnpm dev:infra-up",
    });
  } else {
    for (const svc of REQUIRED_CONTAINERS) {
      const row = ps.find((r) => r.service === svc);
      const healthy = row?.state === "running" && (row.health === "healthy" || row.health === "");
      out.push({
        name: `容器 ${svc}`,
        ok: healthy,
        detail: row ? `${row.state}${row.health ? `/${row.health}` : ""}` : "未运行",
        fix: "corepack pnpm dev:infra-up",
      });
    }
  }

  // ── ③ 迁移 ────────────────────────────────────────────
  const prismaReady = p.prismaClientGenerated();
  out.push({
    name: "Prisma 客户端已生成",
    ok: prismaReady,
    detail: prismaReady ? "node_modules/.prisma/client 在" : "没生成——新 clone 上它不会自动生成",
    // 这一条不在 dev:bootstrap 里（它只 migrate deploy），所以新 clone 必须显式跑一次。
    fix: "corepack pnpm --filter @cabinhug/db db:generate",
  });
  const applied = prismaReady ? await p.migrationsApplied() : undefined;
  const onDisk = p.migrationsOnDisk();
  out.push({
    name: "数据库迁移",
    ok: applied !== undefined && applied >= onDisk,
    detail: applied === undefined ? (prismaReady ? "连不上库" : "跳过（Prisma 客户端未生成）") : `已落 ${applied} / 目录里 ${onDisk}`,
    fix: "corepack pnpm dev:bootstrap（它会 migrate deploy 并复查）",
  });

  // ── ④ 宿主进程（复用 dev.sh 的判定）─────────────────────
  const rows = p.devStatus();
  if (!rows) {
    out.push({ name: "宿主服务", ok: false, detail: "拿不到 dev:status 输出", fix: "corepack pnpm dev:status 手动看一眼" });
  } else {
    for (const target of REQUIRED_TARGETS) {
      const row = rows.find((r) => r.target === target);
      const state = row?.state ?? "未运行";
      // 「监护层已死」时端口照常应答、改代码不生效，算 ✗。
      const dead = state.includes("监护层已死");
      const running = row !== undefined && state !== "未运行" && !state.startsWith("❌") && !dead;
      out.push({
        name: `服务 ${target}`,
        ok: running,
        detail: state,
        fix: dead ? `corepack pnpm dev:restart ${target}（监护层死了，重启才会重新生效）` : `corepack pnpm dev:restart ${target}`,
      });
    }
  }

  // ── ⑤ 端口真的应答（进程在 ≠ 服务可用）──────────────────
  /*
   * 后端端口从 `.env` 读，不写死。
   *
   * `.env.example` 里 `GATEWAY_PORT` / `AGENT_RUNTIME_PORT` / `MOCK_DEALER_PORT`
   * 都可改；写死端口会在改过端口的机器上探到别的服务，结果不可信。
   *
   * 前端三个（cockpit 1430 / mobile 1420 / web 5173）写死：它们在各自的
   * `vite.config.ts` 里且 `strictPort: true`，环境变量改不动。改端口要改 vite 配置，
   * 届时这里同步改。
   */
  const port = (key: string, fallback: number): number => Number(env?.[key] ?? process.env[key] ?? fallback) || fallback;
  const gatewayPort = port("GATEWAY_PORT", 8790);
  const runtimePort = port("AGENT_RUNTIME_PORT", 8791);
  const dealerPort = port("MOCK_DEALER_PORT", 8792);
  const runtimeHealthUrl = `http://localhost:${runtimePort}/internal/health/runtime`;
  for (const [name, url, fix] of [
    [`网关 /healthz :${gatewayPort}`, `http://localhost:${gatewayPort}/healthz`, "corepack pnpm dev:restart gateway"],
    [`runtime 健康 :${runtimePort}`, runtimeHealthUrl, "corepack pnpm dev:restart runtime"],
    [`门店系统 /health :${dealerPort}`, `http://localhost:${dealerPort}/health`, "corepack pnpm dev:restart mock-dealer（它不起时助手会说「门店系统没连上」，看着像产品故障）"],
    ["车机 vite :1430", "http://localhost:1430/", "corepack pnpm dev:restart cockpit（vite 没起，客户端窗口就是白屏）"],
    ["运营台 :5173", "http://localhost:5173/", "corepack pnpm dev:restart web"],
  ] as const) {
    const r = await p.http(url);
    out.push({ name, ok: r !== undefined && r.status < 400, detail: r ? `HTTP ${r.status}` : "无响应", fix });
  }

  // ── ⑥ 演示数据 ────────────────────────────────────────
  const seed = await p.seedStatus();
  if (!seed) {
    out.push({ name: "演示数据", ok: false, detail: "查不到（库连不上？）", fix: "corepack pnpm demo:seed" });
  } else {
    for (const s of seed) {
      out.push({ name: `演示数据 ${s.name}`, ok: s.ok, detail: s.detail, fix: "corepack pnpm demo:seed（幂等，可重复跑）" });
    }
  }

  /*
   * ── ⑥.5 档位配置自洽吗 ────────────────────────────────
   *
   * 既没有真实 LLM 密钥、又没开离线档时，对话一直挂着不出字且没有报错
   * （SSE 里有 tool_call、有 branch，没有 delta 和 turn_end）。
   * `.env.example` 里 `CABINHUG_LLM=fake` 缺省是注释掉的。这一项判 ✗。
   */
  if (env) {
    const llmMode = (env.CABINHUG_LLM ?? "").trim();
    const deepseek = (env.DEEPSEEK_API_KEY ?? "").trim();
    const usable = llmMode === "fake" || deepseek.length > 0;
    out.push({
      name: "LLM 档位配置",
      ok: usable,
      detail: usable ? (llmMode === "fake" ? "离线档（CABINHUG_LLM=fake）" : "真实档（有 DEEPSEEK_API_KEY）") : "既没有 DEEPSEEK_API_KEY，也没开 CABINHUG_LLM=fake",
      fix: "离线演示：在 .env 里加一行 CABINHUG_LLM=fake（.env.example 里它是注释掉的）；真实档：填 DEEPSEEK_API_KEY",
    });
  }

  // ── ⑦ 当前是哪一档（只报事实，不判对错）──────────────────
  const health = await p.http(runtimeHealthUrl);
  if (health) {
    try {
      const h = (JSON.parse(health.body) as { health?: { llm?: string; guardrails?: { moderation?: boolean } } }).health;
      out.push({
        name: "当前档位",
        ok: true,
        info: true,
        // runtime 的 `llm` 只看 CABINHUG_LLM 这一个开关：没配密钥、也没标 fake 时
        // 它照样报 real，而实际行为不是。所以这里补一句以 .env 为准的说明。
        detail:
          `runtime 自报 LLM=${h?.llm ?? "?"}；内容审核层=${h?.guardrails?.moderation ? "已接入" : "未接入"}` +
          (env && (env.CABINHUG_LLM ?? "").trim() !== "fake" && !(env.DEEPSEEK_API_KEY ?? "").trim()
            ? "（⚠️ 但 .env 里既无密钥也未开 fake——自报的 real 不作数）"
            : ""),
      });
    } catch {
      /* 拿不到就不报这一项——它是信息，不是判定 */
    }
  }

  return out;
}

export function render(results: CheckResult[]): string {
  const out: string[] = ["演示前检查单（只读；不代跑任何修复）", ""];
  for (const r of results) {
    const mark = r.info ? "ℹ" : r.ok ? "✓" : "✗";
    out.push(`  ${mark} ${r.name.padEnd(26)} ${r.detail}`);
    if (!r.ok && !r.info && r.fix) out.push(`      ↳ ${r.fix}`);
  }
  const bad = results.filter((r) => !r.ok && !r.info);
  out.push("");
  out.push(bad.length === 0 ? "全部通过——可以开始演示。" : `${bad.length} 项未通过——**先修完再演示**，上面每项都给了命令。`);
  return out.join("\n");
}

// ── 真实探测 ──────────────────────────────────────────────

/**
 * 生成后的 Prisma 客户端可能落在两处，两处都要看。
 *
 * npm/yarn 的经典布局是 `node_modules/.prisma/client`；pnpm 下它落在
 * `node_modules/.pnpm/@prisma+client@<版本>/node_modules/.prisma/client`。
 * 只查前者会把本仓（pnpm）的正常环境报成"没生成"。
 * （ADR-003：校验器识别不到时报"可能瞎了"，不当成缺失。）
 */
function prismaClientPaths(): string[] {
  const out = [join(ROOT, "node_modules/.prisma/client")];
  const pnpmDir = join(ROOT, "node_modules/.pnpm");
  try {
    for (const entry of readdirSync(pnpmDir)) {
      if (entry.startsWith("@prisma+client@")) out.push(join(pnpmDir, entry, "node_modules/.prisma/client"));
    }
  } catch {
    /* 没有 .pnpm 目录就只看经典布局 */
  }
  return out;
}
function parseEnvFile(): Record<string, string> | undefined {
  const p = join(ROOT, ".env");
  if (!existsSync(p)) return undefined;
  const env: Record<string, string> = {};
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const raw = m[2];
    env[m[1]] = raw.replace(/^["'](.*)["']$/, "$1");
  }
  // 改名前的旧名（ACR-051）：只有旧名的 .env 照样判得出主密钥在不在，
  // 否则这里会建议"生成一把新的"——新名优先生效，已加密的数据就解不开了。
  bridgeLegacyEnv(env);
  return env;
}

/** 解析 `dev.sh status` 的表格。复用它而不是重写进程探测：它按 cwd 认进程，能认出最里层那个 node。 */
export function parseDevStatus(text: string): DevStatusRow[] {
  const rows: DevStatusRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s{2}(\S+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!m || m[1] === "目标") continue;
    rows.push({ target: m[1], port: m[2], pid: m[3], state: m[4] });
  }
  return rows;
}

function realProbes(): Probes {
  return {
    envFile: parseEnvFile,
    composePs: () => {
      try {
        const raw = execFileSync("docker", ["compose", "-f", join(ROOT, "infra/docker-compose.yml"), "ps", "--format", "json"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        return raw
          .split("\n")
          .filter((l) => l.trim().startsWith("{"))
          .map((l) => JSON.parse(l) as { Service?: string; State?: string; Health?: string })
          .map((r) => ({ service: r.Service ?? "", state: r.State ?? "", health: r.Health ?? "" }));
      } catch {
        return undefined;
      }
    },
    devStatus: () => {
      try {
        return parseDevStatus(
          execFileSync("bash", [join(ROOT, "infra/scripts/dev.sh"), "status"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
        );
      } catch {
        return undefined;
      }
    },
    http: async (url) => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
        return { status: r.status, body: await r.text() };
      } catch {
        return undefined;
      }
    },
    migrationsApplied: async () => {
      try {
        /*
         * 按相对路径动态 import，并包在 try 里：
         *  ① `import("@cabinhug/db")` 在 tsx 的 CJS 转译路径下解析不到 workspace 包；
         *  ② 顶层静态 import 会让 `test:infra` 起不来（`infra/` 不是 workspace 成员，
         *    仓库根 node_modules 里没有 `@cabinhug/*` 的链接）；
         *  ③ 新 clone 上 Prisma 客户端未生成时，顶层 import 会让整个检查单以
         *    `Cannot find module '.prisma/client/default'` 崩溃。
         */
        const { getPrisma } = (await import("../../../enterprise/backend/shared/db/src/index")) as {
          getPrisma: () => { $queryRawUnsafe: (q: string) => Promise<Array<{ n: bigint }>> };
        };
        const rows = await getPrisma().$queryRawUnsafe(
          `select count(*)::bigint as n from "_prisma_migrations" where finished_at is not null and rolled_back_at is null`,
        );
        return Number(rows[0]?.n ?? 0);
      } catch {
        return undefined;
      }
    },
    migrationsOnDisk: () =>
      readdirSync(join(ROOT, "enterprise/backend/shared/db/prisma/migrations"), { withFileTypes: true }).filter((d) => d.isDirectory()).length,
    prismaClientGenerated: () => prismaClientPaths().some((d) => existsSync(d)),
    seedStatus: async () => {
      try {
        const { status } = (await import("./demo-seed")) as { status: () => Promise<Array<{ name: string; ok: boolean; detail: string }>> };
        return await status();
      } catch {
        return undefined;
      }
    },
  };
}

async function main(): Promise<void> {
  /*
   * 自己把 `.env` 灌进 process.env（不覆盖已有值），与 `dev-readiness.mjs`
   * 的 `loadRootEnv` 同一做法。
   *
   * 否则进程拿不到 `DATABASE_URL`，库正常时也会报「数据库迁移：连不上库」；
   * 检查单不要求使用者先手动 source `.env`。
   */
  const fileEnv = parseEnvFile();
  for (const [k, v] of Object.entries(fileEnv ?? {})) if (process.env[k] === undefined) process.env[k] = v;

  const results = await runChecks(realProbes());
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  } else {
    console.log(render(results));
  }
  process.exit(results.some((r) => !r.ok && !r.info) ? 1 : 0);
}

// 直接执行时才跑 main。须锚定结尾：`includes("x")` 会匹配 `x.test.ts`，
// 单测 import 时就会真的探活并打印检查单。
if (/\/demo-verify\.ts$/.test(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
