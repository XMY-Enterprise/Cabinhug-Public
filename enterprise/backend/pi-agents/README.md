# enterprise/backend/pi-agents —— pi 的项目级配置

本目录不含自建协议代码：ACP 由开源 `pi-acp` 桥接，这里放的是 pi 的项目级配置、
业务 prompt、以及工具注入用的扩展。真正的接线在 `enterprise/backend/agent-runtime/src/acp-client/`。

```
.pi/settings.json          项目级设置（覆盖 ~/.pi/agent/settings.json）
.pi/extensions/            工具注入。pi 经 session/new 的 cwd 发现它
bin/pi-approved.sh         pi --approve 包装（见脚本内的说明）
prompts/<agent>.md         各 Agent 的业务 prompt
```

## 运行时边界

- 项目 Node 基线是精确 `24.20.0`，pnpm 是 `9.15.0`（由 Corepack 提供）。
- 项目解析的 `pi` 是 `@earendil-works/pi-coding-agent@0.84.1`，桥接器是
  `pi-acp@0.0.33`；两者不随 Node 基线升级。
- 业务进程不执行裸 `pi` 或裸 `pi-acp`。`agent-runtime` 从本目录下的
  `node_modules/.bin/pi-acp` 绝对路径启动，并由 `bin/pi-approved.sh` 解析
  相邻的项目内 `node_modules/.bin/pi`；宿主机全局安装不会被读取。
- 手工核对项目内版本使用：
  `corepack pnpm --filter @cabinhug/pi-agents exec pi --version`。
- 项目运行时由 `bin/pi-approved.sh` 设置 `PI_SKIP_VERSION_CHECK=1` 与 `PI_OFFLINE=1`，
  关闭 pi 本体的启动版本/包更新检查；`bin/pi` 额外屏蔽 `pi-acp@0.0.33` 绕过
  wrapper 执行的裸 `pi --version` 探针。两层都不升级 pi，也不修改用户全局设置。

## `.pi/settings.json` 钉定的三个值

JSON 放不了注释，理由记在这里。这三个值决定用户等待时长与调用成本，改动后用
`corepack pnpm probe:latency` 复量。

| 键 | 值 | 为什么 |
|---|---|---|
| `defaultProvider` | `deepseek` | —— |
| `defaultModel` | `deepseek-flash` | 见下「为什么必须钉」与「正式名 `deepseek-flash`」 |
| `defaultThinkingLevel` | `high` | 见下「思考档位：`off` 会让答案退化」 |

### 为什么必须钉模型

不设这三个键时，pi 使用自己的默认值，实际模型取决于 `~/.pi/agent/models-store.json`。
该文件里有两个候选，价格差三倍多：

| 模型 | 输入 $/M | 输出 $/M | reasoning |
|---|---|---|---|
| `deepseek-flash`（旧名 `deepseek-v4-flash`） | 0.14 | 0.28 | ✅ |
| `deepseek-v4-pro` | 0.435 | 0.87 | ✅ |

models-store 是用户全局文件，不进版本控制。不钉时，同一份代码在两台机器上可能跑两个模型、
两种价钱、两种延迟，延迟对照实验也因此不可比。

### 正式名 `deepseek-flash` 与 pi 目录补丁

DeepSeek 服务端把 `deepseek-v4-flash` 别名到 V4.1 Flash：请求它时响应里 `model=deepseek-flash`，
`/models` 只列 `deepseek-flash` 与 `deepseek-v4-pro`（该别名使行程四个分支的输出量下降 10~30 倍，见
`内部文档` §1）。`defaultModel` 与
`contracts` 的 `DEFAULT_DEEPSEEK_MODEL` 都写正式名；这不改变实际运行的模型，只让配置与实际一致。

