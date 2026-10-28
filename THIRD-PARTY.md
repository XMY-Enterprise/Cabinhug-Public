# 第三方依赖清单（THIRD-PARTY）

> 生成日期 2026-09-11，2026-09-24 更新。表 1、表 2 由脚本从 `pnpm -r list --depth 0`、`pnpm licenses list` 与 `cargo metadata` 生成；表 3 来自 `vision-trainer` 的 uv 环境与 `vision-infer` 的锁文件；表 4、表 5 手写。
> 只列**直接依赖**的名字、版本与许可证；传递依赖按许可证汇总在 §6。商业服务（模型、地图、审核、知识库）的调用环节、费用假设与锁定风险在 [docs/disclosure.md](docs/disclosure.md)。
> 本仓自身以 MIT 发布（根 `LICENSE`）。下面标注了两处许可证与 MIT 不同、需要单独说明的依赖。

## 0. 需要单独说明的两处

| 依赖 | 许可证 | 在哪 | 说明 |
|---|---|---|---|
| `ultralytics` | AGPL-3.0 | `enterprise/backend/vision-trainer`（Python 服务） | 警示灯检测器的训练工具，只在开发机上使用（ACR-026），不对外提供服务，也不随公开仓发布；该目录应视为 AGPL-3.0 派生物，**不按 MIT 再分发**。线上推理由 `vision-infer`（onnxruntime，MIT）承担。要商用可换 Apache-2.0 的实现或购买 Ultralytics 商业许可（ACR-026 §风险）。 |
| `webrtc-audio-processing(-sys)` 2.1.0 | BSD-3-Clause（crate 无 `license` 字段，许可证在 COPYING）；另附 Google 专利授权 `webrtc/PATENTS` | `clients/shared/rust/cabinhug-media`；`clients/shared/rust/vendor/` 带一份 iOS 交叉编译补丁 | Google WebRTC 的 AEC；补丁只改 build script，来由与删除条件见 `clients/shared/rust/vendor/README.md`。所含第三方组件见 §7。 |

## 1. JavaScript / TypeScript 直接依赖（47 个）

