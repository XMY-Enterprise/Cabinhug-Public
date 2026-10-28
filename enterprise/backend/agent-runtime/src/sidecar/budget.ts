/**
 * 旁路的节奏参数。
 *
 * # 只管节奏，不管何时收口
 *
 * turn 会不会结束由会话超时负责。旁路的生命周期绑在 turn 上（`closePair` 挂在
 * `turn-runner.run()` 的 `finally`，正常收口 / 异常 / 取消都会走到），turn 一结束节拍就停，
 * 这里不另设条数或总时长上限：主 agent 的 fan-out 汇聚超时是 60 秒，
 * 正常的长等待就会撞上较小的上限。
 */

export interface SidecarConfig {
  /**
   * 静默多久算"该说句话了"。
   *
   * 1500 是单样本初值，不是结论（架构 §13-14 要求 P50~P90 之间）。
   * 依据：实测 `guard.input` 在 225~287ms 结束、
   * `acp.session_new` 在 1580~1875ms 结束，1500ms 落在两者之间。
   */
  silenceMs: number;

  /**
   * 两句之间隔多久，从上一句估算播完的时刻算起。
   *
   * 按"发出时刻"算时，长句（40 多字约 8 秒）未念完就会被下一句掐掉。
   *
   * 它表示"上一句念完之后再等这么久"，不是"每隔这么久说一句"，
   * 调小它不会让句子互相打断。取 500ms：等待期应被填满，句与句之间只留短暂停顿。
   */
  minGapMs: number;

  /**
   * 每个字的播报时长估算，用来推算"这句什么时候念完"。
   *
   * 服务端拿不到端上的播完回执，也不为此加上行通道：filler 是不留痕的瞬时事件，
   * 加回执会让它变成有状态的东西。
   * 中文 TTS 约 4~5 字/秒，实测 45~49 字对应 9~10 秒，200ms/字 吻合。
   *
   * 它是节奏提示，不是保障。防截断由端上负责（`tts::filler_slot`）：
   * 正在播就等它播完，只有端上知道真实播放状态。这里估偏了只影响节奏，不会截断。
   */
  speechMsPerChar: number;

  /**
   * 重新判定的节拍。
   *
   * span 在完成时才落，单跳可能占数秒（如 `tool.ragflow_retrieve` 实测 3.8 秒），
   * 这期间轨迹侧没有事件，纯事件驱动不会被唤起。
   *
   * 它只重新判定，不制造内容：内容仍然只来自模板/生成器，
   * 无可映射信号时 tick 多少次都是零输出。
   */
  tickMs: number;
}

const DEFAULTS: SidecarConfig = {
  silenceMs: 1500,
  /*
   * 较长的停顿在车里听着像"它说完了"，所以取 500ms。间隔从念完起算，
   * 不会造成句子互相打断（见字段注释）。
   */
  minGapMs: 500,
  speechMsPerChar: 200,
  tickMs: 700,
};

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * 现取而不是模块级快照：`env-timing` 不变量要求非入口模块不在模块级读
 * `process.env`（否则 `.env` 改了不生效，且没有任何症状）。
 */
export function sidecarConfig(): SidecarConfig {
  return {
    silenceMs: num("SIDECAR_SILENCE_MS", DEFAULTS.silenceMs),
    minGapMs: num("SIDECAR_MIN_GAP_MS", DEFAULTS.minGapMs),
    speechMsPerChar: num("SIDECAR_SPEECH_MS_PER_CHAR", DEFAULTS.speechMsPerChar),
    tickMs: num("SIDECAR_TICK_MS", DEFAULTS.tickMs),
  };
}

export function sidecarDefaults(): SidecarConfig {
  return { ...DEFAULTS };
}

/** 这句话大概要念多久。上限判定与预生成都靠它。 */
export function estimateSpeechMs(text: string, cfg: SidecarConfig): number {
  return [...text].length * cfg.speechMsPerChar;
}

/**
 * 生成失败/被拒之后，多久才允许再打一次模型。
 *
 * 不复用 `minGapMs`：一个是"说话的节奏"（用户体感），一个是"重试的退避"（费用与限流）。
 * 共用时间隔调小会让退避一起变短，被过滤器拒一次后每个节拍都重打一次模型，
 * 而用户侧只是全程听到 L0 模板话，看不出异常。
 *
 * 取 `max(minGapMs, 2000)`：节奏可以任意调快，退避有地板。
 */
export function genRetryMs(cfg: SidecarConfig): number {
  return Math.max(cfg.minGapMs, 2000);
}
