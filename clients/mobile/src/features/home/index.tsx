/**
 * 手机端主页 = 功能入口页（设计 UI-01 v1.1）。
 *
 * 主页不是行程地图页：行程规划是二级页（`features/trip/secondary.tsx`），
 * 与「拍照问诊」平级摆在暖暖脚下。这一页是普通竖向流式页（设计系统 §6：除 HUD 舞台外一律 pt 流式），
 * 与设置页同一种页壳，不进 `HudStage` 的绝对定位坐标系；AssistantDock 与入口行的布局约束
 * 在 `features/hud/index.tsx`，那是二级页的内容。
 *
 * 三条红线：
 *  - 没有麦克风、没有「长按说话」、没有音波：主页不提供语音入口。
 *    暖暖的 dock 卡由 CSS 隐藏，点她只进对话层。
 *  - 除底导选中态外没有实心橙：两张入口卡等大等重，都不是主行动。
 *  - 组件不 `invoke`、不 `fetch`：数据全部由 props 进（与 `MobileHud` 一致）。
 */

import type { ReactNode } from "react";
import type { AssistantState, LiveEnergy } from "@cabinhug/shared";
import { AssistantDock, MapBackdrop, SPRITES, type ThemeName } from "@cabinhug/ui";

import {
  DEFAULT_REMINDER,
  DEFAULT_REMINDER_NO_PHOTO,
  consultStatus,
  energyValue,
  greetingFor,
  odometerValue,
  serviceValue,
  tripsStatus,
  vehicleLine,
  type HomeVehicle,
  type VehicleReadState,
} from "./model";

/*
 * 两张入口卡的插画：从定稿
 * `内部文档` 上裁下来的两个圆盘
 * （356px，含浅橙 / 浅蓝底）。与暖暖立绘一致，素材从定稿取，不由代码画。
 */
import entryDiagnosisArt from "./assets/entry-diagnosis.png";
import entryTripsArt from "./assets/entry-trips.png";

import "./home.css";

export type { HomeVehicle, VehicleReadState } from "./model";
export { isHomeDemo, DEMO_HOME_VEHICLE, DEMO_HOME_TRIP_COUNT, DEMO_HOME_REMINDER } from "./demo";

export interface HomeReminder {
  title: string;
  body: string;
  linkLabel?: string;
  onLink?: () => void;
}

export interface MobileHomeProps {
  theme: ThemeName;
  assistantState: AssistantState;
  assistantMode?: "rest" | "work";
  /** 只挂 tap（进对话层）。长按说话的手势不挂：主页不提供语音入口。 */
  assistantGestureProps?: Record<string, unknown>;
  onAssistantDismiss?: () => void;
  vehicle?: HomeVehicle | null;
  /** 与 `loadVehicles()` 三态同名；浏览器预览是 `offline`。 */
  vehicleState: VehicleReadState;
  /** 缺席 = 读不到（与 `unavailable` 同一表现）。 */
  energy?: LiveEnergy;
  tripCount: number;
  /** 暖暖脚下那张卡；缺席用 `DEFAULT_REMINDER`（拍照问诊关闭时用 `DEFAULT_REMINDER_NO_PHOTO`），不编一条。 */
  reminder?: HomeReminder;
  /** 缺席 = 拍照问诊关闭（ACR-057），不渲染那张卡，行程卡占满一行。 */
  onOpenDiagnosis?: () => void;
  onOpenTrips: () => void;
  /** 铃铛；不给不渲染。 */
  onOpenReminders?: () => void;
  /** 本地小时（测试注入）。 */
  hour?: number;
}

function BellGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </svg>
  );
}

function BatteryGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="2.5" y="7" width="17" height="10" rx="2.5" />
      <path d="M21.5 10.5v3" />
    </svg>
  );
}

function OdometerGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 15a8 8 0 0 1 16 0" />
      <path d="M12 15l3.5-4.5M3 19h18" />
    </svg>
  );
}

function WrenchGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M14.5 4.5a4 4 0 0 0-4.6 5.6L4 16l4 4 5.9-5.9a4 4 0 0 0 5.6-4.6l-2.6 2.6-2.4-2.4z" />
    </svg>
  );
}

function StripCell({ icon, caption, value, unit, muted }: { icon: ReactNode; caption: string; value: string; unit?: string; muted: boolean }) {
  return (
    <div className="mh-strip__cell">
      <span className="mh-strip__caption">
        {icon}
        {caption}
      </span>
      <span className={`mh-strip__value${muted ? " is-muted" : ""}`}>
        {value}
        {unit && <span className="mh-strip__unit">{unit}</span>}
      </span>
    </div>
  );
}