| 包 | 版本 | 许可证 | 运行 / 开发 | 使用方（workspace 成员） |
|---|---|---|---|---|
| `@agentclientprotocol/sdk` | 0.26.0 | Apache-2.0 | 运行 | agent-runtime |
| `@ai-sdk/deepseek` | 0.1.17 | Apache-2.0 | 运行 | agent-runtime |
| `@ai-sdk/openai-compatible` | 0.1.17 | Apache-2.0 | 运行 | agent-runtime |
| `@aws-sdk/client-s3` | 3.1106.0 | Apache-2.0 | 运行 | gateway |
| `@earendil-works/pi-coding-agent` | 0.84.1 | MIT | 开发 | pi-agents |
| `@langchain/core` | 1.2.5 | MIT | 运行 | agent-runtime |
| `@langchain/langgraph` | 1.4.9 | MIT | 运行 | agent-runtime |
| `@langchain/langgraph-checkpoint` | 1.1.3 | MIT | 运行 | agent-runtime |
| `@langchain/langgraph-checkpoint-postgres` | 1.0.4 | MIT | 运行 | agent-runtime |
| `@napi-rs/image` | 1.16.0 | MIT | 运行 | tools |
| `@number-flow/react` | 0.6.2 | MIT | 运行 | web |
| `@paper-design/shaders-react` | 0.0.80 | Apache-2.0 | 运行 | web |
| `@prisma/client` | 6.19.3 | Apache-2.0 | 运行 | db |
| `@qdrant/js-client-rest` | 1.19.0 | Apache-2.0 | 运行 | rag |
| `@tauri-apps/api` | 2.11.1 | Apache-2.0 OR MIT | 运行 | cockpit, mobile |
| `@tauri-apps/cli` | 2.11.4 | Apache-2.0 OR MIT | 开发 | cockpit, mobile |
| `@tauri-apps/plugin-geolocation` | 2.3.2 | MIT OR Apache-2.0 | 运行 | mobile |
| `@types/express` | 5.0.6 | MIT | 开发 | gateway |
| `@types/node` | 22.20.1 | MIT | 开发 | agent-runtime, db, gateway, memory, mock-cabin, mock-dealer, mock-insurance, mock-repair, mock-tts, rag, shared, web, worker |
| `@types/node-cron` | 3.0.11 | MIT | 开发 | worker |
| `@types/react` | 18.3.31 | MIT | 开发 | cockpit, mobile, ui, web |
| `@types/react-dom` | 18.3.7 | MIT | 开发 | cockpit, mobile, ui, web |
| `@vitejs/plugin-react` | 4.7.0 | MIT | 开发 | cockpit, mobile, web |
| `ai` | 4.3.19 | Apache-2.0 | 运行 | agent-runtime |
| `c8` | 12.0.0 | ISC | 开发 | cabinhug |
| `express` | 4.22.2 | MIT | 运行 | gateway |
| `http-proxy-middleware` | 4.2.0 | MIT | 运行 | gateway |
| `husky` | 9.1.7 | MIT | 开发 | cabinhug |
| `mem0ai` | 3.1.5 | Apache-2.0 | 运行 | memory |
| `node-cron` | 3.0.3 | ISC | 运行 | worker |
| `pg-boss` | 12.28.1 | MIT | 运行 | agent-runtime |
| `pi-acp` | 0.0.33 | MIT | 开发 | pi-agents |
| `prettier` | 3.9.6 | MIT | 开发 | cabinhug |
| `prisma` | 6.19.3 | Apache-2.0 | 开发 | db |
| `react` | 18.3.1 | MIT | 运行 | cockpit, mobile, ui, web |
| `react-dom` | 18.3.1 | MIT | 运行 | cockpit, mobile, ui, web |
| `react-router-dom` | 7.18.2 | MIT | 运行 | web |
| `reactflow` | 11.11.4 | MIT | 运行 | web |
| `recharts` | 3.10.1 | MIT | 运行 | web |
| `redis` | 4.7.1 | MIT | 运行 | agent-runtime, gateway, tools |
| `tsx` | 4.23.9 | MIT | 开发 | agent-runtime, cabinhug, db, gateway, guardrails, memory, mobile, mock-cabin, mock-dealer, mock-insurance, mock-repair, mock-tts, rag, shared, tools, ui, web, worker |
| `turbo` | 2.10.8 | MIT | 开发 | cabinhug |
| `typescript` | 5.9.3 | Apache-2.0 | 开发 | agent-runtime, cabinhug, cockpit, db, gateway, guardrails, memory, mobile, mock-cabin, mock-dealer, mock-insurance, mock-repair, mock-tts, rag, shared, tools, ui, web, worker |
| `vite` | 6.4.3 | MIT | 开发 | cockpit, mobile, web |
| `yaml` | 2.9.0 | ISC | 开发 | cabinhug |
| `zod` | 3.25.76 | MIT | 运行 | agent-runtime, guardrails, memory, tools |
| `zod-to-json-schema` | 3.25.2 | ISC | 运行 | tools |

## 2. Rust 直接依赖（27 个）

