/**
 * 指标格的文案与格式化：车机屏底状态栏（`StatusBar`）与手机底部胶囊（`EnergyCapsule`）共用。
 *
 * # 单独一个文件，不放在 `StatusBar.tsx` 里
 *
 * `StatusBar.tsx` 顶上有七个 `import … from "../assets-hud/statusbar/*.png"`。
 * 常量与纯函数若放在那里，只要引一个字符串就会把整包 PNG 拖进自己的依赖图：
 *  - `EnergyCapsule`（只有手机在用）引 `durationLabel` 时，手机侧会多一条
 *    指向车机切图的依赖边；
 *  - Node 不认 `.png`，测试里 `import { METRIC_EMPTY }` 会报
 *    `ERR_UNKNOWN_FILE_EXTENSION`，这几个字符串就无法对真实产物测试。
 *
 * 所以：纯文本与纯函数放这里，带素材的组件各自去引它。
 */

/** 没有数据时那一格的值。不用省略号或「--」：那两个符号需要读者自己猜含义。 */
export const METRIC_EMPTY = "暂无";

/**
 * 连不上服务时那一格的值。
 *
 * 与 `METRIC_EMPTY` 必须是两句话：一句说「服务在，这项没数据」，一句说「根本没连上」。
 * 合成一句会让两种状态无法区分，右端那枚「数据更新中」也会与事实不符。
 */
export const METRIC_UNAVAILABLE = "服务暂不可用";

/** 「4 h 30 min」/「45 min」。 */
export function durationLabel(min: number): string {
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} min`;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}
