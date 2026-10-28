/**
 * 播放后端 —— 真正让主机出声的那一层。
 *
 * # 为什么要抽象，而不是直接调 afplay
 *
 * 「能不能不重头播地暂停」「能不能播放中改音量」在不同后端下不一样，
 * 而这两件事是车机媒体最基本的两个动作。差异若被隐藏，说「声音小一点」时歌会
 * 从头开始，而上游无从解释。所以能力差异显式上报（`BackendCaps`），播放器状态里
 * 带着它出去，上游能如实说「这台机器上暂停会从头开始」。这与 capabilities 表的规则相同。
 *
 * 三个后端，按能力从强到弱探测：
 *
 *   mpg123 -R   遥控模式，长驻一个进程。LOAD/PAUSE/VOLUME/STOP 走 stdin，
 *               `@F` 行逐帧回报已播/剩余秒数。能力全，首选。
 *   afplay      macOS 自带，一曲一进程。暂停靠 SIGSTOP/SIGCONT（能停住，
 *               但缓冲区里那一点会漏出来）；音量是 spawn 参数，播放中改不了。
 *   none        没有可用二进制，或 `MOCK_CABIN_AUDIO=off`。状态照常维护，
 *               不出声，`audible:false`。测试使用它，单测不往机器的喇叭上放歌。
 *
 * # 背景播放：不阻塞、不串台
 *
 * 子进程的 stdio 全部接管并常读（不读会把管道灌满、进程卡死），HTTP 循环
 * 从不等它。它与车机端的 TTS 是两条完全独立的音频通路：暖暖说话走
 * cockpit 自己的 `tts` 模块，不经过这里，两边互不知道对方存在。
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";

export type BackendName = "mpg123" | "afplay" | "none";

export interface BackendCaps {
  name: BackendName;
  /** 能不能从暂停处继续（false = 继续等于重头播）。 */
  canPauseResume: boolean;
  /** 能不能在播放中调音量（false = 改了要下一首才生效）。 */
  canSetVolumeLive: boolean;
  /** 能不能报告播放进度。 */
  reportsPosition: boolean;
  /** 这个后端解得了的扩展名（不含点）。 */
  formats: string[];
  /** 探测结论的人话说明，`/health` 与播放器状态都带着它。 */
  note: string;
}

export interface BackendEvents {
  /** 一曲自然播完（不是被 stop 掉的）。播放器据此推进队列。 */
  onEnded: () => void;
  /** 后端自己出的错。播放器据此停下并如实上报，不装作在放。 */
  onError: (message: string) => void;
}

