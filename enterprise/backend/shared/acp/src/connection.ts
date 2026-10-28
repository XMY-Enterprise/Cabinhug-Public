/**
 * acp-client/connection —— ACP Client：连接 pi-acp 子进程，管理会话与 session/prompt。
 *
 * 【形态】`agent-runtime` 是 ACP Client（`@agentclientprotocol/sdk` 的 `ClientSideConnection`），
 * 由开源 `pi-acp` 扮演 ACP Agent（它自己再 spawn `pi`）。两者是两个物理进程，
 * 只通过 ACP 消息通信（§4.1）；本目录之外不得 import pi/ACP SDK（F-12-10，CI 守）。
 *
 * 【依赖与机制（§13-1）】
 *  - 包名：`@agentclientprotocol/sdk`（Client）/ `pi-acp`（Agent，svkozak）/ `@earendil-works/pi-coding-agent`（pi 本体）。
 *  - 工具注入机制是 `.pi/extensions/` 目录发现，由 `session/new` 的 `cwd` 决定加载哪个项目的配置。
 *    MCP 路径不可行：pi 不支持 mcpServers，pi-acp 只接受并存储该参数。
 *  - pi-acp 依赖 SDK `^0.26.0`，Client 侧对齐 `~0.26.0`，协商结果 protocolVersion=1。
 *    升级 SDK 必须与 pi-acp 同步，否则协商可能失败。
 *
 * 【一个会话 = 一个 (cabinhugSessionId, agent) 对】Supervisor 与 5 个子 Agent 各自独立会话
 * （F-12-05 / AC-12-7：不是同一次 LLM 调用里扮演六个角色）。
 *
 * 【上下文归属】①Working = "LangGraph 图状态 + pi session"（§7①）。pi 会话自己保存历史，
 * 因此每轮只发本轮的用户输入（末尾那串连续 user 消息，见 `currentUserText`），
 * 不回灌全量历史，避免上下文翻倍。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

import type { AcpApp } from "./app";
import type { ChatStreamer, ChatStreamHooks, ChatTurnMessage } from "./stream";
import { messageText } from "./stream";
import {
  isPiAcpUpdateNotice,
  projectUpdate,
  type UpdateSink,
} from "./update-bridge";

import { canonicalAgent } from "./naming";
import type { ThinkingLevel } from "./thinking";
import { splitThinkBursts, type ThoughtTick } from "./think";

/*
 * 本文件不得使用 `import.meta.url`（`check:arch` 的 `acp-substrate-pure`）。
 * pi 目录只从 `AcpApp.piDir` 来，理由见 `app.ts`。
 */

const CONNECT_TIMEOUT_MS = 30_000;
/**
 * 单次 session/prompt 的兜底超时，必须比任何一层编排超时都长。
 * 行程 fan-out 的 `ITINERARY_BRANCH_TIMEOUT_MS` 是 300s，本层留 30s 余量，
 * 保证编排层先判超时并下发 cancel；两层同时到点时僵尸调用会回来。
 */
const PROMPT_TIMEOUT_MS = 330_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;



export interface AcpClientOptions {
  /**
   * 这个连接服务哪个应用。必填，没有默认值。
   *
   * 默认值会让漏传的应用静默拿到车主面的 pi 目录、prompts 与工具表；
   * 必填时漏传在 `tsc` 阶段即报错。
   */
  app: AcpApp;
  /**
   * 覆盖 pi 的项目级配置目录（测试用）。
   *
   * 它同时覆盖项目目录与二进制目录（`resolvePiCommands`），
   * 可用一个夹具目录顶替整份 pi 安装。
   */
  piAgentsDir?: string;
  /** 注入给子进程的环境变量（模型凭证等由父进程注入，pi 子进程不自己读配置 DB）。 */
  env?: Record<string, string | undefined>;
  /** 本连接服务哪个 Agent，决定 pi 扩展加载哪张工具表（§4.3 能力映射裁剪）。 */
  agent?: string;
  /** Mock 三态（FL-39 F-39-02）；由装配层决定，pi 侧不自己选。 */
  toolMode?: "real" | "mock" | "off";
  /**
   * 思考档位，按进程固定：pi 的 `--model <id>:<level>` 在启动时确定，
   * 不能按单次调用改。池因此按 (Agent, 档位) 分进程，见 `pool.ts` 的 `processKey`。
   * 省略时用 `.pi/settings.json` 里的 `defaultThinkingLevel`。
   */
  thinkingLevel?: ThinkingLevel;
}

interface SessionEntry {
  acpSessionId: string;
  agent: string;
}

