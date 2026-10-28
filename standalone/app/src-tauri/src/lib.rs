//! 单机版桌面应用的 Rust 侧（ACR-063）。
//!
//! # 分工
//!
//! - 宿主（`cabinhug-standalone-host`）托管本机数据库与三个服务；本文件在窗口起来时建好它，
//!   凭据齐了就自动启动，窗口退出时倒序停掉。
//! - 界面不直接连网关：请求与事件流都经下面几个命令转发，登录口令与令牌只在 Rust 侧
//!   （与车机端、手机端「网络与鉴权在 Rust」同一条线，§2.2 C2）。
//! - 事件流原样转发 SSE 的 `data:` 行，投影成对话事件由界面复用 `@cabinhug/ui` 里与 Rust
//!   `fanout::project` 逐条对齐的那份 `project()`，不在这里再写第三份。

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cabinhug_standalone_host::{
    validate, FileBackend, GatewayAccess, Host, HostConfig, HostStatus, KeychainBackend, Layout, Phase, Profile, Secrets,
};
use futures_util::StreamExt;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, RunEvent, State};
use tokio::sync::Mutex as AsyncMutex;

/// 钥匙串里的服务名（与无头调试用的 `.dev` 分开）。
const KEYCHAIN_SERVICE: &str = "com.cabinhug.standalone";

struct GatewaySession {
    access: GatewayAccess,
    token: Option<String>,
}

struct AppState {
    host: AsyncMutex<Option<Host>>,
    /// 宿主状态的共享句柄：启动中宿主被锁住，状态照样读得到。
    status: Option<Arc<Mutex<HostStatus>>>,
    boot_error: Option<String>,
    profile: Profile,
    gateway: AsyncMutex<Option<GatewaySession>>,
    streams: Mutex<HashMap<u32, tokio::task::AbortHandle>>,
    next_stream: AtomicU32,
    http: reqwest::Client,
}

