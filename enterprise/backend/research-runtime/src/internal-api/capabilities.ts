/**
 * 能力端点的受理逻辑。
 *
 * # G1 在服务端的落点
 *
 * 界面上的能力条由 `capabilitiesFor(scope)` 决定，本模块用同一个函数决定是否受理，
 * 保证被抑制的格上界面不给按钮、后端也不受理，绕过界面直接 POST 同样被拒。
 * G1 防的是"AI 按钮成为小单元抑制的侧门"，所以任何能力都先过它。
 *
 * # 没做的能力回 501，不回 404
 *
 * 404 表示调用方拼错了能力名，501 表示能力尚未实现，前端据此区分。
 * 501 的 body 里点名它属于哪张工单。
 *
 * # 不给假数据
 *
 * 未实现的能力不返回空结果或示例结构：形状正确的空对象会被界面渲染成
 * "跑过了，没发现什么"。
 */

import {
  ASK_AGENT_OF,
  ASK_MAX_ROUNDS,
  CAPABILITIES,
  askSessionKey,
  capabilitiesFor,
  redTeamChecklist,
  type AskCapabilityKey,
  type Capability,
  type CapabilityId,
  type RedTeamInput,
  type SelectionScope,
} from "@cabinhug/research";

import {
  DEFAULT_DELTAS,
  findCounterEvidence,
  sliceBySegment,
  systemEventsFor,
  thresholdSensitivity,
  type LookupDeps,
} from "../capabilities/lookup";
import { startSummarizeCell, type SummarizeCellDeps } from "../capabilities/summarize-cell";
import { startChallengeCard, type ChallengeCardDeps } from "../capabilities/challenge-card";
import { FOLLOW_UP_MAX_ROUNDS, screenAngle } from "../capabilities/follow-up";
import { askRoundsUsed, recordAskRound, startAskAgent, type AskAgentDeps } from "../capabilities/ask-agent";
import { CATCH_ALL_CODE, startProposeCode, type ProposeCodeDeps } from "../capabilities/propose-code";
import type { CapabilityRuns } from "../capabilities/runs";

export interface CapabilityDeps {
  /**
   * C9 的输入：当前窗口的证据矩阵快照 + 窗内系统事件 + codebook 锁态。
   *
   * 取数放在装配处：本模块不依赖仓储，只依赖"能力目录"和"红队规则"两个纯函数。
   * 快照不存在时返回 null。
   */
  redTeamInput(contractId: string): Promise<RedTeamInput | null>;

  /**
   * C2–C5 的取数。按合同装配：四条查类能力与 Challenger 的工具共用同一个窗口
   * 与同一份回调，窗口由合同决定。合同不存在时返回 null。
   */
  lookup(contractId: string): Promise<LookupDeps | null>;

  /**
   * `✎` 层的运行台账。缺省时 C1 回 503，不回假 runId（界面会订阅一条不存在的流）。
   */
  runs?: CapabilityRuns;
  /** C1 的取数与落库。与 `runs` 同时存在或同时缺省。 */
  summarizeCell?: SummarizeCellDeps;
  /** C6 / C7 的取数与落库。同上，缺省时回 503 而不是假 runId。 */
  challengeCard?: ChallengeCardDeps;
  /** C8 的取数与落库。同上。 */
  proposeCode?: ProposeCodeDeps;
  /**
   * C10–C12「问它」的取数与两跳。
   *
   * 缺省时三条 ask 回 503 `agents_not_available`，不给假 runId：这三条只走 ACP
   * （`RESEARCH_CHALLENGER_TRANSPORT=direct` 或没 key 时 `index.ts` 不建池）。
   */
  askAgent?: AskAgentDeps;
}

/** 每条能力属于哪张工单。501 的 body 点名它。 */
const WORKORDER_OF: Record<CapabilityId, string> = {
  c1: "M85-06",
  c2: "M85-05",
  c3: "M85-05",
  c4: "M85-05",
  c5: "M85-05",
  c6: "M85-07",
  c7: "M85-07",
  c8: "M85-08",
  c9: "M85-03",
  c10: "M89-03",
  c11: "M89-03",
  c12: "M89-03",
};

/*
 * 已实现的能力。这一行是前端可用性表的对账基准
 * （`console/test/capability-rail.test.ts` 逐字读它），所以必须留在一行上、
 * 全部 id 写成字面量：拆行或改用 `CAPABILITIES.filter(...)` 推导时对账读不出 id，
 * 无法检出"后端已实现、界面按钮仍灰"。
 */
