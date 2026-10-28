/**
 * 垫片：进程池实现在 `@cabinhug/acp`（ACR-035）。
 *
 * 这一层只负责补上车主面的描述符。底座一侧 `app` 是必填的，默认值只出现在
 * 确知自己是车主面的这一层；调用点保持 `new AcpClientPool()` 的写法。
 */

import { AcpClientPool as AcpClientPoolBase, type AcpClientOptions } from "@cabinhug/acp";

import { createCockpitApp } from "./cockpit-app";
import type { AgentName } from "./connection";

export class AcpClientPool extends AcpClientPoolBase {
  constructor(opts: Omit<AcpClientOptions, "agent" | "app"> & { app?: AcpClientOptions["app"] } = {}) {
    super({ ...opts, app: opts.app ?? createCockpitApp() });
  }

  /**
   * 把会话反解的结果窄回 `AgentName`。
   *
   * 底座只认 `string`（它不感知具体 Agent），而车主面的 `setSessionResolver`
   * 要的是联合类型，窄化放在这一层。
   *
   * 窄化是安全的：池里的 Agent 名全部来自车主面自己传进去的会话名。
   */
  override resolveSession(acpSessionId: string): { cabinhugSessionId: string; agent: AgentName } | undefined {
    return super.resolveSession(acpSessionId) as { cabinhugSessionId: string; agent: AgentName } | undefined;
  }
}
