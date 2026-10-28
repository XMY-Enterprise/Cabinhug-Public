/**
 * 演示曲库的真实录音（`corepack pnpm demo:music`）。
 *
 * # 与 `gen-demo-media.mts` 的分工
 *
 * 那个是合成（正弦波叠泛音）。这个下载真人演奏的录音：Musopen 的肖邦全集，
 * 钢琴家实录，CC0。
 *
 * # 为什么只有 CC0 / 公有领域，以及为什么每次都重新查一遍
 *
 * `mocks/cabin/media/.gitignore` 的纪律成立：商业发行的音乐不进这个仓库。
 * CC0 的真实录音可以用。
 *
 * archive.org 的 `licenseurl` 是上传者自己填的，不是平台核过的。
 * 所以这里的判据分两层：
 *
 *  1. 只取 Musopen 这一个来源——它是个以"把古典乐录音放进公有领域"为宗旨的组织，
 *     CC0 声明是它自己作的，不是某个上传者随手勾的；
 *  2. 每次下载前重新拉一次 item 的 `licenseurl` 比对，对不上就整体中止。
 *     写死在清单里的许可证会过期（条目被替换、被重新授权），且没有征兆。
 *
 * 逐条的来源与许可证同时写进 `media/PROVENANCE.md`，那份是给人看的凭据。
 *
 * # 为什么取 FLAC 原件、不要 ffmpeg
 *
 * 出声位在车机端，车机端只解 WAV / FLAC / Vorbis（ACR-068：车载设备不带 MP3/AAC
 * 解码器）。Musopen 那个 item 里 FLAC 和 MP3 都有，直接取 FLAC 原件：不转码，
 * 也不依赖本机哪个 ffmpeg 可用。下完用 `flac -t` 解一遍校验。
 *
 * # 为什么只取 16 bit、20 MiB 以内的
 *
 * mock-cabin 单曲上限 20 MiB（`mocks/cabin/src/index.ts` 的 `TRACK_BYTES_LIMIT`），
 * 车机端整曲拉进内存再解。同一 item 里有一批 24 bit 原件（最大 75 MiB），会被 413。
 * 所以下载前按 item 元数据逐首核对格式（`Flac` 即 16 bit）与大小，有一首不符就整体中止，
 * 不留半套曲库。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 单曲字节上限，与 mock-cabin 的 `TRACK_BYTES_LIMIT` 同值。 */
const TRACK_BYTES_LIMIT = 20 * 1024 * 1024;
/** archive.org 元数据里 16 bit FLAC 的 format 字段（24 bit 的是 `24bit Flac`）。 */
const FLAC_16BIT_FORMAT = "Flac";

/** 只认这两种许可证。别的一律不下——包括各种 CC-BY，它们要署名，演示里给不出。 */
const ACCEPTED_LICENSES = [
  "https://creativecommons.org/publicdomain/zero/1.0/",
  "http://creativecommons.org/publicdomain/zero/1.0/",
  "https://creativecommons.org/publicdomain/mark/1.0/",
  "http://creativecommons.org/publicdomain/mark/1.0/",
];

interface Source {
  /** archive.org 的 item 标识。 */
  item: string;
  /** 这个 item 是什么、为什么可信。 */
  note: string;
  /** item 里的文件名 → 落到曲库里的「艺人 - 曲名」。 */
  picks: Array<{ file: string; artist: string; title: string }>;
}

const CHOPIN = "肖邦（Musopen CC0）";

const SOURCES: Source[] = [
  {
    item: "musopen-chopin-complete-works-flac",
    note: "Musopen《肖邦全集》。Musopen 是专做「把古典乐录音放进公有领域」的非营利组织，CC0 由它自己声明。真人钢琴演奏，非合成。",
    picks: [
      // 全部是 16 bit FLAC 原件、单曲 ≤ 20 MiB（ACR-068 换掉了原件超限的 5 首）
      { file: "Nocturne in E minor, Op. posth. 72.flac", artist: CHOPIN, title: "e小调夜曲 Op.72 No.1（遗作）" },
      { file: "Nocturne in C sharp minor, Op. 27 no. 1.flac", artist: CHOPIN, title: "升c小调夜曲 Op.27 No.1" },
      { file: "Waltz in D flat major 'Minute', Op. 64 no. 1.flac", artist: CHOPIN, title: "小狗圆舞曲 Op.64 No.1" },
      { file: "Waltz in G flat major, Op. 70 no. 1.flac", artist: CHOPIN, title: "降G大调圆舞曲 Op.70 No.1" },
      { file: "Preludes, Op. 28 - No. 15 'Raindrop'.flac", artist: CHOPIN, title: "雨滴前奏曲 Op.28 No.15" },
      { file: "Preludes, Op. 28 - No. 4 'Suffocation'.flac", artist: CHOPIN, title: "e小调前奏曲 Op.28 No.4" },
      { file: "Etude Op. 10, no. 3 in E major - 'Tristesse'.flac", artist: CHOPIN, title: "离别练习曲 Op.10 No.3" },
      { file: "Etude Op. 10, no. 12 in C minor - 'Revolutionary'.flac", artist: CHOPIN, title: "革命练习曲 Op.10 No.12" },
      { file: "Mazurka in A minor, Op. 17 no. 4.flac", artist: CHOPIN, title: "a小调玛祖卡 Op.17 No.4" },
    ],
  },
];

