/**
 * 配置项注册表，单一真相源。
 *
 * 这张表同时驱动四件事，所以新增一项配置只改这里：
 *   1. 配置视图渲染
 *   2. 写入校验
 *   3. 启动期必填校验（缺失即快速失败）
 *   4. `.env.example` 一致性检查（`pnpm check:env-example`）
 *
 * 分类（US-35 的四分类在本表中的投影）：
 *   A 密钥类   `class: "secret"`   → 只写不读，全链路掩码
 *   B 接入面类 `class: "endpoint"` → 可读可改，热生效
 *   C 策略值类 → 不在本表：归运营控制台（§8.2 字段级分权）
 *   D 红线类   → 永远不在本表：硬禁清单、capability 白名单、omni 端到端开关
 *
 * `registryHasNoPolicyOrRedline()` 把后两条做成了可断言的不变量。
 */

import {
  CAPABILITIES,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_DEEPSEEK_VISION_MODEL,
  DEFAULT_WEATHER_PROVIDER,
  isWeatherProvider,
  unknownCapabilities,
  WEATHER_PROVIDERS,
} from "@cabinhug/shared";

/**
 * 开发环境的 JWT 签名密钥缺省值。这是仓库里唯一一份字面量：
 * `.env.example` 的注释、`enterprise/backend/gateway/src/auth/jwt.ts` 的兜底都引用它或由它派生，
 * 避免多处副本不同步。
 *
 * 名字里的 `insecure` 与 `changeme` 都是有意的：前者在代码审查里醒目，
 * 后者命中 `scripts/dev/check/check-secrets.ts` 的放行表（否则明文密钥扫描会报出它）。
 * 生产环境拿不到这个值，见 `startup.ts` 的 `isProductionEnv`。
 */
export const DEV_JWT_SECRET = "carlife-dev-insecure-jwt-secret-changeme";

/*
 * 后台两个角色的开发默认 token。本地脚本、书签与 runbook 里的 curl 依赖这两个值，
 * 不随意更改。
 */
export const DEV_CONSOLE_ADMIN_TOKEN = "admin-token";
export const DEV_CONSOLE_OPS_TOKEN = "ops-token";

export type ConfigClass = "secret" | "endpoint";
/**
 * 三种存储模式（ACR-017）：
 *  - `db`：后台为主，env 兜底（绝大多数配置）。
 *  - `env-only`：只能由部署层注入，后台只读：它们在配置层自身可用之前就被需要。
 *  - `env-override`：env 优先，其次 db，最后默认，部署层可"钉死"该项；
 *    钉死期间后台写入被拒（不做落库不生效，否则删掉 env 后会冒出一个
 *    早已遗忘的旧值）。配置页 `source` 字段如实显示 env/db/default，
 *    避免被 .env 静默覆盖。
 */
export type ConfigScope =
  | "llm"
  | "asr"
  | "tts"
  | "runtime"
  | "bootstrap"
  | "memory"
  | "rag"
  | "docparse"
  | "storage"
  | "map";
export type ConfigStorage = "db" | "env-only" | "env-override";

export interface ConfigDef {
  key: string;
  class: ConfigClass;
  scope: ConfigScope;
  /**
   * `db`：可在后台热改（A/B 类的正常形态）。
   * `env-only`：只能由部署层注入、后台只读展示，它们在配置层自身可用之前就被需要
   *   （DATABASE_URL 要先连上库，主密钥要先能解密），做成可热改是循环依赖。
   */
  storage: ConfigStorage;
  envFallback: string;
  default?: string;
  /** 启动期必填：缺失或非法即快速失败并指明具体项（AC-35-11） */
  required?: boolean;
  /**
   * 开发可用、生产必须显式覆盖的缺省值。
   *
   * 与上面的 `default` 分工不同：
   *  - `default` 是任何环境都可用的缺省（如模型名），生产使用没问题；
   *  - `devDefault` 只为让新克隆的仓库能启动，生产使用即为安全事故。
   *
   * 语义由 `startup.ts` 实现：非生产时把它写回 env 并打一行告警；
   * `NODE_ENV=production` 时视为不存在，必填项缺失照旧启动失败。
   * 只给"泄露影响面止于本机可伪造"的项用；保护落盘密文的主密钥不得加这个字段
   * （仓库里的密钥能解开任何一台机器上的库，风险远高于伪造 token）。
   */
  devDefault?: string;
  /** 只读展示：当前形态下不接受后台写入（如 fake 开关，切换归 FL-39） */
  readOnly?: boolean;
  /**
   * 取值是个闭集。有它的项在后台渲染成下拉而不是文本框。
   *
   * 引擎名这类闭集项用自由文本框时，错字要到端上不出声才会暴露，且难以定位。
   * `validate` 照着这张表兜底：界面防误输入，校验防 API 直调。
   */
  options?: readonly string[];
  description: string;
  howToObtain?: string;
  /** 返回错误信息；返回 null 表示合法 */
  validate?: (value: string) => string | null;
}

const nonEmpty = (label: string) => (v: string): string | null =>
  v.trim().length === 0 ? `${label}不能为空` : null;

const httpUrl = (v: string): string | null =>
  /^https?:\/\/.+/.test(v) ? null : "必须是 http(s):// 开头的 URL";

/**
 * 高德 key 池上限，与 `@cabinhug/tools` 的 `AMAP_KEY_MAX` 同值。
 *
 * 不从那边 import：`@cabinhug/db` 不依赖 `@cabinhug/tools`（反向依赖会成环）。两处各写一个 10，
 * 由 `config-model.test.ts` 断言相等，只改一处时测试失败。
 */
export const AMAP_SERVER_KEY_MAX = 10;

/**
 * `AMAP_SERVER_KEY_2` … `AMAP_SERVER_KEY_10` 的注册表条目。
 * 第一条 `AMAP_SERVER_KEY` 单独手写在下面：既有 `.env` 与后台配置页都依赖它，措辞保持不变。
 */
function amapServerKeyDefs(): ConfigDef[] {
  const out: ConfigDef[] = [];
  for (let n = 2; n <= AMAP_SERVER_KEY_MAX; n += 1) {
    out.push({
      key: `AMAP_SERVER_KEY_${n}`,
      class: "secret",
      scope: "map",
      storage: "db",
      envFallback: `AMAP_SERVER_KEY_${n}`,
      description:
        `高德 **第 ${n} 个账号** 的 Web 服务 key（可选）。必须来自**另一个开发者账号**——` +
        "同账号下的第二把 key 共用同一份 QPS 与日配额，配了反而更容易撞 10021。" +
        "车道数即账号数，持续速率与搜索日配额都按账号数成倍；用量按 key 指纹记在台账里，`probe:amap` 与后台财务页可看",
      howToObtain:
        "另一个高德账号 → https://console.amap.com → 应用管理 → 添加 key，服务平台选「Web 服务」；" +
        "该 key 的「数字签名」要**关闭**（我们不做 sig 签名，开着会一律返回 infocode=10008）",
    });
  }
  return out;
}

