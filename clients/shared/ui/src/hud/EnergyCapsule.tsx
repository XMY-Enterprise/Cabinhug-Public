/**
 * 出行能量摘要胶囊。
 *
 * Brief §3.2：单条胶囊，始终同时表达预计里程 / 当前能量 / 预计需电量
 * （第三格现为「预计用时」，理由见渲染处的注释）。
 * 中段的"当前能量"是实时读数：电车报剩余电量、油车报剩余油量、
 * 读不到就说读不到（`LiveEnergy` 三支，见契约注释）。
 * 该区域只读；数据更新异常时保留最近有效值及更新时间，且不遮挡生活环或助手。
 * Brief §4：不得展示 VIN、维修档案或任何车辆控制入口。
 */

import type { EnergySummary, LiveEnergy, TripLeg } from "@cabinhug/shared";

/* 从 `metric-text.ts` 引，不从 `StatusBar` 引：后者顶上挂着七张车机切图的 PNG。 */
import { METRIC_UNAVAILABLE, durationLabel } from "./metric-text";

// 契约在 `@cabinhug/shared`（端云唯一真相源）。这里只转出，供
// `import { type EnergySummary } from "@cabinhug/ui"` 使用。
export type { EnergySummary, LiveEnergy };

export interface EnergyCapsuleProps {
  summary: EnergySummary;
  /**
   * 出发地 → 今天第一站的高德驾车规划（与车机屏底状态栏同一份数据）。
   * 「预计里程」「预计用时」两格只认它，缺席显示「暂无」：`summary.distanceKm` 是 mock 快照里的常数。
   */
  leg?: TripLeg;
  /**
   * 拉不到数据（`freshness.stale`：上一跳没连上网关 / 服务没起）。
   * 与车机状态栏同一条（`StatusBar.tsx` 文件头）：里程 / 用时两格的值位改写「服务暂不可用」，
   * 不另浮「数据更新中」。剩余电量那一格不受它影响：它走车辆信号那一路，自己有「读不到」态。
   */
  stale?: boolean;
  /**
   * 最近一次有效更新时间。
   * 目前没有任何地方显示它（见 `stale`）。保留这个 prop 是因为两端都在传；
   * 竖屏那条胶囊没有空位显示它。
   */
  updatedAt?: string;
}

/** 低电/低油的告警阈值。与车机侧的自动补能阈值（10%）拉开，先黄后动作。 */
const LOW_PERCENT = 20;

/**
 * 中段：剩余电量 / 剩余油量。
 *
 * 三支各画各的，不共用一个"百分比"模板，否则燃油车会挂上电池图标。
 */
function LiveMetric({ summary }: { summary: EnergySummary }) {
  const live = summary.live;

  if (live?.kind === "unavailable") {
    return (
      <div className="hud-energy__metric hud-energy__metric--muted" title={live.reason}>
        <svg className="hud-energy__glyph" viewBox="0 0 28 24" aria-hidden="true">
          <rect x="1.5" y="6" width="21" height="12" rx="3.5" fill="none" stroke="var(--hud-text-muted)" strokeWidth="2" />
          <path d="M6 12h12" stroke="var(--hud-text-muted)" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span className="hud-energy__caption">剩余</span>
        {/* 不给数字：读不到就是读不到，写 0 会被当成"快没电了" */}
        <span className="hud-energy__value hud-energy__value--none">读不到</span>
      </div>
    );
  }

  const fuel = live?.kind === "fuel";
  const percent = live ? live.percent : summary.batteryPercent;
  const low = percent <= LOW_PERCENT;
  const tint = low ? "var(--hud-amber)" : "var(--hud-ok)";
  const charging = live?.kind === "battery" && live.charging;

  return (
    <div className={`hud-energy__metric${low ? " is-low" : ""}`}>
      {fuel ? (
        <svg className="hud-energy__glyph" viewBox="0 0 24 24" aria-hidden="true">
          {/* 油枪：与电池轮廓一眼可分，不靠颜色区分（色觉差异下会失效） */}
          <path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16" fill="none" stroke={tint} strokeWidth="2" />
          <path d="M3 21h12" stroke={tint} strokeWidth="2" strokeLinecap="round" />
          <path d="M6 8h6" stroke={tint} strokeWidth="2" strokeLinecap="round" />
          <path d="M14 8h3a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0 3 0v-6" fill="none" stroke={tint} strokeWidth="2" />
        </svg>
      ) : (
        <svg className="hud-energy__glyph" viewBox="0 0 28 24" aria-hidden="true">
          <rect x="1.5" y="6" width="21" height="12" rx="3.5" fill={tint} />
          <rect x="24" y="10" width="3" height="4" rx="1.2" fill={tint} />
          {charging && <path d="M13 8.5 9.5 13h3l-.5 3.5L16 12h-3z" fill="#fff" />}
        </svg>
      )}
      <span className="hud-energy__caption">{fuel ? "剩余油量" : charging ? "充电中" : "剩余电量"}</span>
      <span className="hud-energy__figure">
        <span className="hud-energy__value">{Math.round(percent)}</span>
        <span className="hud-energy__unit">%</span>
      </span>
      {/* 早返回已排除 unavailable，此处 live 必是 battery | fuel */}
      {live && <span className="hud-energy__range">≈{live.rangeKm} km</span>}
    </div>
  );
}