const IMPLEMENTED: ReadonlySet<CapabilityId> = new Set(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "c11", "c12"]);

export interface CapabilityJson {
  status: number;
  body: unknown;
}

const byKeyOrId = new Map<string, Capability>();
for (const c of CAPABILITIES) {
  byKeyOrId.set(c.id, c);
  byKeyOrId.set(c.key, c);
}

/**
 * 把请求体里的 `scope` 收成 `SelectionScope`。
 *
 * 拒收而不补默认值：`suppressed` 缺省成 `false` 时，漏传字段的调用方会绕过 G1。
 */
export function parseScope(v: unknown): SelectionScope | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const str = (k: string): string | null => (typeof o[k] === "string" ? (o[k] as string) : null);
  const bool = (k: string): boolean | null => (typeof o[k] === "boolean" ? (o[k] as boolean) : null);

  switch (o.kind) {
    case "cell": {
      const needPainCode = str("needPainCode");
      const sceneCode = str("sceneCode");
      const suppressed = bool("suppressed");
      const catchAll = bool("catchAll");
      const hasDirection = bool("hasDirection");
      if (needPainCode === null || sceneCode === null || suppressed === null) return null;
      return {
        kind: "cell",
        needPainCode,
        sceneCode,
        suppressed,
        catchAll: catchAll ?? false,
        hasDirection: hasDirection ?? false,
      };
    }
    case "row": {
      const needPainCode = str("needPainCode");
      const suppressed = bool("suppressed");
      if (needPainCode === null || suppressed === null) return null;
      return { kind: "row", needPainCode, suppressed, catchAll: bool("catchAll") ?? false };
    }
    case "col": {
      const sceneCode = str("sceneCode");
      return sceneCode === null ? null : { kind: "col", sceneCode };
    }
    case "card": {
      const insightId = str("insightId");
      return insightId === null ? null : { kind: "card", insightId };
    }
    case "page":
      return { kind: "page" };
    default:
      return null;
  }
}

export interface CapabilityBody {
  scope?: unknown;
  contractId?: unknown;
  /** C2 一次取几条反例。缺省 10，`findCounterEvidence` 会再按 `TOOL_LIMIT_MAX` 封顶。 */
  limit?: unknown;
  /** C5 探哪几个 delta。缺省 `DEFAULT_DELTAS`。 */
  deltas?: unknown;
  /** C7 的追问角度。只进 Challenger 的 system 侧，不改 schema、不改判定口径。 */
  angle?: unknown;
  /**
   * C10–C12 的问句。必填字符串，过 `screenAngle` 同一道门。
   *
   * 与 `angle` 分开：角度进 Challenger 的调查方向，问句是研究员要的答案；
   * 共用字段时"追问还是提问"只能靠能力名反推。
   */
  question?: unknown;
  /**
   * 决定人（C8）。由路由从 `?actor=` 填入，不取客户端 body 里的值：
   * 客户端自己写 `actor` 等于自证身份。
   */
  actor?: unknown;
}

/**
 * 这个范围说的是哪个需求码。
 *
 * C2 / C4 / C5 都是"按码找主题再查"，而只有格与整行带码。
 * 返回 null 时调用方必须拒收，不能退回到"全部码"：那会把针对某一格的提问
 * 换成一次全表扫描。
 */
const codeOf = (scope: SelectionScope): string | null =>
  scope.kind === "cell" || scope.kind === "row" ? scope.needPainCode : null;

const readLimit = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 10);

/** body 里给了 deltas 就用它，否则跑缺省那一组。非数字一律丢掉，不静默当 0。 */
function readDeltas(v: unknown): readonly number[] {
  if (!Array.isArray(v)) return DEFAULT_DELTAS;
  const ns = v.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return ns.length > 0 ? ns : DEFAULT_DELTAS;
}

/**
 * 受理一次能力调用。
 *
 * 顺序固定：识别能力 → 解析范围 → 过闸门 → 分发。
 * 闸门在"未实现回 501"之前，保证被抑制的格上任何能力（含未实现的）都被闸门拒绝。
 */
