/**
 * `destination_highlights` —— 到了那儿吃什么、拍哪儿。
 *
 * # 必须联网，不让模型凭记忆答
 *
 * 美食榜与网红打卡点时效性强（网红点半年一换）、长尾（模型对小城市几乎没有记忆），
 * 必须联网。凭记忆答会产出貌似可信的假推荐——本仓对这类输出有明确红线（`external.ts` 的来源标注、
 * `weather.ts`/`pretrip-items.ts` 的"取不到就说取不到"）。
 *
 * # 联网靠 DeepSeek 自己的内置工具，我们不接搜索引擎
 *
 * 走 DeepSeek 的 Anthropic 兼容端点（`/anthropic/v1/messages`）声明服务端工具
 * `{"type":"web_search_20250305","name":"web_search"}`。搜索由 DeepSeek 那侧执行，
 * 回包里带 `server_tool_use` 与 `web_search_tool_result`。
 * 用 `fetch` 直连而不是 `@anthropic-ai/sdk`：只用到一个端点、一个工具类型，
 * 为它加一条依赖要走 `/arch-revision` 变更单，代价与收益不成比例。
 * 调用层在 `web-search.ts`（与导游采集子代理共用），
 * 本文件只负责本场景的 prompt / 解析 / 出处校验 / 缓存。
 *
 * # 三条实测约定（与 Claude 的文档不同）
 *
 * 1. `citations` 恒为 `null`——DeepSeek 不返回 Claude 那套 `web_search_result_location`
 *    引用块。出处的唯一来源是 `web_search_tool_result.content[].url` 这份清单。
 * 2. 模型写的 URL 会被改写：它会把真实 URL 截断成打不开的短链，
 *    却带着"这是出处"的可信度。所以 `sourceUrl` 必须与某条搜索结果的 url
 *    字符串全等才展示，否则置空——由 `parseHighlights` 负责。
 * 3. `allowed_domains` 被静默忽略：传 `["xiaohongshu.com","douyin.com"]`，
 *    回来的 9 条里 7 条是 trip.com / sm.cn / toutiao。所以本文件不声明这个字段，
 *    以免读者误以为域收窄生效。
 *
 * # 规则与网络分开
 *
 * `parseHighlights()` 不碰网络：给它模型那段文本 + 这次回包里的搜索结果清单，
 * 它给出结构化数据与出处校验结论。出处取舍因此可以直接单测，
 * 不依赖 HTTP 调用（与 `pretrip-items.ts` 同一分法）。
 */

import { defineExternalTool, ToolError, type ExternalTool } from "./external";
import { ENV_TTL, envCacheKey, readNegative, withEnvCache, writeNegative } from "./env-cache";
import { getAmapClient, type AmapClient } from "./amap";
import {
  callAnthropicWebSearch,
  getWebSearch,
  readWebSearchTurn,
  setWebSearch,
  type SearchResultRef,
  type WebSearchConfig,
  type WebSearchTurn,
} from "./web-search";

/**
 * 兼容再导出：调用层在 `web-search.ts`，本文件仍是公开面，
 * 既有消费方（index.ts 的导出、单测）的 import 不变。
 */
export { readWebSearchTurn };
export type { SearchResultRef, WebSearchTurn };

export interface DestinationHighlightsArgs {
  /** 目的地名，如「舟山普陀山」。空串直接抛 invalid，不发请求。 */
  destination: string;
  /** 出发日（`2026-09-01` 这种形状）；只进缓存键与提示词（"这个季节"），不做日期运算。 */
  date?: string;
}

/** 出处。只有能与搜索结果对上的才有值；对不上就是 undefined，卡上什么都不显示。 */
export interface HighlightSource {
  url: string;
  title?: string;
}

export interface HighlightEntry {
  name: string;
  /** 一行推荐理由，≤ `MAX_NOTE_CHARS`。 */
  note: string;
  source?: HighlightSource;
}

export interface PhotoTip {
  /** 对应哪个点（多数时候是 `spots` 里的某一个，但不强制——模型也可能给一条通用的）。 */
  spot: string;
  tip: string;
}

