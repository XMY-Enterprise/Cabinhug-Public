/**
 * 内部 HTTP 面。
 *
 * 核心断言是「响应体里没有 `content` 键」：那是 `messages` 表的列名，
 * 出现即说明原文进入了研究面的出口。出口用白名单挑字段而不是删字段，
 * 新增一列时默认不出现，这组测试覆盖该默认。
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { CAPABILITIES, type RedTeamInput } from "@cabinhug/research";

import { loadLatestCodebook } from "../src/codebook/load";
import { createInternalApi, publicUnit } from "../src/internal-api";
import { createCapabilityRuns } from "../src/capabilities/runs";
import { createResearchToolsEndpoint } from "../src/acp/tools-endpoint";
import { readChallengerTransport } from "../src/challenge/acp-transport";

const book = loadLatestCodebook(join(new URL("..", import.meta.url).pathname.replace(/\/$/, ""), "codebooks"));

/** 一行"库里的样子"，故意带上原文，出口必须把它挡掉。 */
const dbRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "unit-1",
  kind: "utterance",
  sourceId: "messages",
  userId: "u1",
  vin: "LSVAA1234567890AB",
  sessionId: "s1",
  turnId: "t1",
  messageId: "m1",
  occurredAt: 1_757_000_000_000n,
  textRedacted: "打 138****8000 给我",
  content: "打 13800138000 给我",
  features: null,
  context: { route: "ownership" },
  fingerprint: "fp1",
  displayLevel: "internal-redacted",
  role: "discovery",
  withdrawnAt: null,
  ...over,
});

const counterRow = dbRow({ id: "unit-2", occurredAt: 1_757_000_000_001n, textRedacted: "其实比我想的准" });

/** 内存假仓储，只实现 API 用到的那几个方法。 */
const repo = {
  contracts: { list: async () => [{ id: "c1", title: "用车痛点", status: "active" }] },
  units: {
    byId: async (id: string) => (id === "unit-1" ? dbRow() : null),
    listForApi: async (q: { polarity: string | null; limit: number }) =>
      q.polarity === "counter-example" ? [counterRow] : [dbRow(), counterRow],
  },
  codings: {
    forUnits: async () => [{ id: "c-1", unitId: "unit-1", axis: "scene", code: "charging" }],
  },
} as never;

/** C9 的输入：一份最小的证据矩阵快照。兜底桶故意占大头，好让规则有东西可报。 */
const redTeamInput = (): RedTeamInput => ({
  matrix: {
    scenes: [{ code: "charging", label: "充电补能", N: 100 }],
    rows: [
      {
        code: "cold-range-loss",
        label: "低温续航",
        total: 30,
        undeliverable: false,
        cells: [{ scene: "charging", n: 12, N: 100, pct: 0.12, bar: 1, direction: "flat", counter: 2, suppressed: false }],
      },
      {
        code: "other",
        label: "其它",
        total: 70,
        undeliverable: false,
        cells: [{ scene: "charging", n: 40, N: 100, pct: 0.4, bar: 1, direction: "flat", counter: 1, suppressed: false }],
      },
    ],
    denominators: { note: "一轮可归多个需求码", turns: 100 },
    suppressed: [],
  },
  window: { from: 0, to: 1000 },
  systemEvents: [],
  codebookLockedAt: 500,
  codebookVersion: "0.1.0",
});

/**
 * C2–C5 的取数。窗口取一个易辨认的值，
 * C3 若用了别的窗口，响应里的 `window` 就对不上这两个数。
 */
const LOOKUP_WINDOW = { from: 1_700_000_000_000, to: 1_707_000_000_000 };

const lookupTheme = { id: "th-1", name: "低温掉电" };

