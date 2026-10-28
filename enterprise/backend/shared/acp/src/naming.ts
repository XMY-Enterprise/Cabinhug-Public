/**
 * ACP 会话的命名约定（ACR-035）。
 *
 * 这条约定属于底座而不属于某个应用：同一个 Agent 有多个 ACP 会话，用后缀区分，
 * 两个应用对"哪些后缀是会话变体"的判定必须一致，否则 prompt 文件、工具 ACL、
 * 进程池三处会各认各的名字。
 */

/**
 * 会话身份 → 规范 Agent 名。
 *
 * 同一个 Agent 有多个 ACP 会话，用后缀区分：
 *  - `-task`：fan-out 的分支（`trip-task`），与直达路由不共享上下文
 *  - `-voice`：表述路径（`trip-voice`）。分支已交出求解结果时，
 *    应答由直连非推理模型讲出来，正常不经过这条路。
 *    后缀家族在此一处列全：漏掉时若该路径接回 ACP，加载 prompt 会去找
 *    `trip-voice.md` 并抛错，外部症状只是"应答失败"。
 *  - `-intent`：意图抽取（`supervisor-intent`），必须与应答分开：
 *    共用一个会话时，模型在输出四要素 JSON 之后会继续以 JSON 应答，
 *    用户看到的回答是一段 `{"goal":…}`。
 *
 * 这三样东西按规范名走：pi 进程（工具表）、prompt 文件、工具 ACL。
 * 会话隔离靠会话键，不靠进程或工具表。
 *
 * Agent 名不能以这三个后缀结尾，否则它自己会被剥掉。
 */
export function canonicalAgent(agent: string): string {
  return agent.replace(/-(task|intent|voice)$/, "");
}
