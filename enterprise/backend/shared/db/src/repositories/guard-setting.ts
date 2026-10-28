/**
 * Guard 策略值仓储（FL-30 F-30-01/02/03）。
 *
 * # 只承载 C 策略值，红线没有落点
 *
 * §8.2 三分边界：策略值归运营（本表）、接入面归管理员（`config_items`）、
 * 红线只在代码里。红线类字段在本仓储的类型里不存在：不是"写入会被拒绝"，
 * 而是没有那个 key。"可写但校验拒绝"的设计会面临校验被放宽的风险。
 *
 * # 写入必留痕，且保留旧值
 *
 * 与 `ConfigItemRevision` 对密钥类的处理相反：那边不留旧值是为了不扩大泄露面；
 * 策略值不是密钥，保留旧值才能追溯某次误伤发生在哪套策略下。
 */

import { PrismaClient, Prisma } from "@prisma/client";

/**
 * 本表承载的五项。红线不在其中，见文件头。
 *
 * `freshness_thresholds` 是 ④⑥ 数据新鲜度的三项阈值。它进这张表而不是环境变量，
 * 因为按 FL-35 的四分类它是 C 策略值：运营可热改、要留痕，改错只影响打扰多寡，
 * 不涉及安全红线。放 env 会使改阈值需要重启，并绕过留痕。
 *
 * 话术拆成"开关"与"文案"两个 key，不压成一份：
 * 「谁关掉了金融免责」是合规决定，「某版话术是谁改的」是文案决定，
 * 审阅人与风险都不同，留痕需要分别回答。
 * 两者的校验红线也不同：开关是"售后免责不可关"，文案是"不能太长"。
 */
export type GuardSettingKey =
  | "policy"
  | "kill_switch"
  | "disclaimer_policy"
  | "disclaimer_text"
  | "freshness_thresholds";

/** 止血开关（F-30-03）。Agent 级关闭在编排层生效，不是去停 pi-acp 进程。 */
export interface KillSwitch {
  /** 被关停的 Agent 名（supervisor/buying/ownership/trip/cabin/service）。 */
  agents: string[];
  /** 被关停的能力（工具名）。 */
  capabilities: string[];
}

export interface GuardSettingRecord<T = unknown> {
  key: GuardSettingKey;
  value: T;
  updatedBy?: string;
  updatedAt: number;
}

export interface GuardSettingRevisionRecord {
  id: string;
  key: string;
  prevValue: unknown;
  nextValue: unknown;
  actor: string;
  actorRole: string;
  at: number;
}

export interface GuardSettingRepository {
  /** 读一项；从未写过返回 null（调用方回落到代码里的默认值）。 */
  get<T>(key: GuardSettingKey): Promise<GuardSettingRecord<T> | null>;
  /**
   * 写一项并留痕，二者在同一事务内：留痕失败则写入也失败，
   * 不会出现无从追溯的策略变更。
   */
  put<T>(
    key: GuardSettingKey,
    value: T,
    actor: { subject: string; role: string },
  ): Promise<GuardSettingRecord<T>>;
  /** 变更历史，最近在前。 */
  history(key: GuardSettingKey, limit?: number): Promise<GuardSettingRevisionRecord[]>;
}

export function createGuardSettingRepository(prisma: PrismaClient): GuardSettingRepository {
  return {
    async get<T>(key: GuardSettingKey) {
      const row = await prisma.guardSetting.findUnique({ where: { key } });
      if (!row) return null;
      return {
        key: row.key as GuardSettingKey,
        value: row.value as T,
        updatedBy: row.updatedBy ?? undefined,
        updatedAt: row.updatedAt.getTime(),
      };
    },

    async put<T>(key: GuardSettingKey, value: T, actor: { subject: string; role: string }) {
      return prisma.$transaction(async (tx) => {
        const before = await tx.guardSetting.findUnique({ where: { key } });
        const row = await tx.guardSetting.upsert({
          where: { key },
          create: { key, value: value as Prisma.InputJsonValue, updatedBy: actor.subject },
          update: { value: value as Prisma.InputJsonValue, updatedBy: actor.subject },
        });
        await tx.guardSettingRevision.create({
          data: {
            key,
            prevValue: (before?.value ?? Prisma.JsonNull) as Prisma.InputJsonValue,
            nextValue: value as Prisma.InputJsonValue,
            actor: actor.subject,
            actorRole: actor.role,
          },
        });
        return {
          key: row.key as GuardSettingKey,
          value: row.value as T,
          updatedBy: row.updatedBy ?? undefined,
          updatedAt: row.updatedAt.getTime(),
        };
      });
    },

    async history(key, limit = 50) {
      const rows = await prisma.guardSettingRevision.findMany({
        where: { key },
        orderBy: { at: "desc" },
        take: limit,
      });
      return rows.map((r) => ({
        id: r.id,
        key: r.key,
        prevValue: r.prevValue,
        nextValue: r.nextValue,
        actor: r.actor,
        actorRole: r.actorRole,
        at: r.at.getTime(),
      }));
    },
  };
}
