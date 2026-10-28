//! 哨兵监听的**纯逻辑层**，车机端与手机端共用。
//!
//! # 共用的三块判据
//!
//! 这三块各端复制一份会各自漂移，两端行为出现分歧且不报错：
//!
//!  - [`wake`]：唤醒词与控制口令表。两端听得懂的话必须一致，
//!    例如「暖暖，退下」在车上与手机上同样生效。
//!  - [`windows`]：唤醒后的对话窗口时长。两端的"喊一次能说几句"
//!    必须是同一个数。
//!  - [`degrade`]：转写连败进降级、退避探测。
//!
//! **循环本身不共用**（cpal 起停、AEC、播报期窄通道）：车机那份与
//! 本地 TTS 深度交织（回声消除、播报期打断），手机端没有本地播报。
//! 抽成带钩子的通用循环需要重写车机已验证的组件，因此两端各留一份循环、
//! 共用这三块判据。
//!
//! 三个模块都是纯函数 / 纯状态机：不碰设备、不碰网络、时钟由调用方注入，
//! 因此可以脱离 Tauri 直接单测（`cargo test -p cabinhug-voice`）。

pub mod degrade;
pub mod wake;
pub mod windows;

pub use degrade::DegradeGate;
pub use wake::{classify, has_wake_word, is_interrupt, WakeOutcome};
pub use windows::{WakeWindows, WindowConfig, WindowKind};
