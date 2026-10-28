/**
 * TTS 引擎解析：`TTS_ENGINE` 取值到合成地址的唯一映射。
 *
 * # 单独抽成纯函数
 *
 * 消费方有后台探活、端上配置下发（`GET /v1/tts/config`）以及其他需要知道
 * 当前引擎的地方。各处自写映射会不一致，表现为后台探活正常而端上打的是另一个地址。
 *
 * 它是纯函数、不碰 IO、可单测，输入就是 `runtimeValues()` 那张表。
 *
 * # 它不解析密钥
 *
 * 返回值里没有 API Key，这是刻意的：这份结果会经 HTTP 下发到端上，
 * 而 A 类密钥「只写不读、全链路掩码」（§8.2）。
 *
 * # 两个地址：`url` 给端上，`upstreamUrl` 给服务端（ACR-018）
 *
 * 端上恒打网关自己（`TTS_GATEWAY_PATH`），三档皆然：车机与手机只认识一个后端。
 * 真正的供应商地址是 `upstreamUrl`，只在网关自己合成时使用，不下发。
 * 这样密钥不必发到每台车、日用量闸门能统计全部合成、换供应商不必发客户端版本。
 */

/**
 * 豆包 openspeech 的合成端点。只有网关会打它，端上不持有这个地址（ACR-018）。
 */
export const DOUBAO_TTS_URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional";

/**
 * 端上该打的合成端点：相对路径，三档共用（ACR-018）。
 *
 * 真正的合成方是网关：它按当前档位分流到豆包 / mock / DashScope，
 * 再把音频折成豆包 NDJSON 回给端上（`enterprise/backend/gateway/src/http/tts-speech.ts`）。
 * 这里给不了绝对地址：db 层不知道网关对外的名字；
 * `tts-config.ts` 下发时按请求的 Host 补成绝对 URL。
 */
export const TTS_GATEWAY_PATH = "/v1/tts/speech";

/**
 * aliyun 档的旧门面路径，为兼容仍缓存着它的旧客户端二进制而保留。
 * 两个端都发过一次新版本之后删除。
 */
export const LEGACY_ALIYUN_TTS_GATEWAY_PATH = "/v1/tts/aliyun";

export type TtsEngine = "mock" | "doubao" | "aliyun";

export interface ResolvedTts {
  engine: TtsEngine;
  /**
   * 端上该打的合成端点：恒为 `TTS_GATEWAY_PATH` 这个相对路径，
   * 下发前由 `tts-config.ts` 补 Host。端上不认识任何供应商地址（ACR-018）。
   */
  url: string;
  /**
   * 服务端去合成时该打的上游地址：doubao=火山，mock=本机 mock-tts。
   * aliyun 档为空串——DashScope 的地址由 `synthesizeDashScope` 自己按
   * base + 模型名拼，不经这里。
   *
   * 与 `url` 分成两个字段：两者的读者与下发面不同，
   * 合成一个字段会让"哪个值下发到端上"依赖调用点自行区分。
   */
  upstreamUrl: string;
  resourceId: string;
  speaker: string;
  /** 这一档是否按字计费，界面据此变色。 */
  billed: boolean;
  /**
   * @deprecated 恒为 `false`（ACR-018）：所有档的密钥都在服务端，端上不持有
   * 任何 vendor 凭证。字段保留只为向后兼容：旧客户端读不到它会回落 `billed`，
   * 而 doubao 档 `billed=true` 会让它误以为"本机得有 key"并降级 say。
   * 两个端都发过一次新版本之后可以连同端上的解析一起删。
   */
  keyRequired: boolean;
}

const DEFAULT_MOCK_URL = "http://localhost:8794/api/v3/tts/unidirectional";
const DEFAULT_RESOURCE_ID = "seed-tts-2.0";
const DEFAULT_SPEAKER = "zh_female_vv_uranus_bigtts";
const DEFAULT_ALIYUN_TTS_MODEL = "qwen3-tts-flash";
const DEFAULT_ALIYUN_TTS_VOICE = "Cherry";

export function isTtsEngine(v: string | undefined): v is TtsEngine {
  return v === "mock" || v === "doubao" || v === "aliyun";
}

/**
 * 从配置表解析出端上要用的合成端点。
 *
 * 认不出的引擎名回落 mock 而不是 doubao：回落方向必须是不计费的那个，
 * 拼写错误（`doubao ` 带空格、`Doubao` 大小写）不应接上计费引擎。
 */
export function resolveTts(values: ReadonlyMap<string, string>): ResolvedTts {
  const raw = values.get("TTS_ENGINE")?.trim();
  const engine: TtsEngine = isTtsEngine(raw) ? raw : "mock";
  const mockUrl = values.get("MOCK_TTS_URL")?.trim() || DEFAULT_MOCK_URL;
  if (engine === "aliyun") {
    return {
      engine,
      url: TTS_GATEWAY_PATH,
      // DashScope 的地址在 synthesizeDashScope 里按 base + 模型拼，这里没有可给的。
      upstreamUrl: "",
      // 豆包协议里的 resourceId 对门面没有路由意义，放模型名供日志与界面辨认。
      resourceId: values.get("ALIYUN_TTS_MODEL")?.trim() || DEFAULT_ALIYUN_TTS_MODEL,
      speaker: values.get("ALIYUN_TTS_VOICE")?.trim() || DEFAULT_ALIYUN_TTS_VOICE,
      billed: true,
      keyRequired: false,
    };
  }
  return {
    engine,
    url: TTS_GATEWAY_PATH,
    upstreamUrl: engine === "doubao" ? DOUBAO_TTS_URL : mockUrl,
    resourceId: values.get("BYTEDANCE_TTS_RESOURCE_ID")?.trim() || DEFAULT_RESOURCE_ID,
    speaker: values.get("BYTEDANCE_TTS_SPEAKER")?.trim() || DEFAULT_SPEAKER,
    billed: engine === "doubao",
    // 密钥全在服务端，端上不需要 vendor key；见字段上的 deprecated。
    keyRequired: false,
  };
}
