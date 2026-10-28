/**
 * 右上天气：「☁ 杭州 有雨」。只读行程快照里与行前物品同一次算出的那份天气（`plan.weather`），
 * 没有就不显示——不在这里另查一次。快照里没有气温，所以不写度数。来源按 ACR-052 署在旁边。
 */
import type { TripPlanSnapshot } from "@cabinhug/shared";

import { Icon, type IconName } from "../../ui";
import s from "./WeatherChip.module.css";

const ICON: Record<string, IconName> = {
  sunny: "sun",
  cloudy: "cloud",
  overcast: "cloud",
  rain: "cloud-rain",
  snow: "cloud",
  haze: "cloud",
};

export function WeatherChip({ city, weather }: { city: string; weather: NonNullable<TripPlanSnapshot["weather"]> }) {
  return (
    <div className={s.chip} title={weather.source ? `天气来源：${weather.source.name}` : undefined}>
      <Icon name={ICON[weather.kind] ?? "cloud"} className={s.icon} />
      <span className={s.city}>{city}</span>
      <span>{weather.label}</span>
      {weather.source && <span className={s.source}>{weather.source.name}</span>}
    </div>
  );
}