const MEDIA_DIR =
  process.env.MOCK_CABIN_MEDIA_DIR ?? new URL("../../../mocks/cabin/media/", import.meta.url).pathname;

interface ItemFile {
  format?: string;
  size?: string;
}

/** item 的许可证与文件表（文件名 → 格式 / 大小），一次请求取回。 */
async function itemMeta(item: string): Promise<{ license: string; files: Map<string, ItemFile> }> {
  const res = await fetch(`https://archive.org/metadata/${item}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`取 item 元数据失败 ${item}: HTTP ${res.status}`);
  const meta = (await res.json()) as { metadata?: { licenseurl?: string }; files?: Array<ItemFile & { name: string }> };
  const files = new Map((meta.files ?? []).map((f) => [f.name, f] as const));
  return { license: meta.metadata?.licenseurl ?? "", files };
}

/** 下载前逐首核对：在 item 里、是 16 bit FLAC、不超过单曲上限。返回不合格的说明。 */
function unfitPicks(picks: Source["picks"], files: Map<string, ItemFile>): string[] {
  const problems: string[] = [];
  for (const p of picks) {
    const f = files.get(p.file);
    const size = Number(f?.size ?? NaN);
    if (!f) problems.push(`${p.file}：item 里没有这个文件`);
    else if (f.format !== FLAC_16BIT_FORMAT) problems.push(`${p.file}：格式是「${f.format}」，不是 16 bit FLAC`);
    else if (!(size <= TRACK_BYTES_LIMIT)) problems.push(`${p.file}：${(size / 1048576).toFixed(1)} MiB，超过单曲上限 20 MiB`);
  }
  return problems;
}

async function download(item: string, file: string, dest: string): Promise<number> {
  const url = `https://archive.org/download/${item}/${encodeURIComponent(file)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`下载失败 ${file}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 100_000) throw new Error(`${file} 只有 ${bytes.length} 字节，不像一首曲子`);
  writeFileSync(dest, bytes);
  return bytes.length;
}

/** 下完当场解一遍（`flac -t` 全量解码并核对 MD5），确认能放，而不只是下载成功。 */
function decodes(path: string): boolean {
  try {
    execFileSync("flac", ["-t", "-s", path], { stdio: "ignore", timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  try {
    execFileSync("/usr/bin/env", ["which", "flac"], { stdio: "ignore" });
  } catch {
    console.error("✗ 缺 flac——下完要用它解一遍校验：brew install flac");
    process.exit(1);
  }
  if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });
  const rows: string[] = [];
  let got = 0;

  for (const src of SOURCES) {
    const { license, files } = await itemMeta(src.item);
    if (!ACCEPTED_LICENSES.includes(license)) {
      console.error(
        `✗ ${src.item} 的许可证是「${license || "（空）"}」，不在允许清单里——整体中止。\n` +
          "  清单里写死的许可证会过期（条目被替换、被重新授权），而那种过期不会有任何征兆。",
      );
      process.exit(1);
    }
    const problems = unfitPicks(src.picks, files);
    if (problems.length > 0) {
      console.error(`✗ ${src.item} 有曲目不合要求，整体中止（不留半套曲库）：\n  ${problems.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`\n${src.item}\n  许可证 ${license} ✓\n  ${src.note}`);

    for (const p of src.picks) {
      const name = `${p.artist} - ${p.title}.flac`;
      const dest = join(MEDIA_DIR, name);
      const size = await download(src.item, p.file, dest);
      if (!decodes(dest)) {
        console.error(`✗ ${name} 下下来了但解不了——不留半成品`);
        process.exit(1);
      }
      got += 1;
      console.log(`  ✓ ${name}  ${(size / 1e6).toFixed(1)}MB`);
      rows.push(`| ${p.title} | ${p.artist} | \`${src.item}\` | ${license} | \`${p.file}\` |`);
    }
  }

  writeFileSync(
    join(MEDIA_DIR, "PROVENANCE.md"),
    [
      "# 演示曲库里那些**真实录音**的来源",
      "",
      "由 `corepack pnpm demo:music` 生成，**不要手改**——改了下一次下载就会把它覆盖掉。",
      "音频本身不入 git（`.gitignore` 挡着），这份凭据入。",
      "",
      "| 曲名 | 归入的艺人 | archive.org item | 许可证 | 原文件名 |",
      "|---|---|---|---|---|",
      ...rows,
      "",
      "脚本每次下载前会重新拉一次 item 的 `licenseurl` 与允许清单比对，对不上整体中止——",
      "写死在清单里的许可证会过期，而那种过期不会有任何征兆。",
      "",
      `更新于 ${new Date().toISOString().slice(0, 10)}`,
    ].join("\n") + "\n",
  );

  console.log(`\n共 ${got} 首真实录音 → ${MEDIA_DIR}`);
  console.log("凭据写在 media/PROVENANCE.md（入 git），音频不入 git。");
  console.log("下一步：corepack pnpm demo:media 补时长 sidecar，再 curl -sX POST localhost:8793/media/library 重扫");
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
