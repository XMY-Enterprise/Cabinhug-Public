//! 语音桥接命令（F-02-07）。
//!
//! `invoke`：`start_push_to_talk` / `stop_push_to_talk`；
//! `emit`：`voice:capture`（`CaptureStatus` 契约）：桥接层只传状态，
//! 不传音频字节（AC-02-2）。采集/编码在 cabinhug-media，上传在 cabinhug-net。
//!
//! 网关地址与 token 经设置层（`crate::settings`，env → 端上持久化 → 默认），
//! `session_id` 由前端随 stop 传入。

use std::sync::Mutex;

use cabinhug_core::contract::{
    AudioMeta, CaptureFailed, CaptureMode, CaptureStarted, CaptureStatus, CaptureStopped,
};
use cabinhug_media::{encode_pcm_s16le, CaptureError, MicPermission, PttHandle};
use cabinhug_net::{AcceptedTurn, GatewayClient, NetError};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

pub const CAPTURE_EVENT: &str = cabinhug_core::fanout::EVENT_VOICE_CAPTURE;

pub(crate) fn gateway_client() -> GatewayClient {
    let (base, token) = crate::settings::gateway();
    GatewayClient::new(base, token)
}

/// 建会话（网络归 Rust 侧，§2.2 C2；WebView 不直接访问网关）。
///
/// # 车机模式下必须带上本次上车的声明
///
/// 车辆级 token 不代表任何人，`POST /v1/session` 没带 activeUserId 就返回
/// 400 `active_user_required`。
///
/// 判据用 `bound_vin()` 而不是设备角色：决定服务端如何裁决的是
/// 当前 token 的种类，角色只是端上的显示状态，两者可能短暂不一致。
#[tauri::command]
pub async fn create_session() -> Result<String, String> {
    create_session_for_device().await
}

/// 建会话的唯一实现，`create_session` 命令与 PTT 松手时的现建 / 409 收编共用。
///
/// "车机要带上上车声明"的判据只在这里维护一份；不带声明时车辆级 token
/// 会得到 400 `active_user_required`。
pub(crate) async fn create_session_for_device() -> Result<String, String> {
    let id = if cabinhug_core::auth::bound_vin().is_some() {
        let Some(declared) = crate::boarding::declared() else {
            // 没声明过就不请求服务端，直接返回对用户有意义的原因。
            return Err("尚未完成上车声明：请先选择现在是谁在用车".into());
        };
        gateway_client()
            .create_session_as(Some(declared))
            .await
            .map(|s| s.session_id)
            .map_err(|e| e.to_string())?
    } else {
        gateway_client()
            .create_session()
            .await
            .map(|s| s.session_id)
            .map_err(|e| e.to_string())?
    };
    /*
     * 声明这一段是谁在说话，与 `device::create_session_as` 一致。
     *
     * 不声明时 `acting::session()` 停在上一次上车时的会话 id；该会话关闭后，
     * `GatewayClient` 默认头带的是已关闭的会话，网关无法补出身份
     * （车辆级 token 本身不代表任何人），按人查的路由（如
     * `GET /v1/trip-plan/current`）一律 401，而聊天不受影响；
     * 主页行程列表因此停止更新，端上不报错。
     *
     * 放在这个唯一实现里而不是各调用点，保证所有建会话路径一致。
     */
    cabinhug_core::acting::set_session(&id);
    Ok(id)
}

/// 结束这段对话：车主点了「退下」。
///
/// 软关闭：服务端标记会话结束，`messages` 一条不删。端上随后建新会话，
/// 暖暖回到休息形象。服务端幂等，连点两次没有副作用。
#[tauri::command]
pub async fn close_session(session_id: String) -> Result<(), String> {
    gateway_client()
        .close_session(&session_id)
        .await
        .map_err(|e| e.to_string())
}

/// 发送一条文本消息（F-03-09）。
///
/// 对话层的文字输入走这里，这是全产品唯一输入框，HUD 层没有输入框（US-01 AC-01-1）。
/// 与语音上行共用同一个网关端点，仅 content-type 不同。
#[tauri::command]
pub async fn send_text_message(
    app: AppHandle,
    session_id: String,
    content: String,
) -> Result<String, String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err("empty_content".into());
    }
    // 闲聊旁路开关随每条消息上行：仅端上关闭不会生效。
    gateway_client()
        .with_filler_enabled(crate::voice::filler_enabled_now(&app))
        .send_text(&session_id, trimmed, cabinhug_core::contract::MessageSource::Text)
        .await
        .map(|a| a.turn_id)
        .map_err(|e| e.to_string())
}

