//! 端上用户偏好（F-02-12）。
//!
//! 只放用户偏好：播报开关这类"这台车的主人怎么用"的选择。
//! 与运维配置注册表分开：后者是"系统连哪里、用谁的 key"，
//! 由系统管理员在后台改；前者由车主在端上改，跨重启保持。

use std::sync::Arc;

use tauri::{AppHandle, Manager, State};

use crate::tts::TtsState;

/// 读取播报开关（true = 播报开启）。
#[tauri::command]
pub fn get_broadcast_enabled(state: State<'_, Arc<TtsState>>) -> bool {
    !state.is_muted()
}

/// 设置播报开关；立即生效并持久化。关闭时停掉正在进行的播报。
#[tauri::command]
pub fn set_broadcast_enabled(app: AppHandle, state: State<'_, Arc<TtsState>>, enabled: bool) -> bool {
    state.set_muted(!enabled);
    if !enabled {
        // 关闭时同时停掉正在播的那句
        crate::tts::stop(&state);
        let _ = app.emit_assistant_idle();
    }
    enabled
}

/// 读取播报音量（百分比 0~100）。设置页「播报音量」滑块。
#[tauri::command]
pub fn get_broadcast_volume(state: State<'_, Arc<TtsState>>) -> u32 {
    state.volume_percent()
}

/// 设置播报音量；对正在播的那句立即生效并持久化。返回钳过的实际值。
///
/// 与播报开关分开：0 不等于关（见 `TtsState::volume` 的说明）。
#[tauri::command]
pub fn set_broadcast_volume(state: State<'_, Arc<TtsState>>, percent: u32) -> u32 {
    state.set_volume_percent(percent)
}

/// 试听：用当前音量说一句固定的话，让车主拖完滑块就能听到这一档有多响。
///
/// 走 `speak` 正常路径：受播报开关约束、进入 speaking 状态、让路哨兵。
/// 不另开"只出声不改状态"的路径，保证形象与声音一致。
#[tauri::command]
pub fn preview_broadcast_volume(app: AppHandle, state: State<'_, Arc<TtsState>>) {
    crate::tts::speak(&app, &state, "我现在就是这么大声，听得清吗？");
}

/// 读取垫场话开关（true = 垫场开启）。F-45-13。
#[tauri::command]
pub fn get_filler_enabled(state: State<'_, Arc<TtsState>>) -> bool {
    !state.is_filler_muted()
}

/// 设置垫场话开关；立即生效并持久化。
///
/// 与播报总开关分开：用户可能要正文播报但不要垫场。
/// 关闭时正在播的垫场也停掉，只停垫场、不碰正文（`stop_if_filler`）。
///
/// 这只是端上偏好。服务端需收到 `TurnInput.fillerEnabled` 才会停止生成垫场；
/// 仅端上丢弃时，服务端的判断逻辑与指标写入仍在运行，接 L1 后仍产生费用。
/// 该上行链路尚未接入。
#[tauri::command]
pub fn set_filler_enabled(state: State<'_, Arc<TtsState>>, enabled: bool) -> bool {
    state.set_filler_muted(!enabled);
    if !enabled {
        crate::tts::stop_if_filler(&state);
    }
    enabled
}

/// 读取「播报时可以出声打断」开关（F-52-01）。
#[tauri::command]
pub fn get_barge_in_enabled() -> bool {
    crate::voice::sentinel::BARGE_IN_ENABLED.load(std::sync::atomic::Ordering::Relaxed)
}

/// 设置「播报时可以出声打断」；立即生效并持久化。
///
/// 关闭时播报期哨兵整段丢帧，播报中说「停」不会被听见。
/// 保留该开关是因为回采过滤在极端环境（车内音量很大、扬声器离麦克风很近）
/// 可能不稳定，助手会被自己的播报打断；此时车主可以关掉出声打断。
#[tauri::command]
pub fn set_barge_in_enabled(app: AppHandle, enabled: bool) -> bool {
    crate::voice::sentinel::BARGE_IN_ENABLED
        .store(enabled, std::sync::atomic::Ordering::Relaxed);
    if let Some(path) = barge_in_prefs_path(&app) {
        if let Err(e) = std::fs::write(&path, if enabled { "on" } else { "off" }) {
            eprintln!("[voice] 打断偏好持久化失败: {e}");
        }
    }
    enabled
}

/// 启动时载入（跨重启保持）。文件不存在 = 默认开。
pub fn load_barge_in_pref(app: &AppHandle) {
    let Some(path) = barge_in_prefs_path(app) else { return };
    let enabled = std::fs::read_to_string(&path).map(|c| c.trim() != "off").unwrap_or(true);
    crate::voice::sentinel::BARGE_IN_ENABLED
        .store(enabled, std::sync::atomic::Ordering::Relaxed);
}

/// 打断偏好文件。与另外三个偏好各存一个，理由同 `filler_prefs_path`。
pub fn barge_in_prefs_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("barge-in-pref"))
}

// ── 哨兵监听（语音唤醒）总开关 ─────────────────────────

/// 读取「哨兵监听」开关（true = 常驻监听开着，能听见「暖暖你好」）。
///
/// 真相源是 [`crate::voice::sentinel::SENTINEL_ENABLED`]，不是偏好文件——
/// 文件只在启动时读一次，之后语音/HUD/设置页都改这个静态量。
#[tauri::command]
pub fn get_sentinel_enabled() -> bool {
    crate::voice::sentinel::SENTINEL_ENABLED.load(std::sync::atomic::Ordering::Relaxed)
}