export interface DestinationHighlightsData {
  destination: string;
  foods: HighlightEntry[];
  spots: HighlightEntry[];
  photoTips: PhotoTip[];
  /**
   * 这次真的搜了几次。
   * 0 = 模型没调搜索，即凭记忆答；调用方（工具壳）据此当失败处理，不把结果发出去。
   */
  searchCount: number;
  /**
   * 出处能对上白名单的条数 / 模型声称有出处的条数。
   * 排障用，不上卡：卡上只显示对得上的那些。
   */
  sourcesVerified: { matched: number; claimed: number };
}

/** 卡上就这么多格。多要一条 = 多花 token 换一条永远不显示的数据。 */
export const MAX_FOODS = 3;
export const MAX_SPOTS = 3;
export const MAX_PHOTO_TIPS = 3;
/** 一行理由的字数上限。提示词里也写了，但模型不守字数是常态，代码侧再截一次。 */
export const MAX_NOTE_CHARS = 18;

/** DeepSeek 侧一次调用最多搜几次。3 次约 8 秒，再多只是更慢更贵。 */
const MAX_SEARCH_USES = 3;

// ────────────────────────────── 供应商接线 ──────────────────────────────

/**
 * 配置本体在 `web-search.ts`（一处注入、两类消费方共用：
 * 本工具 + 通用 `web_search`）。这里保留原名作为别名，装配层不用改。
 */
export type DestinationSearchConfig = WebSearchConfig;

export function setDestinationSearch(c: DestinationSearchConfig | undefined): void {
  setWebSearch(c);
}

export function getDestinationSearch(): DestinationSearchConfig | undefined {
  return getWebSearch();
}

// ────────────────────────────── 纯函数：解析与出处校验 ──────────────────────────────

interface RawEntry {
  name?: unknown;
  note?: unknown;
  sourceUrl?: unknown;
}
interface RawTip {
  spot?: unknown;
  tip?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** 超长就截断并加省略号，让截断本身可见。 */
function clampNote(s: string): string {
  return s.length <= MAX_NOTE_CHARS ? s : `${s.slice(0, MAX_NOTE_CHARS - 1)}…`;
}

/**
 * 从模型的回答里抠出 JSON。
 *
 * 容错到"第一个 `{` 到最后一个 `}`"为止：模型有时会在 JSON 外面裹一层
 * ```` ```json ```` 围栏，或在前面写一句"好的，以下是…"。不再做更宽松的容错。
 */
function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new ToolError("destination_highlights", "invalid", "模型的回答里没有 JSON", false);
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ToolError("destination_highlights", "invalid", "模型返回的 JSON 解析失败", false);
  }
}

/**
 * 模型给的 `sourceUrl` → 可展示的出处。
 *
 * 只认全等。不做"前缀匹配"或"同域名就算"的宽松匹配：模型会给出真实 URL 的
 * 截断版，前缀匹配会把这种打不开的短链放行。
 */
function verifySource(
  claimed: unknown,
  whitelist: ReadonlyMap<string, SearchResultRef>,
): { source?: HighlightSource; claimed: boolean } {
  const url = str(claimed);
  if (!url) return { claimed: false };
  const hit = whitelist.get(url);
  if (!hit) return { claimed: true };
  return { claimed: true, source: { url: hit.url, ...(hit.title ? { title: hit.title } : {}) } };
}

function parseEntries(
  raw: unknown,
  limit: number,
  whitelist: ReadonlyMap<string, SearchResultRef>,
  counter: { matched: number; claimed: number },
): HighlightEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: HighlightEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= limit) break; // 截尾不截头：模型已按排名给，前面的更重要
    const e = item as RawEntry;
    const name = str(e.name);
    if (!name || seen.has(name)) continue; // 没名字的格子不上卡；同名去重
    seen.add(name);
    const v = verifySource(e.sourceUrl, whitelist);
    if (v.claimed) counter.claimed += 1;
    if (v.source) counter.matched += 1;
    out.push({ name, note: clampNote(str(e.note)), ...(v.source ? { source: v.source } : {}) });
  }
  return out;
}

