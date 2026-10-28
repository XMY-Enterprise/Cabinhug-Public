/**
 * 演示曲库生成器（`corepack pnpm demo:media`）。
 *
 * # 为什么是"生成"而不是"下载"
 *
 * `mocks/cabin/media/.gitignore` 与那份 README 规定：商业发行的音乐不进仓库，
 * 私有仓库也是分发。所以演示曲库靠合成，垫底曲《夜路》同样是合成的
 * （名字里写着"Cabinhug 合成"）。
 *
 * 进 git 的是生成器，音频不进（`.gitignore` 已经挡着），生成结果可复现：
 * clone 后跑一次即得 29 首。
 *
 * # 素材的来源都在公有领域
 *
 * - 旋律：全部是 1928 年以前的传统曲调或古典作品（小星星 1761、两只老虎 18 世纪、
 *   欢乐颂 1824、致爱丽丝 1810、卡农 1680…）。逐首的年代注在曲目表里。
 * - 故事：伊索寓言，公元前的作品；中文复述是本文件现写的，不抄任何一版译文。
 *
 * # 两条链路
 *
 * ```text
 * 旋律 → 本文件的加法合成器 → WAV → flac → FLAC
 * 故事 → 阿里云档 TTS（qwen3-tts-flash）→ WAV → flac → FLAC
 * ```
 *
 * 用 `flac`（Xiph 的参考编码器）而不是 ffmpeg：本机的 ffmpeg-full 缺 libvpx 动态库，
 * 修它要动开发者的 brew。`flac` 是纯 FLAC 编码器。
 *
 * # 为什么必须是 FLAC
 *
 * 出声位在车机端，车机端用 rodio 解码，只带 WAV / FLAC / Vorbis（ACR-068：车载设备
 * 随机出货的解码器涉及版税，端上不带 MP3/AAC）。容器形态下曲库的 `playable` 按车机端
 * 的格式表算，产 mp3 的话曲目会被标成放不了。FLAC 无损、免版税，体积约为 WAV 的一半。
 *
 * 故事是人声，会被语音哨兵采到（见 `mocks/cabin/media/README.md` 的"别放有人声的"）。
 * 十篇故事的文本已经避开了"暖暖"的同音近音，但哨兵仍可能被别的词干扰，
 * 现场演示唤醒功能时建议放器乐那两组。
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { synthesizeSpeech } from "../../../enterprise/backend/gateway/src/tts/synthesize";

// ── 合成器 ──────────────────────────────────────────────────

const SAMPLE_RATE = 44_100;

/** 音名 → 频率。`R` 是休止符。 */
function freqOf(note: string): number {
  if (note === "R") return 0;
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(note);
  if (!m) throw new Error(`认不出的音名：${note}`);
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1] as "C"];
  const accidental = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
  const octave = Number(m[3]);
  // A4 = 440Hz，MIDI 69。
  const midi = 12 * (octave + 1) + base + accidental;
  return 440 * 2 ** ((midi - 69) / 12);
}

/**
 * 记谱：空格分隔的 `音名[:拍数]`，`R` 是休止。默认一拍。
 *
 * 写成字符串而不是数组字面量，是为了让曲目表里那一行看得出旋律，
 * 改错一个音时读的人能当场发现。
 */
function parseMelody(src: string): Array<{ freq: number; beats: number }> {
    return src
    .trim()
    .split(/\s+/)
    .filter((t) => t && t !== "|")
    .map((tok) => {
      const [note, beats] = tok.split(":");
      return { freq: freqOf(note), beats: beats ? Number(beats) : 1 };
    });
}

/**
 * 一个音的波形。不是纯正弦：纯正弦听着像仪器自检音，不像音乐。
 *
 * 泛音比例取的是钟琴/音乐盒那一类：基频最响，二三次泛音明显，再往上很快衰减，
 * 外加一个略微失谐的高次分音（`5.4`）让音色不那么"电子"。
 * 包络是快起音 + 指数衰减，同样是音乐盒的形状。
 *
 * # 不加低八度垫音
 *
 * `0.18 * sin(2π · f/2 · t)` 这类 f/2 分量会在 f/2 上造出真实的周期，响到成为听感上的
 * 基频：用自相关从成品音频读音高，整条旋律低一个八度（`C4 C4 G4 G4` 读成
 * `C3 C3 G3 G3`），音程关系不变、绝对音高整体走低。上面五个分音已经够厚。
 */
