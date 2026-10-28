/**
 * 浏览器里的语音播报（ACR-049）。
 *
 * # 端上不持有任何 vendor 密钥
 *
 * 合成走网关的 `/v1/tts/speech`：三档（豆包 / 阿里云 / mock）共用这一个地址，
 * 协议差异与密钥全部消化在服务端。响应是豆包形状的 NDJSON：
 *
 *     {"code":0,"data":"<base64 WAV 分片>"}   ← 音频，可多条（网关一律下发 WAV，ACR-067）
 *     {"code":20000000,"message":"OK"}        ← 正常终止
 *     {"code":<非 0>,"message":"..."}          ← 失败（如日用量超限），端上降级
 *
 * # 失败一律静音降级
 *
 * 原生端合成失败会退到系统 `say`，浏览器里没有那条路。所以这里不弹错、不中断对话：
 * 拿不到音频就当这一轮没有播报。播报是增强，不影响主路径。
 */

import { splitForSpeech, stripMarkdownForSpeech } from "./segment";

/** 解析 NDJSON，拼出音频字节。坏行跳过，一行坏掉不影响整段。 */
/**
 * Blob 的 MIME 按字节判，不写死：网关下发 WAV（ACR-067）。不是 RIFF/WAVE 时按 mp3 标，
 * 升级期仍下发 mp3 的旧网关照样能放。
 */
export function audioMimeOf(bytes: Uint8Array): string {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  const wav = bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
  return wav ? "audio/wav" : "audio/mpeg";
}

export function parseTtsNdjson(text: string): { bytes: Uint8Array; error: string | null } {
  const parts: Uint8Array[] = [];
  let error: string | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row: { code?: number; data?: unknown; message?: string };
    try {
      row = JSON.parse(trimmed) as typeof row;
    } catch {
      continue;
    }
    if (row.code === 0 && typeof row.data === "string" && row.data) {
      const bin = atob(row.data);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      parts.push(buf);
    } else if (typeof row.code === "number" && row.code !== 0 && row.code !== 20000000) {
      // 失败行里那句话是"为什么今天没声音"的唯一线索（日用量闸门就走这条）
      error = row.message ?? "tts_failed";
    }
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return { bytes, error };
}

export interface Speaker {
  /** 播一段文本。整段播完才 resolve；被 `stop()` 打断时也 resolve。 */
  speak(text: string): Promise<void>;
  /** 立刻停止。撤回、打断、下一轮开始时调用。 */
  stop(): void;
  readonly playing: boolean;
}

export interface SpeakerDeps {
  /** 拿合成结果的字节。注入是为了单测不打网络。 */
  synthesize(text: string): Promise<{ bytes: Uint8Array; error: string | null }>;
  /** 播放起止回调——`speaking` / `idle` 由它驱动，不由 turn_end 驱动。 */
  onPlayingChange(playing: boolean): void;
  /** 造一个播放器。默认用 <audio>；单测里替换掉。 */
  createAudio?: (url: string) => HTMLAudioElement;
}

export function createSpeaker(deps: SpeakerDeps): Speaker {
  let current: { audio: HTMLAudioElement; url: string } | null = null;
  /*
   * 播报状态单独一个标志位，不从 `current` 推。
   * 分段播报时 `current` 在段与段之间会短暂为 null，拿它当判据会让
   * 最后一段播完时 release 提前返回，idle 不再上报，形象停在"在说"。
   */
  let speaking = false;
  // 每次播报领一个号。回调回来时号变了，说明已经被下一段抢占，这一段的结果作废。
  let generation = 0;

  const dropAudio = () => {
    if (!current) return;
    current.audio.pause();
    URL.revokeObjectURL(current.url);
    current = null;
  };

  const finish = () => {
    dropAudio();
    if (!speaking) return;
    speaking = false;
    deps.onPlayingChange(false);
  };

  /** 播一段已经拿到的音频，播完 resolve。被抢占时立刻 resolve。 */
  const playBytes = (bytes: Uint8Array, mine: number) =>
    new Promise<void>((resolve) => {
      if (mine !== generation) return resolve();
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: audioMimeOf(bytes) }));
      const audio = deps.createAudio ? deps.createAudio(url) : new Audio(url);
      dropAudio();
      current = { audio, url };
      // 段与段之间不报 idle：整段播报期间形象应当一直是 speaking
      if (!speaking) {
        speaking = true;
        deps.onPlayingChange(true);
      }
      const done = () => {
        if (current?.audio === audio) {
          URL.revokeObjectURL(url);
          current = null;
        }
        resolve();
      };
      audio.onended = done;
      audio.onerror = done;
      /*
       * 自动播放可能被浏览器拒（用户还没和页面交互过）。创空间的 iframe 带了
       * `allow="autoplay"`，但访客直接落在页面上、一次都没点过时仍会被拒。
       * 拒了就当这一轮没有播报，不弹框、不打断对话。
       */
      audio.play().catch(() => done());
    });

  return {
    get playing() {
      return speaking;
    },
    /*
     * 停播必须同时作废正在进行的合成：只停当前音频挡不住已经在途的那一段。
     * 撤回到达时正文通常还在合成（几百毫秒），不换号的话它稍后照样开播，
     * 屏幕上显示已收回，声音却把被审核拦下的原文念完。
     */
    stop() {
      generation += 1;
      finish();
    },
    async speak(text) {
      const mine = ++generation;
      finish();

      /*
       * 分段合成，边合边播。整段送去合成要等 `723ms + 30.3ms × 字数`，
       * 250 字的回答约 8.4 秒；切完之后第一段只有十来个字，一秒出头就能开口。
       *
       * 下一段的合成与当前段的播放并行：进入播放前先把下一段发出去，
       * 播完时它通常已经回来（档位按此推算，见 segment.ts）。
       */
      /*
       * 记号在这里剥，位置与原生端的 `play()` 对齐：所有播报路径都使用去掉记号的文本。
       * 网页版目前只有正文这一条路（垫场话由 Rust 直接播，端上 UI 不消费那个事件），
       * 剥的位置放在播报入口而不是某个调用点，新增播报来源时不会遗漏。
       *
       * 必须先剥再分段：反过来会把成对的 ** 切散，两半落进不同段就剥不掉了。
       */
      const segments = splitForSpeech(stripMarkdownForSpeech(text));
      if (segments.length === 0) return;

      const synth = (i: number) =>
        i < segments.length
          ? deps.synthesize(segments[i]).catch(() => ({ bytes: new Uint8Array(), error: "tts_unreachable" }))
          : null;

      let pending = synth(0);
      for (let i = 0; i < segments.length; i++) {
        const got = await pending!;
        if (mine !== generation) return;
        pending = synth(i + 1);
        if (got.error) console.warn("[web-shim] 播报降级：" + got.error);
        if (got.bytes.length > 0) await playBytes(got.bytes, mine);
        if (mine !== generation) return;
      }
      finish();
    },
  };
}