pi 0.84.1 自带目录里没有 `deepseek-flash`（`pi --list-models deepseek` 只列 `deepseek-v4-flash` / `deepseek-v4-pro`）。
`.pi/agent/models.json` 用 `providers.deepseek.models` 把它并进来（合并语义：内置的保留、新 id 追加），
字段与 pi-ai 内置的 `deepseek-v4-flash` 定义一致（价格、1M 上下文、384K 输出、`thinkingFormat: deepseek`），
另加 `low: "low"`（见下「中间档」）。`.pi/agent/` 整个目录 gitignore，只有这一个文件入库；
缺少它时 pi 找不到模型，外部表现为 ACP 会话建不起来。

### 思考档位：`off` 会让答案退化

两个模型都是 `reasoning: true`。一轮 75 秒里模型思考约占 60%（`think.*` 埋点），
比工具、ACP、编排、内容审核加起来还大一个数量级。关闭思考能明显提速，但答案退化，因此缺省为 `high`。

| | 未钉（pi 默认） | `off` | `high` |
|---|---|---|---|
| 端上首字 | 75067ms | **27516ms** | 84446ms |
| 整轮 | 78104ms | **29062ms** | 85668ms |
| `think.*` | 8 段 45177ms | 0 段 | 10 段 90124ms |

每档只测了一次，而思考总时长在同一问题上于 45s 与 90s 之间波动，所以这组数据不能说明
`high` 比默认慢。只有 `off` 一列有意义：0 段是结构性的（思考被关掉），29s 也在波动范围之外。
比较 `high` 与其它档需要多轮取分位。

同一个问题（深圳→黄山、带六岁小孩、看沿途天气），两档的回答：

> **默认**：……**赣州段和景德镇附近有雷阵雨**……**最关键的是黄山有台风蓝色预警**……
> 带六岁小孩，全程约 11 个小时，建议每两小时左右进服务区歇一下。另外你还没建车辆档案，
> 我不知道你具体是什么电动车、续航多少——出发前确认好沿途充电站点。
>
> **off**：……沿途天气**需要如实转述**。5段行程约两三个小时一段……
> **合肥方向不用提，就按江西到黄山这条线讲。**

`off` 的退化方式是原本在思考块里做的规划漏进可见回答："需要如实转述""合肥方向不用提，
就按…讲"是模型对自己下的指令。同时丢了台风预警，也丢了 F-13-04 要求的"你还没建车辆档案"缺失标注。

pi 自带目录里这两个模型的 `thinkingLevelMap` 把 `minimal`/`low`/`medium` 标成 `null`
（pi 文档：该档不支持，跳过/钳掉），可用的只有 `off`、`high`、`max`；接口本身接受 `low`，
见下「中间档」。

钉 `high` 换来的是可复现（同一份代码在不同机器上行为一致）与成本可预期，不是延迟。
延迟收益只有 `off` 一条路，代价是上面的退化。

### 中间档：`low` 是接口支持、目录不认

直接对 `api.deepseek.com/chat/completions` 发 `{"thinking":{"type":"enabled"},"reasoning_effort":"low"}`
不报错，`completion_tokens_details.reasoning_tokens=322`（同题 `high` 为 42；单次方差大，只证明接口接受，不证明更省）。
中间档缺的是 pi 目录里的 `null`：`clampThinkingLevel` 遇到 `low` 会上调到 `high`，
且 jsonl 里 `thinking_level_change` 也记 high，看不出被上调。

pi 的 `models.json` 覆盖层可修正映射（`modelOverrides` 与内置定义合并而非替换）：

```json
{ "providers": { "deepseek": { "modelOverrides": {
  "deepseek-v4-flash": { "thinkingLevelMap": { "low": "low" } } } } } }
```

`deepseek-flash` 不在内置目录中，因此直接在 `providers.deepseek.models` 的定义里带 `low` 映射。
pi 只读 agent 目录下的 `models.json`，而 agent 目录默认是使用者的 `~/.pi/agent/`，不随仓库走。
所以 `bin/pi-approved.sh` 把 `PI_CODING_AGENT_DIR` 指到仓库内 `.pi/agent/`，那里只入库 `models.json`；
pi 的会话 jsonl 因此落在 `.pi/agent/sessions/`（已 gitignore），不在 `~/.pi/agent/sessions/`。