/// 设置「哨兵监听」开关；立即生效并持久化。
///
/// 打开 = 麦克风常驻（VAD 分段 → 转写 → 唤醒词判定），车主说「暖暖你好」
/// 不用按任何按钮就能被听见；关闭 = 哨兵不建流，麦克风不被占用，
/// 长按说话（PTT）不受影响。
///
/// # 打开前先取得麦克风授权，取不到就不打开
///
/// 否则开关显示"已开启"而麦克风从未打开，唤醒词没有任何响应。
/// 取不到授权时返回 `permission_denied`，由界面回滚开关并说明原因。
#[tauri::command]
pub async fn set_sentinel_enabled(app: AppHandle, enabled: bool) -> Result<bool, String> {
    if enabled && !crate::commands::media::acquire_mic_permission().await {
        return Err("permission_denied".into());
    }
    apply_sentinel_enabled(&app, enabled);
    Ok(enabled)
}

/// 开关的唯一落点：置静态量 → 拨正在跑的哨兵 → 落盘。
///
/// 两个入口（设置页的 `set_sentinel_enabled` 与 HUD 麦克风图标的
/// `sentinel_set_switch`）必须做同样的三件事。缺任一件的后果：不置静态量 →
/// 重启后循环读到旧值；不拨哨兵 → 界面已变但麦克风还开着；不落盘 → 重启后恢复旧值。
pub fn apply_sentinel_enabled(app: &AppHandle, enabled: bool) {
    use std::sync::atomic::Ordering;
    crate::voice::sentinel::SENTINEL_ENABLED.store(enabled, Ordering::Relaxed);
    if enabled {
        /*
         * 打开时清掉降级锁。
         *
         * 降级在连败三次后锁上，自动解锁靠消费者的退避探测（15s→120s）。
         * 车主手动打开的语义是"再试一次"，不应等待退避。
         *
         * 只清这个原子量，不动消费者线程里的 `DegradeGate`：清掉后哨兵
         * 恢复采段，第一次转写成功会把 gate 整个复位（`on_success`）。
         * 链路仍然故障时，再连败三次会重新锁上。
         */
        crate::voice::sentinel::SENTINEL_DEGRADED.store(false, std::sync::atomic::Ordering::SeqCst);
    }

    if let Some(state) = app.try_state::<crate::commands::voice::SentinelState>() {
        state.set_switch(enabled);
    }
    if let Some(path) = sentinel_prefs_path(app) {
        if let Err(e) = std::fs::write(&path, if enabled { "on" } else { "off" }) {
            eprintln!("[sentinel] 监听开关持久化失败: {e}");
        }
    }
}

/// 启动时载入（跨重启保持）。文件不存在 = 关，与打断开关相反，
/// 理由见 `SENTINEL_ENABLED` 的文档：常驻麦克风不该是开箱默认。
pub fn load_sentinel_pref(app: &AppHandle) {
    let Some(path) = sentinel_prefs_path(app) else { return };
    let enabled = std::fs::read_to_string(&path).map(|c| c.trim() == "on").unwrap_or(false);
    crate::voice::sentinel::SENTINEL_ENABLED
        .store(enabled, std::sync::atomic::Ordering::Relaxed);
    eprintln!("[sentinel] 监听开关：{}（设置页「语音唤醒」）", if enabled { "开" } else { "关" });
}

/// 哨兵监听开关的偏好文件。与另外几个各存一个，理由同 `filler_prefs_path`。
pub fn sentinel_prefs_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("sentinel-pref"))
}

/// 读取垫场收尾方式。返回 "immediate" 或 "after_sentence"。
#[tauri::command]
pub fn get_filler_preempt_mode(state: State<'_, Arc<TtsState>>) -> String {
    match state.preempt_mode() {
        crate::tts::FillerPreemptMode::Immediate => "immediate".into(),
        crate::tts::FillerPreemptMode::AfterSentence => "after_sentence".into(),
    }
}

/// 设置垫场收尾方式；立即生效并持久化。
///
/// 只认这两个字面量，其它一律回落到默认的衔接，
/// 传错值时不能静默变成抢占。
#[tauri::command]
pub fn set_filler_preempt_mode(state: State<'_, Arc<TtsState>>, mode: String) -> String {
    let m = if mode == "immediate" {
        crate::tts::FillerPreemptMode::Immediate
    } else {
        crate::tts::FillerPreemptMode::AfterSentence
    };
    state.set_preempt_mode(m);
    match m {
        crate::tts::FillerPreemptMode::Immediate => "immediate".into(),
        crate::tts::FillerPreemptMode::AfterSentence => "after_sentence".into(),
    }
}

/// 关闭播报后把助手状态落回 idle（避免停在 speaking）。
trait EmitIdle {
    fn emit_assistant_idle(&self) -> Result<(), tauri::Error>;
}

impl EmitIdle for AppHandle {
    fn emit_assistant_idle(&self) -> Result<(), tauri::Error> {
        use tauri::Emitter;
        self.emit(
            cabinhug_core::fanout::EVENT_ASSISTANT_STATE,
            cabinhug_core::contract::AssistantState::Idle,
        )
    }
}

/// 供 setup 使用：偏好文件放在应用数据目录，与消息缓存同目录。
pub fn prefs_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("broadcast-pref"))
}

/// 播报音量偏好文件。单独一个，理由同下。
pub fn volume_prefs_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("broadcast-volume-pref"))
}

/// 垫场话偏好文件。与播报开关分开存：两个开关语义不同，
/// 分开存储才能单独重置其中一个。
pub fn filler_prefs_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("filler-pref"))
}

/// 垫场收尾方式的偏好文件。单独一个，理由同上。
pub fn filler_preempt_prefs_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("filler-preempt-pref"))
}
