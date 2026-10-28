/**
 * 卡通助手英雄区（静态形态；手势由调用方挂载）
 *
 * Brief §3.4：左下角毛绒 AI 助手是界面的视觉 Key 和唯一主交互。
 *  - 含底座的英雄区约占 22–25% 画布宽、34–40% 画布高，主体大于任一地点缩略图；
 *  - 点击进入对话层，长按按住说话；
 *  - 音波仅在聆听/说话时轻度变化，不抢占地图或卡片；
 *  - 五态状态机，且不显示模型思考过程。
 */

// AssistantState 唯一来源为 @cabinhug/shared（Rust 契约生成）；此处保留 re-export 兼容既有导入。
import type { AssistantState } from "@cabinhug/shared";
export type { AssistantState };

/**
 * 休息 / 办公：与五态正交的另一根轴。
 *
 * 五态说的是"这一刻在干什么"（听/想/说），这根轴说的是"在不在这段对话里"：
 * 没有进行中的会话就是休息，车主开口之后就是办公。办公中仍然有那五态。
 *
 * 不放进 `AssistantState`：它是 Rust 契约的生成物，而且两根轴会相乘（十种组合）。
 */
export type AssistantMode = "rest" | "work";

export interface AssistantDockProps {
  /** 助手精灵（按主题 + 天气服饰传入）。休息形象。 */
  sprite: string;
  /** 办公形象。缺省时 `mode="work"` 退回休息图。 */
  workingSprite?: string;
  state: AssistantState;
  /** 休息 / 办公。未知值回落 `rest` 且不抛错（F-01-01 的边界规则）。 */
  mode?: AssistantMode;
  /** 主提示语，默认「点击对话」。 */
  primaryLabel?: string;
  /** 次提示语，默认「长按说话」。 */
  secondaryLabel?: string;
  /** 供调用方挂载点击/长按手势。 */
  gestureProps?: Record<string, unknown>;
  /**
   * 点一下助手会不会进对话层（默认 true）。
   *
   * 车机端传 false：触屏上「点一下」与「长按说话」抢同一块区域，press 稍短
   * 就翻去对话页，进对话因此收归底部导航的「对话」按钮独占。
   * 这个 prop 只决定提示语；实际行为由 `useAssistantInteraction`
   * 收不收 `onOpenDialog` 决定。两处须一致，否则界面会写着一句做不到的事。
   */
  tapOpensDialog?: boolean;
  /**
   * 点一下会不会打断（车机端传 true）。
   *
   * 与 `tapOpensDialog` 互斥：一块区域只能有一个短按含义，
   * 所以 `tapOpensDialog` 为真时本 prop 被忽略（进对话是调用方显式要的行为，优先）。
   * 它只在 `speaking` / `thinking` 时改变提示语：其余状态点一下什么都不做，
   * 不应提示「点一下打断」。
   */
  tapInterrupts?: boolean;
  /**
   * 点「退下」：结束这段对话。
   *
   * 不给回调就不渲染这个按钮，避免出现点了没反应的按钮。
   */
  onDismiss?: () => void;
  /**
   * 紧凑胶囊形态（新版车机 UI）：卡片收成一行——麦克风图标 + 状态文案 + 音波，
   * 次行提示语不再渲染（那一行在胶囊里放不下；它说的事在 aria-label 里仍然念得出）。
   * 手机端不传，维持原来的两行卡。
   */
  compact?: boolean;
  /**
   * 暖暖身旁的对话气泡（新版车机 UI 定稿：「说说 你的下一段旅程吧！」）。
   * 只在传了文字时渲染；什么状态下说这句由调用方决定。
   */
  bubble?: string;
}

const STATE_TEXT: Record<AssistantState, string> = {
  idle: "点击对话",
  listening: "正在聆听…",
  thinking: "正在准备…",
  speaking: "正在回答…",
  alert: "有一条提醒",
};

/** 音波竖杠的 [x, 高度]，中间高两侧低；viewBox 24 高，居中对称。 */
const WAVE_BARS: ReadonlyArray<readonly [number, number]> = [
  [2, 8],
  [8, 14],
  [14, 20],
  [20, 14],
  [26, 8],
];

