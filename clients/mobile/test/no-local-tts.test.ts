/**
 * [F-02-12] 手机端不出声：产品定调是手机端没有语音播报。
 *
 * # 守的是"不被接回来"
 *
 * 车机端有完整的播报链路（`cabinhug-tts`、音量、垫场话、播报中打断），手机端不接。
 * 接回来的表现是：车主在会议室里打字问一句，手机开始朗读。
 *
 * 五个入口一起钉住：Rust 侧的共享核依赖、iOS 系统合成、WebView 的 Web Speech、
 * 对话层那枚播报开关，以及浏览器演示版的装配。读源码，不渲染。
 *
 * 第五个入口独立于前四个：浏览器垫片的播报不经任何浏览器语音 API，而是打网关的
 * `/v1/tts/speech` 拿 WAV（ACR-067）、用 `<audio>` 放；浏览器构建也不经过 Cargo。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      // `gen/` 是 Tauri 生成的 Xcode 工程与编译产物，不是手写源码。
      if (name === "gen" || name === "target" || name === "node_modules" || name === "dist") continue;
      walk(p, out);
    } else if (/\.(ts|tsx|rs)$/.test(name)) out.push(p);
  }
  return out;
}

const here = fileURLToPath(new URL(".", import.meta.url));
const SOURCES = [...walk(join(here, "../src")), ...walk(join(here, "../src-tauri/src"))];
const CARGO = readFileSync(join(here, "../src-tauri/Cargo.toml"), "utf8");
const APP = readFileSync(join(here, "../src/app/index.tsx"), "utf8");

describe("[F-02-12] 手机端没有任何出声的路", () => {
  it("Cargo 里没有 cabinhug-tts：共享核留着是给车机回接的，不是手机端待接的半成品", () => {
    assert.equal(/cabinhug-tts/.test(CARGO), false);
  });

  it("端上代码里没有系统语音合成（iOS AVSpeech / Web Speech）", () => {
    const hits: string[] = [];
    for (const f of SOURCES) {
      const src = readFileSync(f, "utf8");
      if (/AVSpeechSynthesizer|speechSynthesis|SpeechSynthesisUtterance/.test(src)) hits.push(f.slice(f.indexOf("clients/")));
    }
    assert.deepEqual(hits, [], `这几个 API 一出现就是「手机会出声」：${hits.join("、")}`);
  });

  /**
   * `DialogScreen` 有一枚播报开关（`broadcast` 属性，车机在用）。手机端不传它，
   * 那枚喇叭就不渲染；手机端没有播报可开。
   */
  it("对话页不传 broadcast：那枚喇叭是车机的", () => {
    assert.equal(/broadcast=\{/.test(APP), false);
  });

  /**
   * 浏览器演示版（ACR-049）的装配入口。`createSpeaker` 一旦传给 `installWebShim`，
   * 每轮收尾都会去打网关的 `/v1/tts/speech` 并当场播放。
   *
   * 车机的 `clients/cockpit/src/web-boot.ts` 保持接着，这份不对称是产品定调本身，
   * 这里连带断言它还在，避免"对齐"时两边一起改。
   */
  it("浏览器演示版的手机端不装 speaker；车机端仍装着（这份不对称就是定调）", () => {
    // 先剥注释再判：web-boot 的注释里写着为什么不给 speaker，不剥会误判。
    const code = (f: string) =>
      readFileSync(join(here, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
    assert.equal(/createSpeaker/.test(code("../src/web-boot.ts")), false, "手机端的 web-boot 又把播报接回来了");
    assert.ok(/createSpeaker/.test(code("../../cockpit/src/web-boot.ts")), "车机端的播报被顺手一起删了——只撤手机端，车机不动");
  });
});
