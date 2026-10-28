/**
 * 「开车去档案」过场（主页 → 档案）。
 *
 * # 它盖住的是一次真实的等待
 *
 * 档案页一挂载就去拉车辆列表与用量，冷启动要等网关往返。只显示一行
 * `正在读取…` 时，车机上看起来像"点了没反应"。这一层把等待变成一段有去向的路程：
 * 车从左边开进来、一直在开，档案准备好了它就开出右边，页面已经在后面就位。
 *
 * # 开的是车主自己那辆车
 *
 * 档案页讲的就是这辆车，`vehicleCharacter` 取到的是这辆车的形象，不需要文案解释。
 * 匹配不到车型时不拿别款车顶替（同 `profile-characters.ts` 的规则），
 * 退回一个中性剪影，不让用户以为系统认错了车。
 *
 * # 三段式，中段可以无限长
 *
 * `enter`（开进来）→ `cruise`（一直开，等数据）→ `leave`（加速开走）。
 * 中段是循环的，加载多久都能衔接：路面一直在往后退，车一直在开。
 * 固定时长的动画在数据慢时还得在结束后再补一个"正在读取…"。
 *
 * # 兜底：不把人锁在过场里
 *
 * 数据一直不回来（网关不可达、Wi-Fi 断开）时，`MAX_CRUISE_MS` 到点强制放行，
 * 由档案页展示加载失败。开不完的动画看起来像死机。
 */

import { useEffect, useRef, useState } from "react";
import { vehicleCharacter, type CharacterTheme } from "@cabinhug/ui";

import "./drive-transition.css";

/** 开进来用多久。比 300ms 长才看得出是"开"进来的，比 700ms 长就开始嫌慢。 */
const ENTER_MS = 520;
/** 开走用多久。比进场略短：加速离场，收尾利落。 */
const LEAVE_MS = 420;
/**
 * 巡航段的等待上限。超过它就放行，让档案页自己去说它加载不出来。
 * 3 秒是"还在等"与"是不是坏了"的分界。
 */
const MAX_CRUISE_MS = 3000;
/**
 * 巡航段的最短时长。数据来得比动画快时（热缓存）也要跑完这一小段，
 * 否则车刚进画面就被抽走，看起来像闪了一下。
 */
const MIN_CRUISE_MS = 240;

export interface DriveTransitionProps {
  /** 目的地页面是否已经就绪；`true` 之后过场才进入离场段。 */
  ready: boolean;
  theme: CharacterTheme;
  /** 车型名（`Vehicle.model`）。取不到就画中性剪影。 */
  model?: string;
  /** 离场动画放完后调用，调用方据此卸载本层。 */
  onDone: () => void;
}

type Phase = "enter" | "cruise" | "leave";

/**
 * `?drive=hold`：把过场停在巡航段不放走，供版式预览与截图（同 `?profile=demo`）。
 *
 * 动画中段只有几百毫秒，截图抓不住。它只延长等待，不改变任何画面，
 * 看到的就是真实巡航段。
 */
function isDriveHold(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("drive") === "hold";
}

