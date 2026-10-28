/**
 * 审核层的运行时策略值（§8.2「配置来源」行）。
 *
 * # 三分边界
 *
 * §8.2 的字段级分权：
 *  - 策略值（分类启用、判定严格度、fail 模式）→ 归运营，由本模块管理；
 *  - 接入面（模型端点、API key、超时、并发）→ 归系统管理员，在配置注册表里；
 *  - 红线（硬禁清单、capability 白名单）→ 不可热改，在代码里。
 *
 * 接入面归运维：运营若能把审核指向任意端点，等于绕开内容安全。
 *
 * # 短 TTL 缓存，不另起一套
 *
 * 每次 check 读一遍配置 + 约 30s TTL（§8.2）。缓存复用 enterprise/backend/shared/db 的配置层
 * （§10 要点 8），避免两套缓存的过期时序不一致。
 */

export type FailMode = "open" | "closed";

/**
 * 防护维度的启用开关（§8.2 分类体系，对齐阿里云 AI 安全护栏的 `Type`）。
 *
 * 关掉某维度 = 该维度判 block 时不再拦截（但仍进审计的 suppressed）。
 *
 * # 这些开关只能"关"，不能"开"
 *
 * 某个维度是否参与检测由阿里云控制台（AI 安全护栏 → 防护配置）决定，
 * 不由这里决定。本策略只能把已经回来的 block 抑制掉。
 * 控制台未开启的维度，即使这里为 `true` 也不会有任何检测结果。
 * 本账号当前只开了 `contentModeration` 与 `promptAttack` 两个维度，
 * 可用 `corepack pnpm probe:aliyun-guard` 核对。
 *
 * 因此 `true` 的含义是「接受该维度回来的 block」，而不是「请检测该维度」。
 *
 * # 策略单位是维度而不是标签
 *
 * 阿里云回两层：`Type`（八个防护维度，产品面稳定）与 `Label`
 * （political_entity / sexual_Cleavage 等，几百个且随模型迭代增删）。
 * 运营要表达的是"关掉幻觉检测"这一级别的意图。
 * 标签仍随裁决带出进审计，只是不作为过滤单位。
 *
 * # 键集必须与裁决的值空间一致
 *
 * 裁决回的是维度名；库里若存着其他键（如 Qwen3Guard-Gen 的六类 Violent / Sexual / …），
 * 查询结果全是 undefined，`undefined !== false` 恒成立，任何一类都不会被抑制。
 * 因此 `validatePolicy` 做键集校验：库里存着不一致的形状时判非法，
 * 由 `guard/settings.ts` 回落到默认（更严的一侧）并告警。
 */
export interface CategoryPolicy {
  /** 内容合规（涉政、色情、广告法…）。 */
  contentModeration: boolean;
  /** 提示词攻击（越狱、拒绝抑制…）。 */
  promptAttack: boolean;
  /** 敏感内容（手机号、证件、银行卡…）。命中时阿里云给的是 mask 而非 block。 */
  sensitiveData: boolean;
  /** 模型幻觉（需传 referenceContent 才有意义）。 */
  modelHallucination: boolean;
  /** 恶意文件。 */
  maliciousFile: boolean;
  /** 恶意 URL。 */
  maliciousUrl: boolean;
  /** 控制台自定义检测 Agent。 */
  customLabel: boolean;
}

/** 键集的单一真相源：`validatePolicy` 与后台界面都读它，不各写一份。 */
export const CATEGORY_KEYS: readonly (keyof CategoryPolicy)[] = [
  "contentModeration",
  "promptAttack",
  "sensitiveData",
  "modelHallucination",
  "maliciousFile",
  "maliciousUrl",
  "customLabel",
] as const;

export interface GuardPolicy {
  categories: CategoryPolicy;
  /** 输入侧 fail 模式。默认 open：模型挂了不堵死正常对话。 */
  inputFailMode: FailMode;
  /** 输出侧 fail 模式。默认 closed：宁可不回复也不放行未审核内容。 */
  outputFailMode: FailMode;
}

// 业务话术的开关不在本类型里。它是 Cabinhug 特有的业务规则，
// 归 `enterprise/backend/agent-runtime/src/guard/`（§10 要点 3），
// `check:arch` 的 guardrails-purity 会拦下业务字段进入本包。

export const DEFAULT_POLICY: GuardPolicy = {
  categories: {
    contentModeration: true,
    promptAttack: true,
    sensitiveData: true,
    modelHallucination: true,
    maliciousFile: true,
    maliciousUrl: true,
    customLabel: true,
  },
  inputFailMode: "open",
  outputFailMode: "closed",
};

/**
 * 策略值的合法性校验。
 *
 * 不允许两侧 fail 模式同时为 open：那样审核失败时系统照常回答且无任何症状，
 * 等于关闭审核。因此做成硬校验而不是提示。
 */
export function validatePolicy(p: GuardPolicy): string | null {
  if (p.inputFailMode === "open" && p.outputFailMode === "open") {
    return "输入与输出不能同时为 fail-open——那等于审核层被关闭且无任何症状（§8.2 要求非对称）";
  }

  /*
   * 键集校验。
   *
   * 裁决回的是防护维度名，库里可能存着旧的六类。
   * 旧形状能通过"至少启用一个"的检查，却抑制不了任何一类：
   * `policy.categories["contentModeration"]` 是 undefined，`undefined !== false` 恒成立。
   * 因此要求键集完全一致，多一个少一个都判非法。
   */
  const keys = Object.keys(p.categories ?? {});
  const missing = CATEGORY_KEYS.filter((k) => !(k in (p.categories ?? {})));
  const unknown = keys.filter((k) => !(CATEGORY_KEYS as readonly string[]).includes(k));
  if (missing.length || unknown.length) {
    const parts: string[] = [];
    if (missing.length) parts.push(`缺少维度 ${missing.join("、")}`);
    if (unknown.length) parts.push(`出现未知维度 ${unknown.join("、")}（旧版六类分类已随 TD-04 换掉）`);
    return `${parts.join("；")}。键集不一致会让开关静默失效`;
  }

  const enabled = CATEGORY_KEYS.filter((k) => p.categories[k]).length;
  if (enabled === 0) {
    return "至少启用一个防护维度，否则内容审核不产生任何拦截";
  }
  return null;
}

/** 按策略过滤审核结论：被关掉的类别不参与拦截。 */
export function applyPolicy(
  verdict: { safe: boolean; categories: string[] },
  policy: GuardPolicy,
): { safe: boolean; categories: string[]; suppressed: string[] } {
  if (verdict.safe) return { safe: true, categories: [], suppressed: [] };

  const active = verdict.categories.filter((c) => policy.categories[c as keyof CategoryPolicy] !== false);
  const suppressed = verdict.categories.filter((c) => !active.includes(c));
  // 命中的类别全被关掉 → 放行，但记录被抑制的类别，
  // 供运营评估关闭某类后放行了多少。
  return { safe: active.length === 0, categories: active, suppressed };
}
