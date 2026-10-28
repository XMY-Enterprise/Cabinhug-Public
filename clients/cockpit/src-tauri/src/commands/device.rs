//! 设备与车机绑定的 Tauri 命令（F-56-01/03/04）。
//!
//! # 车机侧职责
//!
//! 展示自己的 deviceId（给车主扫），以及把车主念回来的配对码换成车辆级凭证。
//! 车机上不输入任何账号口令（FL-07 F-07-04 的"免密"）。
//!
//! # 角色切换（F-56-04）
//!
//! `switch_device_role` 只切"当前用哪个 id 文件"，不动文件本身，
//! 因此"退出车机模式"之后私人身份仍在，不用重新登录（设计裁决 R12）。

use cabinhug_core::device::{self, DeviceRole};

/// 当前设备 id（车机未绑定时把它渲染成二维码给车主扫）。
#[tauri::command]
pub fn device_id() -> Result<String, String> {
    device::current_id()
}

/// 当前角色："personal" / "cockpit"。端上据此决定显示哪套界面。
#[tauri::command]
pub fn device_role() -> &'static str {
    match device::role() {
        DeviceRole::Cockpit => "cockpit",
        DeviceRole::Personal => "personal",
    }
}

/// 本机能不能安全保存登录状态（ACR-011）。
///
/// 为真表示凭证库不可用、本进程退回纯内存，重启后需要重新登录；
/// 端上据此提前告知用户。
/// 这里只透出一个布尔，不透出任何凭证内容（§2.2 C3）。
#[tauri::command]
pub fn credential_storage_degraded() -> bool {
    cabinhug_core::auth::storage_degraded()
}

/// 切换角色（"用作车机" / "退出车机模式"）。
#[tauri::command]
pub fn switch_device_role(role: String) -> Result<String, String> {
    let next = match role.as_str() {
        "cockpit" => DeviceRole::Cockpit,
        "personal" => DeviceRole::Personal,
        other => return Err(format!("未知角色：{other}")),
    };
    device::set_role(next);
    /*
     * 切换角色不清声明：R12 要求切回车机后不用重新选择使用人。
     *
     * 声明只在两个时刻作废：用户显式点「更换使用人」（boarding_reset），
     * 或续用被服务端拒（那个人已不在成员名单里，BoardingGate 自己清）。
     */
    device::current_id()
}

/// 输入配对码完成绑定，换到车辆级凭证。返回绑定到的 VIN。
#[tauri::command]
pub async fn confirm_pairing(code: String, model_name: String) -> Result<String, String> {
    // 绑定用的恒是车机身份的 id：当前角色可能还停在 personal
    // （用户刚点"用作车机"、界面还没切过去）。
    let id = device::id_for(DeviceRole::Cockpit)?;
    let (base_url, _) = crate::settings::gateway();
    let vin = cabinhug_net::confirm_pairing(&base_url, &id, &code, &model_name)
        .await
        .map_err(|e| e.to_string())?;
    device::set_role(DeviceRole::Cockpit);
    Ok(vin)
}

// ── 上车声明（F-56-05/06） ────────────────────────────

/// 本次上车声明的「谁在用车」（读 `boarding` 存的声明）。
///
/// 返回 JSON：`{"declared": false}` / `{"declared": true, "activeUserId": "u-1" | null}`。
/// `activeUserId: null` 是访客，与「没声明」是两个状态：前者能建会话、
/// 后者该回声明屏（见 boarding.rs 文件头）。
#[tauri::command]
pub fn boarding_declared() -> String {
    match crate::boarding::declared() {
        None => r#"{"declared":false}"#.into(),
        Some(who) => serde_json::json!({ "declared": true, "activeUserId": who }).to_string(),
    }
}

/// 清掉已保存的「谁在用车」，回到声明屏（设置页「更换使用人」）。
/// 只清声明，不动角色与车辆凭证：换人不等于换设备身份。
#[tauri::command]
pub fn boarding_reset() {
    crate::boarding::clear();
    cabinhug_core::acting::clear();
}

/// 本机当前绑定到哪辆车（车辆级凭证在手时）。未绑定返回空串。
///
/// 空串而不是 `Option`：端上判"有没有绑"只需要一个真假，
/// `null` 与 `""` 在 JS 侧都是假值，统一成一种形状少一类分支。
#[tauri::command]
pub fn bound_vin() -> String {
    cabinhug_core::auth::bound_vin().unwrap_or_default()
}

