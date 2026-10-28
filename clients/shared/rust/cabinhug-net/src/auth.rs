//! 登录与刷新的网络侧（FL-07 F-07-01/02）。
//!
//! # 为什么登录也在 Rust 侧
//!
//! 与其余网关调用同一条纪律（§2.2 C2）：网络在 Rust，WebView 只管 UI。
//! 口令与 token 若经过 WebView 就进了 JS 堆，违反 F-07-03 的"WebView 不可读取原始 token"。
//!
//! # 401 之后只重试一次
//!
//! `with_refresh` 在收到 401 时刷一次 token 再重发，只重试一次：
//! 刷完还 401 说明不是过期问题（账号没了 / 设备被撤销 / 密钥换了），
//! 继续重试只会把一次失败变成一串失败。

use serde::{Deserialize, Serialize};

use cabinhug_core::auth::{self, Credentials};

use crate::upload::NetError;

#[derive(Debug, Serialize)]
struct LoginBody<'a> {
    username: &'a str,
    password: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_id: Option<&'a str>,
}

#[derive(Debug, Deserialize)]
struct LoginResponse {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "refreshToken")]
    refresh_token: String,
    user: LoginUser,
}

#[derive(Debug, Deserialize)]
struct LoginUser {
    id: String,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RefreshResponse {
    #[serde(rename = "accessToken")]
    access_token: String,
    /// 车辆级刷新时服务端回的当前绑定 VIN。
    ///
    /// 人的凭证没有这个字段，因此是 `Option`。
    #[serde(default)]
    vin: Option<String>,
}

/// 登录。成功后凭证进 `cabinhug_core::auth` 的进程内存储，不返回给调用方，
/// 避免 token 被传进 WebView。调用方只拿到成败。
pub async fn login(
    base_url: &str,
    username: &str,
    password: &str,
    device_id: Option<&str>,
) -> Result<(String, Option<String>), NetError> {
    let url = format!("{}/v1/auth/login", base_url.trim_end_matches('/'));
    let res = reqwest::Client::new()
        .post(&url)
        .json(&LoginBody { username, password, device_id })
        .send()
        .await
        .map_err(crate::upload::net_err)?;

    if res.status() == reqwest::StatusCode::UNAUTHORIZED {
        // 服务端刻意不区分"用户不存在"与"口令错"，端上也不细分。
        return Err(NetError::Unauthorized);
    }
    if !res.status().is_success() {
        // 与 `GatewayClient` 同一条分类：4xx 带 body 归 Rejected，5xx 才是 Server，
        // 端上据此拿到服务端的 error code。
        return Err(crate::upload::failure_from(res).await);
    }

    let body: LoginResponse = res.json().await.map_err(|e| NetError::BadResponse(e.to_string()))?;
    let user_id = body.user.id.clone();
    let display_name = body.user.display_name.clone();
    auth::set(Credentials {
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        user_id: user_id.clone(),
        display_name: display_name.clone(),
    });
    Ok((user_id, display_name))
}

/// 用当前 refresh token 换一枚新的 access。成功即就地更新进程内凭证。
///
/// 返回 `Ok(false)` 表示"没有 refresh 可用"（还没登录过），
/// 与"刷新被拒"（`Err`）分开：前者该去登录，后者该重新登录，路径不同。
pub async fn refresh(base_url: &str) -> Result<bool, NetError> {
    let Some(token) = auth::refresh_token() else {
        return Ok(false);
    };
    let url = format!("{}/v1/auth/refresh", base_url.trim_end_matches('/'));
    let res = reqwest::Client::new()
        .post(&url)
        .json(&serde_json::json!({ "refreshToken": token }))
        .send()
        .await
        .map_err(crate::upload::net_err)?;

    if res.status() == reqwest::StatusCode::UNAUTHORIZED {
        // refresh 也失效了：清空，端上回到登录页，避免每次请求都白刷一遍。
        auth::clear();
        return Err(NetError::Unauthorized);
    }
    if !res.status().is_success() {
        // 与 `GatewayClient` 同一条分类：4xx 带 body 归 Rejected，5xx 才是 Server，
        // 端上据此拿到服务端的 error code。
        return Err(crate::upload::failure_from(res).await);
    }
    let body: RefreshResponse = res.json().await.map_err(|e| NetError::BadResponse(e.to_string()))?;
    /*
     * 顺带纠正绑定标记：服务端每次刷新都重读 `devices.vehicleVin`，
     * 那是绑定的当前真相。端上配对时记下的 vin 会过期：补录 VIN
     * （`PEND-xxx` → 真 VIN）之后不纠正，`bound_vin()` 就指着一个
     * 服务端已经不认识的值，车机"已绑定"却列不出成员（404）。
     */
    auth::set_access_token_with_vin(body.access_token, body.vin.as_deref());
    Ok(true)
}

/// 在收到 401 时刷一次 token 再重发。
///
/// access token 有效期 15 分钟，refresh token 14 天；不经此包装的请求
/// 在 access 过期后一律 401。
///
/// # 闭包每次都要重新取 token
///
/// 不能在外面 `let (url, token) = gateway()` 一次然后闭包里用它：
/// 重发必须用刷新后的新 token，捕获快照等于白刷。
///
/// # 只重试一次
///
/// 刷完还 401 说明不是过期问题（账号没了 / 设备被撤销 / 密钥换了），
/// 继续重试只会把一次失败变成一串失败。
pub async fn with_refresh<T, F, Fut>(base_url: &str, mut call: F) -> Result<T, NetError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, NetError>>,
{
    match call().await {
        Err(NetError::Unauthorized) => {}
        other => return other,
    }
    // 没有 refresh 可用（没登录过）与刷新被拒，对调用方都是 Unauthorized：
    // 前者该去登录、后者该重新登录，这一层给不出区分，交给上层。
    if !refresh(base_url).await? {
        return Err(NetError::Unauthorized);
    }
    call().await
}

/// 主动把 access token 刷新一次，用于冷启动与定时保鲜。
///
/// # 与 `with_refresh` 的分工
///
/// `GatewayClient` 上有 39 个带鉴权的请求点，只有上车声明那条路径接了重试；
/// 全部改走重试包装属于核心网络 crate 的大范围重构，需先立 ACR。
/// 定时保鲜让 token 不过期，覆盖同一个失败模式，代价是每 10 分钟一次 HTTP。
///
/// 不返回 Err：保鲜失败不该让调用方（一个后台循环）有任何分支，
/// 但必须留下日志。
pub async fn keep_fresh(base_url: &str) -> bool {
    match refresh(base_url).await {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[auth] 凭证保鲜失败：{e}");
            false
        }
    }
}

