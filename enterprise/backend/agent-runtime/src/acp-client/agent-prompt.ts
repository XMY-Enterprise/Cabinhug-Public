/**
 * 子 Agent 业务 prompt 的加载。
 *
 * `enterprise/backend/pi-agents/prompts/*.md` 是各 Agent 的职责说明；模型读不到它们时
 * 只有 pi 的默认提示词，回答冗长，fan-out 分支会超过汇聚超时。
 *
 * # 投递方式
 *
 * 业务 prompt 经 `--append-system-prompt` 启动参数进入 pi 的系统提示词
 * （`--mode rpc` 下生效，特殊字符逐字透传）。注入点在 `connection.ts` 的 `connect()`：
 * `CABINHUG_PI_APPEND_PROMPT = loadAgentPrompt(agent)` → 包装脚本转 CLI 参数。
 * 不用 `.pi/APPEND_SYSTEM.md`：多个 Agent 共用同一个 cwd，文件注入区分不了 Agent，
 * 按进程差异化只能走参数。
 *
 * 不把职责说明前置在首轮 `session/prompt` 里：那样它混在对话流中，会被 compaction
 * 当普通对话压缩，模型也可能把 prompt 例句当车主提问来回答。
 *
 * 本文件负责加载与规范名：读盘、缓存、抛错语义、后缀家族。
 */

import { canonicalAgent } from "@cabinhug/acp";
import { piThinkingLevelFor, type ThinkingLevel } from "../llm/thinking-policy";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import type { AgentName } from "@cabinhug/tools";
import { HIGHLIGHT_PROMPT } from "../llm/answer-format";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(HERE, "../../../pi-agents/prompts");

/**
 * 占位文件的特征串。
 *
 * 在 CI 里当断言用：写着"占位骨架"的 prompt 上线不会报错，
 * 表现只是回答啰嗦、偶尔跑题。
 */
export const PLACEHOLDER_MARKER = "占位骨架";

const cache = new Map<string, string>();

/*
 * 会话身份 → 规范 Agent 名，实现在 `@cabinhug/acp`。
 *
 * 它是 ACP 的会话命名约定，不是车主面的策略：两个应用必须得出同一结果，
 * 否则 prompt 文件、工具 ACL、进程池三处会各认各的名字。
 * 后缀家族的说明见 `shared/acp/src/naming.ts` 的文档注释。
 */
export { canonicalAgent } from "@cabinhug/acp";


/**
 * 这个会话的产出给谁看，决定它需不需要思考。
 *
 * | 会话 | 产出给谁 | 思考 |
 * |---|---|---|
 * | `supervisor-intent` | 代码解析成四要素 JSON | ❌ |
 * | `*-task`（fan-out 分支） | 代码解析成结构化字段（`merge.ts`） | ❌ |
 * | 应答（`trip` / `ownership` / …） | 车主直接读 | ✅ |
 *
 * 思考占整轮耗时的大头，但全局关闭会让应答质量明显下降；被代码解析的会话
 * 不需要思考，其输出只被正则抽取结构化字段。因此只对后缀会话关闭思考。
 */
/** 档位类型与规则的真相源在 `llm/thinking-policy.ts`；这里是 pi 侧的入口，保留旧名字给 connection.ts。 */
export type { ThinkingLevel } from "../llm/thinking-policy";

/**
 * pi 会话的思考档：`-task` / `-intent` 后缀 off，应答会话 high；例外表与 `CABINHUG_PI_ANSWER_THINKING`
 * 对照实验开关都在 `piThinkingLevelFor`（thinking-policy.ts）。
 */
export function thinkingLevelFor(agent: string): ThinkingLevel {
  return piThinkingLevelFor(agent);
}

/**
 * 车主对她的称呼。
 *
 * 唯一真相源在端上：`clients/shared/rust/cabinhug-voice/src/wake.rs` 的唤醒词表
 * 决定"喊什么能叫醒她"。这里只让模型知道自己叫这个名字，
 * 未被剥掉的唤醒词进入模型时不会被误读成内容（例如曲名）。
 * 剥除唤醒词由网关负责。
 */
export const IDENTITY_PROMPT = `## 你是谁

你叫**暖暖**。车主用「暖暖」「你好暖暖」叫你。`;

export class MissingAgentPromptError extends Error {
  constructor(agent: string, reason: string) {
    super(`Agent ${agent} 的业务 prompt ${reason}（${PROMPTS_DIR}/${agent}.md）`);
    this.name = "MissingAgentPromptError";
  }
}

/**
 * 读取某个 Agent 的业务 prompt。
 *
 * 读不到时抛错而不是返回空：静默降级到"没有业务 prompt"的症状（啰嗦、跑题、超时）
 * 与模型能力问题难以区分。
 */
export function loadAgentPrompt(agent: AgentName | string): string {
  const name = canonicalAgent(agent);
  const raw = cache.get(name) ?? readPromptFile(name);

  /*
   * 身份段按传入的会话名拼，不按规范名，因此不进缓存
   * （`cabin` 与 `cabin-task` 读同一个文件，拿到的应是两份内容）。
   *
   * 判据与 `thinkingLevelFor` 相同："产出给谁看"。`-task` / `-intent`
   * 的输出被代码正则解析（`merge.ts`、意图四要素 JSON），加人设会污染字段；
   * 其余会话由车主直接读，才需要身份段。`-voice` 属于后者。
   */
  if (/-(task|intent)$/.test(agent)) return raw;
  /*
   * 关键信息标注规则排在业务 prompt 之后：它规定回答的排版，
   * 放在职责说明前面会被读成这一轮的首要任务。规则本体在 `llm/answer-format.ts`，
   * 叙述者（`NARRATOR_SYSTEM`）拼的是同一份常量，保证两条路的排版一致。
   */
  return `${IDENTITY_PROMPT}\n\n${raw}\n\n${HIGHLIGHT_PROMPT}`;
}

/** 读盘 + 缓存。缓存的是文件原文，见 `loadAgentPrompt` 里的说明。 */
function readPromptFile(name: string): string {
  let raw: string;
  try {
    raw = readFileSync(join(PROMPTS_DIR, `${name}.md`), "utf8");
  } catch {
    throw new MissingAgentPromptError(name, "文件不存在");
  }
  if (raw.trim().length === 0) throw new MissingAgentPromptError(name, "是空文件");

  cache.set(name, raw);
  return raw;
}

/** 仅供测试：清掉缓存，让下一次 `loadAgentPrompt` 重新读盘。 */
export function resetAgentPromptCache(): void {
  cache.clear();
}
