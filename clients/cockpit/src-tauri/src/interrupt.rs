//! 打断暖暖：端上唯一的打断入口（F-02-07 / F-45-07）。
//!
//! # 单一入口
//!
//! 「打断」不只是停播，而是按序完成三件事：
//!
//! 1. 停播：正文与垫场一起停，并把垫场槽位的三个标志复位；
//! 2. 取消服务端这一轮：否则 delta 继续回、turn_end 继续落库、
//!    垫场继续发，旧答案进入历史成为下一轮的上下文；
//! 3. 回 idle + 记下这一轮：之后到达的旧轮事件按 turnId 丢弃。
//!
//! 长按、单击、语音口令三条路都进这里，保证三步都不遗漏：漏 1 表现为仍在播报，
//! 漏 2 表现为两轮声音叠加，漏 3 表现为打断之后又冒出半句。
//!
//! # 顺序：先同步停播，再异步取消
//!
//! 取消要走一次网络往返（局域网约几十毫秒），而停播必须立刻发生。
//! 所以停播同步做完再 spawn 取消请求。
//!
//! 取消请求失败不回滚停播：声音停止即达成用户意图，
//! 服务端那一轮会按超时收敛。失败只记日志与计数，不弹错误，
//! 因为车主无法处置该错误。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};

use crate::events::StreamState;

/// 谁发起的打断。只用于计数与日志，不改变行为：
/// 三条路必须做同样的事。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InterruptSource {
    /// 长按说话。
    PushToTalk,
    /// 单击暖暖形象。
    Tap,
    /// 语音口令（播报期窄通道）。
    // 三条路共用同一个入口，由 `on_transcript_during_tts` 调用。
    #[allow(dead_code)]
    Voice,
}

impl InterruptSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::PushToTalk => "push_to_talk",
            Self::Tap => "tap",
            Self::Voice => "voice",
        }
    }
}

/// 打断计数，用于判断打断是否生效：
/// "停了但没取消"与"取消了但没停"在车里听起来难以区分。
#[derive(Default)]
pub struct InterruptCounters {
    pub by_push_to_talk: AtomicU64,
    pub by_tap: AtomicU64,
    pub by_voice: AtomicU64,
    /// 取消请求没送出去（网关不可达等）。声音照停，只是服务端那一轮要等自己超时。
    pub cancel_failed: AtomicU64,
    /// 因为"此刻没有在跑的轮"而只做了停播、没发取消。不是错误。
    pub no_active_turn: AtomicU64,
}

impl InterruptCounters {
    fn bump(&self, source: InterruptSource) {
        match source {
            InterruptSource::PushToTalk => &self.by_push_to_talk,
            InterruptSource::Tap => &self.by_tap,
            InterruptSource::Voice => &self.by_voice,
        }
        .fetch_add(1, Ordering::Relaxed);
    }
}

/// 打断当前这一轮。返回是否真的发出了取消请求（只停播时为 false）。
///
/// 任何状态下调用都是安全的：没有在跑的轮时退化成"停播 + 回 idle"，
/// 不发空取消、不报错。单击手势因此可以无条件调用。
pub fn interrupt_assistant(app: &AppHandle, source: InterruptSource) -> bool {
    if let Some(counters) = app.try_state::<Arc<InterruptCounters>>() {
        counters.bump(source);
    }

    // ① 停播。正文与垫场一起停。
    if let Some(tts) = app.try_state::<Arc<crate::tts::TtsState>>() {
        crate::tts::stop(&tts);
        /*
         * 垫场槽位复位（三个标志）。
         *
         * 不复位的话下一轮的垫场会被 `filler_slot()` 判成 `Drop`：
         * `body_active` 覆盖正文的整个播放期，打断在播放中途发生，
         * 该标志不会被清除，之后不再有垫场（`sidecarCounters` 的 dropped 计数可见）。
         */
        tts.reset_filler_slots();
    }

    // ② 记下这一轮 + 发取消。
    let Some(stream) = app.try_state::<Arc<StreamState>>() else {
        emit_idle(app);
        return false;
    };
    let Some((session_id, turn_id)) = stream.current_turn() else {
        // 没有在跑的轮：不发空取消。这不是错误，空闲时点一下暖暖就是这条路。
        if let Some(counters) = app.try_state::<Arc<InterruptCounters>>() {
            counters.no_active_turn.fetch_add(1, Ordering::Relaxed);
        }
        emit_idle(app);
        return false;
    };
    stream.mark_cancelled(&turn_id);

    let app_for_cancel = app.clone();
    let source_name = source.as_str();
    tauri::async_runtime::spawn(async move {
        let gateway = crate::commands::media::gateway_client();
        let outcome = gateway.cancel_turn(&session_id, Some(&turn_id)).await;
        if outcome.turn_id.is_none() {
            // 服务端那一轮已经收口了，或者请求没送到。两者对用户都一样
            // （声音已经停了），但排障时需要区分，所以在这里记录。
            if let Some(counters) = app_for_cancel.try_state::<Arc<InterruptCounters>>() {
                counters.cancel_failed.fetch_add(1, Ordering::Relaxed);
            }
        }
        if outcome.side_effect_in_flight {
            // 动作已经发出去了，无法取消（F-14-05）。这里只记录；
            // 如何告知车主由表现层负责，本函数不在打断时出声。
            eprintln!("[interrupt] 取消落在副作用窗口内：动作已发出（turn={turn_id}）");
        }
        eprintln!("[interrupt] {source_name} → 取消 turn={turn_id} 结果={:?}", outcome.turn_id);
    });

    // ③ 形象回位。放在最后：前两步都是瞬时的，中间插状态事件会让画面闪动。
    emit_idle(app);
    true
}

fn emit_idle(app: &AppHandle) {
    if let Err(e) = app.emit(
        cabinhug_core::fanout::EVENT_ASSISTANT_STATE,
        cabinhug_core::contract::AssistantState::Idle,
    ) {
        eprintln!("[interrupt] emit idle failed: {e}");
    }
}

/// 前端手势的入口（单击暖暖）。语音与长按在 Rust 侧直接调 `interrupt_assistant`。
#[tauri::command]
pub fn interrupt_assistant_cmd(app: AppHandle) -> bool {
    interrupt_assistant(&app, InterruptSource::Tap)
}

/// 打断计数快照（验收与排障用）。
#[tauri::command]
pub fn interrupt_stats(counters: tauri::State<'_, Arc<InterruptCounters>>) -> serde_json::Value {
    serde_json::json!({
        "pushToTalk": counters.by_push_to_talk.load(Ordering::Relaxed),
        "tap": counters.by_tap.load(Ordering::Relaxed),
        "voice": counters.by_voice.load(Ordering::Relaxed),
        "cancelFailed": counters.cancel_failed.load(Ordering::Relaxed),
        "noActiveTurn": counters.no_active_turn.load(Ordering::Relaxed),
    })
}