export function MobileHome({
  theme,
  assistantState,
  assistantMode,
  assistantGestureProps,
  onAssistantDismiss,
  vehicle,
  vehicleState,
  energy,
  tripCount,
  reminder,
  onOpenDiagnosis,
  onOpenTrips,
  onOpenReminders,
  hour,
}: MobileHomeProps) {
  const sprites = SPRITES[theme];
  // 拍照问诊关闭时（`onOpenDiagnosis` 缺席，ACR-057）缺省文案不再说「拍给我看」。
  const r: HomeReminder = reminder ?? (onOpenDiagnosis ? DEFAULT_REMINDER : DEFAULT_REMINDER_NO_PHOTO);
  const trips = tripsStatus(tripCount);
  const en = energyValue(energy);
  const od = odometerValue(vehicleState, vehicle);
  const sv = serviceValue(
    vehicleState === "ready" && vehicle?.forecastRemainingKm !== undefined ? { remainingKm: vehicle.forecastRemainingKm } : undefined,
  );

  return (
    <div className="mh" data-theme={theme}>
      {/* 街道纹理只作气质（登录门同款零依赖舞台），压得很淡、不接事件、没有地名图钉。 */}
      <div className="mh-stage" aria-hidden="true">
        <MapBackdrop />
      </div>

      <div className="mh-scroll">
        <header className="mh-head">
          <div>
            <h1 className="mh-greeting">{greetingFor(hour ?? new Date().getHours())}</h1>
            <p className="mh-vehicle">{vehicleLine(vehicleState, vehicle)}</p>
          </div>
          {onOpenReminders && (
            <button type="button" className="mh-bell" onClick={onOpenReminders} aria-label="提醒">
              <BellGlyph />
            </button>
          )}
        </header>

        <section className="mh-hero" aria-label="暖暖">
          {/*
           * 两行提示语都传空串：dock 自带的卡在本页由 CSS 隐藏（它带着音波与「长按说话」），
           * 提示内容在右边的提醒卡里。`secondaryLabel=""` 让次行连分隔线一起不渲染。
           */}
          <AssistantDock
            sprite={sprites.assistant}
            workingSprite={sprites.assistantWorking}
            state={assistantState}
            mode={assistantMode}
            gestureProps={assistantGestureProps}
            onDismiss={onAssistantDismiss}
            primaryLabel=""
            secondaryLabel=""
          />
          <div className="mh-bubble" role="note">
            <b className="mh-bubble__title">{r.title}</b>
            <p className="mh-bubble__body">{r.body}</p>
            {r.linkLabel && r.onLink && (
              <button type="button" className="mh-bubble__link" onClick={r.onLink}>
                {r.linkLabel}
              </button>
            )}
          </div>
        </section>

        <p className="mh-label">你可以</p>

        {/* 两张卡等大等重：同一个类、grid 两等分、谁都不是实心橙。拍照问诊关闭时只剩行程卡，占满一行。 */}
        <div className={onOpenDiagnosis ? "mh-entries" : "mh-entries mh-entries--single"}>
          {onOpenDiagnosis && (
            <button type="button" className="mh-entry" data-entry="diagnosis" onClick={onOpenDiagnosis}>
              <img className="mh-entry__art" src={entryDiagnosisArt} alt="" aria-hidden="true" draggable={false} />
              <b className="mh-entry__title">拍照问诊</b>
              {/* 同上：半张卡放不下「仪表警示灯 · …」15 字，去掉「仪表」，不缩字。 */}
              <span className="mh-entry__sub">警示灯 · 轮胎 · 漏液 · 车身</span>
              <span className="mh-entry__status">
                <i className="mh-dot" aria-hidden="true" />
                {consultStatus(vehicleState === "ready" ? vehicle?.lastConsultAt : undefined, vehicleState === "ready" ? vehicle?.lastConsultLevel : undefined)}
              </span>
            </button>
          )}
          <button type="button" className="mh-entry" data-entry="trips" onClick={onOpenTrips}>
            <img className="mh-entry__art" src={entryTripsArt} alt="" aria-hidden="true" draggable={false} />
            <b className="mh-entry__title">行程规划</b>
            {/* 390 宽的半张卡放不下「· 沿途停靠」（12pt × 14 字 > 153pt），减一个词，不缩字。 */}
            <span className="mh-entry__sub">多天行程 · 景点 · 住宿</span>
            <span className="mh-entry__status">
              {trips.label}
              {trips.count !== undefined && (
                <>
                  {" · "}
                  <em className="mh-count">{trips.count}</em> 程
                </>
              )}
            </span>
          </button>
        </div>

        {/* 车况条：三格讲的是这辆车（电量 / 表显里程 / 距下次保养），不是"这一程"；行程胶囊在行程页。 */}
        <div className="mh-strip" aria-label="车况">
          <StripCell icon={<BatteryGlyph />} caption={en.caption} value={en.value} unit={en.unit} muted={en.muted} />
          <StripCell icon={<OdometerGlyph />} caption="表显里程" value={od.value} unit={od.unit} muted={od.muted} />
          <StripCell icon={<WrenchGlyph />} caption={sv.caption} value={sv.value} unit={sv.unit} muted={sv.muted} />
        </div>
      </div>
    </div>
  );
}
