/**
 * 助手交互与状态机。
 *
 * Brief §3.4：点击进入对话层；长按按住说话（push-to-talk），松手即发送。
 * 五态：idle / listening / thinking / speaking / alert。不显示模型思考过程。
 *
 * 语音能力属 Rust 侧职责（clients/cockpit/src-tauri/src/voice），前端只依赖
 * AssistantVoicePort 接口；本文件提供 mock 实现，真实实现经 `voice` 参数注入。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantState } from "../assistant-avatar/AssistantDock";

/** 判定为长按的阈值。低于此值视为点击（进入对话层）。 */
export const LONG_PRESS_MS = 350;

/**
 * 点击防抖：短时间连点只触发一次进入对话。车机上手抖/颠簸连点常见，
 * 连触发会来回切层闪屏。取值盖住双击（~300ms）与颠簸连点。
 */
export const OPEN_DEBOUNCE_MS = 600;

export interface AssistantVoicePort {
  startPushToTalk(): Promise<void>;
  stopPushToTalk(): Promise<void>;
}

/**
 * Mock 语音端口：仅驱动状态流转，不做真实录音。
 *
 * stopPushToTalk 刻意保留一段处理延迟：若立即 resolve，thinking 态会在同一个
 * 微任务里被跳过，界面上看不到"正在准备"。真实实现的延迟来自录音收尾与
 * 上行请求，这里用固定值模拟。
 */
export const MOCK_PROCESSING_MS = 700;

export const mockVoicePort: AssistantVoicePort = {
  async startPushToTalk() {},
  async stopPushToTalk() {
    await new Promise((r) => setTimeout(r, MOCK_PROCESSING_MS));
  },
};

export interface AssistantInteractionApi {
  state: AssistantState;
  gestureProps: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerLeave: (e?: React.PointerEvent) => void;
    onPointerCancel: (e?: React.PointerEvent) => void;
    onKeyDown: (e: React.KeyboardEvent) => void;
  };
}

/** `leaveShouldCancel` 的输入：这一下 leave 到来时，手势处在什么状态。 */
export interface LeaveContext {
  /** 元素此刻还握着这个 pointer 的捕获（`hasPointerCapture`）。 */
  captured: boolean;
  /** 长按计时器还在走（按下了、还没到 350ms）。 */
  timerPending: boolean;
  /** 已经判成长按、正在录音。 */
  longPress: boolean;
}

/**
 * 收到 `onPointerLeave` 时，要不要把这次长按取消掉。
 *
 * # 不能见 leave 就取消
 *
 * iOS WebKit 上：`pointerdown` 落在 `<img>` 精灵上 → 对 hero 调 `setPointerCapture` →
 * 捕获在下一个 pointer 事件（第一次 `pointermove`）才生效，WebKit 此时把事件
 * 目标从精灵换到 hero，并补发一个 `pointerout`（精灵）+ `pointerover`（hero）。
 * 这个 `pointerout` 的 `relatedTarget` 是空的，React 据此认为"指针离开了整个文档"，
 * 把 `onPointerLeave` 合成到 hero 上，而浏览器并没有发 `pointerleave`
 * （原生 `pointerleave` 直到松手才来）。见 leave 就取消的话，手指轻微挪动就会
 * 清掉长按计时器或停掉录音。桌面鼠标按住不动没有 move，不会触发。
 *
 * 判据用物理事实而不是猜 React 的合成规则：捕获还在手上，指针就不可能真的
 * 离开，这样的 leave 一律是假的。捕获已丢（`pointercancel` 之后、或一开始就没
 * 捕获成功）时，leave 才是真的移出。
 *
 * # 没有进行中的按压就没有什么可取消
 *
 * 松手后 WebKit 还会补一个 `pointerout` → React 再合成一次 leave；此时若
 * `setLocal(null)`，会把刚设上的「正在准备…」清掉，thinking 态显示不出来。
 */
export function leaveShouldCancel({ captured, timerPending, longPress }: LeaveContext): boolean {
  if (captured) return false;
  return timerPending || longPress;
}

/** 元素是否还握着这个 pointer 的捕获；没有事件 / 老浏览器没有这个 API 都按「没有」算。 */
function stillCaptured(e: React.PointerEvent | undefined): boolean {
  try {
    return e?.currentTarget?.hasPointerCapture?.(e.pointerId) === true;
  } catch {
    return false;
  }
}