| crate | 版本 | 许可证 | 使用方（workspace 成员） |
|---|---|---|---|
| `apple-native-keyring-store` | 1.0.2 | MIT OR Apache-2.0 | cabinhug-core |
| `base64` | 0.22.1 | MIT OR Apache-2.0 | cabinhug-net, cockpit, mobile |
| `block2` | 0.6.2 | MIT | cabinhug-media |
| `cpal` | 0.17.1 | Apache-2.0 | cabinhug-media |
| `futures-util` | 0.3.33 | MIT OR Apache-2.0 | cabinhug-net |
| `image` | 0.25.10 | MIT OR Apache-2.0 | cabinhug-media |
| `keyring` | 4.2.0 | MIT OR Apache-2.0 | cabinhug-core |
| `keyring-core` | 1.0.0 | MIT OR Apache-2.0 | cabinhug-core |
| `libc` | 0.2.189 | MIT OR Apache-2.0 | mobile |
| `objc2` | 0.6.4 | MIT | cabinhug-media, mobile |
| `objc2-foundation` | 0.3.2 | MIT | cabinhug-media |
| `pinyin` | 0.11.0 | MIT | cabinhug-voice, cockpit |
| `reqwest` | 0.13.4 | MIT OR Apache-2.0 | cabinhug-net |
| `rodio` | 0.22.2 | MIT OR Apache-2.0 | cabinhug-tts, cockpit |
| `rusqlite` | 0.32.1 | MIT | cabinhug-core |
| `serde` | 1.0.229 | MIT OR Apache-2.0 | cabinhug-core, cabinhug-net, cockpit, mobile |
| `serde_json` | 1.0.151 | MIT OR Apache-2.0 | cabinhug-core, cabinhug-net, cockpit, mobile |
| `tauri` | 2.11.5 | Apache-2.0 OR MIT | cockpit, mobile |
| `tauri-build` | 2.6.3 | Apache-2.0 OR MIT | cockpit, mobile |
| `tauri-plugin-geolocation` | 2.3.2 | Apache-2.0 OR MIT | mobile |
| `tauri-plugin-opener` | 2.5.4 | Apache-2.0 OR MIT | cockpit, mobile |
| `thiserror` | 2.0.19 | MIT OR Apache-2.0 | cabinhug-core, cabinhug-media, cabinhug-net |
| `tokio` | 1.53.1 | MIT | cabinhug-net, cabinhug-tts, cockpit |
| `tract-onnx` | 0.23.7 | MIT OR Apache-2.0 | cabinhug-vision |
| `ts-rs` | 12.0.1 | MIT | cabinhug-core |
| `webrtc-audio-processing` | 2.1.0 | BSD-3-Clause（COPYING，Google WebRTC） | cabinhug-media |
| `webrtc-vad` | 0.4.0 | MIT | cabinhug-media |

## 3. Python 依赖

`enterprise/backend/vision-trainer`（uv 环境实测版本；该目录不随公开仓发布）：

| 包 | 版本 | 许可证 |
|---|---|---|
| `ultralytics` | 8.4.143 | AGPL-3.0（见 §0） |
| `torch` | 2.14.0 | BSD-3-Clause（含 Apache-2.0 等组件） |
| `torchvision` | 0.29.0 | BSD-3-Clause |
| `opencv-python` | 5.0.0.93 | Apache-2.0 |
| `onnx` | 1.22.0 | Apache-2.0 |
| `onnxruntime` | 1.29.0 | MIT |
| `numpy` | 2.5.3 | BSD-3-Clause |
| `pillow` | 12.3.0 | MIT-CMU |
| `fastapi` | 0.141.1 | MIT |
| `uvicorn` | 0.52.4 | BSD-3-Clause |
| `python-multipart` | 0.0.32 | Apache-2.0 |
| `pyyaml` | 6.0.3 | MIT |

`enterprise/backend/vision-infer`（`requirements.lock.txt` 锁定版本，只列直接依赖）：

| 包 | 版本 | 许可证 |
|---|---|---|
| `onnxruntime` | 1.29.0 | MIT |
| `fastapi` | 0.141.1 | MIT |
| `uvicorn` | 0.52.4 | BSD-3-Clause |
| `pillow` | 12.3.0 | MIT-CMU |
| `numpy` | 2.4.6 | BSD-3-Clause（含 0BSD、MIT、Zlib、CC0-1.0 组件） |

## 4. 模型权重、数据集与非代码素材