export interface PlaybackBackend {
  readonly caps: BackendCaps;
  /** 起播一个文件。已在放的会被换掉。 */
  load(absPath: string, volumePercent: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
  setVolume(volumePercent: number): void;
  /** 已播秒数；后端不支持则 null。 */
  positionSec(): number | null;
  /** 本曲总长（播放中探得）；不支持则 null。 */
  durationSec(): number | null;
  /** 释放进程。服务退出或让出出声位时调。 */
  dispose(): void;
}

function has(bin: string): boolean {
  try {
    // 不走 shell：`shell:true` 会把参数直接拼进命令行（Node 已就此告警）；
    // 这里的 bin 虽是常量，探测函数仍可能被当成通用工具复用。
    return spawnSync("/usr/bin/env", ["which", bin], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

// ── mpg123 -R ───────────────────────────────────────────────

/**
 * mpg123 的遥控模式。协议（v11）：
 *
 *   `@P 0` 停 / `@P 1` 暂停 / `@P 2` 播放 / `@P 3` 本曲自然播完
 *   `@F <帧> <剩余帧> <已播秒> <剩余秒>`
 *   `@E <消息>` 出错
 *
 * `PAUSE` 是 toggle 不是「暂停」，按期望状态直接发会把正在放的暂停掉。
 * 所以这里只在「当前态 ≠ 目标态」时才发，且以进程回报的 `@P` 为准而不是自己记。
 */
class Mpg123Backend implements PlaybackBackend {
  readonly caps: BackendCaps = {
    name: "mpg123",
    canPauseResume: true,
    canSetVolumeLive: true,
    reportsPosition: true,
    formats: ["mp3", "mp2"],
    note: "mpg123 遥控模式：暂停可续播、音量实时生效、有进度",
  };

  private proc: ChildProcess | null = null;
  private phase: 0 | 1 | 2 = 0;
  private pos: number | null = null;
  private dur: number | null = null;
  /** STOP 由本进程主动发出，此时的 `@P 0` 不是「播完了」，不能推进队列。 */
  private stopping = false;
  private disposed = false;
  /**
   * 手上是否有一次「还没汇报过结束」的播放。
   *
   * v11 自然播完会连发 `@P 3` 和 `@P 0` 两条，它们是同一次结束的两种说法。
   * 各算一次会让队列一次推两格（两首歌的队列表现为第一首反复重放）。
   */
  private inPlayback = false;
  /** 这个 mpg123 build 会不会用 `@P 3` 显式报「本曲播完」。见 `onLine` 的 `@P 0` 分支。 */
  private emitsP3 = false;

  constructor(private readonly ev: BackendEvents) {}

  private ensure(): ChildProcess {
    if (this.proc && !this.proc.killed && this.proc.exitCode === null) return this.proc;

    const p = spawn("mpg123", ["-R", "--no-control"], { stdio: ["pipe", "pipe", "pipe"] });
    p.stdout.setEncoding("utf8");
    let buf = "";
    p.stdout.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) this.onLine(line.trim());
    });
    // stderr 也要常读：不读会把管道灌满，进程卡住。
    p.stderr.resume();
    p.on("error", (e) => this.ev.onError(`mpg123 启动失败：${e.message}`));
    p.on("exit", () => {
      this.proc = null;
      this.phase = 0;
    });
    this.proc = p;
    return p;
  }

  private onLine(line: string): void {
    if (line.startsWith("@F ")) {
      const parts = line.slice(3).split(/\s+/);
      const played = Number(parts[2]);
      const left = Number(parts[3]);
      if (Number.isFinite(played)) this.pos = played;
      if (Number.isFinite(played) && Number.isFinite(left)) this.dur = Math.round(played + left);
      return;
    }
    if (line.startsWith("@P ")) {
      const code = Number(line.slice(3).trim());
      if (code === 3) {
        this.emitsP3 = true;
        this.reportEnd();
        return;
      }
      if (code === 0) {
        if (this.stopping) {
          this.stopping = false;
          this.inPlayback = false;
          this.phase = 0;
          this.pos = null;
          return;
        }
        // 这一版 mpg123 用 `@P 3` 报「本曲播完」，紧跟着的 `@P 0` 是同一次结束的余音。
        //
        // 不能靠「刚汇报过就忽略」这种进程内标志去重：两条可能落在不同的
        // stdout 分片里，中间隔着一个事件循环回合，那时下一首已经 load 上、
        // 标志也重置了，余音会被当成新一次结束，一次播完连跳两首。
        //
        // 所以按版本能力判定：见过一次 `@P 3` 就知道这个 build 会显式报播完，
        // 此后 `@P 0` 一律不是结束信号。老版本不发 `@P 3`，才退回用它。
        if (this.emitsP3) return;
        this.reportEnd();
        return;
      }
      this.phase = code === 1 ? 1 : 2;
      return;
    }
    if (line.startsWith("@E ")) {
      this.ev.onError(`mpg123: ${line.slice(3)}`);
    }
  }

  /**
   * 汇报一次「播完了」。同一次播放只认第一条汇报（见 `inPlayback`）。
   *
   * 推进队列必须挪到下一个 tick：在这里同步回调的话，`onEnded` 会立刻
   * load 下一首、把 `inPlayback` 重新置上，而紧跟其后的那条 `@P 0` 还没解析，
   * 会被当成新一次结束。去重和防重入两者都需要。
   */
  private reportEnd(): void {
    if (!this.inPlayback) return;
    this.inPlayback = false;
    this.phase = 0;
    this.pos = null;
    if (this.disposed) return;
    setImmediate(() => {
      if (!this.disposed) this.ev.onEnded();
    });
  }

  private send(cmd: string): void {
    const p = this.ensure();
    p.stdin?.write(`${cmd}\n`);
  }

  load(absPath: string, volumePercent: number): void {
    this.stopping = false;
    this.inPlayback = true;
    this.pos = 0;
    this.dur = null;
    this.send(`VOLUME ${clampVol(volumePercent)}`);
    // LOAD 取整行余下部分，路径里的空格和括号不用转义。
    this.send(`LOAD ${absPath}`);
    this.phase = 2;
  }

  pause(): void {
    if (this.phase === 2) this.send("PAUSE");
  }

  resume(): void {
    if (this.phase === 1) this.send("PAUSE");
  }

  stop(): void {
    if (this.phase === 0) {
      this.inPlayback = false;
      return;
    }
    this.stopping = true;
    this.send("STOP");
    this.phase = 0;
    this.pos = null;
  }

  setVolume(volumePercent: number): void {
    if (this.proc) this.send(`VOLUME ${clampVol(volumePercent)}`);
  }

  positionSec(): number | null {
    return this.phase === 0 ? null : this.pos;
  }

  durationSec(): number | null {
    return this.dur;
  }

  dispose(): void {
    this.disposed = true;
    this.inPlayback = false;
    if (this.proc) {
      this.send("QUIT");
      this.proc.kill();
      this.proc = null;
    }
    this.phase = 0;
  }
}

// ── afplay ──────────────────────────────────────────────────

/**
 * macOS 自带，永远在。一曲一进程，能力受限：
 *
 *  - 暂停走 SIGSTOP/SIGCONT。进程是停住了，但 CoreAudio 缓冲区里已经排好的
 *    那一小段还会放完（听感上约几十毫秒的拖尾），这是这条路子的固有代价。
 *  - 音量只在 spawn 时生效。播放中改音量要重起进程，也就是从头播；
 *    这里不这么做，而是上报 `canSetVolumeLive:false`，让上游如实转述。
 *  - 没有进度回报。`afplay` 什么都不打印。
 */
class AfplayBackend implements PlaybackBackend {
  readonly caps: BackendCaps = {
    name: "afplay",
    canPauseResume: true,
    canSetVolumeLive: false,
    reportsPosition: false,
    formats: ["mp3", "m4a", "aac", "wav", "aiff", "aif", "caf", "flac"],
    note: "afplay：暂停靠挂起进程（有短暂拖尾）；音量改动要下一首才生效；无进度",
  };

