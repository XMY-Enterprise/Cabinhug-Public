//! 登录相关的 Tauri 命令（F-07-01/03）。
//!
//! 与手机端 `clients/mobile/src-tauri/src/commands/auth.rs` **同一形状**：
//! 返回值里没有任何一处是 token，WebView 只知道"登录了没、是谁"。
//!
//! # 车机为什么也要有它
//!
//! 车机角色不在屏上输账号口令（F-07-04：车机免密，扫码绑定）。这套命令服务于
//! personal 角色的登录门（`LoginGate`）；扫码绑定时登录的是手机，走的也是这套命令。
//! 两端共用一份。
use serde::Serialize;

/// 登录后回给界面的身份。**刻意不含 token**。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub authenticated: bool,
    pub user_id: Option<String>,
    pub display_name: Option<String>,
}

fn status_now() -> AuthStatus {
    match cabinhug_core::auth::current_user() {
        Some((user_id, display_name)) => AuthStatus {
            authenticated: true,
            user_id: Some(user_id),
            display_name,
        },
        None => AuthStatus { authenticated: false, user_id: None, display_name: None },
    }
}

#[tauri::command]
pub async fn auth_login(username: String, password: String) -> Result<AuthStatus, String> {
    let (base_url, _) = crate::settings::gateway();
    cabinhug_net::login(&base_url, &username, &password, None)
        .await
        // 401 与网络故障分开提示：前者用户能自己解决，后者与口令无关。
        .map_err(|e| match e {
            cabinhug_net::NetError::Unauthorized => "账号或口令不正确".to_string(),
            other => format!("登录失败：{other}"),
        })?;
    Ok(status_now())
}

#[tauri::command]
pub fn auth_status() -> AuthStatus {
    status_now()
}

#[tauri::command]
pub fn auth_logout() {
    cabinhug_net::logout();
}