function renderNote(freq: number, seconds: number, gain: number): Float32Array {
  const n = Math.round(seconds * SAMPLE_RATE);
  const out = new Float32Array(n);
  if (freq === 0) return out;

  const partials: Array<[number, number]> = [
    [1, 1],
    [2, 0.5],
    [3, 0.22],
    [4, 0.1],
    [5.4, 0.05],
  ];
  const attack = Math.round(0.008 * SAMPLE_RATE);
  // 衰减时常数随音高走：高音衰得快，低音留得久，与真乐器一致。
  const decayTau = seconds * (freq > 700 ? 0.32 : 0.45);

  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    const env = (i < attack ? i / attack : 1) * Math.exp(-t / decayTau);
    let s = 0;
    for (const [mult, amp] of partials) s += amp * Math.sin(2 * Math.PI * freq * mult * t);
    out[i] = s * env * gain;
  }
  return out;
}

/** 两条梳状延迟当混响。没有它，每个音都像贴在耳朵上。 */
function reverb(buf: Float32Array): Float32Array {
  const taps: Array<[number, number]> = [
    [Math.round(0.089 * SAMPLE_RATE), 0.26],
    [Math.round(0.137 * SAMPLE_RATE), 0.17],
  ];
  const out = Float32Array.from(buf);
  for (const [delay, fb] of taps) {
    for (let i = delay; i < out.length; i++) out[i] += out[i - delay] * fb;
  }
  return out;
}

/** 把旋律铺成一整条音轨，重复到够长为止。 */
function renderTrack(melodySrc: string, bpm: number, targetSec: number): Float32Array {
  const notes = parseMelody(melodySrc);
  const beatSec = 60 / bpm;
  const oneRound = notes.reduce((a, x) => a + x.beats * beatSec, 0);
  const rounds = Math.max(1, Math.ceil(targetSec / oneRound));
  const total = Math.round(oneRound * rounds * SAMPLE_RATE) + SAMPLE_RATE;
  const buf = new Float32Array(total);

  let cursor = 0;
  for (let r = 0; r < rounds; r++) {
    for (const { freq, beats } of notes) {
      const dur = beats * beatSec;
      // 音尾留 15% 让它自然衰完，音与音之间才不会糊成一片。
      const wave = renderNote(freq, dur * 1.15, 0.22);
      const at = Math.round(cursor * SAMPLE_RATE);
      for (let i = 0; i < wave.length && at + i < buf.length; i++) buf[at + i] += wave[i];
      cursor += dur;
    }
  }
  return reverb(buf);
}

/** Float32 → 16 位单声道 WAV。归一化到 -1dBFS，别削顶。 */
function toWav(samples: Float32Array): Buffer {
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const scale = peak > 0 ? 0.89 / peak : 1;

  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * scale * 32767))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** WAV → FLAC，最高压缩档；目标已存在时覆盖（重跑脚本是常态）。 */
function encodeFlac(wavPath: string, flacPath: string): void {
  execFileSync("flac", ["--silent", "--best", "--force", "-o", flacPath, wavPath]);
}

// ── 曲目表 ──────────────────────────────────────────────────
//
// 「年代」一栏不是装饰：它就是"这首为什么可以放进来"的答案。
// 往下加曲子时，先能填上这一栏再动手。

interface Tune {
  title: string;
  /** 出处与年代——公有领域的依据。 */
  origin: string;
  bpm: number;
  melody: string;
}