fn to_s(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[tauri::command]
fn host_status(state: State<'_, AppState>) -> serde_json::Value {
    match (&state.status, &state.boot_error) {
        (Some(s), _) => serde_json::to_value(s.lock().unwrap().clone()).unwrap_or_default(),
        (None, err) => serde_json::json!({
            "phase": "failed",
            "steps": [],
            "message": err.clone().unwrap_or_else(|| "本地服务没有建起来".into()),
            "missingCredentials": [],
            "logDir": "",
        }),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FieldView {
    env: String,
    label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GroupView {
    group: String,
    label: String,
    fields: Vec<FieldView>,
    saved: bool,
}

/// 三组凭据的名单与「存过没有」。**不回传任何值**：界面只知道存没存，编辑框是「写入新值」。
#[tauri::command]
async fn credential_groups(state: State<'_, AppState>) -> Result<Vec<GroupView>, String> {
    let guard = state.host.lock().await;
    let host = guard.as_ref().ok_or("本地服务没有建起来")?;
    let missing = host.secrets().missing_groups(&state.profile).map_err(to_s)?;
    Ok(state
        .profile
        .credentials
        .iter()
        .map(|g| GroupView {
            group: g.group.clone(),
            label: g.label.clone(),
            fields: g.fields.iter().map(|f| FieldView { env: f.env.clone(), label: f.label.clone() }).collect(),
            saved: !missing.contains(&g.group),
        })
        .collect())
}

/// 「验证并保存」：先打一次真请求，过了才存（UI-02 第 1 屏）。
#[tauri::command]
async fn save_credentials(
    state: State<'_, AppState>,
    group: String,
    values: BTreeMap<String, String>,
) -> Result<validate::Verdict, String> {
    let verdict = validate::group(&group, &values).await.map_err(to_s)?;
    if !verdict.ok {
        return Ok(verdict);
    }
    let guard = state.host.lock().await;
    let host = guard.as_ref().ok_or("本地服务没有建起来")?;
    host.secrets().set_group(&state.profile, &group, &values).map_err(to_s)?;
    Ok(verdict)
}

/// 起本地服务（后台跑，进度看 `host_status`）。已经在起或已就绪就什么都不做。
#[tauri::command]
fn start_host(app: AppHandle) {
    spawn_start(app);
}

fn spawn_start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let mut guard = state.host.lock().await;
        let Some(host) = guard.as_mut() else { return };
        if matches!(host.status().phase, Phase::Ready | Phase::Starting) {
            return;
        }
        let _ = host.start().await;
        let access = host.access();
        drop(guard);
        *state.gateway.lock().await = access.map(|access| GatewaySession { access, token: None });
    });
}

/// 改了凭据之后重启本地服务：服务进程的环境只在启动时生成。
#[tauri::command]
fn restart_host(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        *state.gateway.lock().await = None;
        if let Some(host) = state.host.lock().await.as_mut() {
            host.stop().await;
        }
        spawn_start(app.clone());
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientConfig {
    amap_js_key: Option<String>,
    amap_security_code: Option<String>,
}

/// 界面要的两样：高德 JS Key 与安全密钥（车主自己的 key，只在本机用；见 ACR-063）。
#[tauri::command]
async fn client_config(state: State<'_, AppState>) -> Result<ClientConfig, String> {
    let guard = state.host.lock().await;
    let host = guard.as_ref().ok_or("本地服务没有建起来")?;
    let creds = host.client_credentials().map_err(to_s)?;
    Ok(ClientConfig {
        amap_js_key: creds.get("AMAP_JS_KEY").cloned(),
        amap_security_code: creds.get("AMAP_JS_SECURITY_CODE").cloned(),
    })
}

fn check_path(path: &str) -> Result<(), String> {
    if path.starts_with("/v1/") && !path.contains("..") {
        Ok(())
    } else {
        Err(format!("不允许的网关路径：{path}"))
    }
}

async fn ensure_token(http: &reqwest::Client, s: &mut GatewaySession) -> Result<String, String> {
    if let Some(t) = &s.token {
        return Ok(t.clone());
    }
    let body: serde_json::Value = http
        .post(format!("{}/v1/auth/login", s.access.base_url))
        .json(&serde_json::json!({ "username": s.access.username, "password": s.access.password }))
        .send()
        .await
        .map_err(to_s)?
        .error_for_status()
        .map_err(|e| format!("本机账号登录失败：{e}"))?
        .json()
        .await
        .map_err(to_s)?;
    let token = body.get("accessToken").and_then(|v| v.as_str()).ok_or("登录没有返回令牌")?.to_owned();
    s.token = Some(token.clone());
    Ok(token)
}

#[derive(Serialize)]
struct GatewayResponse {
    status: u16,
    body: String,
}

/// 转发一个网关请求。令牌过期（401）时重登一次再发。
#[tauri::command]
async fn gateway_request(
    state: State<'_, AppState>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<GatewayResponse, String> {
    check_path(&path)?;
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(to_s)?;
    let mut guard = state.gateway.lock().await;
    let session = guard.as_mut().ok_or("本地服务还没就绪")?;
    for attempt in 0..2 {
        let token = ensure_token(&state.http, session).await?;
        let mut req = state
            .http
            .request(method.clone(), format!("{}{path}", session.access.base_url))
            .bearer_auth(&token)
            .timeout(Duration::from_secs(60));
        if let Some(b) = &body {
            req = req.json(b);
        }
        let res = req.send().await.map_err(to_s)?;
        if res.status().as_u16() == 401 && attempt == 0 {
            session.token = None;
            continue;
        }
        let status = res.status().as_u16();
        return Ok(GatewayResponse { status, body: res.text().await.map_err(to_s)? });
    }
    Err("本机账号登录失效".into())
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum StreamMsg {
    /// 网关已回 200：它在写响应头之后同步订阅会话总线（`gateway/src/stream`），
    /// 收到这一条之后再发消息，这一轮的回流不会丢。
    Open,
    Data { data: String },
    Closed { reason: String },
}

/// 在字节层面按空行切 SSE 块：中文在 TCP 分片上可能被切成两半，按字符串切会出乱码。
fn take_blocks(buf: &mut Vec<u8>) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(i) = buf.windows(2).position(|w| w == b"\n\n") {
        let block: Vec<u8> = buf.drain(..i + 2).collect();
        let text = String::from_utf8_lossy(&block[..i]).into_owned();
        let data: Vec<&str> = text.lines().filter_map(|l| l.strip_prefix("data: ")).collect();
        if !data.is_empty() {
            out.push(data.join("\n"));
        }
    }
    out
}

/// 打开一条事件流，`data:` 原样经 channel 送给界面。返回流号，`gateway_stream_close` 用它关。
#[tauri::command]
async fn gateway_stream(state: State<'_, AppState>, path: String, on_event: Channel<StreamMsg>) -> Result<u32, String> {
    check_path(&path)?;
    let (url, token) = {
        let mut guard = state.gateway.lock().await;
        let session = guard.as_mut().ok_or("本地服务还没就绪")?;
        let token = ensure_token(&state.http, session).await?;
        (format!("{}{path}", session.access.base_url), token)
    };
    let http = state.http.clone();
    let task = tokio::spawn(async move {
        let res = match http.get(&url).bearer_auth(&token).header("accept", "text/event-stream").send().await {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                let _ = on_event.send(StreamMsg::Closed { reason: format!("事件流打不开：{}", r.status()) });
                return;
            }
            Err(e) => {
                let _ = on_event.send(StreamMsg::Closed { reason: e.to_string() });
                return;
            }
        };
        if on_event.send(StreamMsg::Open).is_err() {
            return;
        }
        let mut stream = res.bytes_stream();
        let mut buf = Vec::new();
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => {
                    buf.extend_from_slice(&bytes);
                    for data in take_blocks(&mut buf) {
                        if on_event.send(StreamMsg::Data { data }).is_err() {
                            return;
                        }
                    }
                }
                Err(e) => {
                    let _ = on_event.send(StreamMsg::Closed { reason: e.to_string() });
                    return;
                }
            }
        }
        let _ = on_event.send(StreamMsg::Closed { reason: "ended".into() });
    });
    let id = state.next_stream.fetch_add(1, Ordering::Relaxed);
    state.streams.lock().unwrap().insert(id, task.abort_handle());
    Ok(id)
}