function parseTips(raw: unknown): PhotoTip[] {
  if (!Array.isArray(raw)) return [];
  const out: PhotoTip[] = [];
  for (const item of raw) {
    if (out.length >= MAX_PHOTO_TIPS) break;
    const t = item as RawTip;
    const tip = str(t.tip);
    if (!tip) continue; // 没有建议正文的条目上卡就是一个空格子
    out.push({ spot: str(t.spot), tip: clampNote(tip) });
  }
  return out;
}

/**
 * 模型文本 + 这次的搜索结果清单 → 结构化推荐。不碰网络，单测覆盖在它身上。
 *
 * `searchCount === 0` 在这里不抛错：判"这次数据可不可信"是工具壳的事，
 * 本函数只负责如实把它算出来（这样单测能断言解析结果，而不是断言一个异常）。
 */
export function parseHighlights(
  destination: string,
  rawText: string,
  results: readonly SearchResultRef[],
  searchCount: number,
): DestinationHighlightsData {
  const parsed = extractJson(rawText) as {
    foods?: unknown;
    spots?: unknown;
    photoTips?: unknown;
  };
  // 白名单按 url 建索引：同一条 url 可能被多条推荐引用。
  const whitelist = new Map<string, SearchResultRef>();
  for (const r of results) if (r.url) whitelist.set(r.url, r);

  const counter = { matched: 0, claimed: 0 };
  const foods = parseEntries(parsed.foods, MAX_FOODS, whitelist, counter);
  const spots = parseEntries(parsed.spots, MAX_SPOTS, whitelist, counter);

  return {
    destination,
    foods,
    spots,
    photoTips: parseTips(parsed.photoTips),
    searchCount,
    sourcesVerified: counter,
  };
}

// ────────────────────────────── 网络：一次 messages 调用 ──────────────────────────────
// 调用层（端点拼接 / max_tokens 预算 / 截断判定 / readWebSearchTurn）在 `web-search.ts`。

/** 提示词。JSON 骨架给死——`tool_choice` 在混了服务端工具之后语义会变，不用它。 */
export function buildPrompt(destination: string, date?: string): string {
  return [
    `目的地：${destination}${date ? `，出发日期：${date}` : ""}。`,
    "请联网搜索这个目的地当下的美食排行榜、网红打卡点，以及在这些打卡点的拍照建议。",
    "",
    "只输出下面这个 JSON，不要任何其它文字：",
    '{"foods":[{"name":"","note":"","sourceUrl":""}],' +
      '"spots":[{"name":"","note":"","sourceUrl":""}],' +
      '"photoTips":[{"spot":"","tip":""}]}',
    "",
    `要求：foods ${MAX_FOODS} 条、spots ${MAX_SPOTS} 条、photoTips ${MAX_PHOTO_TIPS} 条；`,
    /*
     * 只说"短"，不给具体字数：给了字数，模型会在思考里逐条数汉字，
     * 撑爆输出预算导致 JSON 截断。多出来的字由这边硬截（`clampNote`）。
     */
    "每条 note / tip 写成一句短语，十几个字，不要成段；",
    "photoTips 的 spot 尽量对应上面 spots 里的名字；",
    "sourceUrl 必须逐字复制自你这次搜索结果里的链接，不要改写、不要截断、不要自己拼。",
  ].join("\n");
}

/**
 * 薄壳：本场景只定 prompt 与搜索次数上限，网络细节（`max_tokens: 4000` 的取值、
 * 截断判定、`allowed_domains` 刻意不带）全在 `callAnthropicWebSearch`。
 * 错误仍以 `destination_highlights` 归属——同一条通路服务多个工具，账要各记各的。
 */
function callWebSearch(
  destination: string,
  date: string | undefined,
  signal: AbortSignal | undefined,
): Promise<WebSearchTurn> {
  if (!getWebSearch()?.apiKey) {
    // 文案保持"目的地推荐"：它会进模型的工具结果，措辞影响行为。
    throw new ToolError(
      "destination_highlights",
      "unconfigured",
      "联网搜索未接入（缺 DeepSeek 密钥），本次不提供目的地推荐",
      false,
    );
  }
  return callAnthropicWebSearch("destination_highlights", buildPrompt(destination, date), {
    maxUses: MAX_SEARCH_USES,
    ...(signal ? { signal } : {}),
  });
}

