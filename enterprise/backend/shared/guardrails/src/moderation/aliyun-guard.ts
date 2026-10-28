/**
 * 阿里云 AI 安全护栏 → `ContentGuard` 适配（§8.2）。
 *
 * # 策略单位是防护维度
 *
 * 阿里云返回防护维度（`Type`：contentModeration / promptAttack / sensitiveData /
 * modelHallucination / …）加细粒度标签（`Label`：political_entity、sexual_Cleavage …）。
 *
 * `applyPolicy` 按 `verdict.categories` 查 `policy.categories[c]`。
 * 两边的分类体系必须一致，否则查出来全是 `undefined`，`undefined !== false` 恒成立，
 * 任何一类都不会被抑制且无报错。因此 `CategoryPolicy` 使用防护维度
 * （见 `runtime-config.ts`），本文件回的 `categories` 就是维度名。
 *
 * 用维度而不是细粒度标签做策略单位：标签有几百个且随模型迭代增删，
 * 维度是产品面的八个，稳定且可解释。标签仍随 `labels` 带出进审计。
 *
 * # 阿里云的敏感内容检测只覆盖输入侧
 *
 * 实测（同一段含姓名/手机号/身份证/地址的文本）：
 *
 * | Service | sensitiveData |
 * |---|---|
 * | `query_security_check_pro` | ✔ 返回（watch/S0，认出姓名、省份、城市） |
 * | `response_security_check_pro` | 不返回该维度 |
 * | `response_security_check` | 不返回该维度 |
 *
 * 助手回复的脱敏不依赖阿里云，`output/pii.ts` 是输出侧唯一的 PII 防线
 * （§8.3 第 4 条"脱敏永远跑"是必需项）。流式输出的跨 chunk 脱敏（F-26-05）
 * 也由本地实现，阿里云的 sessionId 拼接只在输入侧有 sensitiveData 可拼。
 *
 * 输入侧的 `Ext.Desensitization`（已打码的正文）与 `Ext.SensitiveData`
 * （命中样本）仍然带出，用于用户把身份证号贴进对话框这类场景。
 */

import type { ContentGuard, GuardVerdict } from "./content-guard";
import {
  AliyunGuardError,
  type AliyunGuardClient,
  type AliyunGuardDetail,
  type AliyunGuardParams,
  type AliyunGuardService,
  type AliyunSuggestion,
} from "./aliyun-client";

/** doc：单次最大 2000 字符。 */
export const ALIYUN_MAX_CHARS = 2000;

/** 合并优先级（doc 表 2 Suggestion 说明）：block > mask > watch > pass。 */
const SUGGESTION_RANK: Record<AliyunSuggestion, number> = {
  pass: 0,
  watch: 1,
  mask: 2,
  block: 3,
};

export function worseSuggestion(a: AliyunSuggestion, b: AliyunSuggestion): AliyunSuggestion {
  return SUGGESTION_RANK[a] >= SUGGESTION_RANK[b] ? a : b;
}

/** 把长文本切成 ≤2000 字符的片段。不截断，截掉的部分等于未审。 */
export function sliceContent(text: string, max = ALIYUN_MAX_CHARS): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out;
}

export interface AliyunVerdict extends GuardVerdict {
  /** 阿里云的合并建议：block / mask / watch / pass。 */
  suggestion: AliyunSuggestion;
  /** 细粒度标签（`Label`），审计用。策略不按它过滤——它会随模型迭代增删。 */
  labels: string[];
  /** `sensitiveData` 维度给出的脱敏后正文；未命中时 undefined。 */
  desensitized?: string;
}