/** `resolvePiCommands` 的产物：一次算清"在哪儿启动、以谁的身份启动"。 */
export interface PiCommands {
  /** pi 的项目目录：`session/new` 的 cwd、`.pi/settings.json`、`--approve` 作用域。 */
  piDir: string;
  /** pi 的二进制目录：`node_modules/.bin` 与 `bin/` 的父目录。 */
  binDir: string;
  localBin: string;
  adapterBin: string;
  /**
   * pi-acp 的包目录。JS 入口由 `piAcpEntryOf` 读包的 `bin` 字段得到（要读文件，不在本纯函数里），
   * 再用 `process.execPath` 启动（ACR-058）：不经 `node_modules/.bin` 的包装，
   * Windows 上那是 `.cmd`，Node 不允许不经 shell 直接启动它。
   */
  piAcpPackageDir: string;
  /** pi 的启动入口：Unix 为 `bin/pi-approved.sh`，Windows 为 `bin/pi-approved.cmd`；两者都转给 `bin/pi-launch.mjs`。 */
  piCommand: string;
}

/**
 * 解析"这个连接要启动哪儿的 pi、以哪个目录为项目"。
 *
 * 纯函数、不碰文件系统（存在性检查留在 `connect()`），因此可直测。
 * 两种错配都不报错：cwd 用了 binDir 会加载别人的扩展与提示词，
 * 二进制用了 piDir 会让借用方无法启动（ACR-038）。
 *
 * 语义：
 *  - 给了 `opts.piAgentsDir`（测试覆盖入口）时两者都用它；
 *  - 否则项目目录是 `app.piDir`；
 *  - 二进制目录是 `app.binDir ?? app.piDir`，车主面不传 `binDir`，回落到 `piDir`。
 */
export function resolvePiCommands(
  app: Pick<AcpApp, "piDir" | "binDir">,
  opts?: Pick<AcpClientOptions, "piAgentsDir">,
  platform: NodeJS.Platform = process.platform,
): PiCommands {
  const override = opts?.piAgentsDir;
  const piDir = override ?? app.piDir;
  const binDir = override ?? app.binDir ?? app.piDir;

  const localBin = resolve(binDir, "node_modules/.bin");
  const adapterBin = resolve(binDir, "bin");
  return {
    piDir,
    binDir,
    localBin,
    adapterBin,
    piAcpPackageDir: resolve(binDir, "node_modules/pi-acp"),
    // pi-acp 0.0.33 对 `.cmd` / `.bat` 结尾的命令走 shell，其余直接启动；Windows 没有 sh。
    piCommand: resolve(binDir, platform === "win32" ? "bin/pi-approved.cmd" : "bin/pi-approved.sh"),
  };
}

/** pi-acp 的 JS 入口：读包的 `bin` 字段。包没装或入口文件不在时返回 undefined。 */
export function piAcpEntryOf(packageDir: string): string | undefined {
  const pkgPath = join(packageDir, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin?: string | Record<string, string> };
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["pi-acp"];
  if (!rel) return undefined;
  const entry = resolve(packageDir, rel);
  return existsSync(entry) ? entry : undefined;
}

/**
 * 把目录前置到 PATH，按平台分隔符拼接（Unix `:`、Windows `;`）。
 *
 * Windows 的环境变量名不分大小写，`{ ...process.env }` 展开后键名是 `Path`。
 * 直接写 `PATH` 会出现两个同名变量，子进程拿到哪个不确定，所以先删掉任何大小写形态的旧键。
 * `basePath` 是原 PATH 的值，由调用方给出。
 */
export function withPathPrefix(
  env: NodeJS.ProcessEnv,
  dirs: readonly string[],
  basePath: string | undefined,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of Object.keys(out)) if (key.toUpperCase() === "PATH") delete out[key];
  out.PATH = [...dirs, basePath ?? ""].join(platform === "win32" ? ";" : ":");
  return out;
}

/** 按名取环境变量，名字不分大小写（Windows 上 `process.env` 的 PATH 键是 `Path`）。 */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * 拼 pi-acp 子进程的环境变量。
 *
 * 抽成纯函数以便直测注入项。每一项缺失都不报错：
 * `CABINHUG_PI_TOOLS` 为空串时整个 Agent 没有工具可用，`CABINHUG_TOOLS_ENDPOINT`
 * 指错进程时模型手里零工具却照常作答。
 */