  private proc: ChildProcess | null = null;
  private paused = false;
  private stopping = false;
  private disposed = false;
  private volume = 20;

  constructor(private readonly ev: BackendEvents) {}

  load(absPath: string, volumePercent: number): void {
    this.killCurrent();
    this.volume = clampVol(volumePercent);
    this.paused = false;
    // afplay 的 -v 是线性增益，1.0 = 原始电平。把 0~100 映到 0~1。
    const p = spawn("afplay", ["-v", String(this.volume / 100), absPath], { stdio: "ignore" });
    p.on("error", (e) => this.ev.onError(`afplay 启动失败：${e.message}`));
    p.on("exit", () => {
      const wasStopping = this.stopping;
      this.stopping = false;
      if (this.proc === p) this.proc = null;
      if (!wasStopping && !this.disposed) this.ev.onEnded();
    });
    this.proc = p;
  }

  private killCurrent(): void {
    if (!this.proc) return;
    this.stopping = true;
    // 挂起中的进程收不到 TERM，先 CONT 再杀，否则留一个僵着的 afplay 占着声卡。
    if (this.paused) {
      try {
        this.proc.kill("SIGCONT");
      } catch {
        /* 已经没了 */
      }
    }
    this.proc.kill();
    this.proc = null;
    this.paused = false;
  }

