/**
 * 地点配图：品类贴纸（与地图标记同一套 3D 贴纸）摆在一块天空渐变上。
 *
 * 行程快照里没有照片，这里也不去找：贴纸只说"这是一处古街 / 公园"，不冒充这个地方长什么样。
 * 三档尺寸：缩略（时间轴行首）、主图（景点详情）、封面（全屏天卡）。
 */
import { SPRITES } from "@cabinhug/ui";

import { cx } from "./cx";
import s from "./PoiArt.module.css";

export function PoiArt({ kind, size = "thumb" }: { kind: string | undefined; size?: "thumb" | "hero" | "cover" }) {
  const poi = SPRITES.light.poi;
  const src = (kind && poi[kind]) || poi.spot;
  return (
    <span className={cx(s.art, s[size])} aria-hidden="true">
      <img src={src} alt="" className={s.sticker} draggable={false} />
    </span>
  );
}