export async function handleCapability(
  name: string,
  body: CapabilityBody,
  deps: CapabilityDeps | undefined,
  defaultContractId: string | null,
): Promise<CapabilityJson> {
  const capability = byKeyOrId.get(name);
  if (!capability) {
    return {
      status: 400,
      body: { error: "unknown_capability", hint: `能力只有这十二条：${CAPABILITIES.map((c) => c.key).join("、")}` },
    };
  }

  const scope = parseScope(body.scope);
  if (!scope) {
    return { status: 400, body: { error: "bad_scope", hint: "scope 缺字段或 kind 不认识；被抑制与否必须显式传" } };
  }

  // ── G1 的闸门。任何能力、任何时候，都从这里过。 ──
  const available = capabilitiesFor(scope).some((c) => c.id === capability.id);
  if (!available) {
    return {
      status: 400,
      body: {
        error: "capability_not_available",
        capability: capability.key,
        scope: scope.kind,
        hint:
          (scope.kind === "cell" || scope.kind === "row") && scope.suppressed
            ? "这一格被小单元抑制：明细已在快照阶段清空，任何能力都没有可读的输入"
            : "这条能力不在当前选中范围的能力条上",
      },
    };
  }

  if (!IMPLEMENTED.has(capability.id)) {
    return {
      status: 501,
      body: {
        error: "capability_not_implemented",
        capability: capability.key,
        workorder: WORKORDER_OF[capability.id],
        hint: `${capability.title} 由 ${WORKORDER_OF[capability.id]} 落地`,
      },
    };
  }

  if (!deps) return { status: 503, body: { error: "capabilities_not_available", hint: "缺 DATABASE_URL，取不到快照" } };

  const contractId = typeof body.contractId === "string" && body.contractId ? body.contractId : defaultContractId;
  if (!contractId) return { status: 400, body: { error: "contract_required" } };

  const ok = (result: unknown): CapabilityJson => ({
    status: 200,
    body: { capability: capability.key, tier: capability.tier, result },
  });

  if (capability.id === "c9") {
    const input = await deps.redTeamInput(contractId);
    if (!input) {
      // 没快照与"这一屏没问题"不同，不回同一个 200 空数组。
      return { status: 404, body: { error: "snapshot_not_found", hint: "这个合同还没算过证据矩阵，先 POST /runs" } };
    }
    return ok(redTeamChecklist(input));
  }

  /*
   * C1 是 `✎` 层：立即回 runId，后台执行（异步契约）。
   * `tier` 照回 `write`，前端据它决定开运行态面板还是就地渲染结果。
   */
  if (capability.id === "c1") {
    if (!deps.runs || !deps.summarizeCell) {
      return { status: 503, body: { error: "synthesis_not_available", hint: "缺 DEEPSEEK_API_KEY 或 DATABASE_URL" } };
    }
    const code = codeOf(scope);
    if (code === null) {
      return { status: 400, body: { error: "bad_scope", hint: "归纳的对象是一格，范围里必须有需求码" } };
    }
    const { runId } = startSummarizeCell(deps.runs, deps.summarizeCell, { contractId, needPainCode: code });
    return { status: 202, body: { capability: capability.key, tier: capability.tier, runId } };
  }

  if (capability.id === "c6" || capability.id === "c7") {
    return runChallenge(capability, scope, body, deps);
  }

  if (capability.id === "c10" || capability.id === "c11" || capability.id === "c12") {
    return runAsk(capability, scope, body, deps, contractId);
  }

  if (capability.id === "c8") {
    return runProposeCode(capability, scope, body, deps);
  }

  return runLookup(capability, scope, body, deps, contractId, ok);
}

/**
 * C6「挑战这张卡」与 C7「追问」的受理。
 *
 * 两条能力只差一个 `angle`，共用一个函数（与 `challengeOne` 同理），
 * "追问不改 schema、不改判定口径"只需在一处保证。
 *
 * 不读 `contractId`：窗口取自卡片所属合同（装配处读），避免用 A 合同的窗口
 * 去挑 B 合同的卡。
 */