  pause(): void {
    if (this.proc && !this.paused) {
      this.proc.kill("SIGSTOP");
      this.paused = true;
    }
  }

  resume(): void {
    if (this.proc && this.paused) {
      this.proc.kill("SIGCONT");
      this.paused = false;
    }
  }

  stop(): void {
    this.killCurrent();
    this.stopping = false;
  }

  setVolume(volumePercent: number): void {
    // 记下来，下一首 spawn 时生效。刻意不重起当前曲目，见类注释。
    this.volume = clampVol(volumePercent);
  }

  positionSec(): number | null {
    return null;
  }

  durationSec(): number | null {
    return null;
  }

  dispose(): void {
    this.disposed = true;
    this.killCurrent();
  }
}

// ── none ────────────────────────────────────────────────────

/**
 * 不出声，但状态机照常跑。测试与无音频环境用它，也是容器形态的缺省后端。
 *
 * 这时出声位只可能在车机端（cockpit 认领后拉字节自己解），`formats` 因此写的是
 * 车机端带的解码：WAV / FLAC / Vorbis（ACR-068：车载设备不带 MP3/AAC 解码器）。
 * 写宽了，`playable` 会把车机端放不出的曲目标成可放。
 */
class SilentBackend implements PlaybackBackend {
  readonly caps: BackendCaps;

  constructor(_ev: BackendEvents, note: string) {
    this.caps = {
      name: "none",
      canPauseResume: true,
      canSetVolumeLive: true,
      reportsPosition: false,
      formats: ["wav", "flac", "ogg"],
      note,
    };
  }

  load(): void {}
  pause(): void {}
  resume(): void {}
  stop(): void {}
  setVolume(): void {}
  positionSec(): number | null {
    return null;
  }
  durationSec(): number | null {
    return null;
  }
  dispose(): void {}
}

// ── 探测 ────────────────────────────────────────────────────

function clampVol(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

export type BackendKind = BackendName;

let probed: BackendKind | null = null;

/**
 * 选后端。结论进程内缓存一次，避免每次起播都 `command -v` 一遍。
 *
 * `MOCK_CABIN_AUDIO=off` 强制静音，测试与 CI 用；`=afplay` / `=mpg123` 可强制指定，
 * 用来在本机验证降级路径下的表现（"没有 mpg123 的那台机器上是什么样"）。
 */
export function probeBackendKind(): BackendKind {
  if (probed) return probed;
  const forced = (process.env.MOCK_CABIN_AUDIO ?? "").trim().toLowerCase();
  if (forced === "off" || forced === "none" || forced === "silent") probed = "none";
  else if (forced === "mpg123") probed = "mpg123";
  else if (forced === "afplay") probed = "afplay";
  else if (has("mpg123")) probed = "mpg123";
  else if (has("afplay")) probed = "afplay";
  else probed = "none";
  return probed;
}

/** 测试用：让下一次探测重新跑（改了 env 之后）。 */
export function __resetBackendProbe(): void {
  probed = null;
}

export function createBackend(ev: BackendEvents): PlaybackBackend {
  switch (probeBackendKind()) {
    case "mpg123":
      return new Mpg123Backend(ev);
    case "afplay":
      return new AfplayBackend(ev);
    default:
      return new SilentBackend(
        ev,
        (process.env.MOCK_CABIN_AUDIO ?? "").trim()
          ? "已由 MOCK_CABIN_AUDIO 关闭：状态照常维护，主机不出声"
          : "本机没有 mpg123 也没有 afplay：状态照常维护，主机不出声",
      );
  }
}

/** 不建进程也能问「这台机器能干什么」——`/health` 与曲库的 playable 判定要用。 */
export function backendCaps(): BackendCaps {
  const probe = createBackend({ onEnded: () => {}, onError: () => {} });
  const caps = probe.caps;
  probe.dispose();
  return caps;
}