/// 采集会话的三态。
///
/// 需要「正在起流」这一态：iOS 上起流是秒级的（激活会话 + 建 AURemoteIO 单元），
/// 车主可能在就绪之前松手。只有「在录 / 不在录」两态时，松手的 `stop` 拿不到句柄，
/// 随后 `start` 存入的录音器无人停止：麦克风一直开着，之后每次长按都被判
/// `already_recording`。
#[derive(Default, Debug, PartialEq)]
pub enum Phase<H> {
    #[default]
    Idle,
    /// 起流中。`stop_requested` 记的是「还没起好就已经被松手了」。
    Starting {
        stop_requested: bool,
    },
    Recording(H),
}

/// 松手时拿到了什么。
#[derive(Debug, PartialEq)]
pub enum StopTake<H> {
    /// 正在录，句柄归你，去停它。
    Took(H),
    /// 还没起好就松手了：意愿已记下，收尾归 `settle_start`。
    CancelledBeforeReady,
    /// 本来就没在录。
    NotRecording,
}

/// 声明「我要起流了」。已经在起或在录时返回 false（调用方回 `already_recording`）。
pub fn claim_start<H>(phase: &mut Phase<H>) -> bool {
    match phase {
        Phase::Idle => {
            *phase = Phase::Starting { stop_requested: false };
            true
        }
        _ => false,
    }
}

/// 起流完成。返回 `Some(handle)` 表示这段不入账（起流期间已被松手取消，或状态异常），
/// 调用方必须把它停掉，否则录音器泄漏。
pub fn settle_start<H>(phase: &mut Phase<H>, handle: H) -> Option<H> {
    match std::mem::replace(phase, Phase::Idle) {
        Phase::Starting { stop_requested: false } => {
            *phase = Phase::Recording(handle);
            None
        }
        _ => Some(handle),
    }
}

/// 松手。起流中就把取消意愿留在状态里，交给 `settle_start` 收尾。
pub fn take_for_stop<H>(phase: &mut Phase<H>) -> StopTake<H> {
    match std::mem::replace(phase, Phase::Idle) {
        Phase::Recording(h) => StopTake::Took(h),
        Phase::Starting { .. } => {
            *phase = Phase::Starting { stop_requested: true };
            StopTake::CancelledBeforeReady
        }
        Phase::Idle => StopTake::NotRecording,
    }
}

pub type VoicePhase = Phase<PttHandle>;