async function runChallenge(
  capability: Capability,
  scope: SelectionScope,
  body: CapabilityBody,
  deps: CapabilityDeps,
): Promise<CapabilityJson> {
  if (!deps.runs || !deps.challengeCard) {
    return { status: 503, body: { error: "challenge_not_available", hint: "缺 DEEPSEEK_API_KEY 或 DATABASE_URL" } };
  }
  /*
   * `capabilitiesFor` 已把 c6/c7 限定在 `card` 上，这里仍显式判一次：
   * 闸门判的是"能力在不在能力条上"（随目录变化），这里要的是"有没有 insightId"。
   */
  if (scope.kind !== "card") {
    return {
      status: 400,
      body: { error: "bad_scope", capability: capability.key, hint: "挑战与追问的对象是一张已产出的洞察卡" },
    };
  }
  const insightId = scope.insightId;

  if (capability.id === "c6") {
    const { runId } = startChallengeCard(deps.runs, deps.challengeCard, { insightId });
    return { status: 202, body: { capability: capability.key, tier: capability.tier, runId } };
  }

  /*
   * ── C7：两道门，先数轮数、再看文本 ──
   *
   * 次数用尽时直接报次数用尽，不让用户先收到文本被拒的错误而改写措辞重试。
   */
  const used = await deps.challengeCard.countFollowUps(insightId);
  if (used >= FOLLOW_UP_MAX_ROUNDS) {
    return {
      status: 400,
      body: {
        error: "follow_up_limit_reached",
        capability: capability.key,
        used,
        limit: FOLLOW_UP_MAX_ROUNDS,
        hint:
          `同一张卡最多追问 ${FOLLOW_UP_MAX_ROUNDS} 次，这张已经追过 ${used} 次。` +
          "再问下去多半不是证据不够，而是这张卡本身该被重写",
      },
    };
  }

  const angle = typeof body.angle === "string" ? body.angle.trim() : "";
  const screened = await screenAngle(body.angle);
  if (!screened.ok) {
    return {
      status: 400,
      body: {
        error: "angle_rejected",
        capability: capability.key,
        ...(screened.ruleId ? { ruleId: screened.ruleId } : {}),
        hint: screened.reason,
      },
    };
  }

  const { runId } = startChallengeCard(deps.runs, deps.challengeCard, { insightId, angle });
  return {
    status: 202,
    body: {
      capability: capability.key,
      tier: capability.tier,
      runId,
      round: used + 1,
      limit: FOLLOW_UP_MAX_ROUNDS,
      /*
       * 如实带出审核层是否被跳过（与 G7 同一原则），界面据此区分
       * "过了审核"与"只过了规则筛"。
       */
      moderationSkipped: screened.moderationSkipped,
    },
  };
}

/**
 * C10–C12「问它」的受理。
 *
 * 与 C6/C7 共用 `screenAngle`（语义是"这段用户文本能否进模型"），但错误码换成
 * `question_rejected`：`angle_rejected` 对问句不合语义。`ruleId` / `reason` 原样透传。
 *
 * 两道门的顺序与 C7 一致：先数轮数、再看文本。
 */