export function EnergyCapsule({ summary, leg, stale }: EnergyCapsuleProps) {
  const road = leg?.road;
  /* 连不上时两格一律走这一态；连得上才谈"这一格有没有数据"。 */
  const down = stale === true;
  return (
    <section
      className={`hud-card hud-energy${stale ? " is-stale" : ""}`}
      aria-label="出行能量摘要"
      aria-readonly="true"
    >
      <div className="hud-energy__metric">
        <svg className="hud-energy__glyph" viewBox="0 0 24 26" aria-hidden="true">
          <path
            d="M12 1.5c-3.6 0-6.5 2.9-6.5 6.5 0 4.7 6.5 12 6.5 12s6.5-7.3 6.5-12c0-3.6-2.9-6.5-6.5-6.5z"
            fill="var(--hud-pin)"
          />
          <circle cx="12" cy="8" r="2.5" fill="#fff" />
          {/* 虚线尾迹：呼应定稿中"路径里程"的语义 */}
          <path
            d="M4 23.5h16"
            fill="none"
            stroke="var(--hud-pin)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray="0.5 4"
            opacity="0.8"
          />
        </svg>
        <span className="hud-energy__caption">预计里程</span>
        {down ? (
          <span className="hud-energy__value hud-energy__value--none hud-energy__value--down">
            {METRIC_UNAVAILABLE}
          </span>
        ) : leg ? (
          <span className="hud-energy__figure">
            <span className="hud-energy__value">{leg.distanceKm}</span>
            <span className="hud-energy__unit">km</span>
          </span>
        ) : (
          <span className="hud-energy__value hud-energy__value--none">暂无</span>
        )}
      </div>

      <span className="hud-energy__sep" aria-hidden="true" />

      <LiveMetric summary={summary} />

      <span className="hud-energy__sep" aria-hidden="true" />

      {/*
        第三格是「预计用时」（与车机状态栏一致），不是「预计需 N%」：
        预计需电量在两端都没有数据源；用时是高德算的。
        路况没有第四格可放，跟在这一格里，但自己占一行，不并进说明：
        一格只有约 100pt，并进说明必折行，会把「高速」与「畅通」拆到两行。
        三行与中间那格同构：说明 / 数值 / 补充（那格是「≈177 km」）。
        「拥堵」走红（红色规则允许的两个判定之一）；缓行走 warn。
      */}
      <div className="hud-energy__metric">
        <svg className="hud-energy__glyph" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" fill="none" stroke="var(--hud-pin)" strokeWidth="2" />
          <path d="M12 7v5l3.5 2" fill="none" stroke="var(--hud-pin)" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span className="hud-energy__caption">预计用时</span>
        {down ? (
          <span className="hud-energy__value hud-energy__value--none hud-energy__value--down">
            {METRIC_UNAVAILABLE}
          </span>
        ) : leg ? (
          <span className="hud-energy__figure">
            <span className="hud-energy__value">{durationLabel(leg.durationMin)}</span>
          </span>
        ) : (
          <span className="hud-energy__value hud-energy__value--none">暂无</span>
        )}
        {!down && road && (
          <span
            className={`hud-energy__road${road.status === "拥堵" ? " is-jam" : road.status === "缓行" ? " is-slow" : ""}`}
          >
            {road.label} · {road.status}
          </span>
        )}
      </div>
    </section>
  );
}