const lookupDeps = {
  window: LOOKUP_WINDOW,
  themesByCode: async (code: string) => (code === "cold-range-loss" ? [lookupTheme] : []),
  tools: {
    findCounterEvidence: { execute: async ({ themeId, limit }: { themeId: string; limit: number }) => ({ count: 1, units: [{ unitId: `cu-${themeId}-${limit}`, text: "其实比我想的准" }] }) },
    listSystemEvents: { execute: async (w: { from: number; to: number }) => ({ count: 1, events: [{ at: w.to - 1, kind: "deploy", summary: "网关发版" }] }) },
    sliceBySegment: { execute: async () => ({ slices: [{ segment: "高频快充", n: 3, share: 0.75 }] }) },
    thresholdSensitivity: { execute: async ({ delta }: { delta: number }) => ({ flips: delta > 0.15, detail: `挪动 ${delta}` }) },
  },
} as never;

/** C1 的运行台账与取数。`writeCard` 是桩，真实现的测试在 `capabilities-synthesize.test.ts`。 */
const capabilityRuns = createCapabilityRuns();
const summarizeCell = {
  themesByCode: async (code: string) => (code === "cold-range-loss" ? [{ id: "th-1", name: "低温掉电" }] : []),
  currentInputsHash: async () => "snap-hash-1",
  writeCard: async () => "insight-1",
};

/** 能力端点的取数。挂了工具面的那台 server 复用同一份。 */
const capabilityDeps = {
  redTeamInput: async (id: string) => (id === "c1" ? redTeamInput() : null),
  lookup: async (id: string) => (id === "c1" ? lookupDeps : null),
  runs: capabilityRuns,
  summarizeCell,
};

const api = createInternalApi({
  repo,
  book,
  currentInputsHash: async (id) => (id === "c1" ? "snap-hash-1" : null),
  runState: async (runId) => capabilityRuns.state(runId),
  startedAt: Date.now() - 5_000,
  queues: () => ({ code: true, embed: true, snapshot: false }),
  codebookLocked: () => false,
  defaultContractId: () => "c1",
  capabilities: capabilityDeps,
});

let base = "";

before(async () => {
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});
after(() => {
  api.close();
});

const get = async (path: string): Promise<{ status: number; body: Record<string, unknown>; raw: string }> => {
  const res = await fetch(`${base}${path}`);
  const raw = await res.text();
  return { status: res.status, body: JSON.parse(raw) as Record<string, unknown>, raw };
};

describe("[M82-04] /health", () => {
  it("200，带 codebook 版本与各队列注册情况", async () => {
    const { status, body } = await get("/health");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.codebook, { version: "0.1.0", locked: false });
    // 队列按注册情况如实报告，不因进程存活就报 ok。
    assert.deepEqual(body.queue, { code: true, embed: true, snapshot: false });
    assert.ok(Number(body.uptime) >= 5);
  });

  /*
   * ACP 面。没注入 `acpHealth` 时缺省 `configured: false`。
   * `describeCalls` 是"pi 扩展确实被加载"的唯一证据，真跑时仍为 0
   * 说明 `.pi/extensions/` 被静默忽略了。
   */
  it("带 acp 字段，未装配时如实说 configured: false", async () => {
    const { body } = await get("/health");
    assert.deepEqual(body.acp, { configured: false, describeCalls: 0 });
  });

  /*
   * transport=direct（回滚值）下的装配：`index.ts` 那一行是
   * `configured: acpPool !== undefined`，direct 下不建池。
   * 显式 direct → 没有池 → `configured` 必为 false；报 true 会让冒烟脚本误以为 pi 面已就绪。
   * 缺省值本身在 `acp-transport.test.ts` 覆盖，这里不重复。
   */
  it("[M88-05] 回滚值 direct 下不建池，于是 /health.acp.configured 为 false", async () => {
    assert.equal(readChallengerTransport({ RESEARCH_CHALLENGER_TRANSPORT: "direct" }), "direct");
    const { body } = await get("/health");
    assert.equal((body.acp as { configured: boolean }).configured, false);
  });
});

