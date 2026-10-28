/**
 * 端上不带 MP3/AAC 解码器（ACR-068）。
 *
 * 车载设备的解码器随每台设备出货，AAC 仍由专利池收费。rodio 的缺省 feature 会把
 * symphonia 的 MP3 与 MP4/AAC 解码带进来，而 `cargo update`、新加一个依赖或某处
 * 写回 `rodio = "0.22"` 都可能让它们悄悄回来，编译与运行都不会报错。这里守两层：
 *
 *  1. Cargo.lock 里没有任何 MP3/AAC 解码 crate（解析结果，最终出货的依据）；
 *  2. 声明 rodio 的 workspace 成员一律 `default-features = false`（出错时指向改哪里）。
 *
 * TTS 由网关下发 WAV（ACR-067），曲库是 FLAC，端上留 WAV / FLAC / Vorbis 三种解码。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../../", import.meta.url).pathname;

/** 提供 MP3 或 AAC（含承载 AAC 的 MP4 容器）解码的 crate。发现新的同类 crate 时加在这里。 */
const FORBIDDEN_DECODER_CRATES = [
  "symphonia-bundle-mp3",
  "symphonia-codec-aac",
  "symphonia-format-isomp4",
  "minimp3",
  "minimp3_fixed",
  "minimp3-sys",
  "puremp3",
  "fdk-aac",
  "fdk-aac-sys",
];

/** 端上要保留的解码：缺了说明 feature 收窄过头，TTS（WAV）或曲库（FLAC）会放不出声。 */
const REQUIRED_DECODER_CRATES = ["symphonia-bundle-flac", "symphonia-format-riff", "symphonia-codec-pcm"];

/** Cargo.lock 里每个 `[[package]]` 的 name。 */
function lockedCrateNames(lock: string): Set<string> {
  const prefix = 'name = "';
  const names = new Set<string>();
  for (const line of lock.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(prefix) && trimmed.endsWith('"')) names.add(trimmed.slice(prefix.length, -1));
  }
  return names;
}

/** 根 Cargo.toml 的 `members = [ … ]` 列表。 */
function workspaceMembers(rootManifest: string): string[] {
  const start = rootManifest.indexOf("members = [");
  assert.ok(start >= 0, "根 Cargo.toml 里没有 members 列表");
  const end = rootManifest.indexOf("]", start);
  // 引号之间的才是成员路径：按引号切开后奇数位即是
  return rootManifest
    .slice(start, end)
    .split('"')
    .filter((_, i) => i % 2 === 1);
}

/** 成员清单里声明 rodio 的那一段（内联写法取那一行，表写法取整张表）；没声明返回 null。 */
function rodioDeclaration(manifest: string): string | null {
  const lines = manifest.split("\n");
  const inline = lines.find((l) => l.trimStart().startsWith("rodio ") || l.trimStart().startsWith("rodio="));
  if (inline) return inline;
  const tableAt = lines.findIndex((l) => l.trim() === "[dependencies.rodio]");
  if (tableAt < 0) return null;
  const rest = lines.slice(tableAt + 1);
  const nextTable = rest.findIndex((l) => l.trimStart().startsWith("["));
  return rest.slice(0, nextTable < 0 ? rest.length : nextTable).join("\n");
}

describe("[ACR-068] 端上不带 MP3/AAC 解码器", () => {
  const lock = lockedCrateNames(readFileSync(join(ROOT, "Cargo.lock"), "utf8"));

  it("Cargo.lock 里没有 MP3/AAC 解码 crate", () => {
    const found = FORBIDDEN_DECODER_CRATES.filter((name) => lock.has(name));
    assert.deepEqual(
      found,
      [],
      `锁文件里出现了 MP3/AAC 解码 crate：${found.join(", ")}。` +
        "用 `cargo tree -i <crate>` 找出是谁引入的；rodio 要 default-features = false 且不开 mp3 / mp4。",
    );
  });

  it("WAV 与 FLAC 解码仍在：收窄 feature 没有收过头", () => {
    const missing = REQUIRED_DECODER_CRATES.filter((name) => !lock.has(name));
    assert.deepEqual(missing, [], `锁文件里缺少端上要用的解码 crate：${missing.join(", ")}`);
  });

  it("声明 rodio 的 workspace 成员一律关掉缺省 feature", () => {
    const members = workspaceMembers(readFileSync(join(ROOT, "Cargo.toml"), "utf8"));
    const declaring = members
      .map((member) => ({ member, decl: rodioDeclaration(readFileSync(join(ROOT, member, "Cargo.toml"), "utf8")) }))
      .filter((m): m is { member: string; decl: string } => m.decl !== null);
    // 至少要找到车机与共享 TTS 核两处，否则是解析坏了而不是"没人用 rodio"
    assert.ok(declaring.length >= 2, `只找到 ${declaring.length} 个声明 rodio 的成员，解析可能失效`);
    for (const { member, decl } of declaring) {
      assert.match(decl, /default-features\s*=\s*false/, `${member}/Cargo.toml 的 rodio 没有 default-features = false`);
    }
  });
});