async function runAsk(
  capability: Capability,
  scope: SelectionScope,
  body: CapabilityBody,
  deps: CapabilityDeps,
  contractId: string,
): Promise<CapabilityJson> {
  if (!deps.runs || !deps.askAgent) {
    return {
      status: 503,
      body: {
        error: "agents_not_available",
        capability: capability.key,
        hint:
          "研究 Agent 池没起——缺 DEEPSEEK_API_KEY，或 RESEARCH_CHALLENGER_TRANSPORT=direct。" +
          "「问它」只有 ACP 一条路，这里不给一个假的 runId（界面会去订阅一条永远不存在的流）",
      },
    };
  }

  const agent = ASK_AGENT_OF[capability.key as AskCapabilityKey];
  /*
   * 会话键在这里算一次，同时用于数轮数与 pi 会话复用，
   * 保证"还剩几轮"与"是否带上一轮上下文"一致。
   */
  const sessionKey = askSessionKey(agent, scope, contractId);

  const used = askRoundsUsed(sessionKey);
  if (used >= ASK_MAX_ROUNDS) {
    return {
      status: 400,
      body: {
        error: "ask_limit_reached",
        capability: capability.key,
        used,
        limit: ASK_MAX_ROUNDS,
        hint:
          `同一范围最多问 ${ASK_MAX_ROUNDS} 轮，这个范围已经问过 ${used} 轮。` +
          "再问下去多半不是查得不够，而是该换个范围或换个角色问",
      },
    };
  }

  const screened = await screenAngle(body.question);
  if (!screened.ok) {
    return {
      status: 400,
      body: {
        error: "question_rejected",
        capability: capability.key,
        ...(screened.ruleId ? { ruleId: screened.ruleId } : {}),
        reason: screened.reason,
        hint: screened.reason,
      },
    };
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  const round = recordAskRound(sessionKey);
  const { runId } = startAskAgent(deps.runs, deps.askAgent, {
    agent,
    scope,
    contractId,
    question,
    round,
    sessionKey,
  });
  return {
    status: 202,
    body: {
      capability: capability.key,
      tier: capability.tier,
      runId,
      round,
      limit: ASK_MAX_ROUNDS,
      // 如实带出审核层是否被跳过（同 C7），界面据此区分"过了审核"与"只过了规则筛"。
      moderationSkipped: screened.moderationSkipped,
    },
  };
}

/**
 * C8「从兜底桶提码」的受理。
 *
 * 产出是提案，不是新码。不写 codebook（G3）：采纳提案等于开一个新版本，由人决定。
 */
async function runProposeCode(
  capability: Capability,
  scope: SelectionScope,
  body: CapabilityBody,
  deps: CapabilityDeps,
): Promise<CapabilityJson> {
  if (!deps.runs || !deps.proposeCode) {
    return { status: 503, body: { error: "proposal_not_available", hint: "缺 DEEPSEEK_API_KEY 或 DATABASE_URL" } };
  }

  /*
   * 端点侧再挡一次「这不是兜底桶」。
   *
   * `capabilitiesFor` 已按 `catchAll` 过滤，但它判的是"能力在不在能力条上"，
   * 这里要确认对象确实是归不上码的那一堆。对真实需求码提码会产出一个与现有码
   * 几乎相同的提案，且不报错。
   */
  const code = codeOf(scope);
  if (scope.kind !== "row" || code !== CATCH_ALL_CODE) {
    return {
      status: 400,
      body: {
        error: "scope_not_supported",
        capability: capability.key,
        scope: scope.kind,
        hint: `提码的对象只能是兜底桶那一行（needPainCode = ${CATCH_ALL_CODE}）——` +
          "别的行已经有码了，对它提码只会提出一个和现有码几乎一样的",
      },
    };
  }

  /*
   * 决定人由网关经 `?actor=` 注入，不由请求体带。取不到时写 `unknown:unknown`，
   * 不填 `system`，避免无人负责的提案在待审队列里显得有人提过。
   */
  const actor = typeof body.actor === "string" && body.actor ? body.actor : "unknown:unknown";
  const { runId } = startProposeCode(deps.runs, deps.proposeCode, { actor });
  return { status: 202, body: { capability: capability.key, tier: capability.tier, runId, actor } };
}

/**
 * C2–C5 的分发。
 *
 * 与 C9 分开：红队清单要算好的快照，四条查类能力要合同窗口 + 按码找主题。
 * 分开后"没跑过 run"与"合同不存在"各有自己的 404，下一步动作不同。
 */
async function runLookup(
  capability: Capability,
  scope: SelectionScope,
  body: CapabilityBody,
  deps: CapabilityDeps,
  contractId: string,
  ok: (result: unknown) => CapabilityJson,
): Promise<CapabilityJson> {
  const lk = await deps.lookup(contractId);
  if (!lk) {
    return {
      status: 404,
      body: { error: "contract_not_found", hint: "查类能力的时间窗取自合同，合同不在就编不出一个来" },
    };
  }

  if (capability.id === "c3") return ok(await systemEventsFor(lk));

  const code = codeOf(scope);
  if (code === null) {
    /*
     * 只有 C4 会到这里：能力目录把它也开在整列上，而分群切分按主题做，
     * 主题只按需求码切、不带场景维度，整列横跨全部码，现有工具答不了。
     *
     * 回 400 并说明原因，不把该列全部主题合起来切：那样得出的是全窗的分群分布，
     * 与所选的列无关。支持整列需要给分群查询加场景维度（TD-32）。
     */
    return {
      status: 400,
      body: {
        error: "scope_not_supported",
        capability: capability.key,
        scope: scope.kind,
        hint: "分群切分按主题做，而主题只按需求码切、不带场景——整列答不了，请点具体的格或整行",
      },
    };
  }

  switch (capability.id) {
    case "c2":
      return ok(await findCounterEvidence(lk, code, readLimit(body.limit)));
    case "c4":
      return ok(await sliceBySegment(lk, code));
    default:
      return ok(await thresholdSensitivity(lk, code, readDeltas(body.deltas)));
  }
}
