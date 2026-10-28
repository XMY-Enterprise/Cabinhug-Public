/**
 * Guardrails 业务装配（§10 要点 3）。
 *
 * 通用管线在 `enterprise/backend/shared/guardrails`（纯函数、可单测、可复用）；
 * 本文件负责装配它，并注入 Cabinhug 特有的业务规则与运营策略。
 *
 * # 挂在 ACP Client 一侧
 *
 * 对五个子 Agent 统一生效（§8 首段 / §4.1），不依赖每个 Agent 各自接入管线。
 *
 * # 策略从 DB 来，每次 check 现取（带 30s TTL）
 *
 * 不在构造时取一次：止血开关需要改完立即生效，不能依赖重启。
 * 取的开销由 `guard/settings.ts` 的短 TTL 缓存兜住。
 */

import { runInputPipeline, runOutputPipeline, applyPolicy, type ContentGuard } from "@cabinhug/guardrails";

import { renderDisclaimer, serviceDisclaimer, financeDisclaimer, type RiskLevel } from "./disclaimers";
import { getGuardPolicy, getDisclaimerPolicy, getDisclaimerText } from "./settings";

export interface GuardAuditEntry {
  stage: string;
  allowed: boolean;
  reason?: string;
  ruleId?: string;
  /**
   * 被运营策略抑制的分类：模型判不安全、但该类被关掉了，于是放行。
   *
   * 非空即意味着这次放行是策略造成的。它必须进审计，
   * 用于区分被抑制的放行与本来就安全的放行。
   */
  suppressed?: string[];
}

export interface GuardPipelineOptions {
  moderation?: ContentGuard;
  /** 裁决落审计（含放行，§8.5）。 */
  onAudit?: (a: GuardAuditEntry) => void;
  /** 覆盖策略来源，仅测试用。生产走 `guard/settings.ts` 的 DB + TTL 缓存。 */
  policySource?: typeof getGuardPolicy;
  /** 覆盖话术开关来源，仅测试用（同上）。 */
  disclaimerPolicySource?: typeof getDisclaimerPolicy;
  /** 覆盖话术文案来源，仅测试用（同上）。 */
  disclaimerTextSource?: typeof getDisclaimerText;
}

export class GuardPipeline {
  constructor(private opts: GuardPipelineOptions = {}) {}

  private policy() {
    return (this.opts.policySource ?? getGuardPolicy)();
  }

  /**
   * 供流式输出审核取用的审核器。
   *
   * 与 `checkOutput` 的区别：那个是整段文本一次判，用在非流式路径；
   * 流式路径要边流边判才能尽早撤回，所以由 `turn-runner` 自己开会话。
   * 未接入时返回 undefined，会话随之退化成 no-op，不假装审过。
   *
   * 拿到的是原始裁决，策略过滤交给 `judgeOutput` —— 分开是因为
   * 审核发生在流上、而策略要读 DB（异步且带 TTL），两件事的时机不同。
   */
  outputGuard(): ContentGuard | undefined {
    return this.opts.moderation;
  }

  /**
   * 对流式裁决应用运营策略，决定是否该撤回。
   *
   * `checkInput` 走 `runInputPipeline` 自带策略过滤，而流式输出是自己开的会话，
   * 必须在这里过一遍策略，运营关掉某个维度才对流式输出同样生效。
   *
   * 被抑制的维度照常进审计：撤没撤是一回事，因为什么没撤是另一回事。
   */
  async judgeOutput(verdict: { safe: boolean; categories: string[] }): Promise<boolean> {
    const policy = await this.policy();
    const v = applyPolicy(verdict, policy);
    this.opts.onAudit?.({
      stage: "output:stream",
      allowed: v.safe,
      reason: v.safe ? undefined : `内容审核未通过：${v.categories.join("/")}`,
      ...(v.suppressed.length ? { suppressed: v.suppressed } : {}),
    });
    return v.safe;
  }

  async checkInput(text: string) {
    const policy = await this.policy();
    const r = await runInputPipeline(text, { moderation: this.opts.moderation, policy });
    this.opts.onAudit?.({
      stage: `input:${r.stage}`,
      allowed: r.allowed,
      reason: r.reason,
      ruleId: r.ruleId,
      ...(r.suppressed?.length ? { suppressed: r.suppressed } : {}),
    });
    return r;
  }

  /**
   * 输出侧：审核 + 脱敏 + 业务话术。
   *
   * `scenario` 决定注入哪种话术；`undefined` 表示不注入——
   * 不是每段输出都要挂免责（F-20-14）。
   */
  async checkOutput(
    text: string,
    scenario?: { kind: "service"; risk: RiskLevel } | { kind: "finance" },
  ) {
    const policy = await this.policy();
    const r = await runOutputPipeline(text, { moderation: this.opts.moderation, policy });
    this.opts.onAudit?.({
      stage: "output",
      allowed: r.allowed,
      reason: r.reason,
      ...(r.suppressed?.length ? { suppressed: r.suppressed } : {}),
    });

    if (!r.allowed) return r;
    if (!scenario) return r;

    const line = await this.resolveDisclaimer(scenario);
    if (!line) return r;

    return { ...r, text: `${line}\n\n${r.text}` };
  }

  /**
   * 取一句业务话术；关掉的场景返回 undefined。
   *
   * # 单独抽出
   *
   * `checkOutput` 要的是整段文本，而购车的回答是流式的——话术得在第一个
   * token 之前就发出去（`Disclaimer.label` 展示在回答开头，挂到末尾时用户已读完回答）。
   * 两条路径共用同一处开关判定与文案来源；各写一份会漂移成"页面上关掉了，语音里还在念"。
   *
   * 开关先判、文案后取：关掉的场景连文案都不必读，
   * 也避免"文案非法 → 回落默认 → 明明关了却还是挂上去了"。
   * 两者都从 DB 现取（30s TTL），止血开关改完即生效。
   */
  async resolveDisclaimer(
    scenario: { kind: "service"; risk: RiskLevel } | { kind: "finance" },
  ): Promise<string | undefined> {
    const [switches, texts] = await Promise.all([
      (this.opts.disclaimerPolicySource ?? getDisclaimerPolicy)(),
      (this.opts.disclaimerTextSource ?? getDisclaimerText)(),
    ]);
    const enabled = scenario.kind === "service" ? switches.serviceEnabled : switches.financeEnabled;
    if (!enabled) return undefined;

    const d =
      scenario.kind === "service"
        ? serviceDisclaimer(scenario.risk, texts)
        : financeDisclaimer(texts);
    return renderDisclaimer(d);
  }
}
