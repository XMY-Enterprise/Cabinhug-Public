/**
 * 用研面的工具注入扩展（ACR-038 步 3）。
 *
 * 【pi 从本目录发现它】由 ACP `session/new` 的 `cwd` 指向 `enterprise/backend/pi-research/` 决定。
 * 本目录**没有自己的 pi 安装**——二进制、`.pi/agent/models.json` 与凭据都借 `pi-agents/`
 * （底座的 `AcpApp.binDir`，见同目录 README）。借来的只是"怎么起 pi"，
 * 项目级的 `.pi/settings.json` 与本文件仍是用研面自己的：隔离落在 pi 的项目发现层。
 *
 * 【为什么不与 `pi-agents/.pi/extensions/cabinhug-tools.ts` 合并】
 * 设计稿 §9：两份薄代理刻意重复。回调地址取自哪个环境变量、Agent 环境变量的
 * 缺省值、工具表来源（`@cabinhug/research-tools` vs `@cabinhug/tools`）三样都不同，
 * 合并后要靠一个 if 分叉，且分叉会随差异增多而膨胀。
 * 车主面那份读的变量见 `pi-agents/.pi/extensions/cabinhug-tools.ts`；本文件不写它的名字，
 * 隔离由 grep 校验。
 *
 * 【本文件是薄代理，不是工具实现】
 * 工具实现在 `enterprise/backend/shared/research-tools`（全只读、零 sensitive，不接权限门）。
 * 这里只做两件事：把工具**注册进 pi 的工具表**，以及把调用**转发回 research-runtime**。
 * 转发而不是就地执行的理由与车主面同：取数要 `ResearchToolDeps`（仓储、码表版本、
 * 镜头与分群），那些都是用研进程里的东西，pi 子进程拿不到也不该拿到。
 *
 * 【本目录不含协议代码】这里没有一行 ACP 实现，只有 pi 的扩展 API 调用与一次 HTTP 转发。
 */

/**
 * 工具端点。**没有缺省值，缺失即启动失败**（ACR-038 实施陷阱 1）。
 *
 * 回落到缺省地址比启动失败更糟：对方 `listForAgent` 对未知 Agent 回空表（HTTP 200、零工具），
 * 模型会在无工具时编出"查过了，没找到反例"，而这正是 Challenger 不能出的错。
 * 底座 `spawnEnvFor` 也不做回落，两侧同一口径。
 */
const ENDPOINT = process.env.CABINHUG_TOOLS_ENDPOINT;
if (!ENDPOINT) {
  throw new Error("[research-tools] 缺 CABINHUG_TOOLS_ENDPOINT——扩展不回落到任何缺省地址");
}

/** 本进程服务哪个研究 Agent；由 research-runtime 在 spawn pi-acp 时注入。 */
const AGENT = process.env.CABINHUG_PI_AGENT ?? "challenger";

/*
 * 与车主面的第四处差异：**不读 `CABINHUG_TOOLS`、不传 `mode`**。
 * Mock 三态是车主面外部依赖（门店 / 座舱 / 保险）才有的形态；研究工具读的是自己库里的
 * 真实数据，没有"模拟"这一态可选，传过去只会在端点侧多一个永远为 "real" 的参数。
 */

/** 形状与 `@cabinhug/research-tools` 的 `describeForPi()` 返回逐字对应。 */
interface PiToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** 研究工具恒 `false`（全只读，不接权限门）；字段保留是为了与车主面同形。 */
  sensitive: boolean;
  /** 一行简介，进系统提示词 Available tools 节；pi 的规则是不传就不进。 */
  promptSnippet?: string;
  /** 工具纪律 bullets，进 Guidelines 节；每条以 `tool_name` 开头（registry 侧测试守格式）。 */
  promptGuidelines?: string[];
}

type ExtensionApi = {
  registerTool(def: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    promptSnippet?: string;
    promptGuidelines?: string[];
    execute(
      toolCallId: string,
      params: unknown,
      signal: AbortSignal,
      onUpdate: unknown,
      ctx: { sessionManager?: { getSessionId?(): string | undefined } },
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details?: unknown }>;
  }): void;
};

export default async function researchTools(pi: ExtensionApi): Promise<void> {
  // 工具表按 Agent 裁剪（ACL 的唯一读法是 `listForAgent`）——P3 新增 Agent 时这里不用改。
  const res = await fetch(
    `${ENDPOINT}/internal/research/tools/describe?agent=${encodeURIComponent(AGENT)}`,
  );
  if (!res.ok) {
    // 取不到工具表即抛错：静默零工具时模型不调工具，且难以定位原因。
    throw new Error(`[research-tools] 无法从 research-runtime 取工具表：HTTP ${res.status}`);
  }
  const { tools } = (await res.json()) as { tools: PiToolDescriptor[] };

  // 注册回执：`--tools` 允许清单与本表同源；pi 对未知名静默忽略，错配时某工具会无声消失，
  // 这行日志用于对数。
  console.error(`[research-tools] agent=${AGENT} 注册 ${tools.length} 个工具: ${tools.map((t) => t.name).join(",")}`);

  for (const t of tools) {
    pi.registerTool({
      name: t.name,
      label: t.name,
      description: t.description,
      parameters: t.parameters,
      // 提示词元数据原样透传：纪律跟着工具走，不散进 challenger.md。
      ...(t.promptSnippet ? { promptSnippet: t.promptSnippet } : {}),
      ...(t.promptGuidelines?.length ? { promptGuidelines: t.promptGuidelines } : {}),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        // pi 的会话标识：端点按它计步（一次挑战的上界落在那一层，ACR-038 实施陷阱 3）。
        const piSessionId = ctx?.sessionManager?.getSessionId?.() ?? "unknown";
        const r = await fetch(`${ENDPOINT}/internal/research/tools/invoke`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: t.name, args: params, agent: AGENT, piSessionId }),
          signal,
        });
        const body = (await r.json()) as { ok: boolean; result?: unknown; error?: string };
        if (!body.ok) {
          // 失败要让模型看得见，它才能改参数重试或换路——不是静默返回空。
          // 「工具步数已用满」也从这条路回来，模型据此收手去收口。
          return { content: [{ type: "text", text: `工具执行失败：${body.error ?? "unknown"}` }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(body.result) }], details: body.result };
      },
    });
  }
}