describe("[M82-04] 证据端点永不返回原文", () => {
  it("列表响应体里没有 content 键", async () => {
    const { status, body, raw } = await get("/internal/research/evidence");
    assert.equal(status, 200);
    assert.ok(!raw.includes("13800138000"), "原文漏出去了");
    for (const u of body.units as Array<Record<string, unknown>>) {
      assert.ok(!("content" in u), "响应里出现了 content——那是 messages 的列名");
      assert.ok("textRedacted" in u);
    }
  });

  it("单条也不返回原文，且带上编码链", async () => {
    const { status, body, raw } = await get("/internal/research/evidence/unit-1");
    assert.equal(status, 200);
    assert.ok(!raw.includes("13800138000"));
    assert.ok(!("content" in (body.unit as Record<string, unknown>)));
    assert.equal((body.codings as unknown[]).length, 1);
  });

  it("白名单挑字段：库里新增一列默认不出现在出口", () => {
    const shaped = publicUnit(dbRow({ someNewSecretColumn: "不该出现" }));
    assert.ok(!("someNewSecretColumn" in shaped));
    assert.ok(!("content" in shaped));
    // userId / fingerprint 也不出：研究面对外只按车与时刻表述。
    assert.ok(!("userId" in shaped));
    assert.ok(!("fingerprint" in shaped));
  });

  it("BigInt 的 occurredAt 转成数字，否则 JSON.stringify 会抛", () => {
    assert.equal(publicUnit(dbRow()).occurredAt, 1_757_000_000_000);
  });

  it("?counter=true 只回反例", async () => {
    const { body } = await get("/internal/research/evidence?counter=true");
    const units = body.units as Array<Record<string, unknown>>;
    assert.equal(units.length, 1);
    assert.equal(units[0].id, "unit-2");
  });

  it("找不到的单元回 404 而不是空对象", async () => {
    const { status, body } = await get("/internal/research/evidence/nope");
    assert.equal(status, 404);
    assert.equal(body.error, "unit_not_found");
  });
});

describe("[M82-04] 其它端点", () => {
  it("合同列表可读", async () => {
    const { status, body } = await get("/internal/research/contracts");
    assert.equal(status, 200);
    assert.equal((body.contracts as unknown[]).length, 1);
  });

  it("未知路径回 404", async () => {
    assert.equal((await get("/nope")).status, 404);
  });
});

const post = async (
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const cellScope = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: "cell",
  needPainCode: "cold-range-loss",
  sceneCode: "charging",
  suppressed: false,
  catchAll: false,
  hasDirection: false,
  ...over,
});