`tour-task` 以 `off` 运行时推演全写进可见正文（10 轮 15000 字、117 s 生成、到超时未提交）。
`low` 在同场景对照下更糟：7 轮输出 18459 token，其中推理 15194 token、
思考块 46770 字，157 s 才提交；推演没有变短，只是从正文挪进了思考块，token 约为三倍。
因此 `agent-prompt.ts` 的 `THINKING_LEVEL_OVERRIDES` 例外表为空，`tour-task` 使用 `off`；
`models.json` 覆盖与 `PI_CODING_AGENT_DIR` 管线保留。`tour-task` 正文过长的原因在 tour.md
让模型在正文里做体检/时间轴/住宿取舍，应从提示词修正。

### 应答会话 `low` 对照

`CABINHUG_PI_ANSWER_THINKING=low` 只覆盖 `supervisor` / `ownership` / `service` / `cabin` / `test-drive` 五个表述型应答会话
（`llm/thinking-policy.ts` 的 `piThinkingLevelFor`）。8 句 × 2 次 × 两档经网关实测，落到 `supervisor` 的有效样本 11 vs 11：
凭知识作答的两句（限行规则、长江大桥）low 首 token 快 1.2–3.5 倍、思考时长减半，简单问答持平，事实与免责话术无退化；
但 low 有 3/11 轮漏出 markdown 项目符号与加粗（high 0/11），在语音播报场景属于退化。结论留 high、不钉 `PI_OVERRIDES`；
开关与 `models.json` 的 low 映射保留。重新评估前先把格式约束写进提示词，再以 n≥30 复测。见 `内部文档`。

### 不生效的配置：`thinkingBudgets`

pi 的 `thinkingBudgets`（按档位设思考 token 预算）对 DeepSeek 这条路径不生效：设 `{"high": 2048}` 后，
单段思考仍输出 `1998 片 · 7234 字`，远超上限；整轮思考 82980ms、占 85.3%。

`sdk.js` 把它读出并传进 agent 构造，但消费方在打包进去的 pi-ai 里，DeepSeek 走
`openai-completions` + `thinkingFormat: "deepseek"`，从代码无法判断这条路是否读取它，只能实测。

settings.json 不设这个键：不生效的配置会被误认为在起作用。

### 按 Agent 分档

| 这次调用 | 输出给谁 | 思考档 |
|---|---|---|
| `supervisor-intent` | 代码解析成四要素 JSON | ❌ off，只取 JSON |
| `trip-task` / `ownership-task` | 代码解析成结构化字段（`merge.ts`） | ❌ off |
| 应答（`trip` / `ownership` / …） | **用户直接看到** | ✅ high，关闭会退化 |

pi 支持按进程分档：`--model deepseek/deepseek-flash:off`（`docs/rpc.md` 的 `--model` 支持
`provider/id:<thinking>` 后缀），由 `bin/pi-approved.sh` 经 `CABINHUG_PI_MODEL` 传入。
档位规则见 `llm/thinking-policy.ts` 的 `piThinkingLevelFor`（`-task` / `-intent` 后缀 off，应答会话 high）；
思考档位是启动参数，连接池按 (Agent, 档位) 分进程（`enterprise/backend/shared/acp/src/pool.ts` 的 `processKey`）。

## 相关

- 项目未被信任时 pi 静默忽略 `.pi/extensions/`：见 `bin/pi-approved.sh` 的文件头
- 启动自检「扩展已加载」：`agent-runtime/src/index.ts`
- 分跳耗时怎么量：`corepack pnpm probe:latency`，落点 `scripts/dev/probe/latency-probe.ts`