/// 退出登录。当场清空进程内凭证。
pub fn logout() {
    auth::clear();
}

// ── 设备注册与车机绑定（F-56-02/03） ──────────────────

#[derive(Debug, Serialize)]
struct RegisterDeviceBody<'a> {
    #[serde(rename = "deviceId")]
    device_id: &'a str,
    #[serde(rename = "deviceType")]
    device_type: &'a str,
    #[serde(rename = "modelName")]
    model_name: &'a str,
}

/// 私人终端注册。登录后每次启动都调，幂等（服务端 upsert 并刷新活跃时刻）。
pub async fn register_device(
    base_url: &str,
    device_id: &str,
    device_type: &str,
    model_name: &str,
) -> Result<(), NetError> {
    let url = format!("{}/v1/devices/register", base_url.trim_end_matches('/'));
    let Some(token) = auth::access_token() else {
        // 没登录就注册不了设备：这是顺序问题而非错误，由调用方决定要不要报。
        return Err(NetError::Unauthorized);
    };
    let res = reqwest::Client::new()
        .post(&url)
        .header("authorization", format!("Bearer {token}"))
        .json(&RegisterDeviceBody { device_id, device_type, model_name })
        .send()
        .await
        .map_err(crate::upload::net_err)?;
    if res.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(NetError::Unauthorized);
    }
    if !res.status().is_success() {
        // 与 `GatewayClient` 同一条分类：4xx 带 body 归 Rejected，5xx 才是 Server，
        // 端上据此拿到服务端的 error code。
        return Err(crate::upload::failure_from(res).await);
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct PairingCode {
    pub code: String,
    #[serde(rename = "expiresInSec")]
    pub expires_in_sec: u32,
    /// 车主用来核对"我扫的这台机器要绑的是我这辆车"的尾号。
    #[serde(rename = "vinSuffix")]
    pub vin_suffix: String,
}

/// 车主扫码后向服务端要一枚配对码（手机端调，需已登录且是该车车主）。
pub async fn request_pairing_code(
    base_url: &str,
    device_id: &str,
    vin: &str,
) -> Result<PairingCode, NetError> {
    let url = format!("{}/v1/devices/bind-request", base_url.trim_end_matches('/'));
    let Some(token) = auth::access_token() else {
        return Err(NetError::Unauthorized);
    };
    let res = reqwest::Client::new()
        .post(&url)
        .header("authorization", format!("Bearer {token}"))
        .json(&serde_json::json!({ "deviceId": device_id, "vin": vin }))
        .send()
        .await
        .map_err(crate::upload::net_err)?;
    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(NetError::Unauthorized);
    }
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(NetError::Rejected { status: status.as_u16(), body });
    }
    res.json()
        .await
        .map_err(|e| NetError::BadResponse(e.to_string()))
}