export function DriveTransition({ ready, theme, model, onDone }: DriveTransitionProps) {
  const [phase, setPhase] = useState<Phase>("enter");
  const car = vehicleCharacter(model, theme);
  // 巡航开始的时刻。`ready` 早于进场结束时，最短巡航要从进场结束算起。
  const cruiseFrom = useRef<number>(0);

  // enter → cruise：进场是固定时长，跑完就转。
  useEffect(() => {
    if (phase !== "enter") return;
    const t = setTimeout(() => {
      cruiseFrom.current = Date.now();
      setPhase("cruise");
    }, ENTER_MS);
    return () => clearTimeout(t);
  }, [phase]);

  // cruise → leave：数据到了（且巡航够久）就走；一直不来则到上限强制走。
  useEffect(() => {
    if (phase !== "cruise") return;
    if (isDriveHold()) return; // 预览模式：停在这一段

    const elapsed = Date.now() - cruiseFrom.current;
    const wait = ready ? Math.max(0, MIN_CRUISE_MS - elapsed) : MAX_CRUISE_MS - elapsed;
    const t = setTimeout(() => setPhase("leave"), Math.max(0, wait));
    return () => clearTimeout(t);
  }, [phase, ready]);

  /*
   * leave → 卸载。
   *
   * `onDone` 走 ref、不进依赖：调用方传的是内联箭头，父组件每重渲染一次
   * 它就换一个身份，进了依赖就会清掉定时器重排。父组件在流式回答期间
   * 每个 token 都重渲染，比 420ms 频繁得多，定时器会一直排不到头，遮罩卸不掉。
   */
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (phase !== "leave") return;
    const t = setTimeout(() => onDoneRef.current(), LEAVE_MS);
    return () => clearTimeout(t);
  }, [phase]);

  return (
    <div className={`drivet drivet--${phase}`} role="presentation" aria-hidden="true">
      {/* 远景：一条地平线 + 往后掠的光带，给"在往前开"一个参照 */}
      <div className="drivet__sky" />
      <div className="drivet__road">
        <div className="drivet__dashes" />
      </div>

      <div className="drivet__stage">
        <div className="drivet__streaks">
          <span />
          <span />
          <span />
        </div>
        <div className="drivet__car">
          {car ? (
            <img className="drivet__car-art" src={car} alt="" />
          ) : (
            <CartoonCar />
          )}
          <span className="drivet__car-shadow" />
        </div>
      </div>

      {/*
        文案只说去向，不说进度：加载只是两个并发请求，没有可数的阶段。
      */}
      <p className="drivet__label">正在打开车辆档案</p>
    </div>
  );
}

/**
 * 兜底卡通车。
 *
 * 匹配不到车型时画它，不拿别款车的实拍形象顶替（`profile-characters.ts`
 * 的规则：顶替会让用户以为系统认得这辆车）。它画得像"一辆车"而不是某款车：
 * 圆角车身、大车窗、粗轮胎的简笔画。
 *
 * 轮子单独成组以便旋转：不转的轮子配上会动的路面，看起来像车在被拖着走。
 * 颜色全走主题 token（`currentColor` 与 hud 变量），深浅两套主题共用这一份。
 */
function CartoonCar() {
  return (
    <svg className="drivet__car-svg" viewBox="0 0 220 96" role="img" aria-hidden="true">
      {/* 车身：一条封闭路径，前低后高，车头在右（车往右开） */}
      <path
        className="drivet__svg-body"
        d="M14 74c-6 0-9-3-9-9v-13c0-7 5-12 12-14l28-8 20-14c4-3 8-4 13-4h44c6 0 11 2 15 7l14 15 43 7c8 1 13 7 13 15v9c0 5-3 9-9 9z"
      />
      {/* 车窗：两块，中间留 B 柱；一整块玻璃会让它看起来像面包车 */}
      <path className="drivet__svg-glass" d="M74 25h32v22H56z" />
      <path className="drivet__svg-glass" d="M114 25h18c3 0 5 1 7 3l14 19h-39z" />
      {/* 车灯：车头一点暖光，给方向一个额外线索 */}
      <circle className="drivet__svg-lamp" cx="196" cy="58" r="6" />
      {/* 轮子：轮胎 + 轮毂，轮毂里三根辐条才看得出在转 */}
      <g className="drivet__svg-wheel" style={{ transformOrigin: "62px 74px" }}>
        <circle className="drivet__svg-tyre" cx="62" cy="74" r="18" />
        <circle className="drivet__svg-hub" cx="62" cy="74" r="8" />
        <path className="drivet__svg-spoke" d="M62 66v16M55 70l14 8M55 78l14-8" />
      </g>
      <g className="drivet__svg-wheel" style={{ transformOrigin: "164px 74px" }}>
        <circle className="drivet__svg-tyre" cx="164" cy="74" r="18" />
        <circle className="drivet__svg-hub" cx="164" cy="74" r="8" />
        <path className="drivet__svg-spoke" d="M164 66v16M157 70l14 8M157 78l14-8" />
      </g>
    </svg>
  );
}
