/**
 * `research-runtime` 服务入口（ACR-034）。
 *
 * # 独立进程
 *
 * 研究面是跨用户聚合。`agent-runtime` 里每个仓储都带用户键，
 * 把无键读放进那个进程等于给端上路径留一条无键入口，漏用时没有任何现象。
 *
 * # 三个 Agent 直连、一个经 ACP：判据是有没有工具循环（ACR-038）
 *
 * Coder / Namer / Synthesizer 各是一次 `generateObject`，产出给代码解析的结构化
 * 结果，需要 pi 给不了的 schema 约束，ACP 的会话与流式 token 在这里没有消费者，
 * 所以直连。Challenger 的探查跳是模型自己循环调只读工具，与车主面的 A 型 Agent
 * 同形，走 `@cabinhug/acp` 的底座（`AcpApp.id = "research"`，pi 目录 `pi-research/`、
 * 借 `pi-agents/` 的 pi 安装，工具经 `/internal/research/tools/*` 回调到本进程），
 * 收口跳仍是一次 `generateObject`。开关 `RESEARCH_CHALLENGER_TRANSPORT`
 * 缺省 `acp`，`direct` 是回滚值（`challenge/acp-transport.ts`）。
 *
 * # 启动顺序
 *
 * codebook 的 hash 对账在注册队列消费者之前：锁过版的码表被改过时进程起不来，
 * 不会先按新口径编出一批标签再报错。
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { AcpClientPool, createAcpStreamer } from "@cabinhug/acp";
import {
  createConfigStore,
  createResearchRepository,
  createUsageRepository,
  getPrisma,
  bridgeLegacyEnv,
  describeLegacyEnvNotice,
} from "@cabinhug/db";
import { SOURCE_PASSPORTS } from "@cabinhug/research";
import type {
  AskAgentName,
  EvidenceCell,
  EvidenceMatrixData,
  ResearchSystemEvent,
  SelectionScope,
} from "@cabinhug/research";

import { assertCodebookConsistent, loadLatestCodebook } from "./codebook/load";
import { createInternalApi } from "./internal-api";
import { createResearchApp } from "./acp/research-app";
import { createResearchToolsEndpoint } from "./acp/tools-endpoint";
import { createResearchModel, type ResearchUsage } from "./llm";
import { handleCodeJob, type CodeJobPayload } from "./queue/code-handler";
import { handleEmbedJob, type EmbedJobPayload } from "./queue/embed-handler";
import { nameTheme } from "./ontology/namer";
import { runResearch, type RunOptions } from "./runs/run";
import { buildResearchGraph, researchThreadId } from "./graph/research-graph";
import { createChallengeToolDeps } from "./challenge/deps";
import { createChallengeTools, type ChallengeToolDeps } from "./challenge/tools";
import type { ChallengeDeps } from "./challenge/challenger";
import { readChallengerAcpTimeoutMs, readChallengerTransport } from "./challenge/acp-transport";
import { createCapabilityRuns } from "./capabilities/runs";
import { followUpRounds } from "./capabilities/follow-up";
import { CATCH_ALL_CODE, PROPOSAL_RAISED } from "./capabilities/propose-code";
import { ask, type AskContext } from "./stages/ask";
import { synthesizeAll, synthesizeOne } from "./stages/synthesize";
import { challengeAll, challengeOne } from "./stages/challenge";
import { gateAll } from "./stages/gate";
import type { ReviewDeps } from "./review/endpoints";

// 改名前的环境变量（ACR-051）：旧名的值搬到新名上，逐条打弃用日志。必须先于任何读取 env 的代码。
for (const notice of bridgeLegacyEnv(process.env)) console.warn(describeLegacyEnvNotice(notice));

const HERE = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
const PKG_ROOT = join(HERE, "..");

/** 三条队列。名字与 worker 侧的 `RESEARCH_CODE_QUEUE` 同源，改一处要改两处。 */
export const QUEUES = {
  code: "research.code",
  embed: "research.embed",
  snapshot: "research.snapshot",
} as const;

