/**
 * 出发动画的时间轴。
 *
 * # 时间轴和关键帧住在同一个文件里
 *
 * 字幕与每一层的关键帧 offset 全部从同一份 `DEPARTURE_TIMELINE` 推导，且导出成
 * 纯数据：两处各写一份时间会漂移且不报错；导出成数据后单测可以断言
 * "车门打开的那一帧落在「暖暖上车」相位里"。
 *
 * # 出发卡
 *
 * 车驶离后滑入出发卡（目的地/今日路线/途径补能 + 「开始导航」），钥匙是出发入口，
 * 不保留纯看动画的路，只留重播按钮。
 * 卡本身与它的纯逻辑在 `@cabinhug/ui`（`departure/`），两端共用；本文件只有动画时间轴。
 */

// ── 时间轴（唯一真相源）─────────────────────────────────────

export interface DeparturePhase {
  /** 相位起点（ms，相对动画开始）。 */
  at: number;
  key: "arrive" | "climate" | "ambient" | "board" | "ready" | "depart";
  /** 字幕文案。 */
  status: string;
}

/**
 * ── 四段实拍片 ────────────────────────────────────────────
 *
 * 整条出发动画由视频承担。
 *
 * 四段是一条链：每段的起始帧取自上一段的末帧，切点处车位、尺寸、机位、背景一致。
 * 替换其中任意一段，必须从它上一段的末帧重新生成，否则接缝可见。
 *
 * 视频没有 alpha，也不能被本时间轴逐帧驱动，所以时间轴迁就片子：相位时刻由下面
 * 量到的片内节拍推导，播放由 rAF 从同一个动画时钟驱动（见 CabinArrivalDemo）。
 * 改片子只改这张表。
 *
 * `beats` 是逐帧看帧序图量出来的，单位 ms、相对各自片头。
 */
export const DEPARTURE_CLIPS = [
  { key: "arrive", duration: 3_417, beats: { parked: 2_920 } },
  { key: "wake", duration: 4_625, beats: { handUp: 2_000 } },
  { key: "board", duration: 6_042, beats: { doorOpen: 1_800, seated: 4_200, shutAndLit: 5_200 } },
  // 片尾由两段拼接：续接段只取车向左出画的 1.4s，接点选在车位与前段末帧吻合处，
  // 车完全驶出画面。
  { key: "driveoff", duration: 4_833, beats: { gone: 4_300 } },
] as const;

type ClipKey = (typeof DEPARTURE_CLIPS)[number]["key"];

/** 各段在总时间轴上的起点（由时长依次累加，不手写）。 */
export const CLIP_START: Record<ClipKey, number> = (() => {
  const out = {} as Record<ClipKey, number>;
  let t = 0;
  for (const c of DEPARTURE_CLIPS) {
    out[c.key] = t;
    t += c.duration;
  }
  return out;
})();

/** 片内节拍 → 总时间轴时刻。相位一律用它推导，不写裸毫秒。 */
const at = (key: ClipKey, ms = 0) => CLIP_START[key] + ms;

export const DEPARTURE_TIMELINE: { total: number; phases: readonly DeparturePhase[] } = {
  total: DEPARTURE_CLIPS.reduce((n, c) => n + c.duration, 0),
  phases: [
    { at: 0, key: "arrive", status: "车辆驶来" },
    // 这两拍都落在「唤醒」那段片子里：她走过去、举手，车内透出暖光。
    { at: at("wake", 800), key: "climate", status: "空调预热" },
    { at: at("wake", DEPARTURE_CLIPS[1].beats.handUp), key: "ambient", status: "点亮氛围" },
    { at: at("board", DEPARTURE_CLIPS[2].beats.doorOpen), key: "board", status: "暖暖上车" },
    { at: at("board", DEPARTURE_CLIPS[2].beats.shutAndLit), key: "ready", status: "准备出发" },
    { at: at("driveoff"), key: "depart", status: "出发！" },
  ],
};

/** ms → WAAPI offset（0..1）。 */
const T = (ms: number) => ms / DEPARTURE_TIMELINE.total;

/** 相位起点的毫秒值。 */
const phaseMs = (key: DeparturePhase["key"]) =>
  DEPARTURE_TIMELINE.phases.find((p) => p.key === key)!.at;

/** 相位起点的 offset。 */
const P = (key: DeparturePhase["key"]) => T(phaseMs(key));

/**
 * 某一刻该显示哪句字幕。
 *
 * 抽出来以便单测相位边界：相位起点那一帧归属该相位（`ms >= at`），
 * 与关键帧的硬切保持同一边界。
 */
export function statusAt(ms: number): string {
  let cur = DEPARTURE_TIMELINE.phases[0]!.status;
  for (const p of DEPARTURE_TIMELINE.phases) if (ms >= p.at) cur = p.status;
  return cur;
}

/**
 * 功能球外环的整组扫描：在 `climate` 与 `ambient` 两拍各扫一遍，第 `i` 颗按 60ms 递延。
 *
 * 不提供"只闪某一颗"的能力：单颗闪读作"选中了它"，而动画与真实功能状态没有绑定，
 * 功能增删时会指错对象。
 */