/** 十首儿歌。 */
const NURSERY: Tune[] = [
  {
    title: "小星星",
    origin: "法国童谣《Ah! vous dirai-je, maman》，1761",
    bpm: 108,
    melody: `C4 C4 G4 G4 A4 A4 G4:2 F4 F4 E4 E4 D4 D4 C4:2
             G4 G4 F4 F4 E4 E4 D4:2 G4 G4 F4 F4 E4 E4 D4:2
             C4 C4 G4 G4 A4 A4 G4:2 F4 F4 E4 E4 D4 D4 C4:2`,
  },
  {
    title: "两只老虎",
    origin: "法国童谣《Frère Jacques》，18 世纪",
    bpm: 116,
    melody: `C4 D4 E4 C4 C4 D4 E4 C4 E4 F4 G4:2 E4 F4 G4:2
             G4 A4 G4 F4 E4 C4 G4 A4 G4 F4 E4 C4
             C4 G3 C4:2 C4 G3 C4:2`,
  },
  {
    title: "伦敦桥",
    origin: "英格兰童谣《London Bridge Is Falling Down》，17 世纪",
    bpm: 112,
    melody: `G4 A4 G4 F4 E4 F4 G4:2 D4 E4 F4:2 E4 F4 G4:2
             G4 A4 G4 F4 E4 F4 G4:2 D4:2 G4 E4 C4:2`,
  },
  {
    title: "玛丽有只小羊羔",
    origin: "美国童谣《Mary Had a Little Lamb》，1830",
    bpm: 104,
    melody: `E4 D4 C4 D4 E4 E4 E4:2 D4 D4 D4:2 E4 G4 G4:2
             E4 D4 C4 D4 E4 E4 E4 E4 D4 D4 E4 D4 C4:4`,
  },
  {
    title: "划船歌",
    origin: "英美轮唱曲《Row, Row, Row Your Boat》，1852",
    bpm: 96,
    melody: `C4:1.5 C4:1.5 C4 D4 E4:3
             E4 D4 E4 F4 G4:3
             C5 C5 C5 G4 G4 G4 E4 E4 E4 C4 C4 C4
             G4 F4 E4 D4 C4:3`,
  },
  {
    title: "生日快乐",
    origin: "《Happy Birthday to You》，1893；2016 年判入公有领域",
    bpm: 100,
    melody: `G3:0.5 G3:0.5 A3 G3 C4 B3:2
             G3:0.5 G3:0.5 A3 G3 D4 C4:2
             G3:0.5 G3:0.5 G4 E4 C4 B3 A3:2
             F4:0.5 F4:0.5 E4 C4 D4 C4:2`,
  },
  {
    title: "老麦克唐纳有个农场",
    origin: "英美童谣《Old MacDonald Had a Farm》，1917 年前已流传",
    bpm: 120,
    melody: `G4 G4 G4 D4 E4 E4 D4:2 B4 B4 A4 A4 G4:2
             D4 G4 G4 G4 D4 E4 E4 D4:2 B4 B4 A4 A4 G4:2`,
  },
  {
    title: "雨呀雨呀快走开",
    origin: "英格兰童谣《Rain Rain Go Away》，17 世纪",
    bpm: 100,
    melody: `G4 E4 G4:2 A4 G4 E4:2 G4 E4 G4 E4 A4 G4 E4:2
             G4 E4 G4:2 A4 G4 E4:2 G4 G4 E4 G4 A4 G4 E4:2`,
  },
  {
    title: "小蜜蜂",
    origin: "德国童谣《Summ, summ, summ》，1835",
    bpm: 116,
    melody: `G4 E4 E4:2 F4 D4 D4:2 C4 D4 E4 F4 G4 G4 G4:2
             G4 E4 E4:2 F4 D4 D4:2 C4 E4 G4 G4 C4:3`,
  },
  {
    title: "铃儿响叮当",
    origin: "《Jingle Bells》，James Pierpont，1857",
    bpm: 124,
    melody: `E4 E4 E4:2 E4 E4 E4:2 E4 G4 C4 D4 E4:4
             F4 F4 F4 F4 F4 E4 E4 E4 E4 D4 D4 E4 D4:2 G4:2`,
  },
];

/*
 * 「优美的歌曲」那九首不在这里：器乐最能听出合成痕迹，改用公有领域的真实演奏录音
 * （Musopen 的 CC0 肖邦全集），走 `corepack pnpm demo:music`（`fetch-demo-music.mts`）。
 */

// ── 故事 ────────────────────────────────────────────────────
//
// 全是伊索寓言（公元前，公有领域）。中文是这里现写的，不抄任何一版译本：
// 译文本身有著作权，原著进入公有领域不等于译文也能用。
//
// 用词上避开了「暖」及其同音近音（暖/nuǎn），免得播故事时把语音哨兵叫起来。

