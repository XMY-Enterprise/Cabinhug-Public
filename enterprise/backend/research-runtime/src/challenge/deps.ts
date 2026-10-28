/**
 * `ResearchToolDeps` 注入回调的生产实现（九个）。
 *
 * 返回类型钉成 `Omit<ResearchToolDeps, "repo" | "codebookVersion">`：
 * 工具表一侧加一个取数口，这里立即编译报错，不会等到模型首次调用时才暴露缺失。
 *
 * `tools.ts` 的四个只读工具里有三个靠注入取数（`themeMembers` /
 * `sliceBySegment` / `thresholdSensitivity`）；缺了这些实现，它们在首次调用时抛错，
 * 而模型仍会产出挑战记录。
 *
 * # 单独成模块，不埋进 index.ts 的闭包
 *
 * 证据矩阵的四个查类能力（C2–C5）不经模型直调同一份取数逻辑，
 * 共用本模块保证口径一致，尤其是 `thresholdSensitivity` 的象限口径。
 */

import type { CodebookAgreement, ResearchRepository } from "@cabinhug/db";
import type {
  CodebookView,
  CodedUnitBrief,
  LensSnapshotView,
  ResearchToolDeps,
  UnitView,
} from "@cabinhug/research-tools";

import type { Codebook } from "../codebook/load";
import { axesFrom, buildImportancePerformance, type CodedTurn } from "../lenses";

export interface ChallengeDepsOptions {
  repo: ResearchRepository;
  book: Codebook;
  window: { from: number; to: number };
  minCellVehicles: number;
  /** measurement 门过了没有。只影响象限底色，不影响本模块算出的象限归属。 */
  measurementPassed: boolean;
  /**
   * 这一次是哪个研究合同。
   *
   * 只有 `lensSnapshot` 要它：镜头快照按合同算，没有"全局最新的一张"。
   * 可选是因为 Challenger 与 `🔍` 查类能力不按合同装配这套 deps。
   * 缺省时 `lensSnapshot` 一律回 null，不随便挑一张快照：错合同的快照不报错，
   * 却会让模型用另一段窗口的数字作答。
   */
  contractId?: string | null;
}

/** 一格的象限归属。两个轴各自与阈值比，四种组合。 */
type Quadrant = "high-high" | "high-low" | "low-high" | "low-low";

const quadrantOf = (
  importance: number,
  performance: number,
  t: { importance: number; performance: number },
): Quadrant =>
  `${importance >= t.importance ? "high" : "low"}-${performance >= t.performance ? "high" : "low"}`;

/**
 * 九个回调 + 它们共用的窗口数据。
 *
 * `codedTurns` 一次 run 里要被三个回调各读一遍，它是整窗的编码行
 * （实测 1,482 单元 / 8,914 行）。记忆化一次：一次挑战最多走 8 步工具循环，
 * 不记忆化时同一份数据可能被拉八遍。
 */
