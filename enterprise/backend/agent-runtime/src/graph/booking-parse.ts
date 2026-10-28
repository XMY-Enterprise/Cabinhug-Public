/**
 * 预约类子图共享的指代/时间/联系人解析。
 *
 * # 平级模块
 *
 * 维修预约子图（repair-booking.ts）与试驾子图用同一套解析规则，而
 * `check:arch` 的 crosstalk 检查禁止子图互相 import，因此共享代码放在平级。
 * test-drive.ts 对外 re-export 这些函数。
 *
 * # 规则
 *
 * 指代解析在代码里不在模型手里；唯一命中才算，解析不出返回 undefined 不猜。
 * 猜错的后果是把单下到另一家店或另一个时段。
 */

import { normalizePhone } from "@cabinhug/shared";

import type { Intent } from "./state";

/** 意图理解给的时间点。取 `Intent["when"]` 而不是重新声明，避免两处定义漂移。 */
export type IntentWhen = Intent["when"];

/** 时段的最小结构型：试驾与维修的时段类型都满足它，解析器不认哪个业务。 */
export interface SlotLike {
  slotId: string;
  startAt: string;
}

/** 门店/维修站的最小结构型。维修站在调用侧把 stationId 映射进 storeId。 */
export interface StoreLike {
  storeId: string;
  name: string;
  district: string;
}

/**
 * `when.date` → 几号。
 *
 * 只取"日"这一位：`YYYY-MM-DD` 与 `--DD` 都只用后两位。
 * 不校验年月是否落在时段表里，由 `narrowSlots` 的 `pool.filter` 负责：
 * 模型给出门店未开放的日期时命中 0 个，转为追问。
 */
function whenDay(when: IntentWhen): number | undefined {
  const dd = when?.date?.slice(-2);
  if (!dd || !/^\d{2}$/.test(dd)) return undefined;
  const n = Number(dd);
  return n >= 1 && n <= 31 ? n : undefined;
}

const CN_ORDINAL: Record<string, number> = {
  第一: 1, 第二: 2, 第三: 3, 第1: 1, 第2: 2, 第3: 3, 一: 1, 二: 2, 三: 3,
};

/**
 * 「第二家」「南山那家」「深圳南山体验店」→ `storeId`。
 *
 * 解析不出返回 undefined，不猜：猜错会把单下到另一家店。
 */
export function resolveStoreRef(text: string, stores: readonly StoreLike[]): string | undefined {
  if (stores.length === 0) return undefined;
  // 只有一家时"就它吧""可以"都算选中，不要求复述店名。
  if (stores.length === 1 && /(就它|就这家|可以|好的|行|对)/.test(text)) return stores[0].storeId;

  const ord = Object.entries(CN_ORDINAL).find(([k]) => text.includes(`${k}家`) || text.includes(`${k}个`));
  if (ord) {
    const idx = ord[1] - 1;
    if (idx >= 0 && idx < stores.length) return stores[idx].storeId;
    return undefined; // 说了「第五家」而只有三家：不折回第一家，让车主重说
  }

  // 名字或区的片段。取唯一命中，命中多家说明说得不够具体。
  const hits = stores.filter(
    (s) => hasFragment(text, s.name) || (s.district.length > 1 && text.includes(s.district.replace(/区$/, ""))),
  );
  return hits.length === 1 ? hits[0].storeId : undefined;
}

/** 门店名的可辨识片段：去掉"体验店/服务中心"这类通名之后剩下的部分。 */
function hasFragment(text: string, name: string): boolean {
  const core = name.replace(/(体验店|服务中心|门店|店)$/, "");
  return core.length >= 2 && text.includes(core);
}

/**
 * 时段词 → 小时区间（左闭右开）。
 *
 * 上午的右端是 12 不是 11：门店的开放时刻包含 11 点，它属于上午；
 * 取 11 时「周六上午那个」在只有 11 点时段的日子里会过滤为空。
 */
const PERIODS: Array<{ re: RegExp; from: number; to: number }> = [
  { re: /上午|早上/, from: 6, to: 12 },
  { re: /中午/, from: 11, to: 14 },
  { re: /下午|傍晚|晚上/, from: 13, to: 22 },
];

/**
 * 「周六上午那个」「14 号十点」「第二个」→ `slotId`。
 *
 * 与门店同一条规则：唯一命中才算。同一天上午有两个时段而车主只说"上午"时，
 * 不替车主挑选。
 */