export const CONFIG_REGISTRY: readonly ConfigDef[] = [
  // ── LLM（§0 / §5.1：Vercel AI SDK + DeepSeek）
  {
    key: "DEEPSEEK_API_KEY",
    class: "secret",
    scope: "llm",
    storage: "db",
    envFallback: "DEEPSEEK_API_KEY",
    description: "DeepSeek API Key；缺省时 runtime 使用确定性 Fake 模型",
    howToObtain: "https://platform.deepseek.com 控制台 → API Keys",
    validate: nonEmpty("API Key"),
  },
  {
    key: "DEEPSEEK_MODEL",
    class: "endpoint",
    scope: "llm",
    storage: "db",
    envFallback: "DEEPSEEK_MODEL",
    default: DEFAULT_DEEPSEEK_MODEL,
    description: "对话模型名。按 Agent 的档位映射（FL-33 F-33-05）在多 Agent 落地后扩展为映射表",
    validate: nonEmpty("模型名"),
  },
  {
    key: "DEEPSEEK_VISION_MODEL",
    class: "endpoint",
    scope: "llm",
    storage: "db",
    envFallback: "DEEPSEEK_VISION_MODEL",
    default: DEFAULT_DEEPSEEK_VISION_MODEL,
    description:
      "这一次请求带了图片（照片 / 视频帧序图）时用的视觉档（M80-02，ACR-027）。纯文字请求仍走 DEEPSEEK_MODEL / CABINHUG_ANSWER_MODEL——" +
      "按请求判、不按会话钉：车主中途发一张照片，那一轮切视觉档，下一轮纯文字就切回来。" +
      "2026-09-10 起默认 deepseek-flash（V4.1 Flash 正式名）；旧名 deepseek-v4-flash-vision-exp 只是它的别名",
    validate: nonEmpty("模型名"),
  },
  {
    key: "DEEPSEEK_BASE_URL",
    class: "endpoint",
    scope: "llm",
    storage: "db",
    envFallback: "DEEPSEEK_BASE_URL",
    description:
      "OpenAI 兼容端点。切自托管代理（§5.1 可选二阶段 LiteLLM）时只改这里，llm/ 以外零代码改动",
    validate: httpUrl,
  },
  {
    key: "DEEPSEEK_ANTHROPIC_BASE_URL",
    class: "endpoint",
    scope: "llm",
    storage: "db",
    envFallback: "DEEPSEEK_ANTHROPIC_BASE_URL",
    default: "https://api.deepseek.com/anthropic",
    description:
      "DeepSeek 的 **Anthropic 兼容**端点（M32-01）。目的地推荐的联网搜索走它声明服务端工具 web_search；" +
      "与上面 OpenAI 兼容的 DEEPSEEK_BASE_URL 是两条腿，不要互相顶替",
    validate: httpUrl,
  },
  {
    key: "DEEPSEEK_SEARCH_MODEL",
    class: "endpoint",
    scope: "llm",
    storage: "db",
    envFallback: "DEEPSEEK_SEARCH_MODEL",
    default: "deepseek-v4-flash",
    description:
      "联网搜索用的模型名（M32-01）。**刻意不回落到 DEEPSEEK_MODEL**：后者是对话链路调档用的，" +
      "共用一个来源会让调对话模型的人连坐搜索；且 Anthropic 端点对不认识的模型名是静默映射，出事时对不上账",
    validate: nonEmpty("模型名"),
  },
  {
    key: "CABINHUG_LLM_FAKE_TAG",
    class: "endpoint",
    scope: "llm",
    storage: "db",
    envFallback: "CABINHUG_LLM_FAKE_TAG",
    description:
      "Fake 模型回复前缀（仅离线开发/测试可见）。真实 provider 下无效——它与 DEEPSEEK_MODEL 走同一条热生效路径，e2e 用它证明该路径不需要重启",
  },

  {
    key: "LLM_PRICE_PROMPT_PER_1K",
    class: "endpoint",
    scope: "llm",
    storage: "db",
    envFallback: "LLM_PRICE_PROMPT_PER_1K",
    default: "0.003",
    description:
      "输入 token 单价（元/1K），用于成本估算。**单价是配置不是硬编码**——涨价时改这里，不发版。" +
      `默认取 ${DEFAULT_DEEPSEEK_MODEL}（非思考）` +
      "2026-08-17 起高峰未命中价 3 元/1M；" +
      "闲时减半、缓存命中更低，这里按保守上界记",
    validate: (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? null : "必须是非负数"),
  },
  {
    key: "LLM_PRICE_COMPLETION_PER_1K",
    class: "endpoint",
    scope: "llm",
    storage: "db",
    envFallback: "LLM_PRICE_COMPLETION_PER_1K",
    default: "0.009",
    description:
      "输出 token 单价（元/1K），用于成本估算。默认取 V4-Flash 2026-08-17 起高峰输出价 9 元/1M（闲时减半）",
    validate: (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? null : "必须是非负数"),
  },
  {
    key: "TTS_PRICE_PER_10K_CHARS",
    class: "endpoint",
    scope: "tts",
    storage: "db",
    envFallback: "TTS_PRICE_PER_10K_CHARS",
    default: "6.5",
    description:
      "语音合成单价（元/万字符），用于成本估算。默认取火山豆包 seed-tts 2.0 超自然音色按量价 6.5 元/万字符" +
      "（梯度计价日用量大可到 4.9）。计费量 = 应答 delta + 垫场话的下发字符数（turn_end.answerChars）",
    validate: (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? null : "必须是非负数"),
  },

  // ── ASR（§0：豆包 omni，火山方舟 Ark）
  {
    key: "ASR_PRICE_INPUT_PER_1K",
    class: "endpoint",
    scope: "asr",
    storage: "db",
    envFallback: "ASR_PRICE_INPUT_PER_1K",
    default: "0.003",
    description:
      "ASR 输入 token 单价（元/1K），用于成本估算。默认取豆包 seed-2.0-mini 音频输入价 3 元/1M" +
      "（文本输入 0.2 元/1M，识别请求几乎全是音频，按高的记）",
    validate: (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? null : "必须是非负数"),
  },
  {
    key: "ASR_PRICE_OUTPUT_PER_1K",
    class: "endpoint",
    scope: "asr",
    storage: "db",
    envFallback: "ASR_PRICE_OUTPUT_PER_1K",
    default: "0.002",
    description: "ASR 输出 token 单价（元/1K）。默认取豆包 seed-2.0-mini 输出价 2 元/1M",
    validate: (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? null : "必须是非负数"),
  },
  {
    key: "ASR_DAILY_CALL_LIMIT",
    class: "endpoint",
    scope: "asr",
    storage: "db",
    envFallback: "ASR_DAILY_CALL_LIMIT",
    default: "0",
    description:
      "云 ASR 每日调用次数上界（ACR-016）。**0 = 不限**（默认）。超限后自动落到本地档" +
      "（免费，需 local-asr 在跑）；本地档不可用则明确失败，不返回假文本。" +
      "**不是账单上限**——它只挡我们这一侧的调用，供应商那边的钱仍要看余额。" +
      "量的大头是哨兵唤醒词转写（车内每段语音都送），设这个数前先看几天实际用量",
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 ? null : "必须是非负整数"),
  },
  {
    key: "ARK_API_KEY",
    class: "secret",
    scope: "asr",
    storage: "db",
    envFallback: "ARK_API_KEY",
    description: "火山方舟 Ark API Key；缺省时使用 Fake ASR",
    howToObtain: "火山引擎控制台 → 方舟 → API Key",
    validate: nonEmpty("API Key"),
  },
  {
    key: "ARK_BASE_URL",
    class: "endpoint",
    scope: "asr",
    storage: "db",
    envFallback: "ARK_BASE_URL",
    default: "https://ark.cn-beijing.volces.com/api/v3",
    description: "Ark 服务端点",
    validate: httpUrl,
  },
  {
    key: "ARK_ASR_MODEL",
    class: "endpoint",
    scope: "asr",
    storage: "db",
    envFallback: "ARK_ASR_MODEL",
    default: "doubao-seed-2-0-mini-260428",
    description: "omni 模型名。**只当 ASR 用**（音频→文本），端到端能力不启用（§0 语音链选型说明）",
    validate: nonEmpty("模型名"),
  },
  {
    key: "ASR_ENGINE",
    class: "endpoint",
    scope: "asr",
    storage: "env-override",
    envFallback: "ASR_ENGINE",
    default: "ark",
    options: ["ark", "aliyun", "mock"],
    description:
      "语音识别 vendor（ACR-015 立，ACR-017 收成唯一开关）。ark=火山方舟豆包 omni（默认）｜" +
      "aliyun=百炼 qwen3-asr-flash｜mock=本机 local-asr 容器（llama.cpp llama-server + Qwen3-ASR，" +
      "见 LOCAL_ASR_URL，需先 `dev.sh start local-asr`）。" +
      "⚠️ **与 TTS_ENGINE=mock 不是同一个服务**：那个是 mocks/tts（本机 say 包装成豆包协议，" +
      "8794），是假的；这个跑的是真模型，只是在本机、不花钱。热生效约 30s。" +
      "**.env 写了本项即钉死**（source 显示 env，" +
      "后台只读）——要热切就别在 .env 里写它。另有 fake 档仅供测试脚本经 env 注入，不进本闭集",
    validate: (v) =>
      ["ark", "aliyun", "mock"].includes(v.trim()) ? null : "只能是 ark / aliyun / mock",
  },
  {
    key: "DASHSCOPE_API_KEY",
    class: "secret",
    scope: "asr",
    storage: "db",
    envFallback: "DASHSCOPE_API_KEY",
    description:
      "阿里云百炼（DashScope）API Key，ASR 与 TTS 的 aliyun 档共用一把（ACR-015）。" +
      "缺省时两个 aliyun 档都不可用。**它不下发到端上**——aliyun TTS 走网关门面，密钥只在服务端",
    howToObtain: "https://bailian.console.aliyun.com → API-KEY 管理",
    validate: nonEmpty("API Key"),
  },
  {
    key: "DASHSCOPE_BASE_URL",
    class: "endpoint",
    scope: "asr",
    storage: "db",
    envFallback: "DASHSCOPE_BASE_URL",
    default: "https://dashscope.aliyuncs.com/api/v1",
    description: "百炼服务端点（ASR 与 TTS 共用）。新加坡地域或业务空间隔离时才需要改",
    validate: httpUrl,
  },
  {
    key: "ALIYUN_ASR_MODEL",
    class: "endpoint",
    scope: "asr",
    storage: "db",
    envFallback: "ALIYUN_ASR_MODEL",
    default: "qwen3-asr-flash",
    description:
      "百炼 ASR 模型名。选同步档（base64 直传、按秒计费）；" +
      "**别换成 -filetrans 后缀的异步档**——那条路要公网音频 URL，我们的哨兵段没有",
    validate: nonEmpty("模型名"),
  },
  {
    key: "LOCAL_ASR_URL",
    class: "endpoint",
    scope: "asr",
    storage: "db",
    envFallback: "LOCAL_ASR_URL",
    default: "http://127.0.0.1:8795/v1/audio/transcriptions",
    description:
      "本机 llama.cpp `llama-server` + Qwen3-ASR 的 OpenAI 风格转写端点（ACR-007）。" +
      "仅 ASR_ENGINE=mock 时使用；需先启动 infra/scripts/dev.sh 的 local-asr 目标。",
    validate: httpUrl,
  },

  // ── TTS（§0：豆包 seed-tts-2.0）
  {
    key: "BYTEDANCE_TTS_API_KEY",
    class: "secret",
    scope: "tts",
    storage: "db",
    envFallback: "BYTEDANCE_TTS_API_KEY",
    description:
      "字节 openspeech API Key。「仅 TTS_ENGINE=doubao 时使用」——mock 档不需要它。" +
      "**自 ACR-018 起只在服务端使用**：端上不再持有任何 vendor 密钥，合成经网关" +
      "`/v1/tts/speech` 转发。没配而切到豆包时，网关拒绝合成并回 NDJSON 错误行，" +
      "端上据此降级系统 TTS（不会拿占位值去打计费接口）",
    validate: nonEmpty("API Key"),
  },
  {
    key: "BYTEDANCE_TTS_RESOURCE_ID",
    class: "endpoint",
    scope: "tts",
    storage: "db",
    envFallback: "BYTEDANCE_TTS_RESOURCE_ID",
    default: "seed-tts-2.0",
    description: "TTS 资源 ID",
  },
  {
    key: "BYTEDANCE_TTS_SPEAKER",
    class: "endpoint",
    scope: "tts",
    storage: "db",
    envFallback: "BYTEDANCE_TTS_SPEAKER",
    default: "zh_female_vv_uranus_bigtts",
    description: "音色。手机/车机分端配置归 FL-38 F-38-06，本 Sprint 单值",
  },
  {
    key: "TTS_ENGINE",
    class: "endpoint",
    scope: "tts",
    storage: "env-override",
    envFallback: "TTS_ENGINE",
    // 默认 mock：开发期默认值不走计费档，避免默认云端与播报链路缺陷叠加产生费用。
    // 需要真实音色时在这里显式切成 doubao/aliyun。
    default: "mock",
    options: ["mock", "doubao", "aliyun"],
    description:
      "语音合成引擎。mock=本机 say 包装成豆包协议（mocks/tts，8794，不计费但走完整网络链）——" +
      "⚠️ **与 ASR_ENGINE=mock 不是同一个服务**（那个是跑真模型的 local-asr 容器）；" +
      "doubao=豆包 seed-tts-2.0（按合成字数计费）；aliyun=百炼 qwen3-tts-flash（按字符计费）。" +
      "**三档一律经网关 `/v1/tts/speech` 合成，密钥不下端**（ACR-018；aliyun 的协议转换见 ACR-015）。" +
      "切换后约 30s 内端上自动生效，不必重启客户端。" +
      "**.env 写了本项即钉死**（source 显示 env，后台只读，ACR-017）",
    validate: (v) =>
      ["mock", "doubao", "aliyun"].includes(v) ? null : "只能是 mock / doubao / aliyun",
  },
  {
    key: "TTS_STREAM_SPEECH",
    class: "endpoint",
    scope: "tts",
    storage: "db",
    envFallback: "TTS_STREAM_SPEECH",
    // 默认关：它改变"什么时候开口"的链路形状，听感只能在真车上判断，
    // 不宜默认对所有端开启。
    default: "off",
    options: ["off", "on"],
    description:
      "边收边播（流式播报）。关=等这一轮文字全部返回，再分段合成播报；" +
      "开=模型每吐出一句就送去合成，声音几乎跟着文字走。" +
      "**开了之后首声约等于「模型说完第一句」的时间**，而不是「说完整段」——" +
      "长回答上能省十几秒。代价是断句只能看已经到手的那半句，" +
      "极少数情况下停顿位置不如整段切得自然；听着别扭就关掉，端上约 30s 内改口。" +
      "两种模式的分段判据是同一份（clients/cockpit/src-tauri/src/tts/segment.rs），" +
      "关掉不会退回「整段一次合成」那个 14 秒的老形态。",
    validate: (v) => (["off", "on"].includes(v) ? null : "只能是 off / on"),
  },
  {
    key: "TTS_DAILY_CHAR_LIMIT",
    class: "endpoint",
    scope: "tts",
    storage: "db",
    envFallback: "TTS_DAILY_CHAR_LIMIT",
    // 默认非 0（ACR-018）：三档都经网关合成，这个闸对最贵的 doubao 档同样生效；
    // doubao 档在真机上按字计费，默认不限就没有兜底。
    default: "80000",
    description:
      "云 TTS 每日合成字符上界（ACR-016）。字符数是这一档的计费量，所以按字符不按次数计。" +
      "**0 = 不限**；默认 80000（豆包 seed-tts 约 6.5 元/万字符，即约 52 元/天封顶）。" +
      "**自 ACR-018 起三档全部经网关，这个闸对 doubao 也生效**——" +
      "改之前 doubao 是端上直连供应商，网关看不见也拦不住。超限后端上降级系统 say。" +
      "参照 INC-0030：一上午重复播报烧掉几十万字当量，正是这个闸要挡的形状",
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 ? null : "必须是非负整数"),
  },
  {
    key: "ALIYUN_TTS_MODEL",
    class: "endpoint",
    scope: "tts",
    storage: "db",
    envFallback: "ALIYUN_TTS_MODEL",
    default: "qwen3-tts-flash",
    description:
      "百炼 TTS 模型名（仅 TTS_ENGINE=aliyun 时使用）。按字符计费约 1 元/万字符（豆包 6.5）",
    validate: nonEmpty("模型名"),
  },
  {
    key: "ALIYUN_TTS_VOICE",
    class: "endpoint",
    scope: "tts",
    storage: "db",
    envFallback: "ALIYUN_TTS_VOICE",
    default: "Cherry",
    description: "百炼 TTS 音色（仅 TTS_ENGINE=aliyun 时使用）。音色闭集见百炼「系统音色」文档",
  },
  // 检测器训练服务（ACR-026）：内部工具，网关的 /console/vision-trainer/* 代理到它。
  // 空 = 未启用（代理回 503 vision_trainer_not_configured）。它自己没有鉴权，所以只应指向 localhost / 内网。
  {
    key: "VISION_TRAINER_URL",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "VISION_TRAINER_URL",
    default: "",
    description:
      "检测器训练服务地址（enterprise/backend/vision-trainer，dev:restart vision-trainer 起，缺省 http://localhost:8799）。" +
      "空 = 未启用，控制台「模型训练」页显示服务未启用；服务无鉴权，只填 localhost 或内网地址",
    validate: (v: string) => (v.trim() === "" ? null : httpUrl(v)),
  },
  {
    key: "MOCK_TTS_URL",
    class: "endpoint",
    scope: "tts",
    storage: "db",
    envFallback: "MOCK_TTS_URL",
    default: "http://localhost:8794/api/v3/tts/unidirectional",
    description:
      "mock 引擎的合成端点（mocks/tts）。它与豆包「同一套请求体与 NDJSON 响应」，" +
      "所以切换只换 URL，端上客户端一行不动",
    validate: httpUrl,
  },

  // ── 运行时开关（只读展示；切换归 FL-39 的 Mock 三态开关）
  {
    key: "CABINHUG_LLM",
    class: "endpoint",
    scope: "runtime",
    storage: "env-only",
    envFallback: "CABINHUG_LLM",
    readOnly: true,
    description: '=fake 时强制离线 Fake 模型。**处于 Fake 模式时视图会高亮提示**——演示前最怕没注意到',
  },
  // 视觉观察层（ACR-024）：拍照问诊的「看图」适配器。不是工具、不进 Agent ACL，
  // 是与 ASR 同位的输入转换；档位只在部署层定，后台只读展示。
  {
    key: "CABINHUG_VISION",
    class: "endpoint",
    scope: "runtime",
    storage: "env-only",
    envFallback: "CABINHUG_VISION",
    default: "dashscope",
    options: ["dashscope", "deepseek", "fake", "off"],
    readOnly: true,
    description: "视觉观察层档位：dashscope=通义千问视觉档（DASHSCOPE_API_KEY）；deepseek=DeepSeek 视觉档（DEEPSEEK_API_KEY）；fake=按图片哈希回放 evals/vision-observe/fixtures/by-sha（零网络、确定性）；off=观察节点直通并在 caveats 写「本次未分析图片」",
  },
  {
    key: "CABINHUG_VISION_DETECT_PROVIDER",
    class: "endpoint",
    scope: "runtime",
    storage: "env-only",
    envFallback: "CABINHUG_VISION_DETECT_PROVIDER",
    options: ["dashscope", "deepseek", "yolo"],
    readOnly: true,
    description: "第一遍（整图定位）走哪一家；空=跟 CABINHUG_VISION。2026-09-09 实测同一张图 bbox 平均 IoU：qwen3-vl-plus 0.936、DeepSeek v4.1-flash 0.643——定位这一遍别换家。yolo=端侧检测器经 VISION_TRAINER_URL 推理（M80-07），只做定位",
  },
  {
    key: "CABINHUG_VISION_YOLO_MODEL",
    class: "endpoint",
    scope: "runtime",
    storage: "env-only",
    envFallback: "CABINHUG_VISION_YOLO_MODEL",
    readOnly: true,
    description: "检测那一遍选 yolo 时用哪个训练任务的权重（vision-trainer GET /models 里的 id，如 train-20260909-141540-e8c0）。空 = 选了 yolo 就启动失败",
  },
  {
    key: "CABINHUG_VISION_YOLO_CONF",
    class: "endpoint",
    scope: "runtime",
    storage: "env-only",
    envFallback: "CABINHUG_VISION_YOLO_CONF",
    default: "0.25",
    readOnly: true,
    description: "yolo 置信阈值。0.25 与 M79 负样本筛选、detector-localize 评测同一个数；调高少报少漏不了",
  },
  {
    key: "CABINHUG_VISION_YOLO_IMGSZ",
    class: "endpoint",
    scope: "runtime",
    storage: "env-only",
    envFallback: "CABINHUG_VISION_YOLO_IMGSZ",
    default: "960",
    readOnly: true,
    description: "yolo 推理边长，默认 = 训练尺寸 960。2026-09-10 实测 1280 时驻车灯置信 0.28、负样本误报 13 框，960 时 0.78 / 5 框；离训练尺寸越远越差（1600 以上零框）",
  },
  {
    key: "CABINHUG_VISION_DESCRIBE_PROVIDER",
    class: "endpoint",
    scope: "runtime",
    storage: "env-only",
    envFallback: "CABINHUG_VISION_DESCRIBE_PROVIDER",
    options: ["dashscope", "deepseek"],
    readOnly: true,
    description: "第二遍（逐 crop 描述）与成对核验走哪一家；空=跟 CABINHUG_VISION。两遍可以来自两家",
  },
  {
    key: "CABINHUG_VISION_DETECT_MODEL",
    class: "endpoint",
    scope: "runtime",
    storage: "env-only",
    envFallback: "CABINHUG_VISION_DETECT_MODEL",
    default: "qwen3-vl-flash",
    readOnly: true,
    description: "第一遍整图检测用的视觉模型（便宜档，定位准；2026-09-08 实测 bbox 全贴目标）。按角色生效：混搭时它只作用在检测那一家上",
  },
  {
    key: "CABINHUG_VISION_DESCRIBE_MODEL",
    class: "endpoint",
    scope: "runtime",
    storage: "env-only",
    envFallback: "CABINHUG_VISION_DESCRIBE_MODEL",
    default: "qwen3-vl-plus",
    readOnly: true,
    description: "第二遍逐 crop 描述用的视觉模型（实测 plus 零实质错，flash 会把安全带写成「车形 十字」）。按角色生效：混搭时它只作用在描述那一家上",
  },
  {
    key: "CABINHUG_VISION_FIXTURES",
    class: "endpoint",
    scope: "runtime",
    storage: "env-only",
    envFallback: "CABINHUG_VISION_FIXTURES",
    readOnly: true,
    description: "fake 档 fixture 目录；缺省 <cwd>/evals/vision-observe/fixtures/by-sha",
  },
  // 图标图文索引（ACR-025）：向量只召回不裁决；off 时观察层只带描述子进双路问诊并写 caveat。
  {
    key: "CABINHUG_ICON_INDEX",
    class: "endpoint",
    scope: "runtime",
    storage: "env-only",
    envFallback: "CABINHUG_ICON_INDEX",
    default: "on",
    options: ["on", "off"],
    readOnly: true,
    description: "手册图标图文索引开关：on=观察项经 pgvector 双路召回 + 闸门 + 成对核验对到手册图标；off=不匹配，caveats 写「图标未能与手册对上」",
  },
  // 手册图文索引（ACR-029）：手册里的图 + 它锚定到的段落。缺省 off，评测过线（eval:figure-anchor ≥ 90%）才切 on。
  // off 时上下文不含图文索引，可作止血位。
  {
    key: "CABINHUG_KB_FIGURES",
    class: "endpoint",
    scope: "runtime",
    storage: "env-only",
    envFallback: "CABINHUG_KB_FIGURES",
    default: "off",
    options: ["on", "off"],
    readOnly: true,
    description: "手册图文索引开关（ACR-029）：on=用车 / 售后问诊多一路「手册图示」（文字轮按检索词、照片轮按 crop 向量召回手册里的图，命中的带锚定段与出处，top-1 图附给表述模型）；off=逐字节回到现状。需 DASHSCOPE_API_KEY 与 kb:figures 建过索引",
  },
  {
    key: "CABINHUG_KB_FIGURES_STORE",
    class: "endpoint",
    scope: "runtime",
    storage: "env-only",
    envFallback: "CABINHUG_KB_FIGURES_STORE",
    default: "pgvector",
    options: ["pgvector", "qdrant"],
    readOnly: true,
    description:
      "图文索引的存储后端（ACR-030）：pgvector=库内 manual_figures 表（缺省，与历史行为相同）｜qdrant=独立部署的 Qdrant。" +
      "两档喂同一个 FigureStore 契约，召回算法与相似度门不变——M81-02 实测 20 题逐位一致、存储层 P50 从 209.8 ms 降到 59.2 ms。" +
      "**Qdrant 连不上会自动退回 pgvector 并打告警**，不会让 runtime 起不来",
  },
  // 图文索引的 Qdrant 后端（ACR-030）。向量由本系统计算，Qdrant 只做存储与检索。
  {
    key: "QDRANT_URL",
    class: "endpoint",
    scope: "runtime",
    storage: "env-only",
    envFallback: "QDRANT_URL",
    default: "",
    readOnly: true,
    description:
      "图文索引 Qdrant 服务地址（ACR-030）。空 = http://127.0.0.1:6333。" +
      "**本机档没有鉴权且只绑 127.0.0.1**——指向任何非本机地址前必须先给它配 API key",
  },
  {
    key: "QDRANT_API_KEY",
    class: "secret",
    scope: "runtime",
    storage: "env-only",
    envFallback: "QDRANT_API_KEY",
    default: "",
    readOnly: true,
    description: "Qdrant 的 API key（ACR-030）。本机档为空（服务无鉴权）；非本机部署必填",
  },
  {
    key: "CABINHUG_KB_FIGURES_ROOT",
    class: "endpoint",
    scope: "runtime",
    storage: "env-only",
    envFallback: "CABINHUG_KB_FIGURES_ROOT",
    default: "",
    readOnly: true,
    description: "kb:convert 落盘的手册图片目录（`<md 名>/part-N/images/`）。空 = 从 runtime 代码位置反推仓库内 data/kb-figures；取不到图片文件时只给文字段、不挂图",
  },
  // 官方警报代码表：车机「警报」页上的代码 → 厂商写的含义与措施。本地查表不走检索：
  // 代码是精确键，混进向量检索词会稀释查询，召回无关内容。
  {
    key: "CABINHUG_ALERT_CATALOG_ROOT",
    class: "endpoint",
    scope: "runtime",
    storage: "env-only",
    envFallback: "CABINHUG_ALERT_CATALOG_ROOT",
    default: "",
    readOnly: true,
    description:
      "官方警报代码表目录（内含 tesla-alerts.json，由 corepack pnpm kb:alerts 生成）。" +
      "空 = 从 runtime 代码位置反推仓库内 data/kb-src/alerts；**取不到时读到的警报只有屏幕原话，每条都标「手册里没有收录」**",
  },
  // 手册图标图片：成对核验要把用户裁片和这张图并排给视觉模型比。
  // 取不到就不核验，匹配只能说「疑似」，属安全方向的降级，不报错。
  {
    key: "CABINHUG_ICON_IMAGES_ROOT",
    class: "endpoint",
    scope: "runtime",
    storage: "env-only",
    envFallback: "CABINHUG_ICON_IMAGES_ROOT",
    default: "",
    readOnly: true,
    description:
      "手册图标图片根目录（内含 <车型目录>/ 与同名 <车型目录>-indicators.md，车型串取 md 的 vehicle: 行）。" +
      "空 = 从 runtime 代码位置反推仓库内 data/kb-src/icons；**容器形态下若没把这个目录挂进来，成对核验不会发生，匹配只能说「疑似」**",
  },
  {
    key: "CABINHUG_ICON_EMBED_MODEL",
    class: "endpoint",
    scope: "runtime",
    storage: "env-only",
    envFallback: "CABINHUG_ICON_EMBED_MODEL",
    default: "qwen3-vl-embedding",
    readOnly: true,
    description: "图标索引用的 DashScope 多模态向量模型（图文同空间，2026-09-08 探针维度 2560；换模型必须整表重建 kb:icons --rebuild）",
  },
  // CARLIFE_ASR / CARLIFE_TTS 已随 ACR-017 退休：选档只有
  // ASR_ENGINE / TTS_ENGINE 一套（env-override，.env 写死即钉档且 source 可见）；
  // 出声与否归端上播报开关。发现旧变量时网关/车机启动会打废弃告警。

  {
    key: "HISTORY_RETENTION_DAYS",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "HISTORY_RETENTION_DAYS",
    default: "0",
    description:
      "对话历史保留天数；0 = 长期保留（默认）。**与记忆衰减无耦合**——历史表只服务「可翻阅」，衰减是 Mem0 那一侧的事（FL-03 存储分层对齐）。承接 M2-06 F-03-11",
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 ? null : "必须是非负整数"),
  },
  {
    key: "SESSION_AUTO_CLEAN_DAYS",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "SESSION_AUTO_CLEAN_DAYS",
    default: "0",
    description:
      "会话自动清理天数：最后活动早于 N 天的会话由 worker 每小时自动清理一批；0 = 关（默认），演示环境设 1。**清理是软删除**——只写 sessions.deleted_at，任何表一行不删，控制台「会话与对话」页可筛出来恢复。与 HISTORY_RETENTION_DAYS 不是一回事（那个是硬删消息，且未接线）。M108 F-03-11",
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) >= 0 ? null : "必须是非负整数"),
  },

  // ── 引导层（配置层自身可用之前就被需要，因此只能由部署层注入）
  {
    key: "DATABASE_URL",
    class: "secret",
    scope: "bootstrap",
    storage: "env-only",
    envFallback: "DATABASE_URL",
    required: true,
    readOnly: true,
    description: "PostgreSQL 连接串（含口令，故按密钥类掩码）",
  },
  {
    key: "CABINHUG_CONFIG_MASTER_KEY",
    class: "secret",
    scope: "bootstrap",
    storage: "env-only",
    envFallback: "CABINHUG_CONFIG_MASTER_KEY",
    required: true,
    readOnly: true,
    description:
      "配置加密主密钥（§13-12）。**不与密文同库**，缺失或过短即启动失败——不允许降级成明文存储",
    validate: (v) => (v.length >= 16 ? null : "主密钥至少 16 字符"),
  },
  {
    key: "CABINHUG_PII_MASTER_KEY",
    class: "secret",
    scope: "bootstrap",
    storage: "env-only",
    envFallback: "CABINHUG_PII_MASTER_KEY",
    required: true,
    readOnly: true,
    description:
      "PII 落盘加密主密钥（M42-01）。与配置主密钥**独立两把钥匙**（轮换周期与泄露影响面不同）；" +
      "不与密文同库，缺失或过短即启动失败——不允许降级成明文存储",
    validate: (v) => (v.length >= 16 ? null : "主密钥至少 16 字符"),
  },
  {
    key: "CABINHUG_JWT_SECRET",
    class: "secret",
    scope: "bootstrap",
    storage: "env-only",
    envFallback: "CABINHUG_JWT_SECRET",
    required: true,
    readOnly: true,
    devDefault: DEV_JWT_SECRET,
    description:
      "端上 JWT 签名密钥（M48-02，F-07-01；M49-01 加开发默认值）。开发环境留空时自动用" +
      "内置默认密钥并每次启动告警；**生产必须显式配置，缺失即启动失败**——一个仓库里写着的" +
      "签名密钥等于没有鉴权，而且不会以任何现象暴露（token 照常签发、照常通过）。过短同样失败",
    validate: (v) => (v.length >= 16 ? null : "签名密钥至少 16 字符"),
  },
  /*
   * 后台两个角色 token 与 `CABINHUG_JWT_SECRET` 同一条纪律：
   * 开发有默认值、生产缺失即启动失败。
   *
   * 默认值写在公开仓库里，生产若沿用即等于公开运营后台的全权凭证
   * （配置读写、会话浏览、审计查询、记忆浏览都在 admin 名下），且不会有任何可见现象。
   */
  {
    key: "CABINHUG_ADMIN_TOKEN",
    class: "secret",
    scope: "bootstrap",
    storage: "env-only",
    envFallback: "CABINHUG_ADMIN_TOKEN",
    required: true,
    readOnly: true,
    devDefault: DEV_CONSOLE_ADMIN_TOKEN,
    description:
      "后台 admin 角色 token（POC 简化形态，退出条件见 FL-07 F-07-01）。" +
      "开发环境留空时自动用内置默认值并每次启动告警；**生产必须显式配置，缺失即启动失败**" +
      "——admin 是运营后台的全权角色，一个仓库里写着的默认值等于后台没有鉴权",
  },
  {
    key: "CABINHUG_OPS_TOKEN",
    class: "secret",
    scope: "bootstrap",
    storage: "env-only",
    envFallback: "CABINHUG_OPS_TOKEN",
    required: true,
    readOnly: true,
    devDefault: DEV_CONSOLE_OPS_TOKEN,
    description: "后台 ops 角色 token（同上；ops 只读，但会话与审计都在它名下）",
  },

  // ── 对象存储（§9）。S3 兼容；本地是 MinIO，生产可换任意 S3。
  //
  // 凭证不得出现在端上、日志、前端响应中：端上拿不到这些值，只与网关交互。
  {
    key: "S3_ENDPOINT",
    class: "endpoint",
    scope: "storage",
    storage: "db",
    envFallback: "S3_ENDPOINT",
    default: "http://localhost:59000",
    description: "S3 兼容端点。**留空表示上传未接入**——此时上传接口明确返回未接入，不假装成功",
    validate: (v) => (v.trim() === "" ? null : httpUrl(v)),
  },
  {
    key: "S3_ACCESS_KEY_ID",
    class: "secret",
    scope: "storage",
    storage: "db",
    envFallback: "S3_ACCESS_KEY_ID",
    description: "对象存储 Access Key",
  },
  {
    key: "S3_SECRET_ACCESS_KEY",
    class: "secret",
    scope: "storage",
    storage: "db",
    envFallback: "S3_SECRET_ACCESS_KEY",
    description: "对象存储 Secret Key",
  },
  {
    key: "S3_BUCKET",
    class: "endpoint",
    scope: "storage",
    storage: "db",
    envFallback: "S3_BUCKET",
    default: "carlife-attachments",
    description: "附件桶名。**与知识库分开**：用户上传的内容不得进入知识库（M8-01 约束 5-②）",
  },

  // ── MinerU（PDF 版面解析）。
  //
  // 它不在检索链路上：只在把 PDF 转成 markdown 时用一次，产物进 RAGFlow。
  // 它不可用时不影响线上问答，只影响新增文档。
  {
    key: "MINERU_API_TOKEN",
    class: "secret",
    scope: "docparse",
    storage: "db",
    envFallback: "MINERU_API_TOKEN",
    description:
      "MinerU API Token。**多栏 PDF 必须经它转换**——RAGFlow 云端的 DeepDOC 会把三栏" +
      "按行横着串读（实测于迈锐宝用户手册），每行通顺、关键词也在，所以检索照样命中出处，" +
      "只是拼起来讲的不是一件事。留空则只能传单栏 PDF",
    howToObtain: "https://mineru.net 控制台 → API",
  },

  // ── RAGFlow Cloud（§6）。本仓不自建向量库，检索全托管。
  //
  // 三个 dataset id 分开配：数据集隔离靠 id 在调用层强制（AC-24-8），
  // 不是靠 prompt。少配一个只会让那一类检索报"未配置"，不会串到别的集。
  {
    key: "RAGFLOW_BASE_URL",
    class: "endpoint",
    scope: "rag",
    storage: "db",
    envFallback: "RAGFLOW_BASE_URL",
    description:
      "RAGFlow Cloud 端点。**留空表示未接入**——此时双路检索只剩⑥那一路，" +
      "回答会显式标注「本次未引用说明书出处」，不假装查过",
    validate: (v) => (v.trim() === "" ? null : httpUrl(v)),
  },
  {
    key: "RAGFLOW_API_KEY",
    class: "secret",
    scope: "rag",
    storage: "db",
    envFallback: "RAGFLOW_API_KEY",
    description: "RAGFlow API Key",
    howToObtain: "RAGFlow Cloud 控制台 → API Keys",
  },
  {
    key: "RAGFLOW_DATASET_VEHICLE_MANUALS",
    class: "endpoint",
    scope: "rag",
    storage: "db",
    envFallback: "RAGFLOW_DATASET_VEHICLE_MANUALS",
    description: "车辆说明书数据集 id（消费方：用车助手）",
  },
  {
    key: "RAGFLOW_DATASET_REPAIR_KB",
    class: "endpoint",
    scope: "rag",
    storage: "db",
    envFallback: "RAGFLOW_DATASET_REPAIR_KB",
    description:
      "维修知识库数据集 id（消费方：售后）。**内容是模拟数据**，" +
      "展示时须标注来源，不冒充真实厂商资料（F-24-11）",
  },
  {
    key: "RAGFLOW_DATASET_CAR_CATALOG",
    class: "endpoint",
    scope: "rag",
    storage: "db",
    envFallback: "RAGFLOW_DATASET_CAR_CATALOG",
    description: "车型参数库数据集 id（消费方：购车顾问）",
  },
  {
    key: "RAGFLOW_DATASET_INSURANCE_KB",
    class: "endpoint",
    scope: "rag",
    storage: "db",
    envFallback: "RAGFLOW_DATASET_INSURANCE_KB",
    description:
      "车险条款与理赔指引数据集 id（消费方：售后与购车顾问，ACR-040）。" +
      "留空 = 未接入，只影响这一集的检索",
  },

  // ── Mem0 记忆存储（§7 ②③⑥）。
  //
  // 这里没有 MEM0_URL 之类的服务地址：`mem0ai` 的 TS OSS 形态是进程内库，
  // 不是服务。要配的是它的两个后端：向量库落在哪、embedding 用谁。
  {
    key: "MEM0_VECTOR_PROVIDER",
    class: "endpoint",
    scope: "memory",
    storage: "db",
    envFallback: "MEM0_VECTOR_PROVIDER",
    default: "pgvector",
    description:
      "Mem0 向量库落点（§13-11 方案 A 取 pgvector：复用现有 PG，备份归入同一条 pg_dump）。" +
      "**改成 memory 会落到本地 sqlite 文件，那份数据在备份面之外**，仅供离线实验",
    validate: (v) =>
      ["pgvector", "memory", "qdrant", "redis"].includes(v.trim())
        ? null
        : "只支持 pgvector / memory / qdrant / redis",
  },
  {
    key: "MEM0_DATABASE_URL",
    class: "secret",
    scope: "memory",
    storage: "env-only",
    envFallback: "MEM0_DATABASE_URL",
    readOnly: true,
    description:
      "Mem0 向量库的连接串。**留空即回落到 DATABASE_URL**（同一台 PG，方案 A 的常态）。" +
      "与 DATABASE_URL 同为引导层性质：含口令、由部署层注入，不接受后台热改",
    validate: (v) => (v.trim() === "" ? null : nonEmpty("连接串")(v)),
  },
  {
    key: "MEM0_COLLECTION",
    class: "endpoint",
    scope: "memory",
    storage: "db",
    envFallback: "MEM0_COLLECTION",
    default: "cabinhug_memories",
    description: "向量集合名（pgvector 下即表名）。恢复演练脚本按它选表，改名要同步演练脚本",
    // 与 @cabinhug/memory 的 collection.ts 同一条判据：表名会被拼进控制台记忆面板的 SQL。
    validate: (v) =>
      /^[a-z_][a-z0-9_]{0,62}$/.test(v.trim()) ? null : "只允许小写字母、数字与下划线，且不以数字开头",
  },
  // embedding 一侧：缺省走 DashScope 的 OpenAI 兼容口 + text-embedding-v4。
  // DeepSeek 没有 embeddings 接口，所以不能复用 LLM 那条线；本机 Ollama 仍可选（provider=ollama）。
  {
    key: "MEM0_EMBEDDING_PROVIDER",
    class: "endpoint",
    scope: "memory",
    storage: "db",
    envFallback: "MEM0_EMBEDDING_PROVIDER",
    default: "openai",
    description:
      "embedding 供应商档：`openai` = 任何 OpenAI 兼容口（缺省填 DashScope，**记忆正文会出网到阿里云**，" +
      "与护栏 / ASR / TTS 同一供应商）；`ollama` = 本机 Ollama，不出网、无 key，但每台机器要先装并拉模型",
    validate: nonEmpty("供应商档"),
  },
  {
    key: "MEM0_EMBEDDING_API_KEY",
    class: "secret",
    scope: "memory",
    storage: "db",
    envFallback: "MEM0_EMBEDDING_API_KEY",
    description:
      "embedding 端点凭证。**留空回落 DASHSCOPE_API_KEY**——单独一项是为了记忆的调用量与账单能与语音分开；" +
      "provider=ollama 时不用。两把都缺时记忆读写降级为不可用，对话不受影响",
  },
  {
    key: "MEM0_EMBEDDING_BASE_URL",
    class: "endpoint",
    scope: "memory",
    storage: "db",
    envFallback: "MEM0_EMBEDDING_BASE_URL",
    default: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    description:
      "embedding 端点。缺省是 DashScope 的 OpenAI 兼容口；切本机 Ollama 时改成 http://localhost:11434。" +
      "DeepSeek 没有 embedding 接口，所以这条不能复用 LLM 的端点",
    validate: httpUrl,
  },
  {
    key: "MEM0_EMBEDDING_MODEL",
    class: "endpoint",
    scope: "memory",
    storage: "db",
    envFallback: "MEM0_EMBEDDING_MODEL",
    default: "text-embedding-v4",
    description:
      "embedding 模型名（DashScope 缺省 text-embedding-v4；Ollama 档常用 nomic-embed-text）。" +
      "**换模型必须同步改 MEM0_EMBEDDING_DIMS**——维度对不上时写入会失败或检索结果全错，且不一定报错",
  },
  {
    key: "MEM0_EMBEDDING_DIMS",
    class: "endpoint",
    scope: "memory",
    storage: "db",
    envFallback: "MEM0_EMBEDDING_DIMS",
    default: "768",
    description:
      "向量维度，必须与 embedding 模型一致（text-embedding-v4 可选 64–2048 含 768；nomic-embed-text=768，bge-m3=1024）。" +
      "**已有数据的集合改维度需要重建并重新 embedding**，不是改个数字的事",
    validate: (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? null : "必须是正整数"),
  },
  {
    key: "MEM0_TELEMETRY",
    class: "endpoint",
    scope: "memory",
    storage: "db",
    envFallback: "MEM0_TELEMETRY",
    default: "false",
    description:
      "mem0ai 自带的 PostHog 遥测（M95-04）。开着时**每次记忆读写都 await 一次出网**加两跳 PG，" +
      "实测把 2 ms 的列举拖到 300–850 ms；发的是方法名 / 集合名等用量元数据，不含记忆正文。缺省关，要开显式写 true",
    validate: (v) => (v === "true" || v === "false" ? null : "只接受 true / false"),
  },

  // ── 内容审核（§8.2）。接入面归系统管理员，策略值归运营（FL-30 F-30-01 的三分边界）。
  {
    key: "GUARD_MODEL",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "GUARD_MODEL",
    default: "qwen3guard-gen",
    description:
      "内容审核模型名。**协议按名自动切换**：含 qwen3guard-gen 用 assistant-turn 协议，否则用通用 system+user（§8.2）",
  },
  {
    key: "GUARD_BASE_URL",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "GUARD_BASE_URL",
    description:
      "审核模型的 OpenAI 兼容端点。换云端/换本地 Ollama 只改这里（§8.2）。**留空表示审核层未接入**——此时规则筛与脱敏照常生效，且结果显式标注未审核，不假装跑过",
    validate: (v) => (v.trim() === "" ? null : httpUrl(v)),
  },
  {
    key: "GUARD_API_KEY",
    class: "secret",
    scope: "runtime",
    storage: "db",
    envFallback: "GUARD_API_KEY",
    description: "审核端点凭证（本地 Ollama 可留空）",
  },
  {
    key: "GUARD_TIMEOUT_MS",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "GUARD_TIMEOUT_MS",
    default: "10000",
    description: "审核调用超时（§8.2 默认 10s）。审核层挂着不返回比它判错更糟",
    validate: (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? null : "必须是正整数毫秒"),
  },

  // ── 内容审核：阿里云 AI 安全护栏（默认供应商）。
  //
  // 与上面的 GUARD_* 是两套并存的接入面，由 GUARD_PROVIDER 选：
  // 阿里云是托管服务（判得更全、含提示词攻击与敏感内容），
  // OpenAI 兼容那套保留以便换回自建/本地模型：审核层是安全边界，
  // 不应被单一供应商的可用性绑定。
  {
    key: "GUARD_PROVIDER",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "GUARD_PROVIDER",
    default: "aliyun",
    description:
      "内容审核供应商：aliyun（阿里云 AI 安全护栏，默认）/ openai-compat（自建或本地模型）/ none（不接入，规则筛与脱敏仍生效且结果标注未审核）",
    validate: (v) =>
      ["aliyun", "openai-compat", "none"].includes(v.trim())
        ? null
        : "只能是 aliyun / openai-compat / none",
  },
  {
    key: "ALIYUN_GUARD_ENDPOINT",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "ALIYUN_GUARD_ENDPOINT",
    default: "https://green-cip.cn-shanghai.aliyuncs.com",
    description:
      "阿里云 green-cip 接入地址。**跨地域会明显加延迟**，选离部署最近的那个；VPC 内用 green-cip-vpc.* 走内网",
    validate: (v) => (v.trim() === "" ? null : httpUrl(v)),
  },
  {
    key: "Aliyun_AccessKey_ID",
    class: "secret",
    scope: "runtime",
    storage: "env-only",
    envFallback: "Aliyun_AccessKey_ID",
    description:
      "阿里云 RAM 用户 AccessKey ID（需授权 AliyunYundunGreenWebFullAccess）。**env-only**：它同时是其它阿里云服务的凭据，不该被后台改写",
  },
  {
    key: "Aliyun_AccessKey_Secret",
    class: "secret",
    scope: "runtime",
    storage: "env-only",
    envFallback: "Aliyun_AccessKey_Secret",
    description: "阿里云 RAM 用户 AccessKey Secret。同上，env-only",
  },
  {
    key: "ALIYUN_GUARD_PRO",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "ALIYUN_GUARD_PRO",
    default: "true",
    description:
      "用 _pro 版审核服务。**实测 sensitiveData（敏感内容检测）只在 _pro 上返回**——关掉它，控制台开的那个维度会一条都不回且无报错。pro 计费更高，要省钱得同时接受输入侧个人信息检测消失",
    validate: (v) => (["true", "false"].includes(v.trim()) ? null : "只能是 true / false"),
  },
  {
    key: "ALIYUN_GUARD_TIMEOUT_MS",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "ALIYUN_GUARD_TIMEOUT_MS",
    default: "5000",
    description:
      "阿里云审核超时。**比自建那套短**（5s vs 10s）：输入侧审核挡在图执行之前，用户在等第一个 token；超时后果由 fail 模式接管，不是把人晾着",
    validate: (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? null : "必须是正整数毫秒"),
  },

  // ── 工具层（§5 工具表 / FL-39 F-39-02：Mock 三态，与 CABINHUG_LLM/ASR/TTS 同源的开关风格）
  {
    key: "CABINHUG_TOOLS",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "CABINHUG_TOOLS",
    default: "real",
    description:
      "工具层 Mock 三态全局默认：real 走真实依赖 / mock 走内置固定数据（结果标注为模拟）/ off 返回明确的未接入。不是布尔——off 与 mock 的区别是「明说没有」与「假装成功」，后者更危险",
    validate: (v) => (["real", "mock", "off"].includes(v) ? null : "只能是 real / mock / off"),
  },

  // ── 能力开关（ACR-056）：按部署形态关掉依赖额外凭据或知识库的能力。
  //
  // env-override：本地一体版由安装包以环境变量钉档，后台改不回来；分离部署不设 env 时可在后台改。
  // 缺省不设 = 什么都不关，现有部署行为不变。
  {
    key: "CABINHUG_CAPABILITIES_OFF",
    class: "endpoint",
    scope: "runtime",
    storage: "env-override",
    envFallback: "CABINHUG_CAPABILITIES_OFF",
    description:
      `要关闭的能力，逗号分隔；空 = 都不关。可选 ${CAPABILITIES.join(" / ")}。` +
      "photo-diagnosis 关闭后网关拒收照片与视频、端上隐藏拍照问诊入口；ownership-qa / service-qa 关闭后" +
      "用车 / 售后问题回一句固定话术，不调模型、不查知识库。约 30 秒内生效",
    validate: (v) => {
      const bad = unknownCapabilities(v);
      return bad.length ? `不认识：${bad.join("、")}。只能是 ${CAPABILITIES.join(" / ")}，逗号分隔` : null;
    },
  },
  {
    key: "CABINHUG_WEATHER_CMA",
    class: "endpoint",
    scope: "map",
    storage: "db",
    envFallback: "CABINHUG_WEATHER_CMA",
    default: "on",
    description:
      "中国气象局天气增强（M10-02）。on = 在基础预报（见 WEATHER_PROVIDER）之上补体感、湿度、" +
      "降水实况、气压、风与气象预警，并把预报窗口从 4 天拉到 7 天；off = 只留基础预报。" +
      "它无 key、大陆可达，默认开；留这个开关是为了接口改版时能一键止血，而不必发版",
    validate: (v) => (["on", "off"].includes(v) ? null : "只能是 on / off"),
  },

  // ── 天气基础预报供应商（ACR-052）。
  //
  // 显式三选一，不按"配了哪把 key"推断：Open-Meteo 免费接口与高德天气免费额度都限非商用，
  // 静默兜底会让部署在不知情时用上非商用来源。选中的那家没配 key，weather 如实报未接入。
  {
    key: "WEATHER_PROVIDER",
    class: "endpoint",
    scope: "map",
    storage: "db",
    envFallback: "WEATHER_PROVIDER",
    default: DEFAULT_WEATHER_PROVIDER,
    description:
      "天气基础预报由谁出（ACR-052）：qweather = 和风天气（缺省，免费额度内允许商用，界面须署名）/ " +
      "amap = 高德天气（免费额度限非商业目的，本地开发用）/ open-meteo = Open-Meteo（免费接口限非商用）。" +
      "选中的那家没配 key 时天气如实返回未接入，不换别家顶上",
    validate: (v) => (isWeatherProvider(v) ? null : `只能是 ${WEATHER_PROVIDERS.join(" / ")}`),
  },
  {
    key: "QWEATHER_API_KEY",
    class: "secret",
    scope: "map",
    storage: "db",
    envFallback: "QWEATHER_API_KEY",
    description:
      "和风天气 API KEY（ACR-052），经请求头 X-QW-Api-Key 发送。" +
      "2027-01-01 起和风限制 API KEY 认证的日请求量，届时改 JWT",
    howToObtain: "https://console.qweather.com → 项目管理 → 新建项目 → 创建凭据，身份认证方式选 API KEY",
  },
  {
    key: "QWEATHER_API_HOST",
    class: "endpoint",
    scope: "map",
    storage: "db",
    envFallback: "QWEATHER_API_HOST",
    description:
      "和风天气账号专属 API Host（形如 xxx.re.qweatherapi.com，带不带 https:// 都行）。" +
      "公共域名 api.qweather.com / devapi.qweather.com 自 2026 年起逐步停用，不要填它们",
    howToObtain: "https://console.qweather.com → 设置 → API Host",
  },

  // ── ⑤环境缓存（§7⑤）。
  //
  // 非必填：没配就是"不缓存"，天气与路线全部直连上游，功能不受影响，
  // 只是慢且费配额。连不上也一样，不会让任何请求失败（降级会计数上报）。
  {
    key: "REDIS_URL",
    class: "endpoint",
    // scope 归 memory：⑤是六类记忆之一（虽然它严格说是缓存不是记忆，§7⑤）。
    // storage 用 env-only：连接串属于部署形态，不在后台页面上改；
    // 改错会让整个缓存层静默失效。
    scope: "memory",
    storage: "env-only",
    envFallback: "REDIS_URL",
    description:
      "⑤环境缓存的 Redis 地址。缓存天气预报（30min）、逆地理（24h）、路线（3min）——" +
      "**TTL 各自不同**：路线缓存久了等于给过期路况。留空即不缓存",
    howToObtain: "本机见 infra/docker-compose.yml（宿主端口 56379）：redis://localhost:56379",
  },

  // ── 高德开放平台（§5 工具表「地图 API」）。
  //
  // 两把 key 属于两种高德应用类型，不能互换：Web 服务（REST）的 key 在浏览器里
  // 调会被拒，Web 端（JS API）的 key 在服务端调同样不行。分成两项，
  // 让填写者在配置页上看到区别，而不是在调用失败时才发现。
  //
  // 三项都非必填：没配就是"地图未接入"，map_route 明确返回未接入，
  // 车机地图回退程序化底图，服务照常起。天气是否走高德由 WEATHER_PROVIDER 决定（ACR-052）。
  {
    key: "AMAP_SERVER_KEY",
    class: "secret",
    scope: "map",
    storage: "db",
    envFallback: "AMAP_SERVER_KEY",
    description:
      "高德 **Web 服务** key（服务端用）：weather 沿途天气与 map_route 路径规划走它。" +
      "留空则 map_route 明确返回未接入；WEATHER_PROVIDER=amap 时天气也未接入（ACR-052 起不再退回 Open-Meteo）",
    howToObtain: "https://console.amap.com → 应用管理 → 新建应用 → 添加 key，服务平台选「Web 服务」",
  },
  // 第 2~10 个账号的 Web 服务 key（由 `amapServerKeyDefs` 生成，与 `@cabinhug/tools` 的
  // `AMAP_KEY_MAX` 同源）。QPS 与日配额都按账号计算（infocode 10021 的原文是「账号使用某个服务接口
  // QPS 超出限制」，10044 是这把 key 今日用尽），所以同账号再加 key 无效，另一个账号才是另一份额度。
  // 留空的位子允许跳过；全部留空即单账号。
  ...amapServerKeyDefs(),
  // 各接口族的日预算：一把 key 某族到九成就不再接该族请求，改为往用量占比最低的那把发；
  // 全部到顶时退回占比最低并 warn：预算是路由偏好，不是拒绝服务，10044 仍是最后一道。
  {
    key: "AMAP_DAILY_BUDGET",
    class: "endpoint",
    scope: "map",
    storage: "db",
    envFallback: "AMAP_DAILY_BUDGET",
    default: "place=450",
    description:
      "高德各接口族的**每把 key 日预算**，格式 `place=450,direction=0`（0 或不写 = 不设限）。" +
      "族名：place（POI 搜索）/ geocode / regeo / district / direction / transit / weather。" +
      "缺省只给搜索 450——2026-09-15 实测三把 key 各约 450 次搜索后 10044。到九成即换 key，池子全到顶仍能发但会告警",
    validate: (v) => {
      const bad = v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((s) => !/^(place|geocode|regeo|district|direction|transit|weather|other)=\d+$/.test(s));
      return bad.length === 0 ? null : `不合法的片段：${bad.join("、")}（应为 <族>=<非负整数>）`;
    },
  },
  {
    key: "AMAP_JS_KEY",
    class: "endpoint",
    scope: "map",
    storage: "db",
    envFallback: "AMAP_JS_KEY",
    description:
      "高德 **Web 端（JS API）** key（车机/客户端显示地图用）。它会随前端产物下发，" +
      "安全性靠高德控制台的域名白名单，不靠保密。留空则 HUD 回退程序化底图",
    howToObtain: "https://console.amap.com → 应用管理 → 添加 key，服务平台选「Web 端(JS API)」",
  },
  {
    key: "AMAP_JS_SECURITY_CODE",
    class: "secret",
    scope: "map",
    storage: "db",
    envFallback: "AMAP_JS_SECURITY_CODE",
    description:
      "JS API 安全密钥。**POC 期直填进前端（window._AMapSecurityConfig）是已知取舍**——" +
      "高德对生产环境的建议是用代理服务器中转，不把它发到浏览器。上线前须改代理形态",
    howToObtain: "与 AMAP_JS_KEY 同一个应用，key 列表里的「安全密钥」",
  },

  // ── 研究面（ACR-034）
  //
  // 两个开关兜底：`RESEARCH_ENABLED` 决定 worker 挂不挂取数任务，
  // `RESEARCH_RUNTIME_URL` 决定网关代不代理。两者缺省时既有功能不受影响。
  //
  // scope 用 runtime 而不是新开一个 `research`：控制台配置页的分组是硬编码的
  // 五个 scope（`console/src/pages/config/index.tsx`），新增 scope 的项不会在页面上显示。
  {
    key: "RESEARCH_ENABLED",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "RESEARCH_ENABLED",
    default: "off",
    options: ["on", "off"],
    description:
      "研究面取数总开关。off（缺省）= worker 的调度表里不出现 research-acquire，" +
      "一条证据都不采；on 才按小时窗切证据单元。改它不影响网关代理（那由 RESEARCH_RUNTIME_URL 决定）",
  },
  {
    key: "RESEARCH_RUNTIME_URL",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "RESEARCH_RUNTIME_URL",
    default: "",
    description:
      "研究服务地址（enterprise/backend/research-runtime，缺省 http://localhost:8800）。" +
      "空 = 未启用，网关 /console/research/* 回 503 research_not_configured、五页显示「本部署没有研究面」；" +
      "服务无鉴权且只绑 127.0.0.1，只填 localhost 或内网地址",
    validate: (v: string) => (v.trim() === "" ? null : httpUrl(v)),
  },
  {
    key: "RESEARCH_RUNTIME_PORT",
    class: "endpoint",
    scope: "runtime",
    // env-only：服务要用它来 bind，那发生在能读配置库之前。
    storage: "env-only",
    envFallback: "RESEARCH_RUNTIME_PORT",
    default: "8800",
    readOnly: true,
    description: "research-runtime 的监听端口（只绑 127.0.0.1）。8790–8799 已被占，本服务取 8800",
  },
  {
    key: "RESEARCH_EMBEDDING_MODEL",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "RESEARCH_EMBEDDING_MODEL",
    default: "text-embedding-v4",
    description: "研究面嵌入模型（百炼，走 DASHSCOPE_API_KEY）。换模型必须同时改 RESEARCH_EMBEDDING_DIM",
    validate: nonEmpty("模型名"),
  },
  {
    key: "RESEARCH_EMBEDDING_DIM",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "RESEARCH_EMBEDDING_DIM",
    default: "1024",
    description:
      "嵌入维度。**改它要同时改迁移里的 vector(1024) 列，光改这里只会让写入报维度不符**。" +
      "上限 2000——pgvector 的 ANN 索引建不了更高维（icon_embeddings 的 2560 就是因此没索引，ACR-030）",
    validate: (v: string) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 64 || n > 2000) return "必须是 64–2000 的整数（pgvector ANN 索引上限 2000）";
      return null;
    },
  },
  {
    key: "RESEARCH_MIN_CELL_VEHICLES",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "RESEARCH_MIN_CELL_VEHICLES",
    default: "10",
    description:
      "小单元抑制阈值（台车）。低于它的格与分群清空明细、只留原因——" +
      "抑制的是「交叉一下就能认出是谁」，不是「统计不显著」，所以调低它是权利决定不是显示偏好",
    validate: (v: string) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 ? null : "必须是 ≥ 1 的整数";
    },
  },
  {
    key: "RESEARCH_CODER_MODEL",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "RESEARCH_CODER_MODEL",
    default: "deepseek-flash",
    description:
      "编码 Agent 的模型。**思考必须显式关**（v4 全系默认 thinking on，SDK 关不掉）——" +
      "不关会出现「49 秒 18253 字一个字段没填」（M24 已踩）",
    validate: nonEmpty("模型名"),
  },
  {
    key: "RESEARCH_SYNTH_MODEL",
    class: "endpoint",
    scope: "runtime",
    storage: "db",
    envFallback: "RESEARCH_SYNTH_MODEL",
    // `"deepseek"` 不是合法模型名：供应商只认 deepseek-flash / deepseek-v4-pro，
    // 传裸 "deepseek" 会回 400「The supported API model names are …」。
    default: "deepseek-v4-pro",
    description: "综合与挑战 Agent 的模型（Synthesizer / Challenger / Namer）。比 Coder 慢但要写得出六栏洞察卡",
    validate: nonEmpty("模型名"),
  },
];

