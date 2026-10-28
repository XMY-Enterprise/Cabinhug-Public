/**
 * 车机端设置页的「播报音量」滑块：调节暖暖说话的响度。
 *
 * 这几条守的都是改错后不报错、只是功能不对的地方：默认值退回 0（AtomicU32 的
 * Default）时车机无声；起播不下发增益时滑块只对下一句生效；
 * 命令漏注册时端上报 command not found，服务端日志无异常。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { clampVolume, DEFAULT_VOLUME } from "../src/features/settings/volume";

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), "utf8");
const SETTINGS = read("../src/features/settings/SettingsScreen.tsx");
const TTS_RS = read("../src-tauri/src/tts/mod.rs");
const PREFS_RS = read("../src-tauri/src/commands/prefs.rs");
const LIB_RS = read("../src-tauri/src/lib.rs");

describe("播报音量：Rust 侧", () => {
  it("出厂默认 15，且两侧同值——没设过音量的车机既不哑也不吓人", () => {
    assert.equal(DEFAULT_VOLUME, 15);
    assert.match(TTS_RS, new RegExp(`pub const DEFAULT_VOLUME_PERCENT: u32 = ${DEFAULT_VOLUME};`));
    assert.match(SETTINGS, /useState\(DEFAULT_VOLUME\)/);
    assert.match(TTS_RS, /Self\(AtomicU32::new\(DEFAULT_VOLUME_PERCENT\)\)/);
    assert.match(TTS_RS, /fn load_volume_prefs[\s\S]*?\.unwrap_or\(DEFAULT_VOLUME_PERCENT\)/);
  });

  it("起播时把增益下发给 rodio，且在 append 之前", () => {
    const body = TTS_RS.slice(TTS_RS.indexOf("fn start_playback(audio: Vec<u8>, gain: f32)"));
    const setAt = body.indexOf("player.set_volume(gain)");
    const appendAt = body.indexOf("player.append(");
    assert.ok(setAt > 0 && appendAt > setAt, "先出第一帧再压音量，每句开头都会有一小截原始响度");
  });

  /*
   * 守的不变量是「起播用的增益来自当前音量」，不绑定某一种调用写法。
   * 增益可以在循环外求值一次（分段播报排进同一个输出队列，逐块重算既多余又可能中途变值），
   * 因此断言顺着值走：先认出 `drive` 里那次求值绑给了谁，再要求起播传的就是它。
   */
  it("起播的增益取自当前音量——直接传或先绑到局部都算（TD-55）", () => {
    const drive = TTS_RS.slice(TTS_RS.indexOf("async fn drive("));
    // 只认两种实参：当场求值，或一个局部变量名。其他写法（表达式、字段访问）
    // 超出本断言覆盖的形状，一律判失败。
    const call = drive.match(
      /start_playback\(bytes,\s*(gain_for_percent\(state\.volume_percent\(\)\)|[A-Za-z_][A-Za-z0-9_]*)\)/,
    );
    assert.ok(call, "drive 里找不到形如 start_playback(bytes, <增益>) 的起播调用");
    const arg = call[1];

    const LIVE_GAIN = "gain_for_percent(state.volume_percent())";
    if (arg === LIVE_GAIN) return; // 直接传
    // 否则必须是同一函数里从当前音量算出来的那个局部变量。
    assert.match(
      drive.slice(0, call.index),
      new RegExp(`let\\s+${arg}\\s*=\\s*gain_for_percent\\(state\\.volume_percent\\(\\)\\);`),
      `起播传的是 ${arg}，但它不是从 ${LIVE_GAIN} 算来的——滑块只会对下一句生效`,
    );
  });

  it("拖动对正在播的那句立即生效", () => {
    const body = TTS_RS.slice(TTS_RS.indexOf("pub fn set_volume_percent"));
    assert.match(body, /Playback::Sink \{ player, \.\. \}[\s\S]*?player\.set_volume\(gain_for_percent\(percent\)\)/);
  });

  it("三条命令都注册了，启动时载入偏好", () => {
    for (const cmd of ["get_broadcast_volume", "set_broadcast_volume", "preview_broadcast_volume"]) {
      assert.match(PREFS_RS, new RegExp(`#\\[tauri::command\\]\\s*\\n\\s*pub fn ${cmd}\\(`));
      assert.match(LIB_RS, new RegExp(`commands::prefs::${cmd},`));
    }
    assert.match(LIB_RS, /tts_state\.load_volume_prefs\(p\)/);
  });

  it("试听走 speak 的正门，受播报开关约束", () => {
    const body = PREFS_RS.slice(PREFS_RS.indexOf("pub fn preview_broadcast_volume"));
    assert.match(body, /crate::tts::speak\(&app, &state, /);
  });
});

describe("播报音量：设置页", () => {
  it("滑块在「播报」组里、命令不在时不渲染", () => {
    const group = SETTINGS.slice(SETTINGS.indexOf("<h2>播报</h2>"), SETTINGS.indexOf("<h2>界面音效</h2>"));
    assert.match(group, /\{volumeAvailable && \(/);
    assert.match(group, /type="range"[\s\S]*?min=\{0\}[\s\S]*?max=\{100\}/);
    assert.match(group, /disabled=\{!broadcast\}/);
  });

  it("界面每一下都跟，落盘节流；试听前先把当前档落下去", () => {
    assert.match(SETTINGS, /const changeVolume[\s\S]*?setVolume\(v\);[\s\S]*?setTimeout\([\s\S]*?"set_broadcast_volume"/);
    assert.match(SETTINGS, /const previewVolume[\s\S]*?"set_broadcast_volume"[\s\S]*?"preview_broadcast_volume"/);
  });

  it("clampVolume：只认 0~100 的整数，NaN 退回出厂默认", () => {
    assert.equal(clampVolume(37.4), 37);
    assert.equal(clampVolume(-5), 0);
    assert.equal(clampVolume(140), 100);
    assert.equal(clampVolume(Number.NaN), DEFAULT_VOLUME);
  });
});