export function resolveSlotRef(
  text: string,
  slots: readonly SlotLike[],
  when?: IntentWhen,
): string | undefined {
  if (slots.length === 0) return undefined;

  const ord = Object.entries(CN_ORDINAL).find(([k]) => text.includes(`${k}个`) || text.includes(`${k}条`));
  if (ord) {
    const idx = ord[1] - 1;
    return idx >= 0 && idx < slots.length ? slots[idx].slotId : undefined;
  }

  /*
   * 先用意图理解给的值，滤空时整个退回正则重判一次。
   *
   * 模型可能给出错值（例如把示例数字抄成 `hour: 0`），此时过滤不命中，时段选不中，
   * 确认框也不会弹出。真实时段表是权威：`when` 把池子滤空即视为它有误。
   */
  const byWhen = narrowSlots(text, slots, when);
  if (byWhen.hit && byWhen.pool.length === 1) return byWhen.pool[0].slotId;

  // `when` 参与了过滤却没能唯一命中（滤空、或反而更宽）→ 视为不可信，退回纯正则再判一次。
  // 唯一命中的规则不变，命中多个照样追问。
  if (when && byWhen.usedWhen) {
    const byRegex = narrowSlots(text, slots, undefined);
    if (byRegex.hit && byRegex.pool.length === 1) return byRegex.pool[0].slotId;
  }
  return undefined;
}

/**
 * 按原话（可选叠加 `when`）收窄时段池。
 *
 * `hit` = 这一轮有没有任何时间限定词；没有说明不是在选时段
 * （「那这个店怎么样」不该被当成选时段）。
 * `usedWhen` = `when` 是否真的参与了过滤，供上面判断要不要退回正则。
 */
function narrowSlots(
  text: string,
  slots: readonly SlotLike[],
  when: IntentWhen,
): { pool: SlotLike[]; hit: boolean; usedWhen: boolean } {
  let pool = [...slots];
  let usedWhen = false;

  const wDay = whenDay(when);
  const day = wDay ?? pickDay(text);
  if (wDay !== undefined) usedWhen = true;
  if (day !== undefined) {
    const dd = String(day).padStart(2, "0");
    pool = pool.filter((s) => s.startAt.slice(8, 10) === dd);
  }

  const weekday = text.match(/周([一二三四五六日天])/);
  if (weekday) {
    const target = "日一二三四五六".indexOf(weekday[1] === "天" ? "日" : weekday[1]);
    pool = pool.filter((s) => isoWeekday(s.startAt) === target);
  }

  const period = PERIODS.find((p) => p.re.test(text));
  if (period) pool = pool.filter((s) => inHour(s.startAt, period.from, period.to));

  // 钟点：`when.hour` 已经是 24 小时制（模型看过整句，比正则更清楚"下午三点"是 15）。
  const hour = when?.hour ?? pickHour(text);
  if (when?.hour !== undefined) usedWhen = true;
  if (hour !== undefined) pool = pool.filter((s) => Number(s.startAt.slice(11, 13)) === hour);

  const hit = day !== undefined || Boolean(weekday) || Boolean(period) || hour !== undefined;
  return { pool, hit, usedWhen };
}

function inHour(iso: string, from: number, to: number): boolean {
  const h = Number(iso.slice(11, 13));
  return h >= from && h < to;
}

/**
 * 取 ISO 字符串里的日历星期。
 *
 * 排班时间的日期属于门店本地时区；先截取日期、再在 UTC 的午夜计算星期，
 * 才不会因为运行进程的宿主时区不同而跨到前一天。
 */
export function isoWeekday(iso: string): number {
  const datePart = iso.slice(0, 10);
  return new Date(`${datePart}T00:00:00Z`).getUTCDay();
}

/** 「十五」「三」「十一」「二十三」→ 数字。只覆盖 1~99，不做通用中文数字。 */
function cnNum(s: string): number | undefined {
  const D: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s === "十") return 10;
  const i = s.indexOf("十");
  if (i < 0) return D[s];
  const tens = i === 0 ? 1 : D[s.slice(0, i)];
  const ones = s.length > i + 1 ? D[s.slice(i + 1)] : 0;
  return tens === undefined || ones === undefined ? undefined : tens * 10 + ones;
}

/**
 * 从一串中文数字里取最长的、落在 [1, max] 内的那个读法。
 *
 * # 长的优先，不合法则退格
 *
 * 「八月十七十点」的钟点部分：取三个字 `十七十` 不是数；两个字 `七十`=70 超出钟点范围；
 * 一个字 `十`=10 才对。而「十五点」必须取两个字（`十五`=15），取一个字会得到 `五`=5。
 * 因此长的优先，解析不出或超范围就退一格。
 *
 * # `from` 决定取向
 *
 * 钟点取「点」前面那几个字（后缀），日期取「月」后面那几个字（前缀）。
 * 方向反了，「八月十七十点」的日期会退成 `十`=10 号，这是一个合法日期，
 * 过滤结果为空且不报错。
 */
