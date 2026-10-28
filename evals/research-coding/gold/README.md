# 编码参照集（gold set）——编码指南

> 施工单 M82-10。
> 本目录用于度量 Coder 的编码准确度。

## 0. 目录里各文件是什么

| 文件 | 谁产出 | 说明 |
|---|---|---|
| `candidates.jsonl` | M82-03 `seed.ts --gold 200` | 200 条待编码单元（分层：场景 × persona），**已冻结** |
| `worksheet.jsonl` | `pnpm eval:research-coding --worksheet` | 空白工作表，两人各复制一份来填 |
| `coder-a.jsonl` / `coder-b.jsonl` | **两名研究者，各自独立** | 独立编码结果 |
| `disputes.jsonl` | 仲裁人 | 分歧逐条 + 仲裁理由 |
| `gold.jsonl` | 仲裁后 | 参照集本体 |
| `reference-model.jsonl` | 二次模型编码（**不是 gold**） | 见 §5，只作诊断 |
| `strata.json` | runner | 分层计数，供分层断言 |

## 1. 独立编码

两人各自独立编完 200 条后再比对。一致率度量的是"这套码表是否说得清"，
只有在两人都没看过对方答案时才有意义；中途对答案会让它失去这一含义。

一致率写进 `research_codebooks.agreement`，控制台五页顶部的
测量 Measurement 门读它；后续各页的数字都以它为前提。

## 2. 编码本体：`codebooks/v0.1.0.yaml` 是唯一依据

六条轴，逐条给：

| 轴 | 基数 | 说明 |
|---|---|---|
| `scene` | 单选 | `commute` / `long-trip` / `charging` / `cabin` / `maintenance` |
| `need_pain` | **多选，≤3** | 十一个码 + `none` |
| `job` | 单选 | `get-there` / `keep-charged` / `understand-car` / `fix-it` / `plan-ahead` / `other` |
| `emotion` | 单选 | 六类 + `mixed` + `uncertain` |
| `deliverability` | 单选 | `deliverable` / `undeliverable-hard-ban` / `unknown` |
| `polarity` | 单选 | `complaint` / `praise` / `question` / `counter-example` |

只看 codebook 里那一条的 `definition` / `include` / `exclude`。
不用推测补齐原文没有的意思；判不出时用 `uncertain`。

`candidates.jsonl` 里的 `scene_hint` 是造数时的标签，不是答案。
它形如 `场景|persona`，给的是这条语料是照哪个模板生成的。
照它填会把生成器的假设带回编码，一致率因此失去意义，编码时忽略它。

## 3. 三个最容易分歧的地方

### `need_pain` 是多选，但不是"能沾边就选"

上限 3 个。判据是这句话本身在说什么，不是它可能牵连到什么。
「天冷续航掉得快」是 `cold-range-loss` 一个码，不加 `range-anxiety`：
后者的定义是"没提温度的普通续航担心"，两者 `exclude` 互相点了名。

一句话里确实说了两件事时才给两个码，例如
「导航绕路害我多跑二十公里，现在电不够了」= `nav-detour` + `range-anxiety`。

### `emotion = uncertain` 什么时候用

话太短或只有指令、看不出情绪时用它，而不是在焦虑与烦躁之间拿不准时用它。
后者用 `mixed`（两种情绪都成立）或按主导情绪选一个。

- `uncertain`：「儿童锁在哪里设置」——一句功能询问，情绪无从判断。
- `mixed`：「这车其实挺好开的，就是这破车机每次都听错」——praise 与 frustration 同时成立。

判不出本身是观察结果：它反映语料中有多少话短到看不出情绪。
把它们摊进六类会让情绪分布看着比实际干净。

### `polarity = counter-example` 是"与主流叙事相反的证据"

不是"负面"，也不是"正面"。它指与正在形成的结论相抵触的那一条：

- 大家都在说低温掉电严重，这一条说「其实入冬以后掉的比我想象中少一些」→ `counter-example`。
- 单纯夸一句「这套车机用久了其实挺顺手的」→ `praise`。

区别在于是否存在一个被它反驳的说法。反例用于证伪，夸奖不是。

## 4. 分歧走仲裁，不走"再看一眼"

编完各自提交 `coder-a.jsonl` / `coder-b.jsonl`，然后：

1. runner 逐条比对，把不一致的写进 `disputes.jsonl`；
2. 两人（或第三人）逐条讨论，每条落一行 `arbitration`：选了哪个、依据 codebook 的哪一句；
3. 仲裁结果写进 `gold.jsonl`，`arbitrated: true`。

不为了让一致率过线改 gold。仲裁理由必须落盘，
只写"讨论后统一为 X"而无依据的记录等于隐藏分歧。
码表说不清的地方是 codebook 下一版的输入，不是改这一条的理由。

参与定义修订的样本不能再充当独立测试（方法本体 §12）。
本期不修 codebook，这 200 条全部是锁定集；一旦用于修订码表，即退出锁定集。

## 5. `reference-model.jsonl` 不是 gold，不要当 gold 用

它由另一个模型（不是 Coder 用的那个）独立编码，用途只有一个：
在人工参照集就绪之前，让 runner 与报告这条链路能在真数据上跑通，
并给"Coder 大概偏在哪些码上"一个方向。

它不写进 `research_codebooks.agreement.humanPercent`，
因此测量门不会因它而通过：模型之间一致不等于口径清晰。

## 6. 文件格式

`coder-*.jsonl` / `gold.jsonl` 每行：

```json
{
  "unitId": "cmtz…",
  "fingerprint": "3bec716e…",
  "codes": {
    "scene": ["cabin"],
    "need_pain": ["feature-discovery"],
    "job": ["understand-car"],
    "emotion": ["uncertain"],
    "deliverability": ["deliverable"],
    "polarity": ["question"]
  },
  "coder": "a",
  "arbitrated": false
}
```

每一轴都是数组，单选轴放一个元素。统一形状省掉一层"这轴是不是多选"的判断。

`disputes.jsonl` 每行：

```json
{
  "fingerprint": "3bec716e…",
  "axis": "need_pain",
  "a": ["feature-discovery"],
  "b": ["feature-discovery", "asr-error"],
  "resolved": ["feature-discovery"],
  "rationale": "codebook 里 asr-error 的 exclude 写明「只是让助手说短一点」不算；本句没有识别错"
}
```