export function spawnEnvFor(
  app: AcpApp,
  opts?: Pick<
    AcpClientOptions,
    "piAgentsDir" | "env" | "agent" | "toolMode" | "thinkingLevel"
  >,
  appendPrompt = "",
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const { piDir, localBin, adapterBin, piCommand } = resolvePiCommands(app, opts, platform);
  const agent = opts?.agent ?? "supervisor";
  // pi-acp 与 pi 的 bin 在 enterprise/backend/pi-agents 的本地 node_modules；
  // pi-acp 0.0.33 会绕过 PI_ACP_PI_COMMAND 执行裸 `pi --version` + `npm view`。
  // 把项目 shim 放在最前面，让该旁路拿不到版本（Unix 的 `bin/pi`；Windows 上这个探针
  // 不经 shell 启动、必然失败，pi-acp 自己吞掉异常）；真正会话仍走下面的绝对
  // PI_ACP_PI_COMMAND。localBin 仍保留给其它本地工具。分隔符与键名见 `withPathPrefix`。
  const base = withPathPrefix(
    { ...process.env, ...opts?.env },
    [adapterBin, localBin],
    envValue(process.env, "PATH"),
    platform,
  );
  return {
    ...base,
    // 两个平台的入口（pi-approved.sh / .cmd）用它启动 pi-launch.mjs：与本进程同一个 node，
    // 不依赖 PATH 上有没有、是哪个版本的 node（单机版的 PATH 由宿主决定）。
    CABINHUG_NODE_BIN: process.execPath,
    // 两层启动都固定为离线：Pi 本体尊重这两个变量，适配器的裸版本探针由
    // adapterBin/pi 截断。模型 API 请求不属于启动检查，不受此项影响。
    PI_SKIP_VERSION_CHECK: "1",
    PI_OFFLINE: "1",
    // 给 .pi/extensions/cabinhug-tools.ts 的三个入参：
    // 工具表回调地址、本进程服务哪个 Agent、Mock 三态。
    // 子进程不自己读配置 DB，否则会出现第三份配置缓存，破坏配置热生效语义。
    AGENT_RUNTIME_URL: process.env.AGENT_RUNTIME_URL ?? `http://localhost:${process.env.AGENT_RUNTIME_PORT ?? 8788}`,
    // 扩展回调地址的通用通道：车主面扩展读上面的 `AGENT_RUNTIME_URL`，
    // 用研面扩展只读这一行。
    // 不做回落：`toolsEndpoint` 为空串时照传空串，让扩展在启动时明确报错。
    // 回落到另一个进程的工具端点时，`listForAgent` 对未知 Agent 回空表，
    // 模型手里零工具却照常作答（ACR-038）。
    CABINHUG_TOOLS_ENDPOINT: app.toolsEndpoint,
    CABINHUG_PI_AGENT: agent,
    CABINHUG_TOOLS: opts?.toolMode ?? process.env.CABINHUG_TOOLS ?? "real",
    // pi 在 `--mode rpc` 下不弹项目信任提示，默认静默忽略 .pi/extensions/，
    // 工具一个都不会注册，且不报错。
    // 启动器给 pi 加 --approve，作用域仅限本仓库的 pi-agents 目录。
    // 固定到仓库内 wrapper，不读取宿主机同名环境变量；个人全局 pi 不在业务链路内。
    PI_ACP_PI_COMMAND: piCommand,
    // 思考档位按进程定（pi 的 `--model <id>:<level>` 是启动参数，不是每次调用的参数）。
    // 走自定义变量而不是往 PI_ACP_PI_COMMAND 里拼参数：后者的解析规则是
    // pi-acp 的内部约定，拼错时会在运行时静默变成另一种行为。
    // 启动器 bin/pi-launch.mjs 认这个变量；拼不出来时为空，不指定档位。
    // 读的是 piDir 的 settings：模型由其所属项目决定。
    CABINHUG_PI_MODEL: modelSpecFor(piDir, opts?.thinkingLevel) ?? "",
    // 工具允许清单：pi 侧再兜一道 §4.3 的 ACL，与 describe/invoke 同源。
    // 启动器据此加 `--tools`；空串时它只加 `--no-builtin-tools`，
    // 因为 `--tools ""` 的语义是"允许零个工具"，会让整个 Agent 没有工具可用。
    CABINHUG_PI_TOOLS: app.toolNamesFor(agent).join(","),
    // 业务 prompt 经 `--append-system-prompt` 进入系统提示词（一次性与 rpc 模式都生效，
    // 特殊字符逐字透传）。
    // 用 CLI 参数而不是 `.pi/APPEND_SYSTEM.md`：多个 Agent 共用同一个 cwd，
    // 按文件注入区分不了 Agent，参数是唯一能按进程差异化的通道。
    // `loadAgentPrompt` 读不到就在连接前抛错，不静默降级。
    CABINHUG_PI_APPEND_PROMPT: appendPrompt,
  };
}

/** 未映射的 update 类型计数：不抛错，只计数上报（与 FL-01 F-01-08 适配器同一原则）。 */
export interface AcpHealth {
  connected: boolean;
  restarts: number;
  unmappedUpdates: Record<string, number>;
  lastError?: string;
}

export class AcpClient {
  private child?: ChildProcessWithoutNullStreams;
  private conn?: ClientSideConnection;
  private connecting?: Promise<void>;
  private sessions = new Map<string, SessionEntry>();
  /** ACP 会话 id → Cabinhug 会话与 Agent（`sessions` 的反向索引，见 `resolveSession`）。 */
  private byAcpSession = new Map<string, { cabinhugSessionId: string; agent: string }>();
  /** 当前活跃的 update 消费者，按 ACP sessionId 索引。 */
  private sinks = new Map<string, UpdateSink>();
  private health: AcpHealth = { connected: false, restarts: 0, unmappedUpdates: {} };
  private disposed = false;

  constructor(private opts: AcpClientOptions) {}

  getHealth(): AcpHealth {
    return { ...this.health, unmappedUpdates: { ...this.health.unmappedUpdates } };
  }