const BY_KEY = new Map(CONFIG_REGISTRY.map((d) => [d.key, d]));

export function findConfigDef(key: string): ConfigDef | undefined {
  return BY_KEY.get(key);
}

/**
 * 可由后台写入的项：db / env-override 存储且非只读。
 *
 * env-override 的"可写"是原则上的：env 实际在场时写入仍会被 store 拒绝
 * （那是运行时状态，纯函数看不见，判定在 `store.write()` 里）。
 */
export function isWritable(def: ConfigDef): boolean {
  return (def.storage === "db" || def.storage === "env-override") && def.readOnly !== true;
}

/**
 * 不变量：注册表中不存在 C 类（策略值）与 D 类（红线）。
 * 做成可断言的函数而不是口头约定。
 */
const FORBIDDEN_KEY_PATTERNS = [
  /hard[_-]?block/i, // 硬禁清单
  /capabilit/i, // Tauri capability 白名单
  /end[_-]?to[_-]?end|omni[_-]?e2e/i, // omni 端到端开关
  /threshold|fail[_-]?mode|disclaimer/i, // Guard 策略值
];

export function registryHasNoPolicyOrRedline(): string[] {
  return CONFIG_REGISTRY.filter((d) =>
    FORBIDDEN_KEY_PATTERNS.some((p) => p.test(d.key)),
  ).map((d) => d.key);
}
