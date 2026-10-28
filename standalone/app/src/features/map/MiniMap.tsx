/**
 * 地图缩略图（定稿左上）：全程落点的示意——按真实经纬度等比投影，虚线按行程顺序串起，
 * 景点用与大地图同一套编号，住处一个蓝点。它不是第二张地图：不加载瓦片，只说"整程长什么形状"。
 * 右上角的按钮把大地图框回全程。
 */
import type { TripMapStop } from "@cabinhug/ui";

import { Button, Card } from "../../ui";
import s from "./MiniMap.module.css";

const W = 228;
const H = 132;
const PAD = 16;

/** 经纬度 → 缩略图坐标。经度按所在纬度的余弦缩短，否则高纬度的行程会被横向拉宽。 */
export function project(stops: readonly Pick<TripMapStop, "lat" | "lon">[]): Array<{ x: number; y: number }> {
  const pts = stops.map((p) => ({ lat: p.lat!, lon: p.lon! }));
  if (pts.length === 0) return [];
  const lats = pts.map((p) => p.lat);
  const k = Math.cos((((Math.min(...lats) + Math.max(...lats)) / 2) * Math.PI) / 180);
  const xs = pts.map((p) => p.lon * k);
  const minX = Math.min(...xs);
  const maxY = Math.max(...lats);
  const spanX = Math.max(...xs) - minX;
  const spanY = maxY - Math.min(...lats);
  const scale = Math.min((W - 2 * PAD) / (spanX || 1e-9), (H - 2 * PAD) / (spanY || 1e-9));
  // 居中：内容比框窄的那一维两边匀开。
  const offX = (W - spanX * scale) / 2;
  const offY = (H - spanY * scale) / 2;
  return pts.map((p, i) => ({ x: offX + (xs[i]! - minX) * scale, y: offY + (maxY - p.lat) * scale }));
}

export function MiniMap({ stops, onRecenter }: { stops: TripMapStop[]; onRecenter(): void }) {
  const placed = stops.filter((p) => p.lat !== undefined && p.lon !== undefined);
  const pts = project(placed);
  let seq = 0;
  return (
    // data-map-left：大地图取景时让开它（AmapTripLayer 的 fitAvoidFor）。
    <Card variant="float" padding="sm" className={s.card} data-map-left="">
      <header className={s.head}>
        <span className={s.title}>地图缩略图</span>
        <Button variant="ghost" size="sm" icon="expand" label="回到全程" onClick={onRecenter} />
      </header>
      <svg className={s.map} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="全程落点示意">
        <polyline className={s.route} points={pts.map((p) => `${p.x},${p.y}`).join(" ")} />
        {placed.map((stop, i) => {
          const p = pts[i]!;
          if (stop.kind !== "spot") return <circle key={`${stop.kind}-${stop.name}`} className={s.hotel} cx={p.x} cy={p.y} r={5} />;
          seq += 1;
          return (
            <g key={`${stop.day}-${stop.name}`} className={s.spot}>
              <circle cx={p.x} cy={p.y} r={8} />
              <text x={p.x} y={p.y}>
                {seq}
              </text>
            </g>
          );
        })}
      </svg>
    </Card>
  );
}
