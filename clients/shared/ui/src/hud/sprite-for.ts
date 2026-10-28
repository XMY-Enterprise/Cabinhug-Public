/**
 * POI 精灵按 `kind` 语义选图（位于 `clients/shared/ui`，两端共用）。
 *
 * 按 `anchor`（落点）取图会让落在 charge 位的第 2 天景点顶着充电桩图标。
 * 两端共用这一份映射表，保证同一条行程在车机和手机上图标一致。
 */
import type { HudSprites } from "./sprites";

/**
 * 图标按语义选精灵，不按锚位。
 * 多日行程的站点按天序占环位，锚位只是落点，第 2 天的景点落在 charge 位
 * 不该顶着充电桩图标。精灵表的键与锚位同名，这里做一次语义映射。
 */
export const KIND_SPRITE: Record<string, string> = {
  home: "home",
  // 品类级 POI：只按上游给出的语义分类取图；不根据地点名猜测。
  temple: "temple",
  heritage: "temple",
  historic_site: "temple",
  ancestral_temple: "temple",
  park: "park",
  leisure: "park",
  amusement_park: "amusement_park",
  amusement: "amusement_park",
  museum: "museum",
  exhibition: "museum",
  exhibition_hall: "museum",
  mountain: "mountain",
  wetland: "wetland",
  lake: "wetland",
  charging: "charge",
  charge: "charge",
  beach: "beach",
  old_town: "old_town",
  historic_district: "old_town",
  food: "food",
  restaurant: "food",
  hotel: "hotel",
  rest: "hotel",
  nature: "wetland",
  spot: "spot",
};

export function spriteFor(
  sprites: Pick<HudSprites, "poi">,
  node: { anchor: string; kind?: string },
): string {
  return sprites.poi[KIND_SPRITE[node.kind ?? ""] ?? "spot"] ?? sprites.poi.spot;
}

