/**
 * 业务话术注入（§8.3 末条）。
 *
 * # 放在这里而不是 enterprise/backend/shared/guardrails
 *
 * 风险等级标签与免责话术是业务规则，不是通用 Guardrails 逻辑（§8.3）。
 * 通用包必须保持无业务耦合（§10 要点 3），否则它就不能被其它服务复用，
 * 也没法脱离 Cabinhug 单测。`check:arch` 的 guardrails-purity 守着这条边界。
 *
 * # 免责必须简短
 *
 * 用户会跳过三行以上的免责声明（FL-20 F-20-14）。
 * 免责若淹没了实质回答，用户会连实质回答一起跳过，比不加免责更危险。
 * 因此：集中一处、简短、不逐句挂载。
 */

export type RiskLevel = "low" | "medium" | "high";

export interface Disclaimer {
  /** 风险等级标签，展示在回答开头。 */
  label: string;
  /** 一句话免责，不超过一行。 */
  text: string;
  /** 可执行的下一步——"拒绝的是结论，不是帮助"（FL-20 核心矛盾）。 */
  nextStep: string;
}

/** 话术全集：售后按风险三档 + 金融一档。运营可改的就是这个结构。 */
export interface DisclaimerText {
  service: Record<RiskLevel, Disclaimer>;
  finance: Disclaimer;
}

const SERVICE: Record<RiskLevel, Disclaimer> = {
  low: {
    label: "风险：低",
    text: "以下为 AI 辅助判断，不替代专业检测。",
    nextStep: "可继续观察；若症状加重再来问我。",
  },
  medium: {
    label: "风险：中",
    text: "以下为 AI 辅助判断，不替代专业检测。",
    nextStep: "建议近期到店检查；我可以帮你列出向修理厂追问的关键问题。",
  },
  high: {
    label: "风险：高",
    text: "以下为 AI 辅助判断，不替代专业检测。",
    nextStep: "建议尽快停车检查；下面是需要立即停车的迹象清单。",
  },
};

/** 编译期默认话术。DB 里没有、或存的那份非法时回落到它。 */
export const DEFAULT_DISCLAIMER_TEXT: DisclaimerText = {
  service: SERVICE,
  finance: {
    label: "测算说明",
    text: "以上为估算，实际受地区、车型、金融方案影响；本系统不代理任何金融产品。",
    nextStep: "可以改任一假设让我重算。",
  },
};

/** 售后场景：风险分级 + 免责（§8.3 末条）。`text` 省略时用编译期默认。 */
export function serviceDisclaimer(level: RiskLevel, text: DisclaimerText = DEFAULT_DISCLAIMER_TEXT): Disclaimer {
  return text.service[level];
}

/**
 * 金融/推荐场景（FL-15 F-15-09）。
 *
 * 不使用紧迫感话术（"限时优惠""名额紧张"），这类话术会把目标用户推走。
 * 写在代码里是为了让它不被文案随手改掉。
 */
export function financeDisclaimer(text: DisclaimerText = DEFAULT_DISCLAIMER_TEXT): Disclaimer {
  return text.finance;
}

/** 拼成一段——集中一处，不逐句挂载。 */
export function renderDisclaimer(d: Disclaimer): string {
  return `【${d.label}】${d.text}${d.nextStep}`;
}

/**
 * 话术开关（业务侧）。
 *
 * 不放在 `enterprise/backend/shared/guardrails` 的 GuardPolicy 里：话术是 Cabinhug 的业务规则，
 * 通用包必须保持可被其它服务复用（§10 要点 3），`check:arch` 的 guardrails-purity 守着这条边界。
 */
export interface DisclaimerPolicy {
  serviceEnabled: boolean;
  financeEnabled: boolean;
}

export const DEFAULT_DISCLAIMER_POLICY: DisclaimerPolicy = {
  serviceEnabled: true,
  financeEnabled: true,
};

/**
 * 售后免责不允许被关闭——它承载的是"不替代专业检测"这条法律与安全承诺
 * （§8.3 末条 / FL-20 的核心矛盾），不是可选的文案偏好。
 * 金融免责可关（不同地区合规要求不同）。
 */
export function validateDisclaimerPolicy(p: DisclaimerPolicy): string | null {
  if (typeof p?.serviceEnabled !== "boolean" || typeof p?.financeEnabled !== "boolean") {
    return "话术开关缺字段：serviceEnabled / financeEnabled 都必须是布尔";
  }
  return p.serviceEnabled ? null : "售后免责话术不可关闭——它是安全承诺不是文案偏好（§8.3）";
}

/**
 * 单条免责渲染后的长度上限。
 *
 * 依据 FL-20 F-20-14：免责淹没实质回答时用户会连实质回答一起跳过。
 * 60 个全角字符约合车机两行、手机三行，是还会被读完的上限。
 */
export const MAX_DISCLAIMER_CHARS = 60;

const RISKS: RiskLevel[] = ["low", "medium", "high"];

/**
 * 话术文案校验。
 *
 * 三条都拦"改完之后免责等于没有"的形态：字段缺失、空串、以及太长。
 * 空串渲染出来只剩一个孤零零的【风险：高】。
 */
export function validateDisclaimerText(t: DisclaimerText): string | null {
  const check = (d: Disclaimer | undefined, where: string): string | null => {
    if (!d) return `${where}：缺失`;
    for (const [k, v] of [["label", d.label], ["text", d.text], ["nextStep", d.nextStep]] as const) {
      if (typeof v !== "string" || v.trim() === "") return `${where}.${k}：不能为空`;
    }
    const rendered = renderDisclaimer(d);
    if (rendered.length > MAX_DISCLAIMER_CHARS) {
      return `${where}：渲染后 ${rendered.length} 字，超过 ${MAX_DISCLAIMER_CHARS} 字上限——免责淹没实质回答比不加更危险（F-20-14）`;
    }
    return null;
  };

  for (const r of RISKS) {
    const err = check(t?.service?.[r], `service.${r}`);
    if (err) return err;
  }
  return check(t?.finance, "finance");
}