  /**
   * pi 的项目目录：`session/new` 的 `cwd`、`.pi/settings.json`、`--approve` 的作用域。
   * 决定加载谁的扩展与设置，因此必须是本应用自己的（ACR-038）。
   */
  private get piDir(): string {
    return resolvePiCommands(this.opts.app, this.opts).piDir;
  }

  /**
   * pi 的二进制目录：`node_modules/`（pi 与 pi-acp）、`bin/`（两个平台的入口与 `pi-launch.mjs`）。
   * 缺省等于 `piDir`；用研面把它指向 `pi-agents/` 借那一份安装。
   */
  private get binDir(): string {
    return resolvePiCommands(this.opts.app, this.opts).binDir;
  }

  /**
   * 建立（或复用）到 pi-acp 的连接。并发调用合并为一次。
   *
   * 冷启动会 spawn 两级子进程（pi-acp → pi）。这一跳只在首次或重连后出现，
   * 稳态测量量不到，因此单独记一个 span。
   */
  private async ensureConnected(): Promise<void> {
    if (this.conn && this.health.connected) return;
    if (this.connecting) return this.connecting;

    // threadId 传 undefined：连接建立发生在任何一轮之外，不属于某一轮。
    // 落库时会带 keyFallback，页面按"会话外事件"呈现。
    this.connecting = this.opts.app.tracer.span(undefined, "acp.connect", () => this.connect(), {
      agent: this.opts.agent ?? "supervisor",
    }).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const app = this.opts.app;
    /*
     * 业务 prompt 在 spawn 之前取，取不到就抛错，不静默降级。
     * 缺少业务 prompt 的症状（啰嗦、跑题、超时）容易被误判为模型能力问题。
     */
    const appendPrompt = await app.promptFor(this.opts.agent ?? "supervisor");
    const { piAcpPackageDir, piCommand } = resolvePiCommands(app, this.opts);
    const piAcpEntry = piAcpEntryOf(piAcpPackageDir);
    // 两条错误文案都点名查找的目录：借用安装时，"pi-acp 不存在"通常是 binDir 指错。
    if (!piAcpEntry) {
      throw new Error(
        `仓库内 pi-acp 不存在：${piAcpPackageDir}（在 binDir=${this.binDir} 下查找）；` +
          "请先运行 corepack pnpm install",
      );
    }
    if (!existsSync(piCommand)) {
      throw new Error(
        `仓库内 pi 启动包装不存在：${piCommand}（在 binDir=${this.binDir} 下查找）；` +
          "请先运行 corepack pnpm install",
      );
    }

    // 用本进程的 node 直接启动 pi-acp 的 JS 入口（ACR-058），不经 `.bin` 包装：
    // Windows 上包装是 `.cmd`，Node 不允许不经 shell 直接启动它（会报 EINVAL）。
    const child = spawn(process.execPath, [piAcpEntry], {
      // cwd 用 piDir 而不是 binDir：它决定 pi 加载谁的 `.pi/extensions` 与
      // `settings.json`，借用二进制的一方需要的是自己的项目配置（ACR-038）。
      cwd: this.piDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnvFor(app, this.opts, appendPrompt),
    });

    child.on("error", (err) => this.onChildDown(`spawn 失败: ${err.message}`));
    child.on("exit", (code, signal) => {
      if (!this.disposed) this.onChildDown(`子进程退出 code=${code} signal=${signal}`);
    });
    // pi-acp 的诊断走 stderr；保留可见是排查"pi 未安装/未登录"的唯一线索。
    child.stderr.on("data", (b: Buffer) => process.stderr.write(`[pi-acp] ${b}`));

    const input = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((res) => {
          if (child.stdin.destroyed) return res();
          child.stdin.write(chunk, () => res());
        });
      },
    });
    const output = new ReadableStream<Uint8Array>({
      start(controller) {
        child.stdout.on("data", (c: Buffer) => controller.enqueue(new Uint8Array(c)));
        child.stdout.on("end", () => {
          try {
            controller.close();
          } catch {
            /* 已关闭 */
          }
        });
        child.stdout.on("error", (e) => controller.error(e));
      },
    });

    const conn = new ClientSideConnection(
      () => ({
        // pi-acp 不实现 session/request_permission。权限门是敏感工具
        // execute() 内的一次内部 HTTP（§8.4），与 ACP 协议无关。
        requestPermission: async () => {
          throw new Error("pi-acp 不应发起 session/request_permission；权限门走内部 HTTP（§8.4）");
        },
        sessionUpdate: async (params: unknown) => {
          this.dispatchUpdate(params);
        },
        writeTextFile: async () => {
          throw new Error("ACP writeTextFile 未启用");
        },
        readTextFile: async () => {
          throw new Error("ACP readTextFile 未启用");
        },
      }),
      ndJsonStream(input, output),
    );

    await withTimeout(
      conn.initialize({
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      } as never),
      CONNECT_TIMEOUT_MS,
      "ACP initialize",
    );

    this.child = child;
    this.conn = conn;
    this.health.connected = true;
    this.health.lastError = undefined;
  }

  /** 子进程掉线：清空会话映射，等待下次请求时重建（不主动重启，避免崩溃风暴）。 */
  private onChildDown(reason: string) {
    this.health.connected = false;
    this.health.lastError = reason;
    this.health.restarts += 1;
    this.conn = undefined;
    this.child = undefined;
    // 会话属于已退出的进程，全部作废，重连后按需重建。
    this.sessions.clear();
    this.byAcpSession.clear();
    for (const sink of this.sinks.values()) sink.fail(new Error(`ACP 连接中断：${reason}`));
    this.sinks.clear();
  }

  private dispatchUpdate(params: unknown) {
    const p = params as { sessionId?: string; update?: Record<string, unknown> };
    const sink = p.sessionId ? this.sinks.get(p.sessionId) : undefined;
    const projected = projectUpdate(p.update);

    // pi-acp 0.0.33 即使 quietStartup=true 也会把版本提示作为普通 delta
    // 发出来。它不是模型回答，不能进入车主会话；shim 负责阻止检查，
    // 这里再做协议边界兜底，兼容旧进程或未来适配器改变探针路径的情况。
    if (projected.kind === "delta" && isPiAcpUpdateNotice(projected.text)) return;

    if (projected.kind === "unmapped") {
      const key = projected.rawKind;
      this.health.unmappedUpdates[key] = (this.health.unmappedUpdates[key] ?? 0) + 1;
      return;
    }
    sink?.push(projected);
  }

  /**
   * 取（或建）某个 Cabinhug 会话下某个 Agent 的独立 ACP 会话。
   *
   * 返回 `fresh=true` 表示这是新建的会话，调用方必须补一次历史回灌，
   * 否则子进程重建后 pi 侧上下文为空（见 `prompt` 的说明）。
   */
  private async sessionFor(
    cabinhugSessionId: string,
    agent: string,
  ): Promise<{ acpSessionId: string; fresh: boolean }> {
    const key = `${cabinhugSessionId}::${agent}`;
    const existing = this.sessions.get(key);
    if (existing) return { acpSessionId: existing.acpSessionId, fresh: false };

    // 每个 (会话 × Agent) 首次用到时各建一次，都串在用户等待里，因此单独记 span。
    const res = (await this.opts.app.tracer.span(
      cabinhugSessionId,
      "acp.session_new",
      () =>
        withTimeout(
          // cwd 是 piDir：pi 按它发现 `.pi/extensions` 与 `settings.json`。
          this.conn!.newSession({ cwd: this.piDir, mcpServers: [] } as never),
          CONNECT_TIMEOUT_MS,
          "ACP session/new",
        ),
      { agent },
    )) as { sessionId: string };

    this.sessions.set(key, { acpSessionId: res.sessionId, agent });
    // 反解索引：工具调用从 pi 侧回传时只带得到 ACP 会话 id，
    // 而 F-07-07 要求工具日志与权限门都带 Cabinhug 的 session_id。
    // 权限门的 interrupt 靠这张表找到该挂起的 SSE，HITL 依赖它。
    this.byAcpSession.set(res.sessionId, { cabinhugSessionId, agent });
    return { acpSessionId: res.sessionId, fresh: true };
  }

  /** pi 会话 id → Cabinhug 会话与 Agent。解析不出返回 undefined，由调用方决定怎么说。 */
  resolveSession(acpSessionId: string): { cabinhugSessionId: string; agent: string } | undefined {
    return this.byAcpSession.get(acpSessionId);
  }

  /**
   * 发一轮 prompt，产出文本增量流。
   *
   * 【上下文的两半与回灌】§7① 把 ①Working 定义为"LangGraph 图状态 + pi session"。
   * 稳态下两者并存，每轮只发本轮用户输入（pi 会话自己保存历史，回灌会让上下文翻倍）。
   * pi-acp 子进程崩溃或重启后，pi session 随进程消失而图状态仍在，只发最新一句会让
   * 模型丢失此前对话。因此新建会话时用图状态回灌一次历史。
   * 图状态是权威源，pi session 是它的副本。
   */
  async *prompt(args: {
    cabinhugSessionId: string;
    agent: string;
    /** 图状态里的完整消息序列（权威源）。 */
    messages: ChatTurnMessage[];
    /** 调用方放弃时的取消信号（F-14-04）；见下面 abort 处的说明。 */
    signal?: AbortSignal;
    /**
     * 本线程的锚定块（ACR-036 §4.9）。只在新建会话时发一次。
     *
     * pi 的系统提示词在进程启动时已固定（`--append-system-prompt`），一个进程服务多个用户，
     * 所以车主档案走会话的第一条 prompt：它位于 pi 历史最前面，之后每一轮都命中前缀缓存。
     * 每轮重发会不断改变前缀，使缓存失效。
     */
    anchor?: string;
  }): AsyncGenerator<string> {
    const app = this.opts.app;
    await this.ensureConnectedWithBackoff();
    const { acpSessionId, fresh } = await this.sessionFor(args.cabinhugSessionId, args.agent);
    // 业务 prompt 在系统提示词里（`connect()` 的 `CABINHUG_PI_APPEND_PROMPT`），
    // 这里只处理回灌：新会话用图状态回灌一次历史。
    const primed = fresh ? primeWithHistory(args.messages) : currentUserText(args.messages);
    if (!primed) return;
    /*
     * 日期行的归属：
     * - 装载层开着时，当天日期已随最后一条 user 消息进入本轮尾区，这里不再前置；
     * - 装载层关着（`CABINHUG_CONTEXT_LAYER=off`）时由 `decoratePrompt` 前置（车主面传 `withDateline`）。
     * 判据用 `args.anchor === undefined` 而不是读环境变量：这一层不感知开关。
     */
    const withContext = args.anchor !== undefined;
    const body = withContext ? primed : (app.decoratePrompt?.(primed, Date.now()) ?? primed);
    const text = fresh && args.anchor ? `${args.anchor}\n\n${body}` : body;

    // 记录实际发出的 text 而不是入参 messages：新会话回灌与稳态只取最后一条形态差别很大，
    // 排查模型输出要看实际发出的内容。
    app.tracer.recordPrompt(args.cabinhugSessionId, args.agent, text);

    const sink = createSink();
    this.sinks.set(acpSessionId, sink);

    const done = withTimeout(
      this.conn!.prompt({
        sessionId: acpSessionId,
        prompt: [{ type: "text", text }],
      } as never),
      PROMPT_TIMEOUT_MS,
      "ACP session/prompt",
    )
      .then(() => sink.end())
      .catch((e) => sink.fail(e instanceof Error ? e : new Error(String(e))));

    /*
     * 思考片：内容不下发（FL-03 F-03-04），但记录时长（见 `think.ts`）。
     * 展示思考内容是产品决策，记录耗时不是。
     */
    const ticks: ThoughtTick[] = [];

    /*
     * 取消下传（F-14-04）。两件事都要做：
     *
     *  1. 发 `session/cancel`，让 pi 停止生成。不发时编排层已放弃，pi 仍消耗 token
     *     直到 `PROMPT_TIMEOUT_MS`。
     *  2. `sink.fail` 立刻结束本地流。流静默时只发 cancel 会一直等待 pi 的最后一条更新。
     *
     * 协议允许 Agent 在 cancel 后再发几条收尾更新（见 SDK acp.d.ts 的说明），
     * 这里不等待：调用方已放弃本次结果，收尾内容没有消费者。
     */
    const onAbort = (): void => {
      void this.conn?.cancel({ sessionId: acpSessionId } as never).catch(() => {
        // 取消发送失败不再抛错：调用方已在放弃这条路径。
      });
      sink.fail(app.tracer.cancelled(`本轮已取消（${args.agent}）`));
    };
    if (args.signal?.aborted) onAbort();
    else args.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      for await (const chunk of sink.stream()) {
        if (chunk.kind === "delta") {
          yield chunk.text;
        } else {
          // 只留到达时刻与字数，不留内容（AC-44-10）。
          ticks.push({ at: Date.now(), chars: chunk.text.length });
        }
      }
      await done;
    } finally {
      this.sinks.delete(acpSessionId);
      args.signal?.removeEventListener("abort", onAbort);
      // 放在 finally：超时、取消与失败时的思考同样耗时，也要记录。
      for (const b of splitThinkBursts(ticks)) {
        app.tracer.recordSpan(args.cabinhugSessionId, `think.${args.agent}`, b.startedAt, b.endedAt, "ok", {
          agent: args.agent,
          detail: `${b.chunks} 片 · ${b.chars} 字`,
        });
      }
    }
  }

  private async ensureConnectedWithBackoff(): Promise<void> {
    let delay = BACKOFF_BASE_MS;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await this.ensureConnected();
        return;
      } catch (e) {
        lastErr = e;
        this.health.lastError = e instanceof Error ? e.message : String(e);
        await sleep(delay);
        delay = Math.min(delay * 2, BACKOFF_MAX_MS);
      }
    }
    throw new Error(
      `ACP 连接不可用（已重试 4 次）：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  }

  /**
   * 启动自检（F-42-12）：pi 子进程能起来，且扩展确实被加载。
   *
   * pi 对未信任项目会静默忽略 `.pi/extensions/`：不报错、不告警，
   * 模型手里没有工具，转而编造答案。只能通过预期回调是否发生来检测。
   *
   * 判据：建一个探针会话后，pi 扩展应当已回调过 `/internal/tools/describe`。
   */
  async selfCheck(expectDescribeCalls: () => number): Promise<{ ok: boolean; detail: string }> {
    const before = expectDescribeCalls();
    try {
      await this.ensureConnectedWithBackoff();
      await this.sessionFor("__selfcheck__", this.opts.agent ?? "supervisor");
    } catch (e) {
      return { ok: false, detail: `ACP 连接或会话创建失败：${e instanceof Error ? e.message : String(e)}` };
    }
    const after = expectDescribeCalls();
    if (after <= before) {
      return {
        ok: false,
        detail:
          "pi 扩展未加载：工具表回调未发生。最常见原因是 pi 未信任项目目录——" +
          "确认仓库内 pi 已安装，并检查 enterprise/backend/pi-agents/.pi/ 是否可读（启动入口已固定为本地 wrapper）",
      };
    }
    return { ok: true, detail: `扩展已加载（describe 回调 ${before}→${after}）` };
  }

  dispose() {
    this.disposed = true;
    this.child?.kill();
    this.child = undefined;
    this.conn = undefined;
    this.health.connected = false;
  }
}

/**
 * 把 ACP 会话包装成 `ChatStreamer` 形状，与直连实现可互换。
 *
 * 入参是全量 `messages`（图状态），但只取本轮的用户输入发给 pi，
 * 其余历史由 pi 会话自己持有（§7① 的"LangGraph 图状态 + pi session"两者并存）。
 */
/**
 * `createAcpStreamer` 只需要"能发一轮 prompt"这一项能力。
 * 收窄成接口，单个客户端与按 Agent 分进程的池（`pool.ts`）都能接。
 */
export interface AcpPrompter {
  prompt(args: {
    cabinhugSessionId: string;
    agent: string;
    messages: ChatTurnMessage[];
    signal?: AbortSignal;
    /** 本线程的锚定块；只在新建会话时使用，见实现处的说明。 */
    anchor?: string;
  }): AsyncGenerator<string>;
}

/**
 * pi 实际跑的模型名（`.pi/settings.json` 的 defaultModel，唯一真相源）。
 * 读不到返回 undefined，调用方回落到会话名。
 *
 * 缓存按 `piDir` 分键（ACR-038）：多个应用共存时，各自的用量行记录各自的模型名。
 * 同一个 `piDir` 只读一次盘（settings 随仓库走，进程内不会变）。
 */
const piModelCache = new Map<string, string | null>();
export function piDefaultModel(piDir: string): string | undefined {
  const cached = piModelCache.get(piDir);
  if (cached !== undefined) return cached ?? undefined;
  let model: string | null;
  try {
    const s = JSON.parse(readFileSync(join(piDir, ".pi", "settings.json"), "utf8")) as {
      defaultModel?: unknown;
    };
    model = typeof s.defaultModel === "string" ? s.defaultModel : null;
  } catch {
    model = null;
  }
  piModelCache.set(piDir, model);
  return model ?? undefined;
}

/**
 * 只给测试用：清空模型名缓存。
 *
 * 避免用例之间缓存串台，使"按 piDir 分键"的用例真正生效。
 */
export function resetPiModelCacheForTests(): void {
  piModelCache.clear();
}

/**
 * 字符 → token 的估算系数。pi 侧拿不到真实 token 计数（不经 AI SDK 出口，
 * 真值需接入 pi 的 get_session_stats）。记 0 会系统性低估且不可见，
 * 估算至少方向正确、口径可写明。
 * 系数取 DeepSeek 官方口径的中文侧（1 汉字 ≈ 0.6 token；英文 ≈ 0.3/字符），
 * 按偏高的一侧取，与单价取"高峰未命中"同一取向：宁可略高，不可偏低。
 */
const EST_TOKENS_PER_CHAR = 0.6;

export function createAcpStreamer(
  client: AcpPrompter,
  resolve: (hooks?: ChatStreamHooks) => { cabinhugSessionId: string; agent: string },
  /** 读 `.pi/settings.json` 拿模型真名用。由应用给出，底座不推断目录。 */
  piDir: string,
): ChatStreamer {
  return async function* (messages: ChatTurnMessage[], hooks?: ChatStreamHooks) {
    const { cabinhugSessionId, agent } = resolve(hooks);
    const startedAt = Date.now();
    const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
    let completionChars = 0;
    let ok = true;
    try {
      // signal 必须透传，否则上层取消后底层仍在消耗 token。
      for await (const chunk of client.prompt({
        cabinhugSessionId,
        agent,
        messages,
        signal: hooks?.signal,
        // 直连那条把锚定块拼进 system；pi 这条没有按线程的 system，所以走会话首条 prompt。
        ...(hooks?.systemSuffix !== undefined ? { anchor: hooks.systemSuffix } : {}),
      })) {
        completionChars += chunk.length;
        yield chunk;
      }
    } catch (e) {
      ok = false;
      throw e;
    } finally {
      hooks?.onUsage?.({
        provider: "pi-acp",
        // 子 Agent 身份：用量页按 Agent 维度统计依赖它（见 LlmUsageSample.agent）。
        agent,
        // 模型记真名（settings 的 defaultModel），按模型聚合成本时才能对上单价。
        model: piDefaultModel(piDir) ?? agent,
        promptTokens: Math.ceil(promptChars * EST_TOKENS_PER_CHAR),
        completionTokens: Math.ceil(completionChars * EST_TOKENS_PER_CHAR),
        durationMs: Date.now() - startedAt,
        status: ok ? "ok" : "failed",
      });
    }
  };
}

// ── 内部工具 ───────────────────────────────────────────────

/** `.pi/settings.json` 只读一次：它随仓库走，进程生命周期内不会变。 */
const modelSpecCache = new Map<string, string | undefined>();

/**
 * 拼出 pi 的 `--model` 值：`<provider>/<model>:<thinking>`。
 *
 * 模型 id 的唯一真相源是 `.pi/settings.json`，这里只加档位后缀。
 * 在别处另写模型 id 会导致两边静默运行不同的模型（见 pi-agents/README）。
 *
 * 读不到、缺字段、或没指定档位时返回 undefined：不加 `--model`，
 * pi 使用 settings 的默认值。
 */

export function modelSpecFor(
  /** pi 的项目目录（不是二进制目录）：settings 跟着项目走，见 `resolvePiCommands`。 */
  piDir: string,
  thinkingLevel: ThinkingLevel | undefined,
): string | undefined {
  if (!thinkingLevel) return undefined;
  const key = `${piDir}::${thinkingLevel}`;
  if (modelSpecCache.has(key)) return modelSpecCache.get(key);

  let spec: string | undefined;
  try {
    const raw = readFileSync(join(piDir, ".pi", "settings.json"), "utf8");
    const s = JSON.parse(raw) as { defaultProvider?: unknown; defaultModel?: unknown };
    if (typeof s.defaultProvider === "string" && typeof s.defaultModel === "string") {
      spec = `${s.defaultProvider}/${s.defaultModel}:${thinkingLevel}`;
    }
  } catch {
    /* 读不到就不加参数——见上 */
  }
  modelSpecCache.set(key, spec);
  return spec;
}

/**
 * 末尾那一串连续 user 消息的起点下标；没有 user 消息时返回 -1。
 *
 * 编排层会在用户原话后面追加自己的指令，它们同样是 `role: "user"`：
 * 意图节点追加 `INTENT_INSTRUCTION`，应答节点追加【编排层已完成的求解结果】。
 * 中间没有 assistant 隔开，它们与用户原话同属本轮输入。
 */
export function trailingUserRunStart(messages: readonly ChatTurnMessage[]): number {
  let i = messages.length - 1;
  // 正常情况下末条就是 user；容错：尾部若挂着 assistant，退回最近一条 user。
  while (i >= 0 && messages[i].role !== "user") i -= 1;
  if (i < 0) return -1;
  while (i - 1 >= 0 && messages[i - 1].role === "user") i -= 1;
  return i;
}

/**
 * 本轮真正要发给 pi 的用户输入。
 *
 * 不能只取最后一条：稳态（会话复用）下末条是编排层追加的指令，只发末条时
 * pi 收不到用户本轮原话。首轮走 `primeWithHistory` 不受影响，问题从第二轮起出现。
 */
function currentUserText(messages: ChatTurnMessage[]): string | undefined {
  const start = trailingUserRunStart(messages);
  if (start < 0) return undefined;
  const parts = messages
    .slice(start)
    .filter((m) => m.role === "user")
    // 附件备注一并带上：pi 路径看不到图片，但需要知道车主附了什么。
    .map((m) => messageText(m))
    .filter((c) => c && c.trim().length > 0);
  return parts.length ? parts.join("\n\n") : undefined;
}

/**
 * 新建 pi 会话时的历史回灌：把图状态里的既往轮次压成一段上下文 + 本轮问题。
 *
 * 只在 `fresh` 时用一次。首轮（无既往历史）等价于直接发本轮输入，不产生额外开销。
 *
 * 切分点与 `currentUserText` 用同一个边界函数，否则末尾那串 user 消息里
 * 靠前的几条会同时进入"历史"与"现在问"，同一句话发两遍。
 */
function primeWithHistory(messages: ChatTurnMessage[]): string | undefined {
  const current = currentUserText(messages);
  if (!current) return undefined;

  const prior = messages.slice(0, trailingUserRunStart(messages));
  if (prior.length === 0) return current;

  const transcript = prior
    .map((m) => `${m.role === "user" ? "车主" : "助手"}：${messageText(m)}`)
    .join("\n");
  return [
    "以下是本次会话此前的对话记录（供你接上下文，不要复述）：",
    transcript,
    "",
    `车主现在问：${current}`,
  ].join("\n");
}


function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} 超时 ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

interface Sink extends UpdateSink {
  stream(): AsyncGenerator<{ kind: "delta"; text: string } | { kind: "thought"; text: string }>;
  end(): void;
}

/** 把回调式的 session/update 转成可 for-await 的流。 */
function createSink(): Sink {
  const queue: Array<{ kind: "delta" | "thought"; text: string }> = [];
  let notify: (() => void) | undefined;
  let finished = false;
  let error: Error | undefined;

  const wake = () => {
    notify?.();
    notify = undefined;
  };

  return {
    push(item) {
      queue.push(item);
      wake();
    },
    fail(e) {
      error = e;
      finished = true;
      wake();
    },
    end() {
      finished = true;
      wake();
    },
    async *stream() {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (error) throw error;
        if (finished) return;
        await new Promise<void>((r) => {
          notify = r;
        });
      }
    },
  };
}