// ────────────────────────────── 工具壳 ──────────────────────────────

/** 目的地字符串里的分隔符——模型会拼「南通 张家港」「张家港（经南通）」「南通如东—张家港」。 */
const PLACE_SPLIT = /[\s、，,／/（）()]|经|→|至|到|—|--/;

/**
 * 把模型随手拼的目的地拆成候选地名。
 *
 * 无分隔符的连写（「南通如东」= 市名 + 区名）单独处理：整串认不出来时，
 * 从前面切 2~3 个字再试一次，剩下的部分当第二个地名。只试这两种切法，
 * 认不出来的退回原串当键。
 */
export function splitPlaces(raw: string): string[] {
  const parts = raw
    .split(PLACE_SPLIT)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2);
  return parts.length > 0 ? [...new Set(parts)] : [];
}

/**
 * 目的地 → 城市级缓存键的组成部分。
 *
 * # 必须归一
 *
 * 模型为同一趟行程会传出多种写法（`南通`、`南通如东`、`南通 张家港`、`张家港（经南通）`、
 * `南通如东—张家港`、`张家港`）。直接用原串当键，每种写法各搜一次（每次 4~7 秒），
 * 缓存几乎不命中。
 *
 * # 归到 adcode，不归到字符串
 *
 * 用高德的行政区编码当键：`resolveRegion` 认得出「南通」与「如东」是 320600 与 320623。
 * 不做前缀 / 模糊匹配：那会把「张家港（经南通）」错命中成南通那一份，
 * 错的命中不报错，比一次 miss 更糟（ADR-008 的同一条取向）。
 *
 * # 不归到地级市
 *
 * 张家港属苏州，归到苏州就会拿苏州市区的吃喝去答张家港。行政区认到哪一级就用哪一级，
 * 只求把不同写法归一，不求把不同地方合并。
 *
 * 认不出来就返回空数组，调用方退回用原串当键。
 *
 * # 适用范围
 *
 * 能归一写法差异：`张家港（经南通）` 与 `南通 张家港` 归一后是同一个键。
 * 配合日期归周，三天行程里为不同日期查同一批城市也只搜一次。
 *
 * 不归一范围差异：`张家港` 与 `南通 张家港 如东` 归一后一个是 `320582`、另一个是三个码，
 * 仍是两个键。搜一个城市和搜三个城市应拿到不同的内容，不应共享缓存。
 * 跨轮稳定命中需要编排层按单个城市逐个预取（每城一个键），
 * 而不是让模型每轮自由拼一个组合串；本函数不处理这一点。
 */
export async function destinationCacheParts(
  destination: string,
  amap: AmapClient | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!amap) return [];
  const codes = new Set<string>();
  for (const part of splitPlaces(destination)) {
    let hit = await amap.resolveRegion(part, signal).catch(() => undefined);
    if (hit) {
      codes.add(hit.adcode);
      continue;
    }
    // 连写：「南通如东」→ 前 2 字是市、余下是区。只切这两刀。
    for (const cut of [2, 3]) {
      if (part.length <= cut + 1) continue;
      const head = await amap.resolveRegion(part.slice(0, cut), signal).catch(() => undefined);
      if (!head) continue;
      codes.add(head.adcode);
      const tail = await amap.resolveRegion(part.slice(cut), signal).catch(() => undefined);
      if (tail) codes.add(tail.adcode);
      hit = head;
      break;
    }
  }
  // 排序：`南通 张家港` 与 `张家港（经南通）` 必须落到同一个键。
  return [...codes].sort();
}

/**
 * 出发日 → ISO 周键。
 *
 * TTL 是两周，因为网红点与老字号是周级变化的内容；键若精确到天，
 * 多天行程的每一天各是一个键，周级 TTL 就不起作用。
 * 精确日期仍然进提示词（"这个季节"那句），只是不进键。
 */
export function weekKeyOf(date?: string): string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return "-";
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "-";
  // ISO 周：把日期挪到本周四，再数它是当年第几周。
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fd = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fd + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}


