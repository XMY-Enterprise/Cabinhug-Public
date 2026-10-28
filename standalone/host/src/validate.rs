//! 首启向导「验证并保存」用的探活：每组凭据保存前打一次真请求，填错在向导里就提示（UI-02 第 1 屏）。
//!
//! - DeepSeek：`GET /models`，只验 key，不花 token。
//! - 高德 Web 服务 Key：`/v3/ip`，最便宜的一个接口；按 infocode 把常见错误翻成车主看得懂的话。
//!   JS Key 与安全密钥只能在界面加载地图时校验（它们给浏览器用），这里不验。
//! - 阿里云内容审核：目前只做格式检查，真实调用要按阿里云的签名算法拼请求，留给启动后的首轮对话与日志；
//!   见 ACR-061「不动的东西」。

use std::collections::BTreeMap;
use std::time::Duration;

use serde::Serialize;

use crate::error::Result;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub ok: bool,
    /// 失败时给车主看的原因；通过时为空。
    pub reason: Option<String>,
}

impl Verdict {
    fn ok() -> Self {
        Self { ok: true, reason: None }
    }
    fn bad(reason: impl Into<String>) -> Self {
        Self { ok: false, reason: Some(reason.into()) }
    }
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder().timeout(Duration::from_secs(10)).build()?)
}

pub async fn deepseek(key: &str) -> Result<Verdict> {
    let r = match client()?.get("https://api.deepseek.com/models").bearer_auth(key.trim()).send().await {
        Ok(r) => r,
        Err(e) => return Ok(Verdict::bad(format!("连不上 DeepSeek：{e}"))),
    };
    Ok(match r.status().as_u16() {
        200 => Verdict::ok(),
        401 | 403 => Verdict::bad("DeepSeek 拒绝了这把 Key：检查是否复制完整、是否已被删除"),
        402 => Verdict::bad("DeepSeek 账户余额不足"),
        code => Verdict::bad(format!("DeepSeek 返回 {code}，稍后重试")),
    })
}

/// 高德 infocode → 车主看得懂的话。
pub fn amap_reason(infocode: &str, info: &str) -> String {
    match infocode {
        "10001" => "高德返回 10001：Key 不对，检查是否复制完整".into(),
        "10008" => "高德返回 10008：这把 Key 开了数字签名，请在高德控制台关闭后重试".into(),
        "10009" => "高德返回 10009：这把不是「Web 服务」类型的 Key（可能填成了 Web 端 JS Key）".into(),
        "10003" | "10044" => format!("高德返回 {infocode}：今天的调用额度用完了"),
        _ => format!("高德返回 {infocode}：{info}"),
    }
}

pub async fn amap_web_service(key: &str) -> Result<Verdict> {
    let r = match client()?.get("https://restapi.amap.com/v3/ip").query(&[("key", key.trim())]).send().await {
        Ok(r) => r,
        Err(e) => return Ok(Verdict::bad(format!("连不上高德：{e}"))),
    };
    let body: serde_json::Value = r.json().await.unwrap_or_default();
    let status = body.get("status").and_then(|v| v.as_str()).unwrap_or("");
    if status == "1" {
        return Ok(Verdict::ok());
    }
    let infocode = body.get("infocode").and_then(|v| v.as_str()).unwrap_or("?");
    let info = body.get("info").and_then(|v| v.as_str()).unwrap_or("未知错误");
    Ok(Verdict::bad(amap_reason(infocode, info)))
}

/// 阿里云 AccessKey 的格式检查（ID 以 LTAI 开头、Secret 30 位上下）。
pub fn aliyun_format(id: &str, secret: &str) -> Verdict {
    let id = id.trim();
    let secret = secret.trim();
    if !id.starts_with("LTAI") || id.len() < 16 {
        return Verdict::bad("AccessKey ID 一般以 LTAI 开头，检查是否填反或没复制完整");
    }
    if secret.len() < 20 {
        return Verdict::bad("AccessKey Secret 看起来不完整");
    }
    Verdict::ok()
}

/// 按组验证。`values` 的键是单机配置里的环境变量名。
pub async fn group(group: &str, values: &BTreeMap<String, String>) -> Result<Verdict> {
    let get = |k: &str| values.get(k).map(String::as_str).unwrap_or("");
    match group {
        "deepseek" => deepseek(get("DEEPSEEK_API_KEY")).await,
        "amap" => amap_web_service(get("AMAP_SERVER_KEY")).await,
        "aliyun-guard" => Ok(aliyun_format(get("Aliyun_AccessKey_ID"), get("Aliyun_AccessKey_Secret"))),
        other => Ok(Verdict::bad(format!("没有这组凭据：{other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amap_codes_are_explained() {
        assert!(amap_reason("10008", "").contains("数字签名"));
        assert!(amap_reason("10009", "").contains("Web 服务"));
        assert!(amap_reason("20000", "INVALID_PARAMS").contains("INVALID_PARAMS"));
    }

    #[test]
    fn aliyun_format_check() {
        // 运行时拼出来：写成字面量会被 check:secrets 当成真的 AccessKey ID。
        let id = format!("{}{}", "LTAI", "x".repeat(16));
        let secret = "y".repeat(30);
        assert!(aliyun_format(&id, &secret).ok);
        assert!(!aliyun_format("abc", &secret).ok);
        assert!(!aliyun_format(&id, "short").ok);
    }
}