export function createChallengeToolDeps(
  opts: ChallengeDepsOptions,
): Omit<ResearchToolDeps, "repo" | "codebookVersion"> {
  const { repo, book, window } = opts;

  let turnsPromise: Promise<CodedTurn[]> | null = null;
  const codedTurns = (): Promise<CodedTurn[]> => {
    turnsPromise ??= repo.units.codedTurns(window, book.version) as unknown as Promise<CodedTurn[]>;
    return turnsPromise;
  };

  let themesPromise: ReturnType<ResearchRepository["themes"]["list"]> | null = null;
  const themes = () => {
    themesPromise ??= repo.themes.list(book.version);
    return themesPromise;
  };

  /*
   * 库里那一行 codebook。`codebook()` 与 `agreement()` 都只要它的两列，
   * `axes` 以进程加载的文件为准（启动时 `assertCodebookConsistent` 已核对 hash）。
   * 同样记忆化一次：taxonomist 一轮里会把这两个工具各调几遍。
   */
  let storedPromise: ReturnType<ResearchRepository["codebooks"]["byVersion"]> | null = null;
  const stored = () => {
    storedPromise ??= repo.codebooks.byVersion(book.version);
    return storedPromise;
  };
  const lockedAtIso = async (): Promise<string | null> => {
    const row = await stored();
    return row?.lockedAt ? new Date(row.lockedAt).toISOString() : null;
  };

  /*
   * 写成局部函数再挂进返回对象，不用 `this`：回调以 `deps.sliceBySegment(...)`
   * 形式调用时 `this` 正确，但解构（`const { sliceBySegment } = deps`）会让它变成
   * undefined，运行时才抛错。
   */
  const themeMembers = async (
    themeId: string,
  ): Promise<{ memberUnitIds: string[]; counterUnitIds: string[] }> => {
    const found = (await themes()).find((t) => t.id === themeId);
    // 主题不存在就返回空，不抛：模型拿过期 id 来问时回答"没有成员"，不让整次挑战失败。
    if (!found) return { memberUnitIds: [], counterUnitIds: [] };
    return { memberUnitIds: found.memberUnitIds, counterUnitIds: found.counterUnitIds };
  };

  return {
    themeMembers,

    /**
     * 一张镜头的最新快照（`lensQuery` 的取数口）。
     *
     * 只投影，不重算：`data` 原样透出，被小单元抑制的格在快照里已没有 n / N / pct，
     * 这一层不补。`population` / `gates` / `inputsHash` 不给模型：门的裁决属于
     * 质量门与界面，不属于 analyst。
     */
    async lensSnapshot(lens): Promise<LensSnapshotView | null> {
      if (!opts.contractId) return null;
      const row = (await repo.snapshots.latest(opts.contractId, lens)) as {
        lens?: string;
        windowFrom?: bigint | number;
        windowTo?: bigint | number;
        codebookVersion?: string;
        computedAt?: Date | null;
        data?: unknown;
      } | null;
      if (!row) return null;
      return {
        lens: row.lens ?? lens,
        windowFrom: Number(row.windowFrom ?? window.from),
        windowTo: Number(row.windowTo ?? window.to),
        codebookVersion: row.codebookVersion ?? book.version,
        ...(row.computedAt ? { computedAt: new Date(row.computedAt).getTime() } : {}),
        data: row.data ?? null,
      };
    },

    /**
     * 码表的结构化视图（`codebookLookup` 的取数口）。
     *
     * 投影掉 `filePath`（本机路径，属内部布局）与 `hash`；
     * 轴上的 `max` / `intensity` 是编码器的约束，查表不需要。
     * YAML 的 `counter_examples` 在这里改成 `counterExamples`：
     * 工具表一侧只认 camelCase，不一致时反例栏恒空。
     */
    async codebook(): Promise<CodebookView> {
      return {
        version: book.version,
        lockedAt: await lockedAtIso(),
        axes: book.axes.map((a) => ({
          id: a.id,
          label: a.label,
          cardinality: a.cardinality,
          codes: a.codes.map((c) => ({
            id: c.id,
            label: c.label,
            definition: c.definition,
            include: c.include,
            exclude: c.exclude,
            examples: c.examples,
            counterExamples: c.counter_examples,
          })),
        })),
      };
    },

    /**
     * 复编码一致率（`agreementReport` 的取数口）。
     *
     * 库里没有这一行时回 `agreement: null`："没量过"与"量出来是 0"不同，
     * 合成一个数会让 taxonomist 把没测量说成测得很差。
     */
    async agreement(): Promise<{ lockedAt: string | null; agreement: CodebookAgreement | null }> {
      const row = await stored();
      return {
        lockedAt: row?.lockedAt ? new Date(row.lockedAt).toISOString() : null,
        agreement: (row?.agreement as CodebookAgreement | null) ?? null,
      };
    },

    /**
     * 按某一轴的某个码取编码轮次（`evidenceByCode` 的取数口）。
     *
     * 与三个挑战回调共用同一份记忆化窗口数据（`codedTurns`），不另开查询，
     * 保证同一个码在两条路上取到相同的行。
     * `codedTurns` 只取 `kind: "utterance"`，所以 `kind` 恒为 utterance：
     * 行为单元不按轮次编码，这条路取不到它们。
     */
    async unitsByCode(q): Promise<CodedUnitBrief[]> {
      const axis = q.axis ?? "needPain";
      const hit = (t: CodedTurn): boolean => {
        if (axis === "needPain") return t.needPains.includes(q.code);
        if (axis === "scene") return t.scene === q.code;
        if (axis === "job") return t.job === q.code;
        if (axis === "emotion") return t.emotion === q.code;
        return t.polarity === q.code;
      };

      const rows: CodedUnitBrief[] = [];
      for (const t of await codedTurns()) {
        if (!hit(t)) continue;
        if (q.polarity != null && t.polarity !== q.polarity) continue;
        rows.push({
          unitId: t.unitId,
          kind: "utterance",
          occurredAt: t.occurredAt,
          scene: t.scene,
          needPains: t.needPains,
          polarity: t.polarity,
          resolved: t.resolved,
        });
        if (rows.length >= q.limit) break;
      }
      return rows;
    },

    /**
     * 单条证据单元的 allowlist 投影（`evidenceById` 的取数口）。
     *
     * `units.byId` 回的是整行，带着 `user_id`、车架号、会话 / 轮次 / 消息 / 行程引用。
     * 这里挑字段而不是删键：黑名单在库里新增列时会漏出，而漏出的字节会经 pi 的
     * 会话 jsonl 落到磁盘上。被投影掉的列：contractId、userId、vin、sessionId、turnId、
     * messageId、tripId、features、context、role、createdAt；`withdrawnAt` 降成一个布尔。
     */
    async unitById(unitId): Promise<UnitView | null> {
      const row = (await repo.units.byId(unitId)) as {
        id?: string;
        kind?: string;
        sourceId?: string;
        occurredAt?: bigint | number;
        textRedacted?: string | null;
        displayLevel?: string;
        withdrawnAt?: Date | null;
        fingerprint?: string;
      } | null;
      if (!row?.id) return null;
      return {
        id: row.id,
        kind: row.kind ?? "utterance",
        sourceId: row.sourceId ?? "",
        occurredAt: Number(row.occurredAt ?? 0),
        textRedacted: row.textRedacted ?? null,
        displayLevel: row.displayLevel ?? "none",
        withdrawn: row.withdrawnAt != null,
        fingerprint: row.fingerprint ?? "",
      };
    },

    /** 一批单元的脱敏文本。批量读，不逐条 `byId`（那是 N 次往返）。 */
    unitTexts: (unitIds) => repo.units.textsByIds(unitIds),

    /**
     * 把一个主题按行为分群切开。回答的是"它是不是只集中在一小撮车上"。
     *
     * 口径：分母是该主题命中的车辆数，不是分群的规模。以分群规模为分母时，
     * share 表达的是"这个群里很多车提到它"，不是"这个主题集中在这个群"。
     */
    async sliceBySegment(themeId) {
      const { memberUnitIds } = await themeMembers(themeId);
      if (memberUnitIds.length === 0) return [];

      const members = new Set(memberUnitIds);
      const vins = new Set<string>();
      for (const t of await codedTurns()) {
        if (t.vin && members.has(t.unitId)) vins.add(t.vin);
      }
      if (vins.size === 0) return [];

      const segments = await repo.segments.list();
      const slices = segments.map((s) => {
        const n = s.memberVins.filter((v) => vins.has(v)).length;
        return { segment: s.name, n, share: n / vins.size };
      });

      /*
       * 没落进任何分群的车单列一行，不丢掉：丢掉时各 share 之和小于 1，
       * 分群覆盖不足会被误读为分布均匀。
       */
      const covered = new Set(segments.flatMap((s) => s.memberVins.filter((v) => vins.has(v))));
      const uncovered = vins.size - covered.size;
      if (uncovered > 0) {
        slices.push({ segment: "未分群", n: uncovered, share: uncovered / vins.size });
      }
      return slices.filter((s) => s.n > 0).sort((a, b) => b.n - a.n);
    },

    /**
     * 把重要度/表现度阈值挪动 `delta`，看这个码会不会换象限。
     *
     * 口径必须与「重要度 × 表现度」镜头一致，所以直接复用
     * `buildImportancePerformance`，保证同一个码在两个页面上属于同一象限。
     */
    async thresholdSensitivity(code, delta) {
      const turns = await codedTurns();
      const { codes, labels } = axesFrom(book);
      const ipa = buildImportancePerformance(turns, {
        needPainCodes: codes.need_pain ?? [],
        labels,
        minCellVehicles: opts.minCellVehicles,
        measurementPassed: opts.measurementPassed,
      });

      const point = ipa.points.find(
        (p): p is Extract<typeof p, { code: string }> => "code" in p && p.code === code,
      );
      if (!point) {
        // 被小单元抑制的格在 points 里是 SuppressedCell，没有 code，无法做敏感性分析；
        // 明确说明，不返回 false 冒充"稳定"。
        return {
          flips: false,
          detail: `码 ${code} 不在当前象限图里（不存在，或因样本不足被抑制）——无法判断敏感性`,
        };
      }

      const base = quadrantOf(point.importance, point.performance, ipa.thresholds);
      const shifted = {
        importance: ipa.thresholds.importance + delta,
        performance: ipa.thresholds.performance + delta,
      };
      const after = quadrantOf(point.importance, point.performance, shifted);

      return {
        flips: base !== after,
        detail:
          `码 ${code}：重要度 ${point.importance.toFixed(3)} / 表现度 ${point.performance.toFixed(3)}；` +
          `阈值 ${ipa.thresholds.importance.toFixed(3)} / ${ipa.thresholds.performance.toFixed(3)} ` +
          `挪动 ${delta >= 0 ? "+" : ""}${delta} 后为 ${shifted.importance.toFixed(3)} / ${shifted.performance.toFixed(3)}；` +
          `象限 ${base} → ${after}${base === after ? "（不变）" : "（翻面）"}`,
      };
    },
  };
}