#[tauri::command]
fn gateway_stream_close(state: State<'_, AppState>, id: u32) {
    if let Some(h) = state.streams.lock().unwrap().remove(&id) {
        h.abort();
    }
}

/// 只认这几个地址：首启向导里的「去申请」与日志目录。不做通用的「打开链接」。
const APPLY_URLS: [&str; 3] = [
    "https://platform.deepseek.com/api_keys",
    "https://ram.console.aliyun.com/manage/ak",
    "https://console.amap.com/dev/key/app",
];

fn open_with_system(target: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(target).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer").arg(target).spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let result = std::process::Command::new("xdg-open").arg(target).spawn();
    result.map(|_| ()).map_err(to_s)
}

#[tauri::command]
fn open_apply_page(url: String) -> Result<(), String> {
    if !APPLY_URLS.contains(&url.as_str()) {
        return Err("不认识的地址".into());
    }
    open_with_system(&url)
}

#[tauri::command]
fn open_log_dir(state: State<'_, AppState>) -> Result<(), String> {
    let dir = state.status.as_ref().map(|s| s.lock().unwrap().log_dir.clone()).unwrap_or_default();
    if dir.is_empty() {
        return Err("还没有日志目录".into());
    }
    open_with_system(&dir)
}

fn build_host(app: &AppHandle) -> Result<Host, String> {
    let data_dir: PathBuf = app.path().app_data_dir().map_err(to_s)?;
    // 开发布局：仓库检出（本文件在 standalone/app/src-tauri/src）。安装包布局在路线第 6 步补。
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let cfg = HostConfig { profile: Profile::embedded().map_err(to_s)?, layout: Layout::dev(repo).map_err(to_s)?, data_dir };
    // 调试构建可以把凭据放进文件（自动化测试不往开发机钥匙串里写）；发行构建只用钥匙串。
    let secrets = match std::env::var("CABINHUG_STANDALONE_SECRETS_FILE") {
        Ok(path) if cfg!(debug_assertions) => Secrets::new(Box::new(FileBackend::new(path))),
        _ => Secrets::new(Box::new(KeychainBackend::new(KEYCHAIN_SERVICE).map_err(to_s)?)),
    };
    Host::new(cfg, secrets).map_err(to_s)
}

pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            let (host, boot_error) = match build_host(&handle) {
                Ok(h) => (Some(h), None),
                Err(e) => (None, Some(e)),
            };
            let status = host.as_ref().map(|h| h.status_handle());
            let ready_to_start = host
                .as_ref()
                .and_then(|h| h.secrets().missing_groups(h.profile()).ok())
                .is_some_and(|m| m.is_empty());
            app.manage(AppState {
                host: AsyncMutex::new(host),
                status,
                boot_error,
                profile: Profile::embedded()?,
                gateway: AsyncMutex::new(None),
                streams: Mutex::new(HashMap::new()),
                next_stream: AtomicU32::new(1),
                // 不走系统代理：本机网关在 127.0.0.1，代理软件会把它转走。
                http: reqwest::Client::builder().no_proxy().build()?,
            });
            if ready_to_start {
                spawn_start(handle);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            host_status,
            credential_groups,
            save_credentials,
            start_host,
            restart_host,
            client_config,
            gateway_request,
            gateway_stream,
            gateway_stream_close,
            open_apply_page,
            open_log_dir,
        ])
        .build(tauri::generate_context!())
        .expect("单机版窗口起不来");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // 倒序停服务与数据库；不等完就退，数据库会留下没收干净的进程。
            let state = handle.state::<AppState>();
            tauri::async_runtime::block_on(async {
                if let Some(host) = state.host.lock().await.as_mut() {
                    host.stop().await;
                }
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_blocks_survive_split_utf8() {
        let raw = "data: {\"t\":\"杭州\"}\n\n: hb\n\ndata: {\"t\":\"两天\"}\n\n".as_bytes();
        // 把第一个汉字从中间劈开，分两次喂。
        let cut = raw.iter().position(|b| *b == 0xe6).unwrap() + 1;
        let mut buf = raw[..cut].to_vec();
        assert!(take_blocks(&mut buf).is_empty());
        buf.extend_from_slice(&raw[cut..]);
        assert_eq!(take_blocks(&mut buf), vec!["{\"t\":\"杭州\"}".to_owned(), "{\"t\":\"两天\"}".to_owned()]);
        assert!(buf.is_empty());
    }

    #[test]
    fn only_v1_paths_are_relayed() {
        assert!(check_path("/v1/sessions").is_ok());
        assert!(check_path("/console/config").is_err());
        assert!(check_path("/v1/../console").is_err());
    }
}
