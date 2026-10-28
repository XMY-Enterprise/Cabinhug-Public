/**
 * 可预约时段的生成。
 *
 * # 按日期生成而不是写死
 *
 * 种子里写死的日期会过期，过期后门店没有任何时段。
 *
 * # 可复现
 *
 * 同一天、同一店、同一车型，两次调用逐字相同。否则用户第一轮看到的时段
 * 在第二轮查询时已变化，`slotId` 对不上，表现为"你选的那个时段不存在"。
 *
 * 因此用 `storeId + model + 日期` 做种子的确定性伪随机，不用 `Math.random()`。
 */

/** 每天开放的试驾时刻（整点）。早于 10 点没人，晚于 18 点关门。 */
const HOURS = [10, 11, 14, 15, 16, 17];
/** 一次试驾占用时长。 */
const SLOT_MINUTES = 45;
/** 默认往后看多少天。 */
export const DEFAULT_DAYS = 14;

export interface Slot {
  slotId: string;
  startAt: string;
  endAt: string;
  /** 该时段还剩几台试驾车。0 表示订满，仍然返回，以区分"没有"与"满了"。 */
  remaining: number;
}

/** FNV-1a：短、稳定、跨进程一致。不用 hashCode 之类依赖运行时实现的东西。 */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * 北京时间某天某点的 ISO 串。
 *
 * 固定 +08:00 而不是取本机时区：门店在中国，跑测试的机器不一定。
 * 否则同一份种子在 CI 和本地会生成不同的时间。
 */
function beijing(day: string, hour: number, minutes = 0): string {
  const mm = String(minutes).padStart(2, "0");
  return `${day}T${String(hour).padStart(2, "0")}:${mm}:00+08:00`;
}

/**
 * 某店某车型在 [from, to] 内的可预约时段。
 *
 * `from` 缺省为明天：当天预约试驾不现实。
 */
export function generateSlots(args: {
  storeId: string;
  model: string;
  from?: string;
  to?: string;
  /** 注入"今天"，便于测试；生产传 `new Date()`。 */
  now: Date;
}): Slot[] {
  const { storeId, model, now } = args;

  const start = args.from ? new Date(`${args.from}T00:00:00Z`) : addDays(now, 1);
  const end = args.to ? new Date(`${args.to}T00:00:00Z`) : addDays(start, DEFAULT_DAYS - 1);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];

  const out: Slot[] = [];
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    const day = ymd(d);
    for (const hour of HOURS) {
      const seed = hash(`${storeId}|${model}|${day}|${hour}`);
      // 约四分之一的时段当天不开（试驾车被占用或不排班），使"选时段"这一步有实际意义。
      if (seed % 4 === 0) continue;
      out.push({
        slotId: slotIdOf(storeId, day, hour, seed),
        startAt: beijing(day, hour),
        endAt: beijing(day, hour, SLOT_MINUTES),
        // 1~2 台。剩 0 的情况由预约占用产生，不在生成时造。
        remaining: (seed % 2) + 1,
      });
    }
  }
  return out;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

/**
 * `slotId` 带一段不可猜的后缀。
 *
 * 没有后缀时 id 是 `门店_日期_小时` 拼接，模型不调 `dealer_slots`
 * 也能猜中一个真实存在的时段并下单，"防编靠 id"随之失效。
 */
function slotIdOf(storeId: string, day: string, hour: number, seed: number): string {
  const sig = hash(`${storeId}|${day}|${hour}|${seed}|carlife-slot`).toString(36).slice(0, 6);
  return `${storeId}_${day}_${String(hour).padStart(2, "0")}_${sig}`;
}

/**
 * 解析 `slotId` 回 `{storeId, day, hour}`。解析不出返回 undefined，不猜。
 *
 * 只做形状解析，不校验后缀：后缀由调用方拿生成集合比对
 * （`generateSlots(...).find(...)`），避免把生成规则复制成两份。
 */
export function parseSlotId(slotId: string): { storeId: string; day: string; hour: number } | undefined {
  const m = /^(.+)_(\d{4}-\d{2}-\d{2})_(\d{2})_([a-z0-9]{1,8})$/.exec(slotId);
  if (!m) return undefined;
  return { storeId: m[1], day: m[2], hour: Number(m[3]) };
}
