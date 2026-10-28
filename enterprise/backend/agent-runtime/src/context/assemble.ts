/**
 * 用户长期状态的投影（ACR-036 §4.9）。
 *
 * # 它不是一个新存储
 *
 * 八段全部来自既有权威源：④ `vehicles`、`owner_profiles`、`vehicle_members`、
 * `trip_plans`、`vehicle_reminders`、Mem0 ③ 与 ⑥ 摘要。这里只负责并行取回、
 * 整理成一个形状，不另存一份，避免出现第二个真相源。
 *
 * # 读取器由装配层注入，本模块零 IO
 *
 * 与 `guard/pipeline.ts` 同一取向：单测里不连库也能运行，
 * "哪一段来自哪个仓储"集中在装配处。
 *
 * # 失败与超时都不阻塞，但要显式标出
 *
 * 任一段读失败或超时 → 那一段是 `{ unavailable, reason }`，不是缺席。
 * 缺席会被下游当成"没有车 / 没有行程"并据此作答。
 */

import {
  type ContextCompanion,
  type ContextHome,
  type ContextIdentity,
  type ContextReminder,
  type ContextTripPointer,
  type ContextUsage,
  type ContextVehicle,
  type UserContext,
} from "@cabinhug/shared";

/**
 * 八个读取器。每一个都必须带 `userId`（ADR-011：不带用户键的读只许在研究进程里）。
 * 缺席的读取器 = 那一段不投影（这个部署没有这项能力），与"读不到"不是一回事。
 */
export interface UserContextReaders {
  identity?(userId: string): Promise<ContextIdentity | undefined>;
  vehicle?(userId: string): Promise<ContextVehicle | undefined>;
  home?(userId: string): Promise<ContextHome | undefined>;
  companions?(userId: string): Promise<readonly ContextCompanion[]>;
  trips?(userId: string): Promise<readonly ContextTripPointer[]>;
  reminders?(userId: string): Promise<readonly ContextReminder[]>;
  preferences?(userId: string): Promise<readonly string[]>;
  usage?(userId: string): Promise<ContextUsage | undefined>;
}

/** 整体预算。超时的那一段标"读不到"，其余照常，不让一个慢仓储拖住整轮。 */
export const ASSEMBLE_BUDGET_MS = 300;

function withBudget<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超过 ${ms}ms 预算`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e as Error);
      },
    );
  });
}

function reasonOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // 原因要短且不带栈：它会被渲染进提示词给模型看。
  return msg.length > 60 ? `${msg.slice(0, 60)}…` : msg;
}

/**
 * 取一段。
 *
 * 三种结果：读出来了（值）、这个人没有（`undefined`，整段不出现）、
 * 读不到（`{ unavailable, reason }`）。本函数用于区分后两种。
 */
async function section<T>(
  read: ((userId: string) => Promise<T>) | undefined,
  userId: string,
  budgetMs: number,
): Promise<T | { unavailable: true; reason: string } | undefined> {
  if (!read) return undefined;
  try {
    return await withBudget(read(userId), budgetMs);
  } catch (err) {
    return { unavailable: true as const, reason: reasonOf(err) };
  }
}

/**
 * 投影一份 `UserContext`。八段并行取，整体最多等 `budgetMs`。
 *
 * 排序在这里做完（同行人按 label、行程按 ref、偏好原序）：锚定块要确定性渲染，
 * 而仓储的返回顺序不保证稳定。这是"两次渲染逐字相同"的前提之一。
 */
export async function assembleUserContext(
  readers: UserContextReaders,
  userId: string,
  budgetMs: number = ASSEMBLE_BUDGET_MS,
): Promise<UserContext> {
  const [identity, vehicle, home, companions, trips, reminders, preferences, usage] = await Promise.all([
    section(readers.identity, userId, budgetMs),
    section(readers.vehicle, userId, budgetMs),
    section(readers.home, userId, budgetMs),
    section(readers.companions, userId, budgetMs),
    section(readers.trips, userId, budgetMs),
    section(readers.reminders, userId, budgetMs),
    section(readers.preferences, userId, budgetMs),
    section(readers.usage, userId, budgetMs),
  ]);

  const ctx: UserContext = { userId };
  if (identity !== undefined) ctx.identity = identity;
  if (vehicle !== undefined) ctx.vehicle = vehicle;
  if (home !== undefined) ctx.home = home;
  if (companions !== undefined) {
    ctx.companions = Array.isArray(companions)
      ? [...companions].sort((a, b) => a.label.localeCompare(b.label))
      : companions;
  }
  if (trips !== undefined) {
    ctx.trips = Array.isArray(trips) ? [...trips].sort((a, b) => a.ref.localeCompare(b.ref)) : trips;
  }
  if (reminders !== undefined) {
    ctx.reminders = Array.isArray(reminders)
      ? [...reminders].sort((a, b) => a.kind.localeCompare(b.kind))
      : reminders;
  }
  if (preferences !== undefined) ctx.preferences = preferences;
  if (usage !== undefined) ctx.usage = usage;
  return ctx;
}
