/**
 * L0 轨迹模板：事件到人话的纯查表（F-45-04）。
 *
 * # 零 LLM
 *
 * 垫场话须在触发后 500ms 内出声（US-45 非功能约束），先跑一次模型再说话会用一次等待
 * 去填另一次等待。
 *
 * # 匹配不到就返回空，没有兜底话术
 *
 * 在什么都没发生时说"正在为您查询"是一句用户无法证伪的假话。
 * 因此这里没有 `default`，没有 `fallback`，匹配不到就是 `undefined`。
 *
 * # 与 `BRANCH_NOTE` 分表
 *
 * 那张表是给屏幕看的短标签（"路线规划开始"），这张是给耳朵听的整句，两种场景的措辞要求不同。
 */

import { fillerPhraseAt, type FillerPhase } from "@cabinhug/shared";

/**
 * 第 1 句的确定性进度前缀。
 *
 * # 不交给模型
 *
 * 它是一句进度断言，交给模型就可能把"已经开始处理"说成"已经查到了"，用户无法证伪。
 * 第 1 句还在静默阈值（1.5 秒）上触发，而一次生成要 1~2 秒，交给模型只会更晚或超时回落。
 *
 * # 多说法轮换
 *
 * 每个阶段一组说法，配上一组引子，按会话轮次轮换，避免重复：
 * 5 个阶段 × 4 种说法 × 5 个引子 = 100 种组合。
 *
 * 每一条都必须是同一个断言的不同说法，不得出现"快查完了"之类的时长承诺——
 * 旁路不知道还要多久（与 `FILLER_PHRASE` 同一条约束，有测试逐词检查）。
 */
const PROGRESS_PREFIX: Readonly<Record<Phase, readonly string[]>> = Object.freeze({
  understanding: Object.freeze([
    "后台已经开始处理您的需求",
    "您这个问题我们已经接上了",
    "后台正在把您说的拆开看",
    "这事儿后台已经在办了",
  ]),
  routing: Object.freeze([
    "后台已经知道该查哪儿了",
    "该找哪一路后台已经定了",
    "方向后台已经找着了",
    "后台已经挑好从哪儿下手",
  ]),
  profile: Object.freeze([
    "后台正在看您这辆车的档案",
    "您这台车的底子后台正在调",
    "后台在翻您这辆车的记录",
    "车的资料后台已经在看了",
  ]),
  retrieval: Object.freeze([
    "后台正在翻您这车的手册",
    "手册那边后台正在查",
    "后台在资料里找对应那一段",
    "该翻的册子后台已经翻上了",
  ]),
  composing: Object.freeze([
    "后台查完了，正在整理",
    "东西齐了，后台正在归拢",
    "后台把查到的正往一块儿凑",
    "材料到齐了，后台在理顺",
  ]),
});

/**
 * 前缀与闲话之间的引子，只在本轮第 1 句出现。
 *
 * 与前缀分开轮换（不同的取模），组合数才是相乘而非相加。
 */
const PROGRESS_BRIDGE_POOL: readonly string[] = Object.freeze([
  "，要不我先跟您聊会天：",
  "，这空档我陪您说说话：",
  "，趁这会儿咱们随便聊聊：",
  "，等着的工夫说点别的：",
  "，我先跟您唠两句：",
]);

/** 仅供测试与结构性断言。 */
export function progressTables(): {
  prefix: Readonly<Record<Phase, readonly string[]>>;
  bridges: readonly string[];
} {
  return { prefix: PROGRESS_PREFIX, bridges: PROGRESS_BRIDGE_POOL };
}

/**
 * 取第 `variant` 号说法（0 起，自动回绕）。
 *
 * 与 `FILLER_PHRASE` 的"用完就闭嘴"不同：这里每一轮都是新的进度断言，
 * 说法回绕不会造成同一件事的重复。
 */
export function progressPrefix(phase: Phase, variant = 0): string {
  const pool = PROGRESS_PREFIX[phase];
  return pool[Math.abs(variant) % pool.length];
}

export function progressBridge(variant = 0): string {
  // 与前缀错开取模：同为 4 的倍数时两者会同步回绕，组合数塌回 5 种。
  return PROGRESS_BRIDGE_POOL[Math.abs(variant) % PROGRESS_BRIDGE_POOL.length];
}


/**
 * 阶段。同一阶段一轮最多说一次（见 `renderFiller`）。
 *
 * 类型与文案都来自 `@cabinhug/shared`：控制台要由 `phase` 还原这句话，
 * 单一来源保证页面上与语音里的说法一致。
 */
export type Phase = FillerPhase;

/**
 * span/trace 名 → 阶段。
 *
 * 每一条都对应实际会产生的事件；没有产生方的名字只会是永远不触发的分支。
 */
const PHASE_OF: Readonly<Record<string, Phase>> = Object.freeze({
  "acp.session_new": "understanding",
  "llm.supervisor-intent": "understanding",
  "node.understand": "understanding",
  route: "routing",
  "tool.vehicle_profile": "profile",
  "tool.usage_profile": "profile",
  "tool.ragflow_retrieve": "retrieval",
  merge: "composing",
});

/** 仅供测试与 `check:arch` 的结构性断言使用。 */
export function templateTables(): { phases: Readonly<Record<string, Phase>> } {
  return { phases: PHASE_OF };
}

export function phaseOf(name: string | undefined): Phase | undefined {
  if (!name) return undefined;
  return PHASE_OF[name];
}

export interface FillerDraft {
  text: string;
  phase: Phase;
  /** 这是第几句（1 起）。进轨迹 `detail`。 */
  ordinal: number;
  /**
   * 哪一档出的。
   *
   * 控制台只能由 `phase#ordinal` 还原 L0 的文本（词表是代码常量）；
   * L1 是模型现生成的，还原不出来。不标档位时页面会用 L0 词表还原出一句用户没听过的话。
   */
  source: "l0" | "l1";
}

/**
 * 取最近一条能映射到阶段的信号，渲染出该阶段还没说过的下一句。
 *
 * 从后往前找：用户关心的是现在在干什么，而不是这一轮干过什么。
 *
 * 同一阶段可以说多句：文案表按阶段给了一组，依次推进。第二句描述的仍是同一阶段，
 * 不引入新断言；它用于填补单跳较长（可达 3.8 秒）且 span 完成时才落的空白。
 *
 * 用完这一阶段的全部句子 → `undefined`，调用方据此保持安静。
 * 不循环：转圈说同样的话比不说更像卡住了。
 */
export function renderFiller(
  signals: ReadonlyArray<{ name?: string }>,
  spoken: ReadonlyMap<Phase, number>,
): FillerDraft | undefined {
  for (let i = signals.length - 1; i >= 0; i -= 1) {
    const phase = phaseOf(signals[i].name);
    if (!phase) continue;
    const used = spoken.get(phase) ?? 0;
    const text = fillerPhraseAt(phase, used);
    // 这一阶段的话说完了就保持安静，不回头找更早的阶段（那是在描述过去）。
    if (!text) return undefined;
    return { text, phase, ordinal: used + 1, source: "l0" };
  }
  return undefined;
}
