/**
 * 车主档案仓储。
 *
 * 目前只有一项：常住地。消费方是座舱 HUD：没有行程时地图以它为中心。
 *
 * # 读时初始化
 *
 * 存量用户在这张表里没有行，建档流程也不写它。第一次读时落一行默认值，
 * 保证 HUD 始终有落点。默认值只表示"还没设置过"，用户设置后以用户的为准
 * （`setHome`）。
 */

import { PrismaClient } from "@prisma/client";

export interface HomePlace {
  /** 展示名，如「浙江杭州」。 */
  city: string;
  lat: number;
  lon: number;
}

export interface OwnerProfile {
  userId: string;
  home: HomePlace;
  updatedAt: Date;
}

/**
 * 未设置常住地时的默认落点：浙江杭州（西湖文化广场一带）。
 *
 * 坐标是真实的杭州市中心坐标，HUD 直接拿它当地图中心。
 */
export const DEFAULT_HOME: HomePlace = { city: "浙江杭州", lat: 30.2741, lon: 120.1551 };

export interface OwnerProfileRepository {
  /** 读；没有就按默认值落一行再返回（见文件头）。 */
  currentForUser(userId: string): Promise<OwnerProfile>;
  /** 覆盖常住地。 */
  setHome(userId: string, home: HomePlace): Promise<OwnerProfile>;
}

type Row = {
  userId: string;
  homeCity: string;
  homeLat: number;
  homeLon: number;
  updatedAt: Date;
};

function toDomain(r: Row): OwnerProfile {
  return {
    userId: r.userId,
    home: { city: r.homeCity, lat: r.homeLat, lon: r.homeLon },
    updatedAt: r.updatedAt,
  };
}

export function createOwnerProfileRepository(prisma: PrismaClient): OwnerProfileRepository {
  return {
    async currentForUser(userId) {
      const existing = await prisma.ownerProfile.findUnique({ where: { userId } });
      if (existing) return toDomain(existing as Row);
      /*
       * upsert 而不是 create：两路轮询同时首次读会撞主键。
       */
      const row = await prisma.ownerProfile.upsert({
        where: { userId },
        update: {},
        create: {
          userId,
          homeCity: DEFAULT_HOME.city,
          homeLat: DEFAULT_HOME.lat,
          homeLon: DEFAULT_HOME.lon,
        },
      });
      return toDomain(row as Row);
    },

    async setHome(userId, home) {
      const row = await prisma.ownerProfile.upsert({
        where: { userId },
        update: { homeCity: home.city, homeLat: home.lat, homeLon: home.lon },
        create: { userId, homeCity: home.city, homeLat: home.lat, homeLon: home.lon },
      });
      return toDomain(row as Row);
    },
  };
}
