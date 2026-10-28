# research-runtime

用户研究面的分析进程（ARCH-001 /
ACR-034）。
端口 **8800**，只绑 `127.0.0.1`，无鉴权。

## 独立进程

研究面是跨用户聚合：「这一百台车里有多少台在低温下抱怨过续航」这个问题没有用户键可带。

`agent-runtime` 里每个仓储都带 `userId` / `vin`，缺一个条件就会读到别人的数据。
把无键读放进那个进程等于给端上路径留一条无键入口，漏用时没有任何现象。

所以研究面另起一个进程，并由 `check:arch` 的 `research-isolation` 守住：
本目录不得 import `@cabinhug/agent-runtime` / `@cabinhug/tools` / `@cabinhug/memory`。

## 与 pi / ACP 的关系

Coder / Namer / Synthesizer 产出的是给代码解析的结构化结果，不是给人读的流式回答，
需要 `generateObject` 的 zod schema 约束，因此直连模型。Challenger 的探查跳由模型自己
循环调只读工具，经 ACP（`RESEARCH_CHALLENGER_TRANSPORT` 缺省 `acp`，`direct` 为回滚值）；
收口跳仍是一次 `generateObject`。详见 ACR-038。

## 起停

```bash
corepack pnpm dev:restart research-runtime
corepack pnpm dev:logs research-runtime
curl -s 127.0.0.1:8800/health | python3 -m json.tool
```

本进程在 `dev.sh` 的默认集合里。研究面由两个开关控制：

| 开关 | 缺省 | 管什么 |
|---|---|---|
| `RESEARCH_ENABLED` | `off` | worker 挂不挂 `research-acquire` 取数任务 |
| `RESEARCH_RUNTIME_URL` | 空 | 网关代不代理 `/console/research/*` |

本进程能否启动与这两个开关无关（开关关着时它只是空转），
但缺 `DEEPSEEK_API_KEY` 时编码队列不注册，只读端点照常，`/health` 的 `queue.code` 报 `false`。

## 目录

| 路径 | 干什么 |
|---|---|
| `codebooks/*.yaml` | **口径本身**。版本 = 文件 sha256；锁版后文件被改 → 启动拒绝 |
| `prompts/coder.md` | 编码员的系统提示词。业务提示词，不经 pi |
| `src/llm/` | 唯一的模型入口。**思考恒关**，`test/thinking.test.ts` 扫源码守它 |
| `src/codebook/` | 载入、结构校验、锁版对账 |
| `src/coding/` | codebook → zod schema；Coder |
| `src/queue/` | `research.code` 与 `research.embed` 的消费者；`research.snapshot` 只注册占位 handler |
| `src/internal-api/` | 只读 HTTP 面。**永不返回原文** |

## 三条约束

1. **思考必须显式关。** DeepSeek v4 全系默认 thinking on，SDK 关不掉，
   要在 provider 的 `fetch` 层合进 `thinking: {type:"disabled"}`。
   不关时不报错，表现为思考数十秒、上万字后一个字段都没填。
   验收查 `SELECT sum(reasoning_tokens) FROM llm_usage WHERE agent LIKE 'research-%'` 应为 0。
2. **codebook 锁版后只增不改。** 改一个码的定义不产生任何可见现象：图照出、
   一致率照样高（两批各自内部仍一致），只有跨版本比较时数字换了含义。
   唯一的拦截点是启动期的 hash 比对。
3. **端点永不返回原文。** 证据出口用**白名单挑字段**而不是删字段，
   库里新增一列时默认不出现。`test/api.test.ts` 断言响应体里没有 `content` 键。

## 队列

三条队列与 `agent-runtime` 的 `guide.*` 共用 `pgboss` schema，两个进程各起一个实例、
各 `work()` 自己的队列。本进程**只消费 `research.*`**，不碰 `guide.*`。

| 队列 | 谁入队 | 谁消费 |
|---|---|---|
| `research.code` | worker 的 `research-acquire` | 本进程 |
| `research.embed` | 本进程（编码完成后） | 本进程（缺 `DASHSCOPE_API_KEY` 时不注册） |
| `research.snapshot` | 保留 | 本进程（占位 handler，只记日志；快照由 `POST /internal/research/runs` 同步算） |