/** 把一次响应的 Detail 折成本层的裁决。 */
export function foldDetail(details: AliyunGuardDetail[]): {
  suggestion: AliyunSuggestion;
  blockedDimensions: string[];
  labels: string[];
  desensitized?: string;
} {
  let suggestion: AliyunSuggestion = "pass";
  const blockedDimensions: string[] = [];
  const labels: string[] = [];
  let desensitized: string | undefined;

  for (const d of details) {
    const s = d.Suggestion ?? "pass";
    suggestion = worseSuggestion(suggestion, s);

    // 只有该维度自己判 block 才进 categories：applyPolicy 按维度抑制，
    // 计入 watch/mask 会让关掉某维度时连带关掉观察态的记录。
    if (s === "block" && d.Type) blockedDimensions.push(d.Type);

    for (const r of d.Result ?? []) {
      if (r.Label && r.Label !== "nonLabel") labels.push(r.Label);
      // 取第一份脱敏正文。多个 Result 都带时它们对应同一段文本，内容相同
      desensitized ??= r.Ext?.Desensitization;
    }
  }
  return { suggestion, blockedDimensions, labels, desensitized };
}

export interface AliyunGuardOptions {
  /**
   * 用 `_pro` 版服务，默认 true。
   *
   * `sensitiveData`（敏感内容检测）只在 `_pro` 上返回。非 pro 版下即使控制台
   * 已开启该维度，接口也不返回，且无报错。
   *
   * pro 版计费更高（doc：本接口为收费接口）。关闭它意味着输入侧的个人信息检测一并消失。
   */
  pro?: boolean;
  /** 生成流式/会话关联 id。默认按调用即时生成，仅用于把 query 与 response 串起来看。 */
  chatId?: () => string;
}

export function createAliyunContentGuard(
  client: AliyunGuardClient,
  opts: AliyunGuardOptions = {},
): ContentGuard {
  const pro = opts.pro ?? true;
  const serviceFor = (role: "input" | "output"): AliyunGuardService => {
    if (role === "input") return pro ? "query_security_check_pro" : "query_security_check";
    return pro ? "response_security_check_pro" : "response_security_check";
  };

  return {
    async check(text, role, stream): Promise<AliyunVerdict> {
      const service = serviceFor(role);
      const slices = sliceContent(text);
      /*
       * 同一 sessionId 让审核引擎把切片拼起来判（doc 表 1 sessionId 说明）。
       *
       * 两种来源：
       *  · 传了 `stream` —— 流式送审，整轮共用一个键，`done` 由调用方控制。
       *    输出侧边流边审依赖于此：第 3 片的判定包含前两片的内容。
       *  · 没传 —— 一次性文本，本次调用自成一个会话，末片即 done。
       */
      const sessionId = stream
        ? `${stream.sessionKey}-${role}`
        : (opts.chatId?.() ?? cryptoRandom()) + `-${role}`;

      let suggestion: AliyunSuggestion = "pass";
      const dims = new Set<string>();
      const labels = new Set<string>();
      let desensitized: string | undefined;
      const raws: string[] = [];

      for (let i = 0; i < slices.length; i += 1) {
        const isLastSlice = i === slices.length - 1;
        const params: AliyunGuardParams = {
          content: slices[i],
          sessionId,
          // 流式时只有调用方标记最后一片才置 done；
          // 每次调用都置 done 会提前关闭会话，后续切片无法与前面拼接
          done: stream ? stream.done && isLastSlice : isLastSlice,
        };
        const res = await client.moderate(service, params);
        raws.push(JSON.stringify(res.Data ?? {}));

        const folded = foldDetail(res.Data?.Detail ?? []);
        // 顶层 Suggestion 与 Detail 折出来的取更严的那个：两者理论上一致，
        // 不一致时按更严处理
        suggestion = worseSuggestion(worseSuggestion(suggestion, folded.suggestion), res.Data?.Suggestion ?? "pass");
        folded.blockedDimensions.forEach((d) => dims.add(d));
        folded.labels.forEach((l) => labels.add(l));
        desensitized ??= folded.desensitized;
      }

      return {
        // mask/watch 不算不安全：前者表示应脱敏，后者表示应观察，
        // 都不拦截整段回答。只有 block 拦截。
        safe: suggestion !== "block",
        categories: [...dims],
        labels: [...labels],
        desensitized,
        suggestion,
        raw: raws.join("\n"),
      };
    },
  };
}

/** 无依赖的短随机串，只用于关联 id，不用于安全用途。 */
function cryptoRandom(): string {
  return Math.random().toString(36).slice(2, 10);
}

export { AliyunGuardError };
