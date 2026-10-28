/**
 * 按 Agent 分进程的 ACP 客户端池。
 *
 * # 必须分进程
 *
 * 一个 `AcpClient` = 一个 `pi-acp` 子进程，而工具表是进程级的：
 * `.pi/extensions/cabinhug-tools.ts` 在扩展加载时读一次 `CABINHUG_PI_AGENT`，
 * 据此向 agent-runtime 要该 Agent 的工具清单，然后 `pi.registerTool` 注册。
 * 之后这个进程里的所有会话看到的都是那一份清单。
 *
 * 共用一个进程时，所有 Agent 都拿到同一份工具表，§4.3 的能力映射不生效；
 * 缺工具的 Agent 不会报错，而是编造执行结果。
 *
 * # 不采用"并集注册 + 运行时按 Agent 拒绝"
 *
 * 那样模型仍会看到不属于它的工具，调用后被 403 再道歉；
 * §4.3 的裁剪要求的是模型根本没有这个选项。
 *
 * # 惰性
 *
 * 全量预热耗时数秒且多数会话用不到，因此第一次用到某个 Agent 才 spawn。
 * `supervisor` 例外：启动自检要用它，它也是最常用的进程。
 */

import { AcpClient, type AcpClientOptions, type AcpHealth } from "./connection";
import type { AcpApp } from "./app";
import { canonicalAgent } from "./naming";
import type { ChatTurnMessage } from "./stream";

/**
 * 进程键 = 规范 Agent + 思考档位。
 *
 * 【键带档位】fan-out 的 `trip-task` 与直达的 `trip` 职责说明、工具表相同，
 * 但思考档位是按进程定的（pi 的 `--model <id>:<level>` 在启动时固定），
 * 而两者需要的档位相反：分支的输出被 `merge.ts` 正则解析，思考纯属浪费；
 * 应答的输出车主直接读，关掉思考会明显退化（见 `thinkingLevelFor` 与 pi-agents/README）。
 * 键不带档位时，先建的进程决定后来者的档位。
 *
 * 【键不当 Agent 名用】`canonicalAgent` 只剥会话后缀，带 `:off` 的键会让
 * `loadAgentPrompt` 去找 `trip:off.md` 并抛错。因此构造 `AcpClient` 时传规范名，
 * 档位单独作为选项传下去。
 *
 * 【代价】进程数最多 9（`supervisor-intent` / `trip-task` / `ownership-task`
 * 各多一个 `off` 档进程），均为惰性创建。
 */
function processKey(app: AcpApp, agent: string): string {
  return `${canonicalAgent(agent)}:${app.thinkingFor(agent)}`;
}

export class AcpClientPool {
  private clients = new Map<string, AcpClient>();
  private disposed = false;

  constructor(private opts: Omit<AcpClientOptions, "agent">) {}

  /** 取（或建）某个 Agent 的客户端。 */
  clientFor(agent: string): AcpClient {
    const key = processKey(this.opts.app, agent);
    let c = this.clients.get(key);
    if (!c) {
      // 传规范名而不是 key：key 带 `:off` 后缀，会让 prompt 加载去找 `trip:off.md`。
      c = new AcpClient({
        ...this.opts,
        agent: canonicalAgent(agent),
        thinkingLevel: this.opts.app.thinkingFor(agent),
      });
      this.clients.set(key, c);
    }
    return c;
  }

  async *prompt(args: {
    cabinhugSessionId: string;
    agent: string;
    messages: ChatTurnMessage[];
    /** 取消信号。整包透传，池这一层不解释它。 */
    signal?: AbortSignal;
  }): AsyncGenerator<string> {
    yield* this.clientFor(args.agent).prompt(args);
  }

  /**
   * pi 会话 id → Cabinhug 会话与 Agent。
   *
   * 逐个客户端问：会话 id 是 pi 侧生成的，池这一层没有全局索引。
   * 客户端数量很少，线性扫描即可，不另建缓存以免多一处失效时机。
   */
  resolveSession(acpSessionId: string): { cabinhugSessionId: string; agent: string } | undefined {
    for (const c of this.clients.values()) {
      const hit = c.resolveSession(acpSessionId);
      if (hit) return hit;
    }
    return undefined;
  }

  /**
   * 聚合健康。
   *
   * `connected` 要求全部已建进程都连上：任一 Agent 的进程掉线，该 Agent 的请求就会失败。
   */
  getHealth(): AcpHealth & { processes: number } {
    const all = [...this.clients.values()].map((c) => c.getHealth());
    const unmapped: Record<string, number> = {};
    for (const h of all) {
      for (const [k, v] of Object.entries(h.unmappedUpdates)) unmapped[k] = (unmapped[k] ?? 0) + v;
    }
    return {
      connected: all.length > 0 && all.every((h) => h.connected),
      restarts: all.reduce((a, h) => a + h.restarts, 0),
      unmappedUpdates: unmapped,
      processes: all.length,
    };
  }

  /** 启动自检跑在 supervisor 上，它是每一轮都会用到的进程。 */
  async selfCheck(describeCalls: () => number): Promise<{ ok: boolean; detail: string }> {
    return this.clientFor("supervisor").selfCheck(describeCalls);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const c of this.clients.values()) c.dispose();
    this.clients.clear();
  }
}