interface Story {
  title: string;
  origin: string;
  text: string;
}

const STORIES: Story[] = [
  {
    title: "龟兔赛跑",
    origin: "伊索寓言",
    text:
      "兔子笑乌龟走得慢，乌龟说，那我们比一场吧。" +
      "发令之后，兔子几步就把乌龟甩得没影了。它回头一看，路上空空的，就想，躺一会儿也来得及。" +
      "这一躺就睡着了。乌龟一步一步地爬，没有停过，从兔子身边过去的时候也没有叫醒它。" +
      "等兔子醒来，乌龟已经在终点那边了。跑得快没有用，不停下来才有用。",
  },
  {
    title: "狼来了",
    origin: "伊索寓言",
    text:
      "山坡上有个放羊的孩子，觉得一个人太闷，就大声喊，狼来了，狼来了。" +
      "村里的人扔下手里的活跑上山，什么也没有。孩子笑得直不起腰。第二天他又喊了一次，大家又跑上来一趟。" +
      "第三天，狼真的来了。孩子拼命地喊，可是山下没有一个人抬头。" +
      "说谎话的人，就算这一次说的是真的，也没有人肯信了。",
  },
  {
    title: "北风与太阳",
    origin: "伊索寓言",
    text:
      "北风和太阳争论谁更有本事。正好路上走来一个披着斗篷的人，它们说，谁能让他把斗篷脱下来，谁就赢。" +
      "北风先来，它使劲地吹，越吹越猛。可是风越大，那个人把斗篷裹得越紧。" +
      "轮到太阳，它只是安安静静地照着。走了一会儿，那个人自己就把斗篷解开了。" +
      "硬来办不成的事，和气反而办得成。",
  },
];

// ── 主流程 ──────────────────────────────────────────────────

/**
 * 故事朗读走项目自己的阿里云档（DashScope `qwen3-tts-flash`），不用 macOS 的 `say`：
 * 项目已接神经网络 TTS，`.env` 里已配好 key。
 *
 * 直接调 `gateway` 的 `synthesizeSpeech`（不经 HTTP）：那是这条协议的唯一实现，
 * 这里不另写一份 DashScope 请求，避免音色与档位分家（例如拿豆包音色名打 DashScope
 * 会 400，见 `tts/synthesize.ts` 的注释）。
 *
 * 音色由 `ALIYUN_TTS_VOICE` 定，缺省 `Cherry`。
 */
const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY?.trim() ?? "";

/** 合成一段旁白落成 FLAC，返回秒数。 */
async function narrateToFlac(text: string, flacPath: string, tmpBase: string): Promise<number> {
  const values = new Map<string, string>([["DASHSCOPE_API_KEY", DASHSCOPE_KEY]]);
  for (const k of ["DASHSCOPE_BASE_URL", "ALIYUN_TTS_MODEL", "ALIYUN_TTS_VOICE"]) {
    const v = process.env[k]?.trim();
    if (v) values.set(k, v);
  }
  // synthesizeSpeech 三档一律交出 WAV（ACR-067；百炼回的不是 WAV 时它会报错）
  const { bytes } = await synthesizeSpeech(values, text, { engine: "aliyun" });
  const wav = `${tmpBase}.wav`;
  writeFileSync(wav, bytes);
  encodeFlac(wav, flacPath);
  // WAV 头 44 字节；采样率从头里读，别假设它是 22.05k。
  const rate = bytes.readUInt32LE(24);
  const bits = bytes.readUInt16LE(34);
  const ch = bytes.readUInt16LE(22);
  return Math.round((statSync(wav).size - 44) / (rate * ch * (bits / 8)));
}

const MEDIA_DIR =
  process.env.MOCK_CABIN_MEDIA_DIR ?? new URL("../../../mocks/cabin/media/", import.meta.url).pathname;

function requireTool(bin: string, hint: string): void {
  try {
    execFileSync("/usr/bin/env", ["which", bin], { stdio: "ignore" });
  } catch {
    console.error(`✗ 缺 ${bin}——${hint}`);
    process.exit(1);
  }
}