export function AssistantDock({
  sprite,
  workingSprite,
  state,
  mode = "rest",
  primaryLabel,
  secondaryLabel,
  gestureProps,
  tapOpensDialog = true,
  tapInterrupts = false,
  onDismiss,
  compact = false,
  bubble,
}: AssistantDockProps) {
  const wave = state === "listening" || state === "speaking";
  // idle 的默认主提示与"点一下会怎样"绑死：tapOpensDialog=false 时还写
  // 「点击对话」就是一句做不到的指示。
  const idleLabel = tapOpensDialog ? STATE_TEXT.idle : "长按说话";
  /*
   * 她正在说 / 正在想，而这台端上点一下就是打断：在提示语里写明，
   * 让车主知道点一下能让她停。
   */
  const interruptible =
    tapInterrupts && !tapOpensDialog && (state === "speaking" || state === "thinking");
  /*
   * 次行默认是「长按说话」。tapOpensDialog=false 时主行已经是这句，
   * 再来一遍就重复了，那时默认收掉，调用方仍可显式覆盖。
   *
   * 「点一下打断」放次行而不是接在主行后面，否则在车机卡片上必然折行。
   * 尺寸（单位 = hud-unit）：卡片右侧的音波圆片占掉右边 87，文字居中排，
   * 所以主行不碰音波的上限约 200，而「正在回答…」自己就 170，
   * 提示语放不进同一行。卡片是"状态一行 + 细线 + 小号灰字一行"
   * 的形态，提示语落在第二行（120 宽）。
   */
  const secondary =
    secondaryLabel ?? (tapOpensDialog ? "长按说话" : interruptible ? "点一下打断" : "");
  // 未知值回落 rest：这个 prop 会从 App 层的派生值传下来，
  // 传错一个字符串不该让整屏 HUD 白掉（F-01-01 的边界规则）。
  const working = mode === "work";
  // 办公图没给就退回休息图：少一张图的后果只是形象没变，
  // 而 `<img src={undefined}>` 会在角色位置留一个碎图标。
  const shown = working && workingSprite ? workingSprite : sprite;
  // 只在办公中、且真有人接这个动作时才渲染按钮。
  const dismissable = working && typeof onDismiss === "function";

  return (
    <div
      className={`hud-assistant${compact ? " hud-assistant--compact" : ""}`}
      data-state={state}
      data-mode={working ? "work" : "rest"}
    >
      {/* 气泡挂在英雄区外面：它不接手势，点它不该算作点了暖暖。 */}
      {bubble && (
        <span className="hud-assistant__bubble" role="note">
          {bubble}
        </span>
      )}
      <div
        className="hud-assistant__hero"
        role="button"
        tabIndex={0}
        aria-label={
          tapOpensDialog
            ? `${STATE_TEXT[state]}，点击进入对话，长按说话`
            : interruptible
              ? `${STATE_TEXT[state]}，点一下打断，长按说话`
              : `${STATE_TEXT[state]}，长按说话`
        }
        {...gestureProps}
      >
        {/* 定稿的「放大镜」底环：一圈亮环 + 内侧柔光，把角色从地图上摘出来。
            没有它时角色直接压在路网上，浅色底图下轮廓会糊掉。 */}
        <span className="hud-assistant__halo" aria-hidden="true" />
        {/* draggable=false 与 hud.css 的 -webkit-user-drag 双保险：防止长按后拖走精灵图。 */}
        <img className="hud-assistant__sprite" src={shown} alt="" aria-hidden="true" draggable={false} />

        {/*
         * 「退下」：结束这段对话。
         *
         * 贴在底环右上角。`stopPropagation` 不能省：它套在 hero 里面，
         * 而 hero 自己挂着"点击进入对话 / 长按说话"的手势，不拦住的话
         * 点退下会顺带把对话层拉起来。
         */}
        {dismissable && (
          <button
            type="button"
            className="hud-assistant__dismiss"
            aria-label="退下，结束这段对话"
            /*
             * 整个 pointer 序列都要拦，不能只拦 pointerdown。
             *
             * 事件顺序是 pointerdown → pointerup → click。只拦 down 时，
             * up 冒泡到 hero，hero 的手势在 pointerup 上判"短按 = 进对话"，
             * 一进对话本按钮就被卸载，后面的 click 送不到，`onDismiss` 不会执行。
             */
            onClick={(e) => {
              e.stopPropagation();
              onDismiss!();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onPointerUp={(e) => e.stopPropagation()}
          >
            退下
          </button>
        )}
      </div>

      <div
        className="hud-card hud-assistant__card"
      >
        {/* 两行文案在卡内水平居中（定稿 §3.4）。音波不参与这个居中：
            它绝对定位贴右边，否则 flex 行会把文字挤到左侧，看起来像没对齐。 */}
        {/* 紧凑形态在文案前带一枚麦克风：定稿里这枚图标就是"长按说话"的视觉锚。 */}
        {compact && (
          <svg className="hud-assistant__mic" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
            <rect x="8.5" y="2.5" width="7" height="12" rx="3.5" stroke="currentColor" strokeWidth="1.9" />
            <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5M8.5 21.5h7" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
        )}
        {/* 主行只放状态，不接任何提示语，否则折行（见上面 `secondary` 的尺寸）。 */}
        <span className="hud-assistant__primary">
          {primaryLabel ?? (state === "idle" ? idleLabel : STATE_TEXT[state])}
        </span>
        {/* 次行为空时连分隔线一起收掉：一条底下没有内容的横线看着像没加载完。
            紧凑胶囊没有第二行，次行整个不渲染。 */}
        {!compact && secondary !== "" && (
          <>
            <div className="hud-assistant__rule" />
            <span className="hud-assistant__secondary">{secondary}</span>
          </>
        )}

        <span className={`hud-assistant__wave${wave ? " is-active" : ""}`} aria-hidden="true">
          {/* 音波：中间高两侧低的对称波形（定稿的语音标识）。
              竖杠数量与高度差是它读起来像"声音"而不像"信号格"的原因，
              改动时保持对称、保持圆头。

              # 为什么是 5 个 <span> 而不是一张 SVG 里的 5 个 <rect>

              竖杠是逐根缩放的，这种动画 WebKit 不会给 SVG 子元素单独的
              合成层：每一帧都要把整张 SVG 重新栅格化并连带整页重绘。
              用 SVG 时这枚 34×24 的小图标让 iPad 模拟器的渲染栈从 4% 升到 87%；
              换成 HTML 元素后约 30%，即模拟器跑任何 60fps 动画的底线。
              桌面端是原生通路，同一处只有个位数百分点，不能用桌面端读数判断这里的开销。

              坐标全部按原 viewBox（34 × 24）折成百分比，所以三处断点里改
              `.hud-assistant__wave-icon` 的宽高仍然照旧生效。 */}
          <span className="hud-assistant__wave-icon" aria-hidden="true">
            {WAVE_BARS.map(([x, h], i) => (
              <span
                key={x}
                className="hud-assistant__wave-bar"
                style={{
                  left: `${(x / 34) * 100}%`,
                  top: `${((12 - h / 2) / 24) * 100}%`,
                  height: `${(h / 24) * 100}%`,
                  animationDelay: `${i * 0.09}s`,
                }}
              />
            ))}
          </span>
        </span>
      </div>
    </div>
  );
}