export const destinationHighlightsTool: ExternalTool<
  DestinationHighlightsArgs,
  DestinationHighlightsData
> = defineExternalTool<DestinationHighlightsArgs, DestinationHighlightsData>({
  name: "destination_highlights",
  provider: "deepseek-web-search",
  sensitive: false,
  /*
   * 只读幂等，但每次重试都是一次计费搜索（按次计费 + 约 19k input tokens），
   * 所以只给 1 次，不是四件套默认的 2 次。
   */
  retries: 1,
  /*
   * 30 秒，不是默认的 5 秒。实测三次分别是 11.7 / 12.4 / 14.0 秒（`max_tokens: 4000`），
   * 5 秒必然超时，20 秒余量太紧。
   *
   * 慢在这里是可接受的：它有 2 周缓存（`ENV_TTL.destinationHighlights`），慢只发生在冷启那一次，
   * 而且不阻塞任何用户动作（走的是读时补齐，不进行程确认那一跳）。
   */
  timeoutMs: 30_000,

  real: async (args, ctx) => {
    const destination = args.destination?.trim();
    if (!destination) {
      throw new ToolError("destination_highlights", "invalid", "没有目的地，无从搜起", false);
    }

    /*
     * ⑤环境缓存：按行政区编码 + ISO 周，不按会话，也不按模型传的原字符串。
     *
     * 模型为同一趟行程会传出多种写法，归一到 adcode 之后写法不再影响命中。
     * 认不出来时退回原串当键。
     */
    const parts = await destinationCacheParts(destination, getAmapClient(), ctx.signal);
    const keyParts = parts.length > 0 ? parts : [destination];
    const key = envCacheKey("dest-highlights", [...keyParts, weekKeyOf(args.date)]);
    /*
     * 「模型没搜就答」的失败有短负缓存（10 分钟），避免同一轮里连续重试、每次耗时 5~7 秒。
     * 10 分钟只挡住同一轮的重试，不会让两周都拿不到结果。
     */
    const missKey = `${key}:no-search`;
    if (await readNegative(missKey)) {
      throw new ToolError(
        "destination_highlights",
        "upstream",
        "刚才这个目的地搜过一次没搜成（模型未联网），本轮不再重试",
        false,
      );
    }
    const { value } = await withEnvCache(key, ENV_TTL.destinationHighlights, async () => {
      const turn = await callWebSearch(destination, args.date, ctx.signal);
      /*
       * 模型没搜就是在凭记忆答，当失败处理，不把结果发出去。
       * 放在缓存的 fetch 里抛：失败的结果不该被缓存 2 周。
       */
      if (turn.searchCount === 0) {
        // 记一条短负缓存再抛，避免同一轮连续重试。
        await writeNegative(missKey);
        throw new ToolError(
          "destination_highlights",
          "upstream",
          "模型没有联网搜索（凭记忆的推荐不可信），本次不提供目的地推荐",
          true,
        );
      }
      return parseHighlights(destination, turn.text, turn.results, turn.searchCount);
    });
    return value;
  },

  /*
   * Mock 三态的 `mock`：四件套会把 `source.kind` 标成 `mock`，所以这里给固定数据是安全的。
   * 出处刻意留空：模拟数据不应带看起来真实的链接。
   */
  mock: (args) => ({
    destination: args.destination || "示例目的地",
    foods: [
      { name: "海鲜面", note: "码头边的老店" },
      { name: "素斋", note: "寺院斋堂，清淡" },
      { name: "观音饼", note: "常见伴手礼" },
    ],
    spots: [
      { name: "南海观音", note: "地标，面朝大海" },
      { name: "千步沙", note: "金色沙滩" },
      { name: "普济寺", note: "香火最旺" },
    ],
    photoTips: [
      { spot: "南海观音", tip: "傍晚斜阳给金身镀边" },
      { spot: "千步沙", tip: "低机位拍浪花与脚印" },
      { spot: "普济寺", tip: "广场仰拍才装得下" },
    ],
    searchCount: 0,
    sourcesVerified: { matched: 0, claimed: 0 },
  }),
});