| 项 | 许可证 / 授权 | 用途 | 进入公开发布 |
|---|---|---|---|
| `yolo11n.pt`（Ultralytics 预训练权重） | AGPL-3.0 | 指示灯检测器的训练起点 | 否（训练机本地下载，`*.pt` 被忽略） |
| 指示灯检测器权重（`clients/shared/rust/cabinhug-vision/models/`） | 以 `yolo11n.pt` 为起点训练，适用 AGPL-3.0 | 端上检测（编入车机端与手机端）、`vision-infer` 推理 | 否（缺权重时端上与 `vision-infer` 均降级为服务端定位） |
| `nomic-embed-text`（经本机 Ollama） | Apache-2.0 | Mem0 记忆向量化，不出网 | 否（Ollama 拉取） |
| Roboflow「Tesla New HMI」v1（815 张屏幕实拍） | CC BY 4.0，署名见下 | 合成训练集的屏幕底图；其中 13 帧原样用作评测负样本 | 13 帧评测样本（`evals/vision-observe/negatives/neg-*-roboflow.jpg`） |
| 厂商车主手册 / 保养手册（Tesla、雪佛兰） | 厂商版权 | 知识库检索与图标核验 | 否 |
| 手册指示灯图标与目录表（`clients/mobile/src/features/service/assets/lamps/`、`data/kb-src/icons/tesla-model3-indicators.md`） | 厂商版权（Tesla 车主手册） | 手机端观察卡图标、图标核验 | 否（缺图时观察卡回落到着色三角块） |
| 手册全文块表（`evals/figure-anchor/fixtures/`，MinerU 转写） | 厂商版权（Tesla、雪佛兰车主手册） | 图文锚定评测与 `rag` 真块表用例 | 否（缺文件时相关用例跳过） |
| 界面字体 Inter、Noto Sans SC（woff2） | SIL OFL 1.1，许可证原文随字体存放 | 车机端与手机端界面 | 是（`clients/shared/ui/src/assets-fonts/`） |
| 和风天气（QWeather）逐日预报 | 和风天气开发者许可协议（免费额度内允许商用；须在显示天气的界面署名并链接官网；不得转售或再分发数据） | 天气基础预报（缺省，`WEATHER_PROVIDER=qweather`） | — |
| 高德天气 | 高德开放平台服务协议（免费额度限非商业目的） | 天气基础预报（仅 `WEATHER_PROVIDER=amap` 时） | — |
| Open-Meteo 天气 | 数据 CC BY 4.0；免费接口限非商用 | 天气基础预报（仅 `WEATHER_PROVIDER=open-meteo` 时，不作兜底） | — |
| 中国气象局天气网公开接口 | 未签商用协议 | 天气增强层（实况、预警、第 5~7 天），开关 `CABINHUG_WEATHER_CMA` | — |
| 界面素材（暖暖形象、HUD 图标） | 项目自制（AI 生成 + 人工修图） | 车机端与手机端 | 是 |

署名：「Tesla New HMI」数据集 v1，Roboflow Universe 工作区 tesla-new-hmi，
<https://universe.roboflow.com/tesla-new-hmi/tesla-new-hmi>，CC BY 4.0
（<https://creativecommons.org/licenses/by/4.0/>）。训练用途经裁切与合成，评测样本为原帧。

字体：Inter，Copyright 2016 The Inter Project Authors（<https://github.com/rsms/inter>）；
Noto Sans SC，Copyright Google Inc.；均以 SIL Open Font License 1.1 发布，许可证全文见
`clients/shared/ui/src/assets-fonts/LICENSE-inter.txt` 与 `LICENSE-noto-sans-sc.txt`。

## 5. 运行时接入的商业服务（详见 docs/disclosure.md）

DeepSeek（LLM 与视觉表述）、阿里云百炼 / 通义千问（视觉观察、ASR、TTS、图标向量）、火山方舟 / 豆包（ASR、TTS）、阿里云 AI 安全护栏（内容审核）、RAGFlow Cloud（知识库检索）、高德开放平台（路径规划、天气、地图底图）、MinerU（PDF 转 markdown，离线工具）、Google Calendar / CalDAV（真实日历后端，可选）。每一项都可不配置，缺省档不出网。

## 6. 传递依赖按许可证汇总

JavaScript 全量 721 个包（含传递，不含本仓 workspace 包；2026-10-28 移除 `sharp` 后按当前锁文件重算，ACR-069）：

| 许可证 | 数量 |
|---|---|
| MIT | 536 |
| Apache-2.0 | 86 |
| ISC | 52 |
| BSD-3-Clause | 25 |
| BlueOak-1.0.0 | 5 |
| BSD-2-Clause | 4 |
| Apache-2.0 OR MIT | 3 |
| MIT OR Apache-2.0 | 2 |
| CC-BY-4.0 | 1 |
| (MIT OR WTFPL) | 1 |
| (AFL-2.1 OR BSD-3-Clause) | 1 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| Unknown | 1 |
| 0BSD | 1 |
| (MIT OR CC0-1.0) | 1 |
| MIT AND ISC | 1 |