async function main(): Promise<void> {
  const prisma = getPrisma();
  const config = createConfigStore(prisma);
  const values = await config.runtimeValues();

  const port = Number(values.get("RESEARCH_RUNTIME_PORT") ?? 8800);
  const apiKey = values.get("DEEPSEEK_API_KEY") ?? "";
  const dashscopeKey = values.get("DASHSCOPE_API_KEY") ?? "";
  const repo = createResearchRepository(prisma);

  // ① codebook：先载入、先对账。锁过版而文件被改过时在这里启动失败。
  const book = loadLatestCodebook(join(PKG_ROOT, "codebooks"));
  const stored = await repo.codebooks.byVersion(book.version);
  assertCodebookConsistent(book, stored);
  await repo.codebooks.upsert({
    version: book.version,
    hash: book.hash,
    axes: book.axes,
    filePath: book.filePath,
  });
  console.log(`[research-runtime] codebook v${book.version}（${stored?.lockedAt ? "已锁版" : "未锁版"}）`);

  // ② 来源护照 → 表。判断读的永远是代码常量，这张表只是可查询副本。
  await repo.sourcePassports.sync(SOURCE_PASSPORTS as unknown as Record<string, unknown>[]);

  /*
   * 用量记账。`llm_usage` 没有 reasoning_tokens 列且不为研究面改表，
   * "思考已关"由 `test/thinking.test.ts` 的源码扫描与抓包实测证明（见 README）。
   *
   * 研究面没有会话与轮次，`sessionId` 固定 `research`、`turnId` 记批次时刻，
   * 使成本能在为对话设计的表键上按 agent 归因。
   *
   * 声明在队列块外：Namer 跑在 run 里（`POST /runs` 同步调）而不在队列里，同样要计费。
   */
  const usage = createUsageRepository(prisma);
  let recordUsage: ((u: ResearchUsage) => Promise<void>) | undefined;

  // ③ 队列。只 work 自己的三条，绝不碰 guide.*（那是 agent-runtime 的）。
  const registered: Record<string, boolean> = { code: false, embed: false, snapshot: false };

  /**
   * Namer 的依赖，在队列块里装配（那里才有 `apiKey`），给 `startRun` 用。
   *
   * 声明在块外，因为主题命名发生在 run 里：`runResearch` 聚完簇后给每一簇起名，
   * run 由 `POST /runs` 同步调。缺 key 时留 null，`runResearch` 退回
   * `${code}#${i}` 占位名，聚类照做。
   */
  let namer: { model: ReturnType<typeof createResearchModel>; systemPrompt: string } | null = null;
  /**
   * Synthesizer 与 Challenger 的依赖。
   *
   * 声明在块外：它们跑在图里，图在这个块之后建。缺 key 时留 null，两个阶段整段
   * 跳过并各打一行日志，不让每个主题各失败一次（与"缺 key 不注册消费者"一致）。
   */
  let agents: {
    synthesizer: { model: ReturnType<typeof createResearchModel>; systemPrompt: string };
    challenger: { model: ReturnType<typeof createResearchModel>; systemPrompt: string };
  } | null = null;
  /** 嵌入模型名。主题聚类按它取向量——取错模型等于取到空集，主题恒 0。 */
  const embedModel = values.get("RESEARCH_EMBEDDING_MODEL") ?? "text-embedding-v4";
  const dbUrl = process.env.DATABASE_URL?.trim();
  if (!dbUrl) {
    console.warn("[research-runtime] 缺 DATABASE_URL——队列不起，只有只读端点可用");
  } else if (!apiKey) {
    console.warn("[research-runtime] 缺 DEEPSEEK_API_KEY——编码队列不起（只读端点照常）");
  } else {
    const { PgBoss } = await import("pg-boss");
    const boss = new PgBoss(dbUrl);
    boss.on("error", (err: unknown) => console.warn("[research-runtime] pg-boss 报错", err));
    await boss.start();

    const model = createResearchModel("coder", {
      apiKey,
      coderModel: values.get("RESEARCH_CODER_MODEL") ?? "deepseek-flash",
      synthModel: values.get("RESEARCH_SYNTH_MODEL") ?? "deepseek",
    });
    const systemPrompt = readFileSync(join(PKG_ROOT, "prompts", "coder.md"), "utf8");

    // Namer 走 synth 档（更强的那个模型）：给主题起名要读懂一簇例句，
    // 而 coder 档是为「填满受控字段」调的，不是为概括调的。
    namer = {
      model: createResearchModel("synth", {
        apiKey,
        coderModel: values.get("RESEARCH_CODER_MODEL") ?? "deepseek-flash",
        synthModel: values.get("RESEARCH_SYNTH_MODEL") ?? "deepseek",
      }),
      systemPrompt: readFileSync(join(PKG_ROOT, "prompts", "namer.md"), "utf8"),
    };

    /*
     * 两个都走 synth 档（更强的那个模型）：一个要把一簇例句写成能被反驳的判断，
     * 一个要读懂这个判断再去找能推翻它的证据。coder 档是为「填满受控字段」调的。
     */
    const synthModel = (): ReturnType<typeof createResearchModel> =>
      createResearchModel("synth", {
        apiKey,
        coderModel: values.get("RESEARCH_CODER_MODEL") ?? "deepseek-flash",
        synthModel: values.get("RESEARCH_SYNTH_MODEL") ?? "deepseek",
      });
    agents = {
      synthesizer: {
        model: synthModel(),
        systemPrompt: readFileSync(join(PKG_ROOT, "prompts", "synthesizer.md"), "utf8"),
      },
      challenger: {
        model: synthModel(),
        /*
         * Challenger 的提示词在 `pi-research/prompts/`（ACR-038）：ACP 路径经
         * `--append-system-prompt` 下发这一份，直连路径读同一个文件，保证两条路径口径一致。
         * coder / namer / synthesizer 三份在本包 `prompts/`，它们不走 ACP。
         */
        systemPrompt: readFileSync(resolve(PKG_ROOT, "../pi-research/prompts/challenger.md"), "utf8"),
      },
    };

    recordUsage = async (u: ResearchUsage): Promise<void> => {
      if (u.reasoningTokens > 0) {
        // 恒应为 0。不为 0 说明关思考没生效（换了 SDK / baseURL / 有人绕过 llm/index.ts）。
        console.warn(`[research-runtime] ⚠️ reasoning_tokens=${u.reasoningTokens}——思考没关掉，编码会变慢且可能填不满字段`);
      }
      usage.record({
        sessionId: "research",
        turnId: `code-${Date.now()}`,
        agent: u.agent,
        // 经 pi 的那一跳记 `pi-acp`（token 是估算值，口径不同，不能与直连混算）。
        provider: u.provider ?? "deepseek",
        model: u.model,
        promptTokens: u.promptTokens,
        completionTokens: u.completionTokens,
        costEstimate: 0,
        durationMs: 0,
        status: "ok",
      });
    };

    await boss.createQueue(QUEUES.code);
    await boss.createQueue(QUEUES.embed);
    await boss.work(QUEUES.code, { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) {
        const payload = job.data as CodeJobPayload;
        const out = await handleCodeJob(payload, { repo, model, systemPrompt, book, recordUsage });
        console.log(`[research-runtime] ${QUEUES.code}：${out.units} 单元 → ${out.codings} 行编码${out.skipped ? "（跳过）" : ""}`);
        // 编完就排嵌入：主题聚类吃的是向量，而向量只对编过的单元才有意义
        // （没编码的单元进不了任何一个码的分组）。
        if (!out.skipped && dashscopeKey) await boss.send(QUEUES.embed, { unitIds: payload.unitIds });
      }
    });
    registered.code = true;

    /*
     * 嵌入队列。缺 DASHSCOPE_API_KEY 时不注册：必然失败的消费者会让每个任务
     * 重试到失败态并刷屏日志。
     */
    if (dashscopeKey) {
      const embedConfig = {
        apiKey: dashscopeKey,
        model: values.get("RESEARCH_EMBEDDING_MODEL") ?? "text-embedding-v4",
        dimensions: Number(values.get("RESEARCH_EMBEDDING_DIM") ?? 1024),
      };
      await boss.work(QUEUES.embed, { batchSize: 1 }, async (jobs) => {
        for (const job of jobs) {
          const out = await handleEmbedJob(job.data as EmbedJobPayload, { repo, config: embedConfig, recordUsage });
          console.log(`[research-runtime] ${QUEUES.embed}：${out.embedded} 个向量${out.skipped ? "（跳过）" : ""}`);
        }
      });
      registered.embed = true;
    } else {
      console.warn("[research-runtime] 缺 DASHSCOPE_API_KEY——嵌入队列不起，主题聚类没有向量可用");
    }

    /*
     * 快照队列：快照由 `POST /internal/research/runs` 同步算。仍注册一个 handler，
     * 否则排进来的任务会停在 created 态而无人处理。
     */
    await boss.createQueue(QUEUES.snapshot);
    await boss.work(QUEUES.snapshot, { batchSize: 1 }, async (jobs) => {
      console.log(`[research-runtime] ${QUEUES.snapshot}：收到 ${jobs.length} 个任务；本版快照走 POST /runs，图在 M82-06 接管`);
    });
    registered.snapshot = true;
  }

  /**
   * 一次 run 要的全部「主题材料」：单元向量 + 脱敏文本 + Namer。
   *
   * 调用 `runResearch` 的装配只在这一处。漏传 `embeddings` 时 `runResearch`
   * 取空 Map，主题聚类整段跳过、主题恒为 0，而向量其实在库里。
   * 新增调用方时复用本函数，不另写一份装配。
   */
  const themeMaterials = async (
    window: { from: number; to: number },
  ): Promise<Pick<RunOptions, "embeddings" | "texts" | "nameTheme">> => {
    const turns = await repo.units.codedTurns(window, book.version);
    const unitIds = turns.map((t) => t.unitId);
    const [embeddings, texts] = await Promise.all([
      repo.embeddings.forUnits(embedModel, unitIds),
      repo.units.textsByIds(unitIds),
    ]);
    if (unitIds.length > 0 && embeddings.size === 0) {
      console.warn(
        `[research-runtime] ${unitIds.length} 个已编码单元一个向量都没有——` +
          `主题会是 0。补排：corepack pnpm research:embed-backfill`,
      );
    }
    const n = namer;
    return {
      embeddings,
      texts,
      ...(n
        ? {
            /**
             * 单簇命名失败不拖垮整个 run。
             *
             * 一次 run 有几十个簇，每簇一次受控生成。schema 不匹配、限流或超时若直接抛，
             * 已聚好的簇一起丢，重跑会在同一簇上同样失败。退回占位名只损失这一个主题的
             * 名字，日志点名该码，可单独复查。
             */
            nameTheme: async (input) => {
              try {
                const r = await nameTheme(input, { model: n.model, systemPrompt: n.systemPrompt });
                await recordUsage?.({
                  agent: n.model.agent,
                  model: n.model.modelName,
                  promptTokens: r.usage.promptTokens,
                  completionTokens: r.usage.completionTokens,
                  reasoningTokens: r.usage.reasoningTokens,
                });
                return r.theme;
              } catch (err) {
                console.warn(
                  `[research-runtime] Namer 在码 ${input.needPainCode} 上失败，退占位名：` +
                    `${err instanceof Error ? err.message : String(err)}`,
                );
                // 名字带码 + 「未命名」，图上可区分出这不是模型起的名。
                return {
                  name: `${input.needPainCode}·未命名`,
                  definition: "",
                  include: "",
                  exclude: "",
                };
              }
            },
          }
        : {}),
    };
  };

  /*
   * ④ POC 缺省合同。快照挂在合同上，合同的八个字段声明"这次研究要回答什么"。
   * 先声明再分析：行动规则须事先声明，避免事后从图里读出支持既定结论的方向。
   */
  const defaultContractId = await ensureDefaultContract(repo, book.version);

  /**
   * 当前证据矩阵快照的 `inputs_hash`，即当前口径（G5）。
   *
   * 洞察卡落库时抄一份，界面拿卡上那份与这一份比：不等表示卡基于旧口径写成，
   * 上面的数字可能不再支持它。没有快照时回 null（合同还没算过矩阵），卡片标「口径未知」。
   */
  const currentInputsHash = async (contractId: string): Promise<string | null> => {
    const snap = (await repo.snapshots.latest(contractId, "evidence-matrix")) as { inputsHash?: string } | null;
    return snap?.inputsHash ?? null;
  };

  /**
   * 一个需求码下的全部主题。C1–C5 共用这一个口径，保证各能力作用在同一组主题上。
   */
  const themesByCode = async (code: string): Promise<Array<{ id: string; name: string }>> =>
    (await repo.themes.list(book.version))
      .filter((t) => t.needPainCode === code)
      .map((t) => ({ id: t.id, name: t.name }));

  /*
   * ACP 面：回调面与描述符。
   *
   * 扩展是否加载看 `/health` 的 `acp.describeCalls`：≥ 1 说明
   * `pi-research/.pi/extensions/` 生效。pi 对未信任项目静默忽略扩展目录，
   * 此时模型手里零工具且不报错。
   *
   * `toolsEndpoint` 必须是 `127.0.0.1`：本进程没有鉴权（见 `internal-api` 文件头），
   * 这两条路径只供本机的 pi 子进程调用。
   */
  const challengerTransport = readChallengerTransport(process.env);
  const researchApp = createResearchApp({ toolsEndpoint: `http://127.0.0.1:${port}` });

  /*
   * `direct` 下不建池：建池会多起一个拉工具表、占着 node 进程却无人发 prompt 的
   * pi 子进程。由 `RESEARCH_CHALLENGER_TRANSPORT` 决定。
   *
   * 凭据由父进程注入，与车主面一致：pi 子进程不自己读配置 DB，
   * 避免出现第三份配置缓存而破坏热生效语义。
   */
  const acpPool =
    challengerTransport === "acp"
      ? new AcpClientPool({
          app: researchApp,
          env: {
            ...(apiKey ? { DEEPSEEK_API_KEY: apiKey } : {}),
            ...(dashscopeKey ? { DASHSCOPE_API_KEY: dashscopeKey } : {}),
          },
        })
      : undefined;

  /*
   * 反解注入给回调面：工具调用从 pi 侧回来时只带 pi 会话 id，而取数按挑战键挂。
   * 没有反解时端点只能回落到"库里恰好只挂着一个会话"，并发两张卡时一律回
   * "挑战会话已结束"，工具全部失灵。
   */
  const researchTools = createResearchToolsEndpoint(
    acpPool ? { resolveSession: (id) => acpPool.resolveSession(id) } : {},
  );

  /** Challenger 探查跳的 ACP 接线。`sessionKey` 由 `challengeOne` 按卡补。 */
  const challengerAcp = acpPool
    ? {
        streamer: createAcpStreamer(
          acpPool.clientFor("challenger"),
          // 会话键即 thread id（`exploreAcp` 按 `hooks.threadId` 传下来）：
          // 一个挑战键一个 pi 会话，追问因此落回同一个会话继续查。
          (hooks) => ({ cabinhugSessionId: hooks?.threadId ?? "challenge:unknown", agent: "challenger" }),
          researchApp.piDir,
        ),
        stepsOf: (key: string) => researchTools.stepsForKey(key),
        timeoutMs: readChallengerAcpTimeoutMs(process.env),
      }
    : undefined;

  /** 登记与摘除挑战会话。两个调用点（图批量、C6/C7）共用这一份。 */
  const acpSessions = acpPool
    ? {
        register: (key: string, deps: ChallengeToolDeps) =>
          researchTools.registerChallengeSession(key, deps),
        release: (key: string) => researchTools.release(key),
      }
    : undefined;

  if (acpPool) {
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => acpPool.dispose());
  }

  console.log(
    `[research-runtime] ACP 描述符已装配：agents=${researchApp.agents.join(",")} ` +
      `piDir=${researchApp.piDir} binDir=${researchApp.binDir}；` +
      `Challenger 探查跳 transport=${challengerTransport}`,
  );

  /**
   * `✎` 层的运行台账。进程内，不落库，理由见 `capabilities/runs.ts` 文件头。
   */
  const capabilityRuns = createCapabilityRuns();

  /**
   * Challenger 的一整套注入件（模型 + 提示词 + 四个只读工具的取数）。
   *
   * 整 run 批量与单卡触发（C6/C7）共用这一个装配，保证 `measurementPassed` 与
   * `minCellVehicles` 两个口径在两条路径上一致，同一张卡不会被挑出不同结论。
   */
  const challengeDepsFor = (window: { from: number; to: number }): ChallengeDeps | null =>
    agents
      ? {
          model: agents.challenger.model,
          systemPrompt: agents.challenger.systemPrompt,
          repo,
          codebookVersion: book.version,
          // 三个取数回调的真实现；缺了它们，四个工具中有三个在首次调用时抛错。
          ...createChallengeToolDeps({
            repo,
            book,
            window,
            minCellVehicles: Number(values.get("RESEARCH_MIN_CELL_VEHICLES") ?? 10),
            // 一致率未测 → measurement 门必 fail → 象限底色关着。
            measurementPassed: false,
          }),
          /*
           * 探查跳的跑法。装配层只给跑法，会话键由 `challengeOne` 按卡补上，
           * 装配层拿不到 insightId。
           */
          transport: challengerTransport,
          ...(challengerAcp ? { acp: challengerAcp } : {}),
        }
      : null;

  /**
   * 「问它」三个 Agent 各自的探查跳接线。
   *
   * # 每个 Agent 各一条 streamer
   *
   * 选哪个 pi 进程由两处决定，都不在 `exploreAcp` 的入参里：
   * `acpPool.clientFor(agent)` 决定进程（工具表是进程级的），
   * `createAcpStreamer` 的 `resolve` 回调决定这一轮算在哪个 Agent 头上
   * （会话键、用量归因）。共用 Challenger 那一条会把 analyst 的问题发进
   * challenger 的进程，拿到的是另一组工具（见 `pool.ts` 文件头）。
   *
   * 惰性建并缓存：`clientFor` 本身按 Agent 记忆化，这里再记一层，
   * 让会话映射回调（带着 agent 名）保持稳定，不每次提问新造闭包。
   */
  const askStreamers = new Map<AskAgentName, ReturnType<typeof createAcpStreamer>>();
  const askAcpFor = (agent: AskAgentName) => {
    if (!acpPool) return null;
    let streamer = askStreamers.get(agent);
    if (!streamer) {
      streamer = createAcpStreamer(
        acpPool.clientFor(agent),
        // 会话键即 thread id（`exploreAcp` 按 `hooks.threadId` 传下来）：
        // 一个 ask 键一个 pi 会话，同一范围的追问因此落回同一个会话继续查。
        (hooks) => ({ cabinhugSessionId: hooks?.threadId ?? `ask:${agent}:unknown`, agent }),
        researchApp.piDir,
      );
      askStreamers.set(agent, streamer);
    }
    return streamer;
  };

  /**
   * 一次提问的工具取数。必须带 `contractId`。
   *
   * 不带时 `lensSnapshot` 恒回 null，analyst 的 `lensQuery` 读成"这张镜头还没算过"，
   * 该工具恒报无数据且不报错。
   */
  const askToolDepsFor = (contractId: string, window: { from: number; to: number }): ChallengeToolDeps => ({
    repo,
    codebookVersion: book.version,
    ...createChallengeToolDeps({
      repo,
      book,
      window,
      minCellVehicles: Number(values.get("RESEARCH_MIN_CELL_VEHICLES") ?? 10),
      // 与 challengeAll / lookup 两处同一个理由：一致率未测 → measurement 门必 fail。
      measurementPassed: false,
      contractId,
    }),
  });

  /** 一个合同的时间窗。窗口只有合同说了算（同 `lookup`）。 */
  const contractWindow = async (contractId: string): Promise<{ from: number; to: number } | null> => {
    const row = (await repo.contracts.byId(contractId)) as
      | { windowFrom?: bigint; windowTo?: bigint }
      | null;
    if (!row) return null;
    return { from: Number(row.windowFrom ?? 0), to: Number(row.windowTo ?? Date.now()) };
  };

  /**
   * 「问它」的备料：把范围翻成模型看得懂的一句话 + 几行已知数字。
   *
   * 被抑制的格只给"样本不足"：明细在快照阶段已清空，这里补数字会绕过 G1
   * （能力条上 ask 本就不出现在抑制格上，这里是第二道）。
   */
  const askContextFor = async (scope: SelectionScope, contractId: string): Promise<AskContext | null> => {
    const facts: string[] = [];
    const needPainOf = (code: string): string =>
      book.axes.find((a) => a.id === "need_pain")?.codes.find((c) => c.id === code)?.definition ?? "";

    if (scope.kind === "cell" || scope.kind === "row") {
      const definition = needPainOf(scope.needPainCode);
      if (definition) facts.push(`需求码 ${scope.needPainCode} 的定义：${definition}`);
    }

    if (scope.kind === "cell") {
      if (scope.suppressed) {
        facts.push("这一格被小单元抑制：明细已在快照阶段清空，没有 n / N / pct 可读");
      } else {
        const snap = (await repo.snapshots.latest(contractId, "evidence-matrix")) as
          | { data?: EvidenceMatrixData }
          | null;
        if (!snap?.data) return null;
        const row = snap.data.rows.find((r) => r.code === scope.needPainCode);
        /*
         * 被抑制的格在快照里是 `{ suppressed: true, reason }`，没有 scene，按场景找不到。
         * 找不到与被抑制合成同一句话：两者对模型的意义相同，都是这一格没有可读的数字。
         */
        let cell: EvidenceCell | undefined;
        // 用循环而不是 `find`：`find` 的谓词不给类型收窄，抑制格与正常格在
        // `MaybeSuppressed<EvidenceCell>` 上是两个分支，收窄要发生在 `if` 里。
        for (const c of row?.cells ?? []) {
          if (c.suppressed !== true && c.scene === scope.sceneCode) cell = c;
        }
        if (cell) {
          facts.push(
            `这一格：n=${cell.n}、N=${cell.N}、pct=${(cell.pct * 100).toFixed(1)}%、` +
              `反例 ${cell.counter} 条、方向 ${cell.direction}`,
          );
          facts.push(`这一行（${row?.label ?? scope.needPainCode}）证据总量 ${row?.total ?? 0}`);
        } else {
          facts.push("这一格在最新快照里没有可读的明细（被抑制或这一格是空的）");
        }
      }
      return {
        headline: `证据矩阵上 ${scope.needPainCode} × ${scope.sceneCode} 这一格（研究合同 ${contractId}）`,
        facts,
      };
    }

    if (scope.kind === "row") {
      const themes = (await repo.themes.list(book.version)).filter((t) => t.needPainCode === scope.needPainCode);
      facts.push(
        themes.length > 0
          ? `这一行下的主题：${themes.map((t) => `${t.name}（${t.id}）`).join("、")}`
          : "这一行下还没有聚出主题",
      );
      return { headline: `证据矩阵上 ${scope.needPainCode} 这一整行（研究合同 ${contractId}）`, facts };
    }

    if (scope.kind === "card") {
      const row = (await repo.insights.byId(scope.insightId)) as
        | { themeId?: string; level?: string; card?: { claim?: string; evidence?: string; boundary?: string } | null }
        | null;
      if (!row) return null;
      const card = row.card ?? {};
      facts.push(`命题：${card.claim ?? ""}`);
      if (card.evidence) facts.push(`它给的证据：${card.evidence}`);
      if (card.boundary) facts.push(`它声明的边界：${card.boundary}`);
      if (row.themeId) facts.push(`主题 id：${row.themeId}`);
      if (row.level) facts.push(`等级：${row.level}（等级由人决定，不在你这一跳里改）`);
      return { headline: `洞察卡 ${scope.insightId}（研究合同 ${contractId}）`, facts };
    }

    /*
     * 整屏（及理论上到不了这里的整列）：只给合同与码表版本。
     * 整屏数字全铺进 brief 时，模型会照着 brief 讲话而不调工具。
     */
    const locked = (await repo.codebooks.byVersion(book.version))?.lockedAt != null;
    facts.push(`码表版本 v${book.version}（${locked ? "已锁版" : "未锁版"}）`);
    return { headline: `研究合同 ${contractId} 的这一屏`, facts };
  };

  /*
   * ⑤ 研究图与 review。
   *
   * 图只在需要人的时候停（codebook 未锁）。升级与售后放行是对已产出洞察的决定，
   * 走独立端点，不占一条图的执行。
   *
   * 检查点与 agent-runtime 共表，靠 `thread_id` 的 `research:` 前缀隔开；
   * `setup()` 幂等，实测既有 387 条检查点前后不变。
   */
  const { PostgresSaver } = await import("@langchain/langgraph-checkpoint-postgres");
  const checkpointer = dbUrl ? PostgresSaver.fromConnString(dbUrl) : null;
  if (checkpointer) await checkpointer.setup();

  const graphApp = checkpointer
    ? buildResearchGraph({
        analyze: async ({ contractId, windowFrom, windowTo }) => {
          const out = await runResearch({
            repo, book, contractId, windowFrom, windowTo,
            minCellVehicles: Number(values.get("RESEARCH_MIN_CELL_VEHICLES") ?? 10),
            agreement: null,
            codebookLocked: stored?.lockedAt != null,
            ...(await themeMaterials({ from: windowFrom, to: windowTo })),
          });
          return { turns: out.turns, themes: out.themes };
        },
        /*
         * Synthesizer 按主题出卡；没有主题（缺嵌入 key）时就是 0 张，不按需求码硬凑。
         *
         * 缺 key 时 `agents` 为 null：整段跳过并打一行日志，不让每个主题各失败一次
         * （与队列"缺 key 不注册消费者"一致）。
         */
        synthesizeAll: async ({ contractId, windowFrom, windowTo }) => {
          if (!agents) {
            console.warn("[research-runtime] 缺 DEEPSEEK_API_KEY——Synthesizer 跳过，本次 0 张洞察卡");
            return [];
          }
          return synthesizeAll({
            repo,
            book,
            contractId,
            window: { from: windowFrom, to: windowTo },
            deps: agents.synthesizer,
            recordUsage,
            /*
             * 这批卡基于哪份快照（G5）。此刻 `analyze` 已写完快照，读回的就是本次 run
             * 的那一份。读不到落 null，即口径未知。
             */
            inputsHash: await currentInputsHash(contractId),
            // 一致率未测（尚无 gold set），传 null。
            agreement: null,
            maxThemes: Number(values.get("RESEARCH_SYNTH_MAX_THEMES") ?? 0) || undefined,
          });
        },
        challengeAll: async (insightIds, { windowFrom, windowTo }) => {
          const deps = challengeDepsFor({ from: windowFrom, to: windowTo });
          if (!deps) {
            console.warn("[research-runtime] 缺 DEEPSEEK_API_KEY——Challenger 跳过，本次 0 条挑战记录");
            return 0;
          }
          return challengeAll(insightIds, {
            repo,
            window: { from: windowFrom, to: windowTo },
            deps,
            recordUsage,
            ...(acpSessions ? { acpSessions } : {}),
          });
        },
        gate: async (insightIds, { contractId }) => {
          const out = await gateAll(insightIds, { repo, contractId });
          console.log(`[research-runtime] gate：${out.note}`);
          return { note: out.note };
        },
        isCodebookLocked: async () => (await repo.codebooks.byVersion(book.version))?.lockedAt != null,
      }).compile({ checkpointer })
    : null;

  /** 运行 id → thread。`GET runs/:id` 与 resume 都按它找。 */
  const threads = new Map<string, string>();

  const reviewDeps: ReviewDeps | undefined = graphApp
    ? {
        repo,
        codebookVersion: book.version,
        lockCodebook: async (v) => repo.codebooks.lock(v),
        createReminder: async (r) => {
          const row = await prisma.vehicleReminder.create({
            data: {
              id: `rem-research-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              userId: r.userId, vin: r.vin, kind: r.kind, message: r.message,
              basis: r.basis, degraded: false,
            },
            select: { id: true },
          });
          return row;
        },
        invalidateReminder: async (id) => {
          await prisma.vehicleReminder.update({ where: { id }, data: { invalidatedAt: new Date() } });
        },
        pendingInterrupts: async () => {
          const out: Array<{ threadId: string; kind: string; subject: string; missing: string }> = [];
          /*
           * 线程清单从检查点表读，不从内存的 `threads` 读。
           *
           * `threads` 是进程内的 Map，重启即空；挂起项持久在 PG 的 `checkpoints` 里。
           * 只认内存时 `GET review` 在重启后回 `{"pending":[]}`。
           *
           * 同时避免别名重复：`threads` 里一条线程有两个键（`inputsHash` 与
           * `<窗口>`），遍历 values 会让同一个挂起项出现两次。
           */
          const rows = await prisma.$queryRaw<Array<{ thread_id: string }>>`
            SELECT DISTINCT thread_id FROM checkpoints WHERE thread_id LIKE 'research:%'
          `;
          for (const { thread_id: threadId } of rows) {
            const st = await graphApp.getState({ configurable: { thread_id: threadId } });
            for (const task of st.tasks ?? []) {
              for (const it of task.interrupts ?? []) {
                const v = it.value as { kind?: string; subject?: string; missing?: string };
                out.push({
                  threadId,
                  kind: v?.kind ?? "unknown",
                  subject: v?.subject ?? "",
                  missing: v?.missing ?? "",
                });
              }
            }
          }
          return out;
        },
        resumeThread: async (threadId, payload) => {
          const { Command } = await import("@langchain/langgraph");
          await graphApp.invoke(new Command({ resume: payload }), { configurable: { thread_id: threadId } });
        },
      }
    : undefined;


  // ⑥ 只绑 127.0.0.1：本进程没有鉴权，鉴权由网关代理负责。
  const startedAt = Date.now();
  const server = createInternalApi({
    repo,
    book,
    startedAt,
    tools: researchTools,
    /*
     * `configured` 仅在池建成时为 true（direct 下回调面在，但没有 pi 进程调用它）。
     * 冒烟脚本按它等服务就绪，所以 direct 下必须报 false。
     */
    acpHealth: () => ({
      configured: acpPool !== undefined,
      ...(acpPool ? { processes: acpPool.getHealth().processes } : {}),
      describeCalls: researchTools.stats().describeCalls,
      invokeCalls: researchTools.stats().invokeCalls,
    }),
    queues: () => ({ ...registered }),
    codebookLocked: () => stored?.lockedAt != null,
    currentInputsHash,
    defaultContractId: () => defaultContractId,
    review: reviewDeps,
    runState: async (runId) => {
      /*
       * 先查能力运行：它们在内存里，不在检查点表里。能力的 runId 带 `cap-` 前缀，
       * 先查内存可省一次数据库往返。
       */
      const cap = capabilityRuns.state(runId);
      if (cap) return cap;

      const threadId = threads.get(runId) ?? runId;
      if (!graphApp) return null;
      const st = await graphApp.getState({ configurable: { thread_id: threadId } });
      if (!st.createdAt) return null;
      const values = st.values as { stage?: string; notes?: string[] };
      return {
        stage: values?.stage ?? "unknown",
        notes: values?.notes ?? [],
        pending: (st.tasks ?? []).flatMap((t) => (t.interrupts ?? []).map((i) => i.value)),
      };
    },

    /**
     * 这次运行用了多少 token（G7）。
     *
     * 口径：这条线程的检查点建立之后、`sessionId = "research"` 的用量行。
     * `llm_usage` 没有 run 列且不为研究面改表，只能按时间圈。
     * 同一时刻并发两个窗口时，两条流会各自报出两次运行的合计；
     * POC 下 `thread_id` 由合同 + 窗口定、一次只跑一个窗，接受这一局限。
     */
    runUsage: async (runId) => {
      /*
       * 能力运行的用量由它自己累加，不按时间圈 `llm_usage`：一次 C1 只有几秒到一分钟，
       * 按时间圈会混入同窗口里别的调用，而每次 `synthesize` 的 usage 都经过本进程。
       */
      const cap = capabilityRuns.get(runId);
      if (cap) return cap.usage;

      if (!graphApp) return null;
      const threadId = threads.get(runId) ?? runId;
      const config = { configurable: { thread_id: threadId } };
      const st = await graphApp.getState(config);
      if (!st.createdAt) return null;

      /*
       * 起点取最早的检查点，不取 `getState()` 给的那个：后者是运行结束时写的最新
       * 检查点，拿它当 since 求和恒为 0。
       */
      let since = new Date(st.createdAt);
      for await (const snap of graphApp.getStateHistory(config)) {
        if (snap.createdAt) since = new Date(snap.createdAt);
      }

      const out = await usage.summary({
        dimension: "model",
        since,
        sessionId: "research",
      });
      return {
        totalTokens: out.total.promptTokens + out.total.completionTokens,
        models: out.buckets.map((b) => b.key),
      };
    },

    /**
     * C9 的取数。矩阵快照、窗内系统事件、codebook 锁态三样都从库里读回已算好的那一份：
     * 红队规则不重算任何数字，保证同一个窗上只有一套读数。
     */
    capabilities: {
      redTeamInput: async (contractId) => {
        const snap = (await repo.snapshots.latest(contractId, "evidence-matrix")) as {
          data?: unknown;
          windowFrom?: bigint;
          windowTo?: bigint;
          codebookVersion?: string;
        } | null;
        if (!snap?.data) return null;
        const from = Number(snap.windowFrom ?? 0);
        const to = Number(snap.windowTo ?? Date.now());
        const version = snap.codebookVersion ?? book.version;
        const events = (await repo.systemEvents.inWindow({ from, to })) as Array<{
          kind: string;
          at: number | bigint;
          key: string | null;
          summary: string;
          sourceRef: string;
        }>;
        const row = await repo.codebooks.byVersion(version);
        return {
          matrix: snap.data as EvidenceMatrixData,
          window: { from, to },
          systemEvents: events.map((e) => ({ ...e, at: Number(e.at) })) as ResearchSystemEvent[],
          codebookLockedAt: row?.lockedAt ? row.lockedAt.getTime() : null,
          codebookVersion: version,
        };
      },

      /**
       * C2–C5 的取数。按合同装配，因为这四条要的窗口由合同决定。
       *
       * 三个回调直接来自 `createChallengeToolDeps`，与 Challenger 的四个工具同一份实现，
       * 保证 `thresholdSensitivity` 的象限口径只有一套。
       */
      lookup: async (contractId) => {
        const row = (await repo.contracts.byId(contractId)) as {
          windowFrom?: bigint;
          windowTo?: bigint;
          codebookVersion?: string;
        } | null;
        if (!row) return null;

        const lookupWindow = { from: Number(row.windowFrom ?? 0), to: Number(row.windowTo ?? Date.now()) };
        const version = row.codebookVersion ?? book.version;
        if (version !== book.version) {
          /*
           * 当前到不了这里（启动时 `assertCodebookConsistent` 已核对，库里只有一版）。
           * 若到了，主题按合同版本查、象限口径用进程加载的版本，两版混算不报错，
           * 所以在这里打警告。
           */
          console.warn(
            `[research-runtime] 合同 ${contractId} 的 codebook 是 v${version}，进程加载的是 v${book.version}——` +
              "主题按前者查、阈值象限按后者算，两者不同源",
          );
        }

        return {
          window: lookupWindow,
          tools: createChallengeTools({
            repo,
            codebookVersion: version,
            ...createChallengeToolDeps({
              repo,
              book,
              window: lookupWindow,
              minCellVehicles: Number(values.get("RESEARCH_MIN_CELL_VEHICLES") ?? 10),
              // 与 challengeAll 那处同一个理由：一致率未测 → measurement 门必 fail。
              measurementPassed: false,
            }),
          }),

          /*
           * 一个需求码下的全部主题，不只取证据量最大的那个。
           * 实测 36 个主题落在 10 个码上、每码 2–4 个、没有 null，合并的代价最多是
           * 4 次工具调用；只取一个会丢掉同码下其余主题且不报错。
           */
          themesByCode: async (code) =>
            (await repo.themes.list(version))
              .filter((t) => t.needPainCode === code)
              .map((t) => ({ id: t.id, name: t.name })),
        };
      },

      /** C1 的运行台账。 */
      runs: capabilityRuns,

      /**
       * C1 的取数与落库。
       *
       * `writeCard` 直接调 `synthesizeOne`，与整 run 批量出卡同一个函数，保证
       * `level` 写死 `signal`、`InsightBoundaryError`、`recordUsage` 在两条路径上都生效。
       */
      summarizeCell: agents
        ? {
            themesByCode,
            currentInputsHash,
            writeCard: async ({ runId, contractId, themeId, inputsHash }) => {
              const row = (await repo.contracts.byId(contractId)) as {
                windowFrom?: bigint;
                windowTo?: bigint;
              } | null;
              if (!row) throw new Error(`合同 ${contractId} 不在——出卡的窗口取自它`);
              const window = { from: Number(row.windowFrom ?? 0), to: Number(row.windowTo ?? Date.now()) };

              const theme = (await repo.themes.list(book.version)).find((t) => t.id === themeId);
              if (!theme) throw new Error(`主题 ${themeId} 不在了——可能上一次 run 重聚过簇`);

              /*
               * 这几张表是 `synthesizeOne` 要的整窗上下文。批量出卡时算一次供所有主题用；
               * 单格触发时每张卡各算一次，一格最多四张，实测整窗 1,482 单元，代价可接受。
               * 不做记忆化，保证数据的读取时刻确定。
               */
              const turns = await repo.units.codedTurns(window, book.version);
              const events = await repo.systemEvents.inWindow(window);

              return synthesizeOne({
                repo,
                book,
                contractId,
                window,
                deps: agents.synthesizer,
                // 一致率未测，传 null。
                agreement: null,
                inputsHash,
                /*
                 * 两处都记：`llm_usage` 那一份是长期账（按 agent / 模型分组），
                 * 运行台账那一份是这次点击的用量，运行面板当场显示（G7）。
                 */
                recordUsage: async (u) => {
                  capabilityRuns.addUsage(runId, u.promptTokens + u.completionTokens, u.model);
                  await recordUsage?.(u);
                },
                theme,
                totalTurns: new Set(turns.map((t) => t.turnId ?? t.unitId)).size,
                vinOf: new Map(turns.map((t) => [t.unitId, t.vin])),
                occurredAt: new Map(turns.map((t) => [t.unitId, t.occurredAt])),
                eventLines: events.map(
                  (e) => `${new Date(Number(e.at)).toISOString().slice(0, 10)} ${e.kind}：${e.summary}`,
                ),
                codeDefinition:
                  book.axes
                    .find((a) => a.id === "need_pain")
                    ?.codes.find((c) => c.id === theme.needPainCode)?.definition ?? "",
              });
            },
          }
        : undefined,

      /**
       * C6 / C7 的取数与落库。
       *
       * 窗口取自卡片所属的合同，不取调用方传的 `contractId`：卡是在某个窗上写成的，
       * 用另一个窗挑它，查出的反例与卡说的不是同一批数据。
       */
      challengeCard: agents
        ? {
            insightBrief: async (insightId) => {
              const row = (await repo.insights.byId(insightId)) as {
                themeId?: string;
                card?: { claim?: string } | null;
              } | null;
              if (!row) return null;
              const theme = (await repo.themes.list(book.version)).find((t) => t.id === row.themeId);
              return {
                // 取不到主题就用 id，保证进度文案不指错对象。
                themeName: theme?.name ?? row.themeId ?? insightId,
                claim: row.card?.claim ?? "",
              };
            },

            /*
             * 追问轮数 = 这张卡下 `payload.angle` 非空的记录数。
             * 判据只有 `isFollowUp` 一处，服务端与界面都读它。
             */
            countFollowUps: async (insightId) =>
              followUpRounds(await repo.challenges.forInsight(insightId)),

            runChallenge: async ({ runId, insightId, angle }) => {
              const row = (await repo.insights.byId(insightId)) as { contractId?: string } | null;
              if (!row?.contractId) return { written: 0, steps: 0, verdicts: [], missing: true as const };

              const contract = (await repo.contracts.byId(row.contractId)) as {
                windowFrom?: bigint;
                windowTo?: bigint;
              } | null;
              if (!contract) throw new Error(`合同 ${row.contractId} 不在——挑战的窗口取自它`);
              const window = { from: Number(contract.windowFrom ?? 0), to: Number(contract.windowTo ?? Date.now()) };

              const deps = challengeDepsFor(window);
              if (!deps) throw new Error("缺 DEEPSEEK_API_KEY——Challenger 起不来");

              return challengeOne(insightId, {
                repo,
                window,
                deps,
                // 一次点击一个 runId——追问的轮数按它数，不按记录条数（见 follow-up.ts）。
                runId,
                ...(angle ? { extraAngle: angle } : {}),
                /*
                 * 两处都记（同 C1）：`llm_usage` 那一份是长期账，
                 * 运行台账那一份是这次点击花了多少，面板当场要显示（G7）。
                 */
                recordUsage: async (u) => {
                  capabilityRuns.addUsage(runId, u.promptTokens + u.completionTokens, u.model);
                  await recordUsage?.(u);
                },
                ...(acpSessions ? { acpSessions } : {}),
              });
            },
          }
        : undefined,

      /**
       * C8 的取数与落库。不写 `research_codebooks`（G3）：产出是提案，
       * 采纳要开一个新版本，由人决定。
       */
      proposeCode: namer
        ? {
            catchAllThemes: async () =>
              (await repo.themes.list(book.version))
                .filter((t) => t.needPainCode === CATCH_ALL_CODE)
                .map((t) => ({
                  id: t.id,
                  name: t.name,
                  memberUnitIds: t.memberUnitIds,
                  counterUnitIds: t.counterUnitIds,
                })),

            textsByIds: (ids) => repo.units.textsByIds(ids),

            /**
             * 「会从哪几个现有码里吸走多少」。由代码算，不问模型。
             *
             * 判据是这批单元在 `need_pain` 轴上还挂着哪些别的码：
             * `other` 自己是分母不是分子，所以剔掉。
             */
            otherCodesFor: async (unitIds) => {
              if (unitIds.length === 0) return [];
              const rows = await repo.codings.forUnits(unitIds, book.version);
              const byCode = new Map<string, Set<string>>();
              for (const r of rows) {
                if (r.axis !== "need_pain" || r.code === CATCH_ALL_CODE) continue;
                // 按单元去重：同一个单元在同一个码上有两条 coding 时只数一个。
                (byCode.get(r.code) ?? byCode.set(r.code, new Set()).get(r.code)!).add(r.unitId);
              }
              return [...byCode.entries()]
                .map(([code, units]) => ({ code, units: units.size }))
                .sort((a, b) => b.units - a.units);
            },

            nameOne: async ({ runId, examples, counterExamples }) => {
              const out = await nameTheme(
                {
                  needPainCode: CATCH_ALL_CODE,
                  /*
                   * 喂给模型的是兜底桶自己的定义。这是 C8 与整 run 命名唯一的差别：
                   * 那边给某个真实码的定义，这里要模型看着归不上现有码的单元提一个新码。
                   */
                  codeDefinition:
                    book.axes.find((a) => a.id === "need_pain")?.codes.find((c) => c.id === CATCH_ALL_CODE)
                      ?.definition ?? "归不上现有需求码的其它诉求",
                  examples,
                  counterExamples,
                },
                namer,
              );
              // 两处都记用量（同 C1/C6）：长期账一份，这次点击的用量一份（G7）。
              capabilityRuns.addUsage(
                runId,
                out.usage.promptTokens + out.usage.completionTokens,
                out.usage.model,
              );
              await recordUsage?.(out.usage);
              return out.theme;
            },

            raise: async ({ proposalId, actor, proposal }) => {
              const row = await repo.decisions.record({
                kind: PROPOSAL_RAISED,
                subjectId: proposalId,
                /*
                 * 提出者是点按钮的研究员，不是模型：他的决定是"把这件事提上议程"，
                 * 不是"采纳"。`decided_by` 的语义是"谁决定的"，G2 治理链按这一列查，
                 * 所以不填 `system` 或模型名。
                 */
                decidedBy: actor,
                rationale: `兜底桶下「${proposal.themeName}」有 ${proposal.candidateUnits} 个单元归不上现有码，提议开「${proposal.codeName}」`,
                payload: proposal as unknown as Record<string, unknown>,
              });
              return row.id;
            },
          }
        : undefined,

      /**
       * C10–C12「问它」的取数与两跳。
       *
       * `agents && acpPool` 两个条件都要：收口跳直连模型（`agents`），
       * 探查跳只走 ACP（`acpPool`）。缺任何一个都留 undefined，
       * 端点回 503 `agents_not_available`，不给假 runId。
       */
      askAgent:
        agents && acpPool
          ? {
              context: async ({ scope, contractId }) => askContextFor(scope, contractId),
              runAsk: async ({ runId, agent, scope, contractId, question, round, sessionKey, context }) => {
                const window = await contractWindow(contractId);
                if (!window) throw new Error(`合同 ${contractId} 不在——提问的窗口取自它`);
                const streamer = askAcpFor(agent);
                if (!streamer) throw new Error("研究 Agent 池没起——「问它」只有 ACP 一条路");
                const toolDeps = askToolDepsFor(contractId, window);

                return ask(
                  { agent, scope, contractId, question, round, context },
                  {
                    streamer,
                    sessionKey,
                    stepsOf: (key) => researchTools.stepsForKey(key),
                    seenIdsOf: (key) => researchTools.seenIdsForKey(key),
                    timeoutMs: readChallengerAcpTimeoutMs(process.env),
                    model: agents.challenger.model,
                    /*
                     * 两处都记（同 C1/C6/C8）：`llm_usage` 那一份是长期账，
                     * 运行台账那一份是这次点击的用量，面板当场显示（G7）。
                     */
                    recordUsage: async (u) => {
                      capabilityRuns.addUsage(runId, u.promptTokens + u.completionTokens, u.model);
                      await recordUsage?.(u);
                    },
                    // 登记这一次提问的取数，与挑战共用同一张会话表（键不同，互不干扰）。
                    register: (key) => researchTools.registerChallengeSession(key, toolDeps),
                    release: (key) => researchTools.release(key),
                  },
                );
              },
            }
          : undefined,
    },
    /**
     * 一次研究运行，走整张图，不绕过图直接调 `runResearch`。
     *
     * 绕过图时 `synthesize` / `challenge` / `gate` 三个节点不执行，`review` 的
     * `interrupt()` 不可达、`GET review` 恒空，`threads` 不被 `.set()`、
     * `GET runs/:id` 恒 `run_not_found`。
     *
     * `runResearch` 的调用点只有图的 `analyze` 一处。
     */
    startRun: async ({ contractId, windowFrom, windowTo }) => {
      if (!graphApp) {
        throw new Error(
          "research_graph_unavailable: 缺 DATABASE_URL，检查点与图都没起——只读端点可用，但跑不了 run",
        );
      }

      /*
       * thread_id 由合同 + 窗口定，不用随机数：同一个窗重跑落回同一条线程，
       * 停在 review 的挂起项才接得上。
       */
      const threadId = researchThreadId(contractId, `${windowFrom}-${windowTo}`);
      const config = { configurable: { thread_id: threadId } };

      const before = (await repo.snapshots.latest(contractId, "evidence-matrix")) as
        | { inputsHash?: string }
        | null;

      await graphApp.invoke({ contractId, windowFrom, windowTo }, config);

      const st = await graphApp.getState(config);
      const v = (st.values ?? {}) as {
        stage?: string;
        turns?: number;
        themes?: number;
        insights?: string[];
        challenges?: number;
        notes?: string[];
      };

      /*
       * `inputsHash` 由 `runResearch` 在 analyze 里算并写进快照，图状态里没有它。
       * 它是快照的属性，所以从快照读回，不在图状态上加字段。
       */
      const after = (await repo.snapshots.latest(contractId, "evidence-matrix")) as
        | { inputsHash?: string }
        | null;
      const inputsHash = after?.inputsHash ?? "";
      const reused = before?.inputsHash !== undefined && before.inputsHash === inputsHash;

      /*
       * 端点把 `inputsHash` 当 runId 回给调用方（既有契约，不改），
       * 所以两个键都指向同一条线程，`GET runs/:id` 才能用回给它的 id 查到。
       */
      threads.set(inputsHash, threadId);
      threads.set(`${windowFrom}-${windowTo}`, threadId);

      console.log(
        `[research-runtime] run ${inputsHash.slice(0, 12)}…（${threadId}）：` +
          `${v.turns ?? 0} 轮 / ${v.themes ?? 0} 主题 / ${v.insights?.length ?? 0} 张卡 / ` +
          `${v.challenges ?? 0} 条挑战，stage=${v.stage ?? "unknown"}` +
          `${reused ? "，命中已有快照未重算" : ""}`,
      );

      // 既有字段 `inputsHash` / `reused` 不删，只增。
      return {
        inputsHash,
        reused,
        threadId,
        stage: v.stage ?? "unknown",
        turns: v.turns ?? 0,
        themes: v.themes ?? 0,
        insights: v.insights?.length ?? 0,
        challenges: v.challenges ?? 0,
        notes: v.notes ?? [],
      };
    },
  });
  server.on("error", (err) => console.error(`[research-runtime] 端口 :${port} 起不来：${err.message}`));
  server.listen(port, "127.0.0.1", () => {
    console.log(`[research-runtime] 内部端点 http://127.0.0.1:${port}/health`);
  });
}

/** 造数窗口是过去 90 天；合同窗口跟着它，否则镜头会算一个空窗。 */
const CONTRACT_WINDOW_DAYS = 90;

/**
 * POC 缺省合同（幂等）。已有 active 合同就用它，不重复建。
 *
 * 八个字段按方法本体 §02 填满，其中 `actionRule` 事先声明"出现什么结果就做什么"，
 * 事后补写无效。
 */
async function ensureDefaultContract(repo: ReturnType<typeof createResearchRepository>, codebookVersion: string): Promise<string> {
  const existing = await repo.contracts.list("active");
  if (existing.length > 0) return existing[0].id;

  const to = Date.now();
  const from = to - CONTRACT_WINDOW_DAYS * 86_400_000;
  const row = await repo.contracts.create({
    title: "已授权车主 · 用车痛点 · 近 90 天",
    decision: "下一个 Sprint 优先改哪一类用车体验（提示词 / 知识库 / 工具 / 售后线索）",
    populationTarget: "国内新能源乘用车车主",
    // 实际观察到的总体由 populationOf 实时算并写进每份快照；这里记的是口径。
    populationObserved: { note: "已授权且未标记 research_excluded 的车主，逐快照实算" },
    object: "需求与痛点主题 × 用车场景",
    horizon: `近 ${CONTRACT_WINDOW_DAYS} 天`,
    evidenceBar: "每格 n/N 双写、分母可显示、反例已检索；观察总体 ≥ 10 台车才出方向",
    exclusions: { userFlags: ["research_excluded"], sources: ["mocks.*", "mem0", "llm_usage", "audit_logs"] },
    freshness: "证据不早于窗口起点；跨 codebook 版本的编码不混算",
    actionRule:
      "某需求码在某场景的提及率 ≥ 10% 且表现度低于中位 → 进候选清单人工评审；" +
      "落在硬禁范畴的一律标不可交付、不进 roadmap；" +
      "分数只排序，不自动触发任何对个体的触达",
    windowFrom: from,
    windowTo: to,
    codebookVersion,
    createdBy: "system:research-runtime",
  });
  await repo.contracts.setStatus(row.id, "active");
  console.log(`[research-runtime] 建了 POC 缺省合同 ${row.id}`);
  return row.id;
}

// 被 import 时（测试）不启动。
const invokedDirectly = process.argv[1]?.endsWith("index.ts") === true;
if (invokedDirectly) {
  main().catch((err) => {
    console.error("[research-runtime] 启动失败", err);
    process.exit(1);
  });
}
