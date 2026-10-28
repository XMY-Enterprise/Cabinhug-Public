//! 单机配置（`standalone/profile/standalone.json`）：开哪些能力、要哪几组凭据、起哪些服务。
//!
//! 它是单机版的唯一来源（ARCH-002「单机版能力范围与配置」）：宿主据此生成服务进程的环境变量，
//! 打包脚本据此决定装哪些东西。容器部署不读它。文件编进二进制（`include_str!`），
//! 安装后没有一份可以被改的副本——能力开关被改开，等于把关掉的能力在单机版里意外开放。

use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;

use crate::error::{fail, Result};

pub const PROFILE_SCHEMA: &str = "cabinhug-standalone-profile/v1";
const EMBEDDED: &str = include_str!("../../profile/standalone.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub schema: String,
    /// 交给 `CABINHUG_CAPABILITIES_OFF` 的关闭清单（ACR-056 / ACR-059）。
    pub capabilities_off: Vec<String>,
    /// 原样进每个服务进程的环境变量。
    pub env: BTreeMap<String, String>,
    pub credentials: Vec<CredentialGroup>,
    /// 按顺序启动，倒序停止。
    pub services: Vec<ServiceSpec>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CredentialGroup {
    pub group: String,
    pub label: String,
    pub fields: Vec<CredentialField>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CredentialField {
    /// 服务进程里的环境变量名，也是存储里的键。
    pub env: String,
    pub label: String,
    /// 界面要用的（高德 JS Key 与安全密钥）。服务端用不用都照样注入。
    #[serde(default)]
    pub client: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceSpec {
    pub name: String,
    /// 相对仓库根（开发布局）或服务端闭包根（安装包）的包目录。
    pub package: String,
    pub port_env: String,
    pub bind_env: String,
    /// 其它服务找它用的变量（如网关读 `AGENT_RUNTIME_URL`）。
    pub url_env: String,
    pub health: String,
}

impl Profile {
    pub fn embedded() -> Result<Self> {
        Self::parse(EMBEDDED)
    }

    pub fn parse(json: &str) -> Result<Self> {
        let profile: Profile = serde_json::from_str(json)?;
        if profile.schema != PROFILE_SCHEMA {
            return fail(format!("单机配置格式不认识：{}", profile.schema));
        }
        let mut groups = BTreeSet::new();
        let mut envs = BTreeSet::new();
        for g in &profile.credentials {
            if !groups.insert(g.group.as_str()) {
                return fail(format!("单机配置里凭据组重名：{}", g.group));
            }
            for f in &g.fields {
                if !envs.insert(f.env.as_str()) {
                    return fail(format!("单机配置里凭据字段重名：{}", f.env));
                }
            }
        }
        if profile.services.is_empty() {
            return fail("单机配置里没有服务");
        }
        Ok(profile)
    }

    pub fn capabilities_off_value(&self) -> String {
        self.capabilities_off.join(",")
    }

    pub fn group(&self, group: &str) -> Option<&CredentialGroup> {
        self.credentials.iter().find(|g| g.group == group)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_profile_is_trip_only() {
        let p = Profile::embedded().unwrap();
        // 单机版只做行程：七项能力全关（ARCH-002）。
        for c in ["photo-diagnosis", "ownership-qa", "service-qa", "buying-advice", "test-drive", "cabin-control", "voice"] {
            assert!(p.capabilities_off.iter().any(|x| x == c), "缺 {c}");
        }
        let groups: Vec<&str> = p.credentials.iter().map(|g| g.group.as_str()).collect();
        assert_eq!(groups, ["deepseek", "aliyun-guard", "amap"]);
        let services: Vec<&str> = p.services.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(services, ["agent-runtime", "gateway", "worker"], "runtime 先起：网关启动时就要能连上它");
        assert_eq!(p.env.get("WEATHER_PROVIDER").map(String::as_str), Some("amap"));
    }

    #[test]
    fn rejects_unknown_schema_and_duplicate_fields() {
        assert!(Profile::parse(r#"{"schema":"x","capabilitiesOff":[],"env":{},"credentials":[],"services":[]}"#).is_err());
        let dup = r#"{"schema":"cabinhug-standalone-profile/v1","capabilitiesOff":[],"env":{},
          "credentials":[{"group":"a","label":"A","fields":[{"env":"K","label":"k"}]},{"group":"b","label":"B","fields":[{"env":"K","label":"k"}]}],
          "services":[{"name":"s","package":"p","portEnv":"P","bindEnv":"B","urlEnv":"U","health":"/h"}]}"#;
        assert!(Profile::parse(dup).is_err());
    }
}