/// 当前采集会话（同一时刻至多一路）。
#[derive(Default)]
pub struct VoiceState(Mutex<VoicePhase>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopOutcome {
    pub turn_id: String,
    pub duration_ms: u32,
    pub truncated: bool,
    /// 仅在旧会话过期、Rust 侧收编新会话时返回；正常上传不改变前端会话。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// PTT 上行的有限恢复：过期只新建一个会话，并把同一段音频再送一次。
/// 网络错误与 5xx 的既有重试仍由 `GatewayClient::upload_audio` 负责。
/// PTT 上传失败的两种成因，端上分开展示。
///
/// 建不出会话（车机没做上车声明、网关不可达）与上传本身失败需要区分，
/// 便于定位断在哪一步。
#[derive(Debug)]
enum PttUploadError {
    /// 手上没有会话（或旧会话已过期）而新会话建不出来。
    CreateSession(String),
    /// 会话在手，上传本身失败。
    Upload(NetError),
}

impl From<NetError> for PttUploadError {
    fn from(err: NetError) -> Self {
        PttUploadError::Upload(err)
    }
}

/// 把这段录音送进一个能用的会话。
///
/// `session_id` 为 `None` 是关闭会话之后的第一次长按：
/// 「退下」与「新建对话」都只把端上的会话位置空、不预建下一个，
/// 下一句话由发送方现建，与文字路径的 `ensureUsableSession` 一致，录音不丢弃。
///
/// 现建放在 Rust 侧而不是前端：这里已经停了采集、释放了麦克风，
/// 建会话的网络往返不占设备；放前端就得先建再停，多录一段空白。
/// 建出来的 id 随 [`StopOutcome::session_id`] 交回前端收编，与 409 那条路同一形态。
async fn upload_with_session_recovery<F, Fut>(
    gateway: &GatewayClient,
    session_id: Option<&str>,
    bytes: &[u8],
    meta: &AudioMeta,
    create_session: F,
) -> Result<(AcceptedTurn, Option<String>), PttUploadError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let Some(session_id) = session_id else {
        eprintln!("[cockpit] PTT 松手时没有会话，现建一个再上传");
        let created = create_session().await.map_err(PttUploadError::CreateSession)?;
        let accepted = gateway.upload_audio(&created, bytes, meta).await?;
        return Ok((accepted, Some(created)));
    };
    match gateway.upload_audio(session_id, bytes, meta).await {
        Ok(accepted) => Ok((accepted, None)),
        Err(NetError::SessionExpired) => {
            eprintln!("[cockpit] PTT 会话已过期，新建会话并重传一次");
            let created = create_session().await.map_err(PttUploadError::CreateSession)?;
            let accepted = gateway.upload_audio(&created, bytes, meta).await?;
            Ok((accepted, Some(created)))
        }
        Err(err) => Err(err.into()),
    }
}

fn emit_status(app: &AppHandle, status: &CaptureStatus) {
    if let Err(e) = app.emit(CAPTURE_EVENT, status) {
        eprintln!("[cockpit] emit capture status failed: {e}");
    }
}

fn reason_of(err: &CaptureError) -> String {
    match err {
        CaptureError::NoDevice => "permission_denied_or_no_device".into(),
        /*
         * 附带失败细节。
         *
         * 这一档涵盖三种不同的失败：音频会话切换失败、拿不到默认输入配置、
         * cpal 建流失败，需要细节才能区分。
         * 前端只按 `permission_denied` 前缀分支，追加冒号后缀不影响既有判定。
         */
        CaptureError::DeviceUnavailable(msg) => format!("device_busy: {msg}"),
        CaptureError::AlreadyRecording => "already_recording".into(),
        CaptureError::NotRecording => "not_recording".into(),
        CaptureError::ThreadFailed => "capture_failed".into(),
    }
}

/// 系统麦克风授权现状："granted" / "denied" / "undetermined"。
/// 前端用它决定暖暖卡片要不要挂"麦克风未授权"的文字说明。
#[tauri::command]
pub fn mic_permission_status() -> String {
    cabinhug_media::mic_permission().as_str().into()
}

/// 长按前的权限门。
///
/// macOS 未授权时 CoreAudio 不报错、只给零样本，cpal 也不会报错；
/// 空音频送进 ASR 只会转出空文本。所以每次长按都先问系统：
///  - 没问过 → 弹系统授权框，等车主作答（阻塞放 blocking 池）；
///  - 拒绝过 → 系统不会再弹，把车主带去系统设置的麦克风页，
///    每次长按都带，保证再次长按也能拉起授权。
/// 申请麦克风授权，不发采集事件。
///
/// 与 [`ensure_mic_permission`] 的唯一差别：后者在被拒时 emit
/// `CaptureStatus::Failed`，前端据此显示"录音失败"。哨兵开关是设置页的动作，
/// 不是一次录音，不应在设置页显示录音报错。
pub(crate) async fn acquire_mic_permission() -> bool {
    match cabinhug_media::mic_permission() {
        MicPermission::Granted => true,
        MicPermission::Undetermined => {
            tauri::async_runtime::spawn_blocking(cabinhug_media::request_mic_permission_blocking)
                .await
                .unwrap_or(false)
        }
        MicPermission::Denied => {
            // 系统层面已经拒过，App 内再问不会弹框，只能把用户送到设置页。
            cabinhug_media::open_mic_settings();
            false
        }
    }
}

async fn ensure_mic_permission(app: &AppHandle) -> Result<(), String> {
    let granted = match cabinhug_media::mic_permission() {
        MicPermission::Granted => true,
        MicPermission::Undetermined => {
            tauri::async_runtime::spawn_blocking(cabinhug_media::request_mic_permission_blocking)
                .await
                .map_err(|e| e.to_string())?
        }
        MicPermission::Denied => {
            cabinhug_media::open_mic_settings();
            false
        }
    };
    if granted {
        Ok(())
    } else {
        emit_status(
            app,
            &CaptureStatus::Failed(CaptureFailed { reason: "permission_denied".into() }),
        );
        Err("permission_denied".into())
    }
}

#[tauri::command]
pub async fn start_push_to_talk(
    app: AppHandle,
    state: State<'_, VoiceState>,
) -> Result<(), String> {
    /*
     * 先声明「我要起流了」（见 `VoicePhase`）。
     *
     * 占位必须在起流之前落下：起流是秒级的，这段时间里的松手需要一个
     * 写入「已经松手了」的位置，否则 start 会留下一个无人停止的录音器。
     */
    if !claim_start(&mut state.0.lock().expect("voice state poisoned")) {
        return Err("already_recording".into());
    }

    /// 任一步失败都要把占位清掉，否则之后无法再起流。
    fn clear_claim(state: &State<'_, VoiceState>) {
        *state.0.lock().expect("voice state poisoned") = Phase::Idle;
    }

    // 权限门在打断/哨兵互斥之前：没权限的长按不打断正在进行的播报。
    if let Err(e) = ensure_mic_permission(&app).await {
        clear_claim(&state);
        return Err(e);
    }

    /*
     * 打断：停播 + 复位垫场槽位 + 取消服务端那一轮 + 记下这一轮。
     *
     * 只停播放时服务端那一轮仍在运行，旧答案的 delta 与垫场会在新问题之后到达。
     *
     * 位置在 `sentinel.pause()` 之前，保持长按的既有时序（AC-52-8）。
     */
    crate::interrupt::interrupt_assistant(&app, crate::interrupt::InterruptSource::PushToTalk);

    /*
     * 哨兵互斥：长按期间让出麦克风；PTT 自身行为不变（AC-52-8）。
     *
     * 须等哨兵真正让出设备。`pause()` 只是把命令塞进通道，
     * 哨兵循环 50ms 一拍才会真正 `stop()` 释放设备；若不等待，两条 cpal 输入流
     * 短暂并存，而 iOS 的 RemoteIO 是独占的，晚到的 teardown 会带走刚建好的流，
     * 录音在按住期间提前结束。
     *
     * 超时上限比一拍宽（200ms > POLL 50ms）：正常情况下第一次查询就返回，
     * 超时后也照常起流，哨兵卡住时优先保证长按可用。
     */
    if let Some(sentinel) = app.try_state::<super::voice::SentinelState>() {
        sentinel.pause();
        if !crate::voice::wait_mic_released(std::time::Duration::from_millis(200)) {
            eprintln!("[ptt] 等哨兵让出麦克风超时（200ms），照常起流");
        }
    }

    // PttHandle::start 阻塞至流就绪；放 blocking 池避免卡 async 运行时。
    let started = match tauri::async_runtime::spawn_blocking(PttHandle::start).await {
        Ok(v) => v,
        Err(e) => {
            clear_claim(&state);
            return Err(e.to_string());
        }
    };

    match started {
        Ok(handle) => {
            /*
             * 起流完成，但车主可能已经松手（起流是秒级的）。
             * `stop` 在这种情况下写下的是 `stop_requested`，这里据此二选一：
             * 入账继续录，或者当场停掉丢弃，不在状态里留下无人停止的录音器。
             */
            let leftover = settle_start(&mut state.0.lock().expect("voice state poisoned"), handle);
            if let Some(h) = leftover {
                // 已经松手，没有内容可上传：停掉并告知。
                let _ = tauri::async_runtime::spawn_blocking(move || h.stop()).await;
                emit_status(
                    &app,
                    &CaptureStatus::Failed(CaptureFailed { reason: "cancelled_before_ready".into() }),
                );
                if let Some(sentinel) = app.try_state::<super::voice::SentinelState>() {
                    sentinel.resume();
                }
                return Err("cancelled_before_ready".into());
            }
            emit_status(&app, &CaptureStatus::Started(CaptureStarted { mode: CaptureMode::PushToTalk }));
            Ok(())
        }
        Err(err) => {
            clear_claim(&state);
            let reason = reason_of(&err);
            emit_status(&app, &CaptureStatus::Failed(CaptureFailed { reason: reason.clone() }));
            // 起流失败也要恢复哨兵，否则一次 PTT 失败后哨兵不再工作
            if let Some(sentinel) = app.try_state::<super::voice::SentinelState>() {
                sentinel.resume();
            }
            Err(reason)
        }
    }
}

#[tauri::command]
pub async fn stop_push_to_talk(
    app: AppHandle,
    state: State<'_, VoiceState>,
    // 前端手上的会话；关闭会话之后是 `None`，由 `upload_with_session_recovery` 现建。
    session_id: Option<String>,
) -> Result<StopOutcome, String> {
    /*
     * 还没起好就松手时，把取消意愿留在状态里，由 `start` 那一侧收尾，
     * 避免录音器泄漏（见 `Phase` 的文档）。
     */
    let handle = match take_for_stop(&mut state.0.lock().expect("voice state poisoned")) {
        StopTake::Took(h) => h,
        StopTake::CancelledBeforeReady => return Err("cancelled_before_ready".into()),
        StopTake::NotRecording => return Err("not_recording".into()),
    };

    // 停止（立即释放麦克风）+ 编码，均为阻塞工作。
    let encoded = tauri::async_runtime::spawn_blocking(move || {
        let capture = handle.stop()?;
        let duration_ms = capture.duration_ms();
        let truncated = capture.truncated;
        // 空/全零样本兜底：权限门失效的平台上（或设备静默失灵），未授权采集
        // 得到全零样本，送进 ASR 只会转出空文本。在这里拦下并告知，
        // 不把空音频交给网关。
        let fault = cabinhug_media::classify_capture(&capture.samples);
        let (bytes, meta) =
            encode_pcm_s16le(&capture.samples, capture.sample_rate, capture.channels);
        Ok::<_, CaptureError>((bytes, meta, duration_ms, truncated, fault))
    })
    .await
    .map_err(|e| e.to_string())?;

    // 松手即恢复哨兵（互斥的另一半）：麦克风此刻已释放（stop 在上面的
    // spawn_blocking 里完成），编码与上传不占设备，不必等它们跑完。
    if let Some(sentinel) = app.try_state::<super::voice::SentinelState>() {
        sentinel.resume();
    }

    let (bytes, meta, duration_ms, truncated, fault) = match encoded {
        Ok(v) => v,
        Err(err) => {
            let reason = reason_of(&err);
            emit_status(&app, &CaptureStatus::Failed(CaptureFailed { reason: reason.clone() }));
            return Err(reason);
        }
    };
    if let Some(fault) = fault {
        let reason = fault.as_str().to_string();
        emit_status(&app, &CaptureStatus::Failed(CaptureFailed { reason: reason.clone() }));
        return Err(reason);
    }
    emit_status(&app, &CaptureStatus::Stopped(CaptureStopped { duration_ms }));

    emit_status(&app, &CaptureStatus::Uploading);
    // 同上：PTT 这条路也要带开关，否则语音关闭旁路后按住说话仍有垫场。
    let gateway = gateway_client().with_filler_enabled(crate::voice::filler_enabled_now(&app));
    match upload_with_session_recovery(
        &gateway,
        session_id.as_deref(),
        &bytes,
        &meta,
        create_session_for_device,
    )
    .await
    {
        Ok((accepted, adopted_session_id)) => {
            emit_status(&app, &CaptureStatus::Uploaded);
            Ok(StopOutcome {
                turn_id: accepted.turn_id,
                duration_ms,
                truncated,
                session_id: adopted_session_id,
            })
        }
        Err(err) => {
            let reason = match &err {
                // 建不出会话要带原因（比如"尚未完成上车声明"），车主可据此自行处理。
                PttUploadError::CreateSession(msg) => format!("session_create_failed: {msg}"),
                PttUploadError::Upload(e) => {
                    eprintln!("[cockpit] upload failed session={session_id:?}: {e}");
                    "upload_failed".into()
                }
            };
            emit_status(&app, &CaptureStatus::Failed(CaptureFailed { reason: reason.clone() }));
            Err(reason)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    fn test_meta() -> AudioMeta {
        AudioMeta {
            duration_ms: 1_000,
            format: "pcm_s16le".into(),
            sample_rate_hz: 16_000,
            channels: 1,
        }
    }

    /// 按给定顺序逐个应答，并把每个请求行交回测试断言。
    fn spawn_recovery_stub(
        responses: Vec<(&'static str, &'static str)>,
    ) -> (String, mpsc::Receiver<String>, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind recovery stub");
        let addr = listener.local_addr().expect("stub address");
        let (tx, rx) = mpsc::channel();
        let handle = std::thread::spawn(move || {
            for (status_line, body) in responses {
                let (mut stream, _) = listener.accept().expect("accept recovery request");
                let mut reader = BufReader::new(stream.try_clone().expect("clone request"));
                let mut request_line = String::new();
                reader.read_line(&mut request_line).expect("read request line");
                let mut content_length = 0usize;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).expect("read request headers");
                    if line.trim_end().is_empty() {
                        break;
                    }
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        content_length = value.trim().parse().unwrap_or(0);
                    }
                }
                let mut payload = vec![0u8; content_length];
                reader.read_exact(&mut payload).expect("read request body");
                tx.send(request_line.trim().to_string()).expect("record request");

                let response = format!(
                    "HTTP/1.1 {status_line}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).expect("write response");
            }
        });
        (format!("http://{addr}"), rx, handle)
    }

    /// 生产里建会话走 `create_session_for_device`（要读设备绑定状态）；
    /// 这里直接请求网关，只验证"什么时候建、建几次"。
    fn create_via(client: &GatewayClient) -> impl std::future::Future<Output = Result<String, String>> + '_ {
        async move {
            client
                .create_session()
                .await
                .map(|s| s.session_id)
                .map_err(|e| e.to_string())
        }
    }

    /// [F-02-04][AC-02-2] 过期 PTT 会话只创建一次并重传同一段音频一次。
    #[test]
    fn expired_ptt_session_is_adopted_and_reuploaded_once() {
        let (base, rx, server) = spawn_recovery_stub(vec![
            ("409 Conflict", r#"{"error":"session_expired"}"#),
            ("201 Created", r#"{"sessionId":"fresh-session"}"#),
            ("202 Accepted", r#"{"turnId":"turn-fresh"}"#),
        ]);
        let client = GatewayClient::new(base, "demo-token");
        let result = tauri::async_runtime::block_on(upload_with_session_recovery(
            &client,
            Some("old-session"),
            &[1, 2, 3],
            &test_meta(),
            || create_via(&client),
        ))
        .expect("PTT recovery should succeed");

        assert_eq!(result.0.turn_id, "turn-fresh");
        assert_eq!(result.1.as_deref(), Some("fresh-session"));
        let requests: Vec<_> = (0..3).map(|_| rx.recv().expect("request record")).collect();
        assert!(requests[0].starts_with("POST /v1/session/old-session/messages"));
        assert!(requests[1].starts_with("POST /v1/session HTTP/1.1"));
        assert!(requests[2].starts_with("POST /v1/session/fresh-session/messages"));
        assert!(rx.try_recv().is_err(), "过期恢复不应产生第四次请求");
        server.join().expect("recovery stub should exit");
    }

    /// [F-02-04][AC-02-2] 关闭会话后的第一次长按：手上没有会话 → 现建一个再传，
    /// 录音不丢，且新会话 id 交回前端收编。
    #[test]
    fn 松手时没有会话就现建一个再上传() {
        let (base, rx, server) = spawn_recovery_stub(vec![
            ("201 Created", r#"{"sessionId":"fresh-session"}"#),
            ("202 Accepted", r#"{"turnId":"turn-fresh"}"#),
        ]);
        let client = GatewayClient::new(base, "demo-token");
        let result = tauri::async_runtime::block_on(upload_with_session_recovery(
            &client,
            None,
            &[1, 2, 3],
            &test_meta(),
            || create_via(&client),
        ))
        .expect("没有会话时应现建并上传成功");

        assert_eq!(result.0.turn_id, "turn-fresh");
        assert_eq!(result.1.as_deref(), Some("fresh-session"), "新建的 id 必须交回去收编");
        let requests: Vec<_> = (0..2).map(|_| rx.recv().expect("request record")).collect();
        assert!(requests[0].starts_with("POST /v1/session HTTP/1.1"), "第一步就是建会话：{}", requests[0]);
        assert!(requests[1].starts_with("POST /v1/session/fresh-session/messages"));
        assert!(rx.try_recv().is_err(), "不该有第三次请求");
        server.join().expect("recovery stub should exit");
    }

    /// 建不出会话时错误归 `CreateSession`，端上据此显示原因，而不是笼统的"上传失败"。
    #[test]
    fn 建不出会话时如实归因() {
        let (base, rx, server) = spawn_recovery_stub(vec![(
            "400 Bad Request",
            r#"{"error":"active_user_required"}"#,
        )]);
        let client = GatewayClient::new(base, "demo-token");
        let err = tauri::async_runtime::block_on(upload_with_session_recovery(
            &client,
            None,
            &[1, 2, 3],
            &test_meta(),
            || create_via(&client),
        ))
        .expect_err("建会话 400 应失败");

        assert!(matches!(err, PttUploadError::CreateSession(_)), "{err:?}");
        rx.recv().expect("建会话那一次请求");
        assert!(rx.try_recv().is_err(), "会话都没有，不该再去上传");
        server.join().expect("recovery stub should exit");
    }
}

#[cfg(test)]
mod phase_tests {
    use super::{claim_start, settle_start, take_for_stop, Phase, StopTake};

    /// 用 u32 代替句柄：状态迁移与句柄类型无关，而真 `PttHandle` 带着线程与通道，
    /// 在单测里无法构造。泛型化使这层逻辑可以单独测试。
    type P = Phase<u32>;

    #[test]
    fn 起流期间松手不会留下没人停的录音器() {
        // 1) 正常一轮：起流 → 就绪 → 松手拿到句柄。
        let mut p: P = Phase::Idle;
        assert!(claim_start(&mut p));
        assert_eq!(settle_start(&mut p, 7), None, "没被取消就该入账，不交回句柄");
        assert_eq!(take_for_stop(&mut p), StopTake::Took(7));
        assert_eq!(p, Phase::Idle);

        // 2) 起流还没完成就松手（比 0.9 秒短的长按）。
        let mut p: P = Phase::Idle;
        assert!(claim_start(&mut p));
        assert_eq!(take_for_stop(&mut p), StopTake::CancelledBeforeReady);
        assert_eq!(
            settle_start(&mut p, 9),
            Some(9),
            "句柄必须交回调用方去停——不交回来就是 2026-09-02 iPad 上那个泄漏：\
             麦克风一直开着，之后每一次长按都被判 already_recording",
        );
        assert_eq!(p, Phase::Idle, "取消之后必须回到 Idle，否则这个 App 再也起不了流");

        // 3) 取消之后还能再来一次（泄漏时这里恒为 already_recording）。
        assert!(claim_start(&mut p));
        assert_eq!(settle_start(&mut p, 11), None);

        // 4) 已经在录时不接受第二次起流；没在录时松手如实说。
        assert!(!claim_start(&mut p));
        assert_eq!(take_for_stop(&mut p), StopTake::Took(11));
        assert_eq!(take_for_stop(&mut p), StopTake::NotRecording);
    }
}

#[cfg(test)]
mod session_declared_tests {
    //! 建会话必须同时声明「这台车机此刻代表谁」。
    //!
    //! 车机端有两条建会话的路：上车选人（`device::create_session_as`）与
    //! 聊天（`create_session` 命令 / PTT 松手现建 / 409 收编，全走
    //! `create_session_for_device`）。任一条不声明，`acting::session()` 会停在
    //! 上一次上车时的会话 id；该会话被空闲清扫（30 分钟）关掉之后，
    //! `GatewayClient` 的默认头带的是已关闭的会话，网关无法补出身份
    //! （车辆级 token 本身不代表任何人），按人查的路由（如
    //! `GET /v1/trip-plan/current`）一律 401，而聊天不受影响。
    //!
    //! 用源码断言检查这一行是否存在：真流程需要起网关，源码断言在 CI 里恒定可跑。

    const MEDIA: &str = include_str!("media.rs");
    const DEVICE: &str = include_str!("device.rs");

    #[test]
    fn 建会话的唯一实现要声明会话() {
        assert!(
            MEDIA.contains("cabinhug_core::acting::set_session(&id);"),
            "create_session_for_device 必须声明会话——聊天、PTT、409 收编三条路都走它"
        );
    }

    #[test]
    fn 上车那条路照旧声明() {
        assert!(
            DEVICE.contains("cabinhug_core::acting::set_session(&created.session_id);"),
            "上车选人那条原本就有，别在重构里把它丢了"
        );
    }

    #[test]
    fn 绑车分支不能提前返回() {
        // 绑车分支是车机上唯一会走的一条；它提前返回就会跳过会话声明。
        let body = MEDIA
            .split("pub(crate) async fn create_session_for_device")
            .nth(1)
            .expect("函数还在");
        let end = body.find("\n}\n").expect("函数体完整");
        assert!(
            !body[..end].contains("return gateway_client()"),
            "绑车分支直接 return 的话，车机上这条路就不会声明会话了"
        );
    }
}