function groupSweep(i: number): Keyframe[] {
  const STAGGER = 60;
  const flash = (atMs: number): Keyframe[] => {
    const a0 = T(atMs + i * STAGGER);
    const b0 = T(atMs + i * STAGGER + 520);
    return [
      { offset: a0, opacity: 0, transform: "scale(0.86)" },
      { offset: Math.min(a0 + 0.006, 1), opacity: 0.94, transform: "scale(0.86)" },
      { offset: Math.min(b0, 1), opacity: 0, transform: "scale(1.24)" },
    ];
  };
  return [
    { offset: 0, opacity: 0, transform: "scale(0.86)" },
    ...flash(phaseMs("climate") + 150),
    ...flash(phaseMs("ambient") + 120),
    { offset: 1, opacity: 0, transform: "scale(1.24)" },
  ];
}

/** 某段片子的可见性：硬切进、硬切出。不做交叉淡化，两段片子半透明同框会形成重影。 */
function clipVisibility(key: ClipKey): Keyframe[] {
  const idx = DEPARTURE_CLIPS.findIndex((c) => c.key === key);
  const on = T(CLIP_START[key]);
  const last = idx === DEPARTURE_CLIPS.length - 1;
  const off = last ? 1 : T(CLIP_START[DEPARTURE_CLIPS[idx + 1]!.key]);
  const frames: Keyframe[] = [{ offset: 0, opacity: 0 }];
  if (on > 0) frames.push({ offset: on, opacity: 0 });
  frames.push({ offset: on, opacity: 1 });
  if (!last) {
    frames.push({ offset: off, opacity: 1 }, { offset: off, opacity: 0 }, { offset: 1, opacity: 0 });
  } else {
    frames.push({ offset: 1, opacity: 1 });
  }
  return frames;
}

/**
 * 每一层的关键帧。key 与组件里 ref 的挂点一一对应；
 * offset 全部由相位/片段起点推导，改节奏只改 DEPARTURE_CLIPS。
 */
export function departureLayers(): Record<string, Keyframe[]> {
  const wakeIn = T(CLIP_START.wake);
  return {
    arriveClip: clipVisibility("arrive"),
    wakeClip: clipVisibility("wake"),
    boardClip: clipVisibility("board"),
    driveoffClip: clipVisibility("driveoff"),

    /*
     * 暖暖只出现在第 2 段之后。这一层是从第 2 段第 0 帧抠出来的她
     * （`nuannuan-intro-plate.png`），在切点前 400ms 淡入到位，落点与片中一致，
     * 避免在第 1→2 切点处凭空出现。
     */
    introNuannuan: [
      { offset: 0, opacity: 0 },
      { offset: T(Math.max(0, CLIP_START.wake - 400)), opacity: 0 },
      { offset: wakeIn, opacity: 1 },
      { offset: wakeIn, opacity: 0 },
      { offset: 1, opacity: 0 },
    ],

    /*
     * 唤醒光带：她举手那一刻从手边漫开的柔光。
     *
     * 由前端绘制而不烘进视频：强度可控、调色板与 HUD 一致，且它与真实功能状态的
     * 耦合关系由前端决定。两端渐隐、不落在任何一颗功能球上，只表达"唤醒"，不表达"选择"。
     */
    wakeBand: [
      { offset: 0, opacity: 0, transform: "scaleX(0)" },
      { offset: P("ambient"), opacity: 0, transform: "scaleX(0)" },
      { offset: T(phaseMs("ambient") + 140), opacity: 0.95, transform: "scaleX(0.12)" },
      { offset: T(phaseMs("ambient") + 700), opacity: 0.85, transform: "scaleX(1)" },
      { offset: T(CLIP_START.board), opacity: 0, transform: "scaleX(1)" },
      { offset: 1, opacity: 0, transform: "scaleX(1)" },
    ],

    /*
     * 功能球那一圈压在片子之上（CSS z=7），只服务"唤醒"两拍。上车段开始后淡到 0.18：
     * 不淡时底下两颗压在车轮上显得杂乱；不归零以保留 HUD 叠加的身份。
     */
    constellation: [
      { offset: 0, opacity: 1 },
      { offset: P("ambient"), opacity: 1 },
      { offset: T(CLIP_START.board), opacity: 0.18 },
      { offset: 1, opacity: 0.18 },
    ],

    ringClimate: groupSweep(0),
    ringLight: groupSweep(1),
    ringSeat: groupSweep(2),
    ringMedia: groupSweep(3),
    ringFamily: groupSweep(4),
  };
}

// ── 出发卡：导航目标与高德 URI ───────────────────────────────
//
// 实现在 `clients/shared/ui/src/departure/amap.ts`（两端共用），这里按原名转出。
// 经子路径 `@cabinhug/ui/departure` 引：根入口带 png，cockpit 的 node:test 里
// import 根入口会整文件失败。
export {
  amapAppNavUri,
  amapNavUri,
  amapWebPolicy,
  navLaunchDegradation,
  pickNavTarget,
  stopsViewportHeight,
  todayStopNames,
  type NavLaunch,
  type NavTarget,
} from "@cabinhug/ui/departure";