function longestCnNumber(
  chars: string,
  max: number,
  from: "start" | "end",
): { value: number; len: number } | undefined {
  for (let len = Math.min(3, chars.length); len >= 1; len -= 1) {
    const piece = from === "end" ? chars.slice(chars.length - len) : chars.slice(0, len);
    const v = cnNum(piece);
    if (v !== undefined && v >= 1 && v <= max) return { value: v, len };
  }
  return undefined;
}

/**
 * 从原话里取几号。取不到返回 undefined。
 *
 * 三种说法，按可信度排：
 *
 *  1. `17号` / `17日`：最明确。
 *  2. `十七号` / `十七日`：语音入口的常见说法。
 *  3. `八月十七` / `8月17`：没有「号」字。
 *
 * 第 3 种用 `longestCnNumber` 而不是贪婪正则：`八月十七十点` 里跟在「月」后面的
 * 中文数字串是 `十七十`，贪婪取满是非法读法，退一格 `十七`=17 才对。
 */
function pickDay(text: string): number | undefined {
  const arabic = text.match(/(\d{1,2})\s*[号日]/) ?? text.match(/\d{1,2}\s*月\s*(\d{1,2})/);
  if (arabic) {
    const v = Number(arabic[1]);
    if (v >= 1 && v <= 31) return v;
  }
  const cnWithSuffix = text.match(/([一二两三四五六七八九十]{1,3})\s*[号日]/);
  if (cnWithSuffix) {
    const v = cnNum(cnWithSuffix[1]);
    if (v !== undefined && v >= 1 && v <= 31) return v;
  }
  // 「八月十七」：取「月」之后那一串中文数字，长的优先但会退格。
  const afterMonth = text.match(/月\s*([一二两三四五六七八九十]{1,3})/);
  if (afterMonth) return longestCnNumber(afterMonth[1], 31, "start")?.value;
  return undefined;
}

/**
 * 从原话里取 24 小时制的钟点。
 *
 *  1. 「下午 3 点」按 12 小时制还原为 15 点，否则与 14/15/17 等时段都不命中。
 *  2. 「下午三点」是语音入口的常见说法，中文数字同样要识别。
 */
function pickHour(text: string): number | undefined {
  const at = text.search(/\s*点/);
  if (at < 0) return undefined;
  const before = text.slice(0, at).replace(/\s+$/, "");

  let raw: number | undefined;
  const digits = before.match(/(\d{1,2})$/);
  if (digits) raw = Number(digits[1]);
  else {
    // 中文钟点：长的优先、不合法则退格。「十七十点」里 `十七十` 不是数、`七十` 超范围、`十`=10。
    const tail = before.match(/[一二两三四五六七八九十]{1,3}$/)?.[0] ?? "";
    raw = tail ? longestCnNumber(tail, 24, "end")?.value : undefined;
  }
  if (raw === undefined || Number.isNaN(raw)) return undefined;
  // 12 小时制还原：「下午/晚上 3 点」= 15 点；「下午 3 点」说成「15 点」时不再加。
  const pm = /下午|晚上|傍晚/.test(text);
  if (pm && raw < 12) return raw + 12;
  // 「上午 12 点」不存在；「中午 12 点」就是 12。
  if (/上午|早上/.test(text) && raw === 12) return 0;
  return raw;
}

/**
 * 从原话里认联系方式。备注不代拟，由车主自己填写。
 *
 * 号码归一化用 `@cabinhug/shared` 的 `normalizePhone`：`contact_update` 也要认
 * 同一批说法（语音说的 `幺八七…`、带空格的 `139 1234 5613`），
 * 映射表只保留一份，避免两处漂移导致某一入口的号码存不进去。
 */
export function pickContact(text: string): { name?: string; phone?: string } {
  const phone = normalizePhone(text);
  const name = text.match(/(?:我姓|本人姓)([一-龥])/)?.[1];
  return { name: name ? `${name}${/女士|小姐/.test(text) ? "女士" : "先生"}` : undefined, phone };
}

/** 车主是不是在要求换一批时段 / 重选门店。 */
export function wantsReset(text: string): boolean {
  return /(换个店|换一家|其它店|其他店|重新选|换个时间|换个时段|别的时间)/.test(text);
}

/** ISO → 人话。车主听不懂 `2026-08-14T10:00:00+08:00`。 */
export function human(iso: string): string {
  const match = iso.match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return iso;
  const [, month, day, hour, minute] = match;
  const wd = "日一二三四五六"[isoWeekday(iso)];
  return `${Number(month)} 月 ${Number(day)} 日（周${wd}）${hour}:${minute}`;
}
