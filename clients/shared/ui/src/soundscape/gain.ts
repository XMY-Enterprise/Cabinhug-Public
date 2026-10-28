/**
 * 音景的增益算术。
 *
 * # 独立文件，不 import 任何 WebAudio 类型
 *
 * 本包的测试跑在 `node --import tsx` 下，没有 jsdom、也没有 WebAudio。
 * 所以"声音到底多响"只有写成纯算术才能被机器钉住，CI 里听不见真实的声音。
 * 这个文件是本模块单测密度最高的地方，其余部分的断言都只是调度参数。
 *
 * # 两个上限是设计取值，不是实测值
 *
 * 真机听感可能要调。调的时候改这里的常量与单测里的期望，
 * 不要在调用方再压一次——两处各留一份迟早对不齐，
 * 表现是"音效忽大忽小"，不报错。
 */

/** 单个 cue 的峰值上限，−12 dBFS。界面音效不该盖过任何一路正经声音。 */
export const PEAK_CUE = 0.251;

/**
 * 风声铺底的峰值，−34 dBFS。它要一直在，所以必须一直不显眼。
 *
 * 更高的取值会掩蔽 cue：铺底是整条 18.9 秒不停的宽带噪声，而六个 cue 是短促的乐音，
 * 同一临界带里的连续噪声对乐音的掩蔽远比峰值差看起来的严重——
 * −24 dBFS 时离线渲染量出铺底稳态 RMS ≈0.009、`chime` ≈0.10，
 * 差 20 dB 听上去却是"其他的听不见"。
 * 降响度只是一半，另一半是把它挪出 cue 的频段，见 `primitives.ts` 的 `bed()`。
 *
 * # 这个数字是滤波前的峰值，不是听到的电平
 *
 * 铺底后面还有两级 320 Hz 低通。离线实测（`PEAK_BED = 0.012`）：
 * 出来的稳态峰值约 0.010（−40 dBFS）、RMS 约 0.0024（−52 dBFS），
 * 而最响的 cue（`thud`）峰值 0.19——差 25 dB，且两者频段完全不重叠。
 * 改这个数之后要重测，不要凭它的字面值判断响度。
 */
export const PEAK_BED = 0.012;

/**
 * 指数收尾的目标值。**不能是 0**——`exponentialRampToValueAtTime(0, …)`
 * 在 WebAudio 规范下会抛。
 */
export const GAIN_FLOOR = 0.0001;

/**
 * 把峰值钳进上限。
 *
 * 超限**不报错**：界面音效不该因为某个参数写错就中断整条动画。
 * `NaN` 一律当 0——把 NaN 喂给 `AudioParam` 会让那一路彻底哑掉且没有任何提示。
 */
export function clampPeak(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(v, PEAK_CUE);
}

/**
 * 主增益该设成多少。
 *
 * `muted` 的优先级**高于** `master`：静音是"暖暖在说话"这类硬条件的表达，
 * 它不该被主音量的取值影响。这一条有单测钉着。
 */
export function effectiveGain(peak: number, master: number, muted: boolean): number {
  if (muted) return 0;
  if (!Number.isFinite(master) || master <= 0) return 0;
  return clampPeak(peak) * Math.min(master, 1);
}