describe("[M85-03] 能力端点", () => {
  it("红队清单在整屏范围上回 200，result 是 findings 数组", async () => {
    const { status, body } = await post("/internal/research/capabilities/red-team", {
      contractId: "c1",
      scope: { kind: "page" },
    });
    assert.equal(status, 200);
    assert.equal(body.capability, "red-team");
    assert.equal(body.tier, "lookup");
    const findings = body.result as Array<{ rule: string }>;
    assert.ok(Array.isArray(findings));
    // 兜底桶 70/100 = 70%，必然命中；同时证明读的是测试给的那份快照。
    assert.ok(findings.some((f) => f.rule === "catch-all-share"));
  });

  it("按 id 调也认（c9 与 red-team 是同一条）", async () => {
    const { status, body } = await post("/internal/research/capabilities/c9", {
      contractId: "c1",
      scope: { kind: "page" },
    });
    assert.equal(status, 200);
    assert.equal(body.capability, "red-team");
  });

  /*
   * 「问它」三条只有 ACP 一条路：这台测试用的 server 没装 `askAgent`
   * （等价于 `RESEARCH_CHALLENGER_TRANSPORT=direct` 或没 key 时 `index.ts` 不建池），
   * 必须回 503 而不是假 runId，否则界面会订阅一条永远不存在的流。
   */
  it("[M89-03] 池没起时 ask-analyst 回 503 `agents_not_available`，不给假 runId", async () => {
    const { status, body } = await post("/internal/research/capabilities/ask-analyst", {
      contractId: "c1",
      scope: cellScope(),
      question: "这一格的 n 相对全表算高还是低？",
    });
    assert.equal(status, 503);
    assert.equal(body.error, "agents_not_available");
    assert.equal(body.runId, undefined);
  });

  it("被抑制的格上任何能力都回 400 `capability_not_available`", async () => {
    for (const name of ["red-team", "summarize-cell", "find-counter-evidence", "propose-code", "ask-analyst", "ask-archivist"]) {
      const { status, body } = await post(`/internal/research/capabilities/${name}`, {
        contractId: "c1",
        scope: cellScope({ suppressed: true, catchAll: true, hasDirection: true }),
      });
      assert.equal(status, 400, `${name} 在被抑制的格上没有被拒`);
      assert.equal(body.error, "capability_not_available");
      assert.match(String(body.hint), /小单元抑制/);
    }
  });

  it("闸门在分发之前：未实现的能力在抑制格上也是 400，不是 501", async () => {
    // 兜底桶的格上才有 c8；这里同时用了抑制 —— 闸门在前，所以仍是 400。
    const { status, body } = await post("/internal/research/capabilities/propose-code", {
      contractId: "c1",
      scope: cellScope({ suppressed: true, catchAll: true }),
    });
    assert.equal(status, 400);
    assert.equal(body.error, "capability_not_available");
  });

  /*
   * 目录中的能力已全部实现，501 分支没有真实能力可测；
   * 需要守的是「目录与已实现表不许分叉」。
   */
  it("[M89-03] 能力目录里的十二条全部已实现，多出第十三条时这条会红", async () => {
    /*
     * 目录里新增一条而未实现时，它会在界面上以灰按钮出现、点了回 501。
     * 这不是缺陷，但需要被知晓，这条用例起通知作用。
     */
    const src = readFileSync(
      join(new URL("..", import.meta.url).pathname.replace(/\/$/, ""), "src/internal-api/capabilities.ts"),
      "utf8",
    );
    const line = src.split("\n").find((l) => /IMPLEMENTED.*new Set\(/.test(l));
    assert.ok(line, "已实现表变了形状，回来核对");
    /*
     * 正则是 `c\d+` 而不是 `c[1-9]`：后者匹配不到 `"c10"` 这类两位数 id，
     * 会让本用例恒绿、失去通知作用。
     */
    const implemented = [...line.matchAll(/"(c\d+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual(
      implemented,
      CAPABILITIES.map((c) => c.id).sort(),
      `目录与已实现表对不上：已实现的是 ${implemented.join("、")}`,
    );
  });

  it("未知能力名回 400，不落进 501 分支", async () => {
    const { status, body } = await post("/internal/research/capabilities/summarize-everything", {
      contractId: "c1",
      scope: { kind: "page" },
    });
    assert.equal(status, 400);
    assert.equal(body.error, "unknown_capability");
  });

  it("scope 缺 suppressed 就拒收，默认成 false 会绕过 G1", async () => {
    const { status, body } = await post("/internal/research/capabilities/red-team", {
      contractId: "c1",
      scope: { kind: "cell", needPainCode: "x", sceneCode: "y" },
    });
    assert.equal(status, 400);
    assert.equal(body.error, "bad_scope");
  });

  it("能力不在当前范围的能力条上 → 400（红队清单只在整屏）", async () => {
    const { status, body } = await post("/internal/research/capabilities/red-team", {
      contractId: "c1",
      scope: cellScope(),
    });
    assert.equal(status, 400);
    assert.equal(body.error, "capability_not_available");
  });

  it("没算过快照的合同 → 404，不是 200 空数组", async () => {
    const { status, body } = await post("/internal/research/capabilities/red-team", {
      contractId: "c-never-run",
      scope: { kind: "page" },
    });
    assert.equal(status, 404);
    assert.equal(body.error, "snapshot_not_found");
  });
});

/*
 * 这一节测的是分发：哪条能力走哪个入口、哪些范围答不了。
 * 四个工具在这里是桩（`lookupDeps`）；工具与"格 → 参数"一跳的真实现
 * 在 `capabilities-lookup.test.ts` 里测，那边不打桩。
 */
describe("[M85-05] 四条查类能力的分发", () => {
  it("C2 在格上回 200，结果带主题来源", async () => {
    const { status, body } = await post("/internal/research/capabilities/find-counter-evidence", {
      contractId: "c1",
      scope: cellScope(),
    });
    assert.equal(status, 200);
    assert.equal(body.tier, "lookup");
    const r = body.result as { count: number; units: Array<{ themeId: string; unitId: string }> };
    assert.equal(r.count, 1);
    assert.equal(r.units[0].themeId, "th-1");
  });

  it("C2 的 limit 从 body 取，缺省是 10", async () => {
    const def = await post("/internal/research/capabilities/find-counter-evidence", {
      contractId: "c1",
      scope: cellScope(),
    });
    assert.match(String((def.body.result as { units: Array<{ unitId: string }> }).units[0].unitId), /-10$/);

    const given = await post("/internal/research/capabilities/find-counter-evidence", {
      contractId: "c1",
      scope: cellScope(),
      limit: 3,
    });
    assert.match(String((given.body.result as { units: Array<{ unitId: string }> }).units[0].unitId), /-3$/);
  });

  it("C3 用的是合同窗口，不是别的时间段", async () => {
    const { status, body } = await post("/internal/research/capabilities/system-events", {
      contractId: "c1",
      scope: cellScope({ hasDirection: true }),
    });
    assert.equal(status, 200);
    assert.deepEqual((body.result as { window: unknown }).window, LOOKUP_WINDOW);
  });

  it("C5 缺省跑一组 delta，翻转与不翻转都在结果里", async () => {
    const { status, body } = await post("/internal/research/capabilities/threshold-sensitivity", {
      contractId: "c1",
      scope: { kind: "row", needPainCode: "cold-range-loss", suppressed: false, catchAll: false },
    });
    assert.equal(status, 200);
    const r = body.result as { probes: Array<{ delta: number; flips: boolean }> };
    assert.equal(r.probes.length, 4);
    assert.ok(r.probes.every((p) => p.flips === false), "桩里只有 >0.15 才翻，缺省那组都不翻");
  });

  it("C5 的 deltas 可以从 body 给", async () => {
    const { body } = await post("/internal/research/capabilities/threshold-sensitivity", {
      contractId: "c1",
      scope: { kind: "row", needPainCode: "cold-range-loss", suppressed: false, catchAll: false },
      deltas: [0.2],
    });
    const r = body.result as { probes: Array<{ delta: number }>; anyFlips: boolean; minFlipDelta: number | null };
    assert.deepEqual(r.probes.map((p) => p.delta), [0.2]);
    assert.equal(r.anyFlips, true);
    assert.equal(r.minFlipDelta, 0.2);
  });

  /*
   * 能力目录把 C4 也开在整列上，而分群切分按主题做、主题只按需求码切。
   * 整列横跨全部码，现有工具答不了，因此明确拒绝；
   * 合并切分算出的数字回答的是另一个问题。
   */
  it("C4 在整列上回 400 `scope_not_supported`，不编一个看起来合理的数", async () => {
    const { status, body } = await post("/internal/research/capabilities/slice-by-segment", {
      contractId: "c1",
      scope: { kind: "col", sceneCode: "charging" },
    });
    assert.equal(status, 400);
    assert.equal(body.error, "scope_not_supported");
    assert.match(String(body.hint), /不带场景/);
  });

  it("C4 在格上照常回 200，上一条没有关掉这条能力", async () => {
    const { status, body } = await post("/internal/research/capabilities/slice-by-segment", {
      contractId: "c1",
      scope: cellScope(),
    });
    assert.equal(status, 200);
    assert.equal((body.result as { perTheme: unknown[] }).perTheme.length, 1);
  });

  it("[M85-06] C1 是 ✎ 层：回 202 + runId，不等模型跑完", async () => {
    const { status, body } = await post("/internal/research/capabilities/summarize-cell", {
      contractId: "c1",
      scope: cellScope(),
    });
    assert.equal(status, 202);
    assert.equal(body.tier, "write");
    assert.match(String(body.runId), /^cap-/);
    // 这个 runId 必须立刻查得到，否则界面会订阅一条 404 的流。
    assert.notEqual(capabilityRuns.get(String(body.runId)), null);
  });

  it("[M85-06] C1 的 runId 能开出运行流，终态帧带 result", async () => {
    const { body } = await post("/internal/research/capabilities/summarize-cell", {
      contractId: "c1",
      scope: cellScope(),
    });
    const runId = String(body.runId);
    // 后台那段是异步的，等它落地。
    for (let i = 0; i < 50 && capabilityRuns.get(runId)?.stage !== "done"; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const res = await fetch(`${base}/internal/research/runs/${runId}/stream`);
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(text, /"event":"done"/);
    assert.match(text, /insight-1/);
  });

  it("合同不在 → 404 `contract_not_found`，与「没跑过 run」分开", async () => {
    // 两者的下一步不同：一个是建合同，一个是 POST /runs。
    const { status, body } = await post("/internal/research/capabilities/find-counter-evidence", {
      contractId: "c-never-run",
      scope: cellScope(),
    });
    assert.equal(status, 404);
    assert.equal(body.error, "contract_not_found");
  });
});

/*
 * 工具回调面挂在同一台 server 上。
 *
 * 这一组覆盖顺序：工具面须在读 body 之前先判断，否则其
 * `for await (const c of req)` 拿到已读完的流，每次 invoke 都 `invalid_json`；
 * 它没接住的请求必须把 body 原样留给原来的路由，否则能力端点收到空 body 回 400。
 */
describe("[M88-04] 工具回调面与既有路由共用一台 server", () => {
  const tools = createResearchToolsEndpoint();
  const withTools = createInternalApi({
    repo,
    book,
    startedAt: Date.now(),
    queues: () => ({ code: true, embed: true, snapshot: false }),
    codebookLocked: () => false,
    defaultContractId: () => "c1",
    capabilities: capabilityDeps,
    tools,
    acpHealth: () => ({ configured: false, describeCalls: tools.stats().describeCalls }),
  });
  let toolsBase = "";

  before(async () => {
    await new Promise<void>((resolve) => withTools.listen(0, "127.0.0.1", resolve));
    toolsBase = `http://127.0.0.1:${(withTools.address() as AddressInfo).port}`;
  });
  after(() => {
    withTools.close();
  });

  it("describe 打得通，/health 的 describeCalls 跟着涨", async () => {
    const res = await fetch(`${toolsBase}/internal/research/tools/describe?agent=challenger`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { tools: unknown[] }).tools.length, 4);

    const health = await (await fetch(`${toolsBase}/health`)).json();
    assert.deepEqual((health as Record<string, unknown>).acp, { configured: false, describeCalls: 1 });
  });

  it("invoke 读得到请求体：没登记会话时明说结束，而不是 invalid_json", async () => {
    const res = await fetch(`${toolsBase}/internal/research/tools/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "findCounterEvidence", args: { themeId: "th-1" }, piSessionId: "pi-1" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: false, error: "挑战会话已结束" });
  });

  it("没接住的 POST 仍然带着 body 走到原来的路由", async () => {
    const res = await fetch(`${toolsBase}/internal/research/capabilities/red-team`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contractId: "c1", scope: { kind: "page" } }),
    });
    const body = (await res.json()) as { capability: string; result: Array<{ rule: string }> };
    assert.equal(res.status, 200);
    assert.equal(body.capability, "red-team");
    assert.ok(body.result.some((f) => f.rule === "catch-all-share"));
  });
});
