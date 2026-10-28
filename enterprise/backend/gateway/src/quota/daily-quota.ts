/**
 * vendor 日用量闸门（ACR-016）：判定今天这个 vendor 还能不能再调。
 *
 * # 它不是账单上限
 *
 * 云厂商（阿里云、火山）只提供预算告警，没有"花到 X 自动停"的开关；
 * 唯一的硬闸是账户欠费，欠费时转写全部 502，与产品故障不可区分。所以闸设在
 * 我们这一侧：它限制的是我们发出去的调用量，不是对方账上的钱。两者会有出入
 * （对方有最低计费、赠额、结算延迟），这里的数字不用于对账。
 *
 * # 三条约束（省钱机制本身不能成为故障源）
 *
 * 1. 超限是降级不是拒绝：降级目标由调用方决定（ASR 落本地档、TTS 落端上
 *    系统 say），本模块只回答"还能不能调"。
 * 2. 计数失败一律放行（`fail-open`）：计数只是保险，Redis 抖动不能让语音
 *    失效。所有异常路径都返回 allowed。
 * 3. 上界 0 = 不限：未配置的上界不会让新部署失声，开闸是一次明确的动作。
 *
 *    TTS 是这条的例外（`TTS_DAILY_CHAR_LIMIT` 默认 80000 而非 0，ACR-018）：
 *    三档 TTS 都经网关且 doubao 档按字计费，默认不限会让新部署没有任何兜底。
 *    80000 字/天（约 52 元/天）留得很宽，正常演示与测试碰不到；写 0 即回到不限。
 *    ASR 的 `ASR_DAILY_CALL_LIMIT` 仍默认 0。
 *
 * # 按自然日而不是滑动窗口
 *
 * 滑动窗口要存时间序列，且"还剩多少"不好表达。自然日与账单直觉一致
 * （"今天用了多少"），键本身带日期、次日自然消失，Redis 侧一个 EXPIRE 就够。
 * 用本地时区的日界而不是 UTC：运维看的是本地"今天"。
 *
 * # 存储：Redis 计数 + 进程内存兜底
 *
 * 与 `http/pairing-store.ts` 的 `allowIssue` 同一做法（INCR + EXPIRE）：
 * 单实例部署下进程内 Map 完全等价；多实例时降级只会让上界变成
 * "每实例一份"（闸更松），而不是失效。
 */

/** 一个受闸门约束的计费口。值进 Redis key，不要随便改。 */
export type QuotaKind = "asr" | "tts";

export interface QuotaDecision {
  allowed: boolean;
  /** 本次消费计入后的当日累计（放行时才有意义）。 */
  used: number;
  /** 当时生效的上界；0 表示不限。 */
  limit: number;
  /**
   * 计数没能真正落下（Redis 异常等）。此时 `allowed` 恒为 true；
   * 调用方不据此改变行为，它只用于日志与状态页的"闸门当前不可靠"提示。
   */
  degraded?: boolean;
}

export interface DailyQuota {
  /**
   * 消费 `amount` 并判定是否放行。先计后判：即使这一次超了也把量记进去，
   * 否则"今天发出去多少"会小于真实值。
   *
   * `limit <= 0` 表示不限，此时仍然计数（状态页要看得见用量），恒放行。
   */
  consume(kind: QuotaKind, amount: number, limit: number): Promise<QuotaDecision>;
  /** 只读当日累计，不计数。状态页用。 */
  snapshot(kind: QuotaKind): Promise<{ used: number; degraded?: boolean }>;
}

/** 计数键的日期段：本地时区的 YYYY-MM-DD（见文件头）。 */
export function dayKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const PREFIX = "cabinhug:quota:";
/**
 * 键的存活时间：两天。按日界过期会让"今天"的键在跨日瞬间被删掉，而此刻可能
 * 正有一次消费在路上；键名带日期，多留一天不会串。
 */
const TTL_SECONDS = 48 * 3600;

const redisKey = (kind: QuotaKind, day: string): string => `${PREFIX}${kind}:${day}`;

function decide(used: number, limit: number, degraded?: boolean): QuotaDecision {
  // limit<=0 不限；degraded 时无条件放行（约束 2）。
  const allowed = degraded === true || limit <= 0 || used <= limit;
  return degraded ? { allowed, used, limit, degraded } : { allowed, used, limit };
}

/**
 * 进程内计数（无 Redis 时的形态，也是 Redis 故障时的兜底）。
 *
 * 只保留"当天"一份：跨日时整个换掉，不累积历史。账本是 `/console/usage`。
 */
export function createMemoryDailyQuota(now: () => Date = () => new Date()): DailyQuota {
  let day = dayKey(now());
  const counts = new Map<QuotaKind, number>();

  const rollover = (): void => {
    const today = dayKey(now());
    if (today !== day) {
      day = today;
      counts.clear();
    }
  };

  return {
    async consume(kind, amount, limit) {
      rollover();
      const used = (counts.get(kind) ?? 0) + Math.max(0, amount);
      counts.set(kind, used);
      return decide(used, limit);
    },
    async snapshot(kind) {
      rollover();
      return { used: counts.get(kind) ?? 0 };
    },
  };
}

/**
 * 装配闸门。`url` 为空即进程内计数（与 `createPairingStore` 同一形态），
 * 连接失败也退进程内而不是抛，理由见文件头约束 2。
 */
export function createDailyQuota(url: string | undefined, now: () => Date = () => new Date()): DailyQuota {
  const backend = connect(url, now);
  return {
    consume: (kind, amount, limit) => backend.then((b) => b.consume(kind, amount, limit)),
    snapshot: (kind) => backend.then((b) => b.snapshot(kind)),
  };
}

async function connect(url: string | undefined, now: () => Date): Promise<DailyQuota> {
  const memory = createMemoryDailyQuota(now);
  if (!url) return memory;
  try {
    const { createClient } = await import("redis");
    const client = createClient({ url });
    client.on("error", (e: unknown) =>
      console.warn("[quota] Redis 连接异常（日用量计数将不跨实例）", e),
    );
    await client.connect();
    return {
      async consume(kind, amount, limit) {
        const key = redisKey(kind, dayKey(now()));
        try {
          // INCRBY 而不是 INCR：TTS 一次消费的是字符数，不是 1。
          const used = await client.incrBy(key, Math.max(0, Math.trunc(amount)));
          // 首次写入才设 TTL（与 pairing-store 的 allowIssue 同一判据）。
          if (used <= Math.max(0, Math.trunc(amount))) await client.expire(key, TTL_SECONDS);
          return decide(used, limit);
        } catch (err) {
          // 约束 2：计数失败不影响语音。退回进程内计数并标记 degraded。
          console.warn(`[quota] ${kind} 计数失败，本次放行并退回进程内计数`, err);
          const fallback = await memory.consume(kind, amount, limit);
          return { ...fallback, allowed: true, degraded: true };
        }
      },
      async snapshot(kind) {
        try {
          const raw = await client.get(redisKey(kind, dayKey(now())));
          return { used: raw ? Number(raw) : 0 };
        } catch {
          return { ...(await memory.snapshot(kind)), degraded: true };
        }
      },
    };
  } catch (err) {
    console.warn(`[quota] Redis 连接失败（${url}）——日用量计数走进程内存`, err);
    return memory;
  }
}
