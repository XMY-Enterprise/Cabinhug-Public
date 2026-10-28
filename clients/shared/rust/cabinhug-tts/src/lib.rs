//! cabinhug-tts — 暖暖播报的共享核。
//!
//! # 分层
//!
//! | 模块 | 管什么 | 车机侧对应 |
//! |---|---|---|
//! | [`text`] | 把回复里的 markdown 记号剥干净再送合成 | 车机 `tts/mod.rs::strip_markdown_for_speech` |
//! | [`endpoint`] | `GET /v1/tts/config` 的端上缓存：1.5s 超时、按 TTL 复查、拉不到沿用旧值 | 车机 `tts/endpoint.rs` |
//! | [`state`] | 在播句柄 + 代际守卫 + 静音开关 + 播报音量；`stop()` 返回新代际 | 车机 `TtsState` 的子集 |
//! | [`player`] | rodio 内存直解 | 车机 `start_playback` |
//! | [`speak`] | 合成 → 播放 → 收尾，状态经回调发射 | 车机 `play()` 去掉垫场/ducking/AEC/say |
//!
//! # 为什么是独立 crate
//!
//! 手机端的「出声播报」需要本地 TTS。车机侧实现大半是车机差异项，
//! 整体复制到手机会维护两份，因此只把两端共用的核抽到这里。

pub mod endpoint;
pub mod player;
pub mod speak;
pub mod state;
pub mod text;

pub use speak::{speak, SpeakCtx};
pub use state::{gain_for_percent, stop, TtsState, DEFAULT_VOLUME_PERCENT};
pub use text::strip_markdown_for_speech;