Rust 全量 642 个 crate（含传递，不含本仓 workspace 成员；2026-09-24 快照）：

| 许可证 | 数量 |
|---|---|
| MIT OR Apache-2.0 | 299 |
| MIT | 131 |
| Apache-2.0 OR MIT | 55 |
| MIT/Apache-2.0 | 30 |
| Zlib OR Apache-2.0 OR MIT | 21 |
| MPL-2.0 | 18 |
| Unicode-3.0 | 18 |
| Apache-2.0 | 10 |
| Unlicense OR MIT | 6 |
| Apache-2.0/MIT | 5 |
| Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | 5 |
| MIT OR Apache-2.0 OR Zlib | 5 |
| BSD-3-Clause | 4 |
| ISC | 4 |
| Apache-2.0 OR ISC OR MIT | 2 |
| BSD-3-Clause OR Apache-2.0 | 2 |
| BSD-3-Clause OR MIT OR Apache-2.0 | 2 |
| MIT OR Apache-2.0 OR LGPL-2.1-or-later | 2 |
| Unlicense/MIT | 2 |
| 见包内 LICENSE 文件 | 2 |
| BSD-2-Clause OR Apache-2.0 OR MIT | 2 |
| 0BSD OR MIT OR Apache-2.0 | 1 |
| BlueOak-1.0.0 OR MIT OR Apache-2.0 | 1 |
| BSD-3-Clause AND MIT | 1 |
| BSD-3-Clause/MIT | 1 |
| Apache-2.0 AND MIT | 1 |
| CC0-1.0 OR MIT-0 OR Apache-2.0 | 1 |
| (Apache-2.0 OR MIT) AND BSD-3-Clause | 1 |
| MIT / Apache-2.0 | 1 |
| Apache-2.0 / MIT | 1 |
| Zlib | 1 |
| BSD-2-Clause OR MIT OR Apache-2.0 | 1 |
| MIT OR Zlib OR Apache-2.0 | 1 |
| Apache-2.0 AND ISC | 1 |
| Apache-2.0 OR BSL-1.0 | 1 |
| Apache-2.0 WITH LLVM-exception | 1 |
| (MIT OR Apache-2.0) AND Unicode-3.0 | 1 |
| CDLA-Permissive-2.0 | 1 |

复制方法：

```bash
corepack pnpm -r list --depth 0 --json > /tmp/pnpm-direct.json
corepack pnpm licenses list --json -r > /tmp/pnpm-licenses.json
cargo metadata --format-version 1 > /tmp/cargo-metadata.json
```

## 7. `webrtc-audio-processing` 所含第三方组件

位于 `clients/shared/rust/vendor/webrtc-audio-processing-sys-2.1.0/webrtc-audio-processing/webrtc/`，
各组件的许可证原文保留在其目录内。

| 组件 | 目录 | 版权方 | 许可证 |
|---|---|---|---|
| WebRTC | `./`（`LICENSE`、`PATENTS`） | The WebRTC project authors | BSD-3-Clause；附 Google 专利授权 |
| Ooura FFT | `common_audio/third_party/ooura/` | Takuya Ooura | 允许任意用途使用、修改与分发（见 `LICENSE`） |
| spl_sqrt_floor | `common_audio/third_party/spl_sqrt_floor/` | Wilco Dijkstra | 作者书面授权（见 `LICENSE`） |
| fft | `modules/third_party/fft/` | Mark Olesen, Queen's University at Kingston | 允许使用、修改与分发，须保留声明（见 `LICENSE`） |
| PFFFT | `third_party/pffft/` | Julien Pommier；基于 NCAR FFTPACKv4 | BSD 风格（见 `LICENSE`） |
| RNNoise | `third_party/rnnoise/` | Mozilla、Jean-Marc Valin、Xiph.Org Foundation、Mark Borgerding | BSD-3-Clause（见 `COPYING`） |