#[derive(Debug, Deserialize)]
struct BindConfirmResponse {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "refreshToken")]
    refresh_token: String,
    vin: String,
}

/// 车机输入配对码换车辆级凭证（车机端调，不需要事先登录）。
///
/// 拿到的凭证进 `cabinhug_core::auth`，与人的 token 用同一个持有者：
/// 车机在同一时刻不会既是"某个人"又是"某辆车"，两者互斥。
/// `user_id` 位置存 vin 的标记，让端上能显示"已绑定到 …4321"。
pub async fn confirm_pairing(
    base_url: &str,
    device_id: &str,
    code: &str,
    model_name: &str,
) -> Result<String, NetError> {
    let url = format!("{}/v1/devices/bind-confirm", base_url.trim_end_matches('/'));
    let res = reqwest::Client::new()
        .post(&url)
        .json(&serde_json::json!({
            "deviceId": device_id,
            "code": code,
            "modelName": model_name,
        }))
        .send()
        .await
        .map_err(crate::upload::net_err)?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(NetError::Rejected { status: status.as_u16(), body });
    }
    let body: BindConfirmResponse = res
        .json()
        .await
        .map_err(|e| NetError::BadResponse(e.to_string()))?;
    let vin = body.vin.clone();
    auth::set(Credentials {
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        // 车辆级凭证不代表任何人（设计裁决 R4）。这里放 vin 只为端上显示
        // "已绑定到哪辆车"；任何"谁在用"的判断都不得读它。
        user_id: format!("vehicle:{vin}"),
        display_name: None,
    });
    Ok(vin)
}

#[cfg(test)]
mod refresh_wiring_tests {
    /*
     * 这一组守的是接线，不是行为：`with_refresh` 与 `keep_fresh` 缺失时
     * 编译与其余测试照常通过，只在 access token 过期后表现为全线 401。
     */
    use super::*;

    /// 401 → 刷新 → 重发；没有 refresh 可用时不重试，直接 Unauthorized。
    #[tokio::test]
    async fn 没有refresh时不做无谓的重试() {
        auth::clear();
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let r: Result<(), NetError> = with_refresh("http://127.0.0.1:1", || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async { Err(NetError::Unauthorized) }
        })
        .await;
        assert!(matches!(r, Err(NetError::Unauthorized)));
        assert_eq!(
            calls.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "没登录过还去刷一遍，只会把一次失败变成两次网络往返",
        );
    }

    /// 非 401 的错误原样穿过：重试包装不得把别的故障吞成鉴权问题。
    #[tokio::test]
    async fn 非401原样返回() {
        let r: Result<(), NetError> =
            with_refresh("http://127.0.0.1:1", || async { Err(NetError::Server(503)) }).await;
        assert!(matches!(r, Err(NetError::Server(503))), "503 被改写了");
    }

    /// 成功路径只调一次，不做多余往返。
    #[tokio::test]
    async fn 成功时只调一次() {
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let r: Result<u8, NetError> = with_refresh("http://127.0.0.1:1", || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async { Ok(7) }
        })
        .await;
        assert_eq!(r.unwrap(), 7);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    /// `keep_fresh` 不返回 Err：它的调用方是个后台循环，不该有分支。
    #[tokio::test]
    async fn 保鲜失败不抛错只记日志() {
        auth::clear();
        assert!(!keep_fresh("http://127.0.0.1:1").await, "没登录过应为 false 而不是 panic");
    }
}