/// 向服务端问一次"这台设备现在绑的是哪辆车"，返回纠偏后的 VIN。
///
/// # 主动查询而不等 401
///
/// `bound_vin()` 读的是钥匙串里配对当时的快照，而绑定在服务端还会变
/// （无 VIN 建档的 `PEND-xxx` 被车主补录成真 VIN）。快照过期后列成员返回
/// 404 而非 401，`with_refresh` 的自愈路径不会触发，
/// 车机会停在"已绑定却选不了使用人"。
///
/// 刷新是唯一能拿到当前绑定的渠道：服务端每次刷新都重读 `devices.vehicleVin`。
/// 刷新失败（没登录过或 refresh 也失效）就返回本地那份，由调用方照常报错；
/// 这里不负责判断"该不该重新配对"。
#[tauri::command]
pub async fn resync_bound_vin() -> String {
    let (base_url, _) = crate::settings::gateway();
    let _ = cabinhug_net::refresh(&base_url).await;
    cabinhug_core::auth::bound_vin().unwrap_or_default()
}

/// 这辆车当前有哪些成员（车机绑定后才有意义）。
///
/// 原样透传服务端 JSON：里面只有账号自设的 displayName，
/// 不含车主给家人起的称呼（那是他人 PII，FL-46 F-46-13）。
#[tauri::command]
pub async fn vehicle_members(vin: String) -> Result<String, String> {
    /*
     * 走 `with_refresh`：access token 只有 15 分钟有效期，而这里常是车机
     * 隔夜后第一个被调用的网络路径，token 通常已过期，需要刷新后重试。
     *
     * 闭包里重新取一次 `gateway()`：刷新后 token 已变，不能用捕获的快照。
     */
    let (base_url, _) = crate::settings::gateway();
    cabinhug_net::with_refresh(&base_url, || async {
        let (base_url, token) = crate::settings::gateway();
        cabinhug_net::GatewayClient::new(base_url, token)
            .fetch_vehicle_grants(&vin)
            .await
    })
    .await
    .map_err(|e| e.to_string())
}

/// 建会话并声明"现在是谁在用"。
///
/// `active_user_id`：`None` = 访客模式（显式的，不是"忘了传"）。
/// 服务端会校验声明的这个人在不在成员名单里——集合外一律 400，
/// 车辆级凭证换不成任意人的身份。
#[tauri::command]
pub async fn create_session_as(active_user_id: Option<String>) -> Result<String, String> {
    // 同 `vehicle_members`：紧接在它后面发生，同样可能带着过期的 token。
    let (base_url, _) = crate::settings::gateway();
    let created = cabinhug_net::with_refresh(&base_url, || async {
        let (base_url, token) = crate::settings::gateway();
        cabinhug_net::GatewayClient::new(base_url, token)
            .create_session_as(Some(active_user_id.clone()))
            .await
    })
    .await
    .map_err(|e| e.to_string())?;
    /*
     * 记住声明，供同一次上车里「新建对话」与唤醒词建会话时复用；
     * 缺失时服务端返回 400 active_user_required。
     */
    crate::boarding::set(active_user_id);
    // 后续请求靠它告诉服务端"这台车机此刻代表谁"。
    cabinhug_core::acting::set_session(&created.session_id);
    serde_json::to_string(&serde_json::json!({
        "sessionId": created.session_id,
        "guest": created.guest,
    }))
    .map_err(|e| e.to_string())
}

/// 播报一句降级话术（F-56-06）。
///
/// 只用于"访客模式"这类必须告知用户的降级，不是通用 TTS 出口；
/// 通用播报由 turn 事件驱动（`events.rs`）。
///
/// 走 `tts::speak` 而不另起一条：播报开关、打断、状态机都在那条链上，
/// 另起一条会绕过播报开关。
#[tauri::command]
pub fn announce_downgrade(
    app: tauri::AppHandle,
    state: tauri::State<'_, std::sync::Arc<crate::tts::TtsState>>,
    text: String,
) {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }
    /*
     * 记录播报开关与引擎状态，用于区分"没被调用""被静音""引擎不可用"
     * 三种没有声音的原因。
     *
     * 播报本身是 fire-and-forget（`speak` 内部起线程），所以只能在入口记。
     */
    let muted = state.is_muted();
    let engine_on = crate::tts::enabled();
    eprintln!(
        "[tts] 降级播报：{} 字，播报开关={}，引擎={}",
        trimmed.chars().count(),
        if muted { "关（不会出声）" } else { "开" },
        if engine_on { "可用" } else { "off（不会出声）" },
    );
    crate::tts::speak(&app, &state, trimmed);
}