export interface UseAssistantOptions {
  /**
   * 点击 → 进入对话层。HUD 内不执行任何有后果的动作（Brief §7-6）。
   *
   * 不给就没有"点击进对话"这条路：触屏上「点一下」与「长按说话」共用同一块区域，
   * press 稍短就被判成点击，车主想说话、屏幕却翻去了对话页。车机端因此把进对话
   * 收归底部导航的「对话」按钮独占，助手身上只留长按说话。
   * 手机端仍然传它：那边助手不是唯一入口，两种手势并存没有这个问题。
   */
  onOpenDialog?: () => void;
  /**
   * 短按（不是长按）时触发。车机端用它做打断。
   *
   * # 挂在这里，而不是在 HUD 上另写一套 pointer 逻辑
   *
   * 「这一下是不是长按」的判定只有这个 hook 有（`LONG_PRESS_MS` 计时器 +
   * `isLongPress`）。在外面另写一套的话，每次长按说话结束都会顺带触发一次
   * 短按回调，说完话还被打断一次。这块区域的手势容易冲突（例如 iPad 上长按
   * 会弹出 iOS 图片菜单），只保留这一处手势判定。
   *
   * 与 `onOpenDialog` 并存：两者都在短按分支里跑，各管各的。
   * 共用同一个防抖窗口：车机颠簸连点常见。
   */
  onTap?: () => void;
  voice?: AssistantVoicePort;
  /**
   * 这次长按为什么没录成。
   *
   * 只把形象放回 idle 会吞掉原因：车主看到「正在聆听」闪一下又变回「长按说话」，
   * 屏幕上没有任何交代，排障时也无从定位。
   *
   * 不给这个回调时只把形象放回 idle（手机端未接）。
   */
  onVoiceError?: (reason: string) => void;
  /** 外部（数据源）驱动的状态，例如 alert；本地交互态优先。 */
  externalState?: AssistantState;
}

export function useAssistantInteraction({
  onOpenDialog,
  onTap,
  voice = mockVoicePort,
  onVoiceError,
  externalState = "idle",
}: UseAssistantOptions): AssistantInteractionApi {
  const [local, setLocal] = useState<AssistantState | null>(null);
  const timer = useRef<number | null>(null);
  const isLongPress = useRef(false);
  /**
   * 这次长按已经失败（例如无麦克风权限时 start 会 reject）。
   * 不记这一笔的话有两个后果：形象停在「正在聆听」（其实什么都没录）；
   * 且松手时 `isLongPress` 已被复位，会被误判成短按触发 tap 动作。
   */
  const aborted = useRef(false);
  const lastOpenAt = useRef(0);

  /**
   * 防抖后的短按动作：窗口期内的重复触发静默吞掉。没有回调即什么都不做。
   *
   * 两个回调共用一个窗口而不是各自一个：车机颠簸连点时，
   * 各自一个窗口会让两件事各触发一次，而车主只按了一下。
   */
  const tapOnce = useCallback(() => {
    if (!onOpenDialog && !onTap) return;
    const now = Date.now();
    if (now - lastOpenAt.current < OPEN_DEBOUNCE_MS) return;
    lastOpenAt.current = now;
    onOpenDialog?.();
    onTap?.();
  }, [onOpenDialog, onTap]);

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  useEffect(() => clearTimer, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // 指针捕获让长按过程中手指轻微滑出仍能继续录音；但对不活跃的 pointerId
      // 会抛 NotFoundError，绝不能让它中断长按计时器的装配。
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        /* 捕获失败不影响长按判定，忽略 */
      }
      isLongPress.current = false;
      aborted.current = false;
      clearTimer();
      timer.current = window.setTimeout(() => {
        isLongPress.current = true;
        setLocal("listening");
        void voice.startPushToTalk().catch((err: unknown) => {
          // 起流失败（无权限 / 设备被占）：这次长按当场作废。
          // 不处理的话，「正在聆听」会一直挂在屏幕上，而实际没在录。
          aborted.current = true;
          isLongPress.current = false;
          setLocal(null);
          // 原因交给上层显示，否则车主看到的就是「按了没反应」。
          onVoiceError?.(err instanceof Error ? err.message : String(err));
        });
      }, LONG_PRESS_MS);
    },
    [voice, onVoiceError],
  );

  const finish = useCallback(() => {
    clearTimer();
    if (isLongPress.current) {
      isLongPress.current = false;
      setLocal("thinking");
      // stop 失败（上传失败 / not_recording）也要把形象放回去：
      // reject 落在 then 外面的话，「正在准备…」就收不掉。
      void voice.stopPushToTalk().finally(() => setLocal(null));
    } else {
      setLocal(null);
      // start 已失败的那次长按，松手不算短按，否则没权限的长按会顺带
      // 触发一次打断/进对话，车主想说话，屏幕却做了别的事。
      if (!aborted.current) tapOnce();
      aborted.current = false;
    }
  }, [tapOnce, voice]);

  /**
   * 真正的取消：指针移出 / 被系统收走。停掉进行中的录音，形象放回去。
   *
   * `pointercancel` 也走这里（iPadOS 的多任务手势、来电等会把触摸收走）。
   * 它到来时捕获已被浏览器释放，所以 `leaveShouldCancel` 不会把它当成假 leave。
   */
  const cancelPress = useCallback(
    (e?: React.PointerEvent) => {
      if (
        !leaveShouldCancel({
          captured: stillCaptured(e),
          timerPending: timer.current !== null,
          longPress: isLongPress.current,
        })
      ) {
        return;
      }
      clearTimer();
      if (isLongPress.current) {
        isLongPress.current = false;
        void voice.stopPushToTalk().catch(() => {});
      }
      setLocal(null);
    },
    [voice],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // 没有 onOpenDialog 时键盘不做任何事，也不 preventDefault：
      // 吞掉按键却什么都不发生，比不接管更难排查。
      if (!onOpenDialog) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        tapOnce();
      }
    },
    [onOpenDialog, tapOnce],
  );

  return {
    state: local ?? externalState,
    gestureProps: {
      onPointerDown,
      onPointerUp: finish,
      onPointerLeave: cancelPress,
      onPointerCancel: cancelPress,
      onKeyDown,
    },
  };
}