/**
 * 文件名就是元数据（曲库按第一个 ` - ` 拆艺人与曲名，见 `media/library.ts`）。
 * 三个"艺人"名把三组分开，车主说「放个故事」时 `select query=故事` 就能命中。
 */
function fileNameFor(artist: string, title: string): string {
  return `${artist} - ${title}.flac`;
}

/**
 * 写 `library.json`（曲库的 sidecar，按文件名覆盖字段）。
 *
 * # 为什么必须写：容器里探不出时长
 *
 * `media/library.ts` 的 `probeDuration` 先试 `afinfo`（macOS 自带）、再试 `ffprobe`，
 * 两个都没有就返回 null。mock-cabin 跑在 Alpine 容器里，两个都没有，
 * 曲库里每一首的 `durationSec` 恒为 null，模型无法转述"这首多长"。
 *
 * 生成器知道确切秒数（合成的按采样数算，朗读的按 WAV 字节数算），写进 sidecar。
 * 已经在目录里、不是本次生成的那些（比如那首垫底曲）用宿主的 `afinfo` 探一次，
 * 本脚本只跑在 macOS 上（它依赖 `say`）。
 *
 * sidecar 与音频一样不入 git（`media/.gitignore` 里有 `library.json`）。
 */
function writeSidecar(durations: Map<string, number>): void {
  for (const f of readdirSync(MEDIA_DIR)) {
    if (!f.toLowerCase().endsWith(".flac") || durations.has(f)) continue;
    try {
      const info = execFileSync("afinfo", [join(MEDIA_DIR, f)], { encoding: "utf8" });
      const m = /estimated duration:\s*([\d.]+)\s*sec/i.exec(info);
      if (m) durations.set(f, Math.round(Number(m[1])));
    } catch {
      // 探不出就算了：时长是锦上添花，没有它照样能放（与 library.ts 同一条纪律）。
    }
  }
  const payload: Record<string, { durationSec: number }> = {};
  for (const [name, sec] of [...durations].sort()) payload[name] = { durationSec: sec };
  writeFileSync(join(MEDIA_DIR, "library.json"), `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\n✓ library.json：${Object.keys(payload).length} 首的时长（容器里 afinfo/ffprobe 都没有，探不出来）`);
}

async function main(): Promise<void> {
  requireTool("flac", "FLAC 编码器：brew install flac");
  if (!DASHSCOPE_KEY) {
    console.error("✗ DASHSCOPE_API_KEY 未配置——故事旁白走阿里云档，没有它合成不了。\n  先 `set -a; source .env; set +a` 再跑。");
    process.exit(1);
  }

  if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "cabinhug-media-"));
  let made = 0;

  /** 文件名 → 秒数。写进 library.json，理由见 `writeSidecar`。 */
  const durations = new Map<string, number>();

  const emitTune = (artist: string, tune: Tune, targetSec: number) => {
    const wav = join(tmp, "t.wav");
    const samples = renderTrack(tune.melody, tune.bpm, targetSec);
    writeFileSync(wav, toWav(samples));
    const name = fileNameFor(artist, tune.title);
    encodeFlac(wav, join(MEDIA_DIR, name));
    durations.set(name, Math.round(samples.length / SAMPLE_RATE));
    made += 1;
    console.log(`  ✓ ${name}   ← ${tune.origin}`);
  };

  console.log(`\n儿歌（${NURSERY.length} 首）`);
  for (const t of NURSERY) emitTune("Cabinhug 童谣", t, 45);

  console.log(`\n故事（${STORIES.length} 篇，人声——放它们时哨兵可能被干扰）`);
  for (const s of STORIES) {
    const name = fileNameFor("Cabinhug 故事", s.title);
    const sec = await narrateToFlac(s.text, join(MEDIA_DIR, name), join(tmp, "s"));
    durations.set(name, sec);
    made += 1;
    console.log(`  ✓ ${name}   ← ${s.origin}`);
  }

  writeSidecar(durations);

  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n共 ${made} 条 → ${MEDIA_DIR}`);
  console.log("下一步：curl -sX POST localhost:8793/media/library 让车机重扫（不用重启服务）");
  console.log("⚠ 音频不进 git（media/.gitignore 挡着）：商业分发的顾虑之外，这些也没必要入库——跑一次就有。");
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
