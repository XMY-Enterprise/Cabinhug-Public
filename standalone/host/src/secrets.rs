//! 凭据与本机内部密钥的保管（ARCH-002「宿主凭据模块」）。
//!
//! # 存什么
//!
//! - 车主填的三组凭据（单机配置 `credentials` 里的每个字段，按环境变量名存）；
//! - 首次启动时生成、之后不变的内部密钥：本机数据库口令、网关 JWT 密钥、配置与个人数据主密钥、
//!   后台令牌、本机账号口令。它们只在这台机器上用，用户看不到也不需要知道。
//!
//! # 整份存成一条钥匙串条目
//!
//! 一条条目对应一次系统授权弹窗（ad-hoc 签名的应用每次重签后都会再问一次）；拆成十几条，
//! 首次启动就要连点十几次。整份 JSON 一条，读写都是一次。
//!
//! # 读坏了不重置
//!
//! 数据库口令一旦换掉，已有的本机数据库就再也打不开。所以条目解析失败时报错，不生成新的覆盖它。
//!
//! # 文件后端只给开发与测试
//!
//! 无头调试（`cabinhug-standalone-host run --secrets-file …`）与单测不该往开发机的钥匙串里写东西。
//! 文件权限 0600；安装包里的宿主只用钥匙串。

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{fail, HostError, Result};
use crate::profile::Profile;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSecrets {
    #[serde(default)]
    pub internal: Option<InternalSecrets>,
    /// 环境变量名 → 值。
    #[serde(default)]
    pub credentials: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalSecrets {
    pub db_password: String,
    pub jwt_secret: String,
    pub config_master_key: String,
    pub pii_master_key: String,
    pub admin_token: String,
    pub ops_token: String,
    pub owner_password: String,
}

impl InternalSecrets {
    fn generate() -> Result<Self> {
        Ok(Self {
            db_password: random_hex(24)?,
            jwt_secret: random_hex(32)?,
            config_master_key: random_hex(32)?,
            pii_master_key: random_hex(32)?,
            admin_token: random_hex(32)?,
            ops_token: random_hex(32)?,
            owner_password: random_hex(24)?,
        })
    }

    /// 进服务进程的那几个（本机账号口令不进：它只用来登录，见 `host.rs`）。
    pub fn service_env(&self) -> BTreeMap<String, String> {
        BTreeMap::from([
            ("CABINHUG_JWT_SECRET".to_owned(), self.jwt_secret.clone()),
            ("CABINHUG_CONFIG_MASTER_KEY".to_owned(), self.config_master_key.clone()),
            ("CABINHUG_PII_MASTER_KEY".to_owned(), self.pii_master_key.clone()),
            ("CABINHUG_ADMIN_TOKEN".to_owned(), self.admin_token.clone()),
            ("CABINHUG_OPS_TOKEN".to_owned(), self.ops_token.clone()),
        ])
    }
}

pub fn random_hex(bytes: usize) -> Result<String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| HostError::Message(format!("系统随机数不可用：{e}")))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

pub trait SecretBackend: Send + Sync {
    fn load(&self) -> Result<Option<String>>;
    fn save(&self, value: &str) -> Result<()>;
}

/// 系统凭据库：macOS 钥匙串 / Windows 凭据管理器。
pub struct KeychainBackend {
    service: String,
    account: String,
}

impl KeychainBackend {
    pub fn new(service: impl Into<String>) -> Result<Self> {
        if !init_store() {
            return fail("系统钥匙串不可用：不会把凭据存成明文文件");
        }
        Ok(Self { service: service.into(), account: "host-secrets".to_owned() })
    }

    fn entry(&self) -> Result<keyring_core::Entry> {
        keyring_core::Entry::new(&self.service, &self.account).map_err(|e| HostError::Message(format!("钥匙串条目打不开：{e}")))
    }
}

impl SecretBackend for KeychainBackend {
    fn load(&self) -> Result<Option<String>> {
        match self.entry()?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(e) => fail(format!("读钥匙串被拒绝或不可用：{e}")),
        }
    }

    fn save(&self, value: &str) -> Result<()> {
        self.entry()?.set_password(value).map_err(|e| HostError::Message(format!("写钥匙串失败：{e}")))
    }
}

/// 与 `cabinhug-core` 的 `auth.rs` 同一套装配：macOS 用钥匙串，其余平台走 keyring 的 v1 兼容层。
fn init_store() -> bool {
    use std::sync::OnceLock;
    static READY: OnceLock<bool> = OnceLock::new();
    *READY.get_or_init(|| {
        #[cfg(target_os = "macos")]
        {
            match apple_native_keyring_store::keychain::Store::new() {
                Ok(store) => {
                    keyring_core::set_default_store(store);
                    true
                }
                Err(_) => false,
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            keyring::Entry::store_status().is_ok()
        }
    })
}

/// 开发与测试用的文件后端（0600）。
pub struct FileBackend {
    path: PathBuf,
}

impl FileBackend {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
}

impl SecretBackend for FileBackend {
    fn load(&self) -> Result<Option<String>> {
        match std::fs::read_to_string(&self.path) {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    fn save(&self, value: &str) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&self.path, value)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    }
}

pub struct Secrets {
    backend: Box<dyn SecretBackend>,
}

impl Secrets {
    pub fn new(backend: Box<dyn SecretBackend>) -> Self {
        Self { backend }
    }

    pub fn load(&self) -> Result<StoredSecrets> {
        match self.backend.load()? {
            None => Ok(StoredSecrets::default()),
            Some(raw) => serde_json::from_str(&raw)
                .map_err(|_| HostError::Message("凭据记录损坏；不会重置（本机数据库口令在里面，换掉就打不开已有数据）".into())),
        }
    }

    fn save(&self, s: &StoredSecrets) -> Result<()> {
        self.backend.save(&serde_json::to_string(s)?)
    }

    /// 已有就原样返回，没有就生成并存下。`has_database` 为真却没有记录：拒绝生成新的（见文件头）。
    pub fn ensure_internal(&self, has_database: bool) -> Result<InternalSecrets> {
        let mut s = self.load()?;
        if let Some(internal) = s.internal.clone() {
            return Ok(internal);
        }
        if has_database {
            return fail("本机已有数据库，但找不到它的口令记录；不会生成新口令覆盖（那样已有数据会打不开）");
        }
        let internal = InternalSecrets::generate()?;
        s.internal = Some(internal.clone());
        self.save(&s)?;
        Ok(internal)
    }

    /// 存一组凭据：只收单机配置里声明过的字段，且每个都要填。
    pub fn set_group(&self, profile: &Profile, group: &str, values: &BTreeMap<String, String>) -> Result<()> {
        let Some(spec) = profile.group(group) else {
            return fail(format!("没有这组凭据：{group}"));
        };
        for f in &spec.fields {
            match values.get(&f.env) {
                Some(v) if !v.trim().is_empty() && v.len() <= 4096 => {}
                _ => return fail(format!("{}：「{}」没填", spec.label, f.label)),
            }
        }
        if let Some(extra) = values.keys().find(|k| !spec.fields.iter().any(|f| &f.env == *k)) {
            return fail(format!("{}：多了一个不认识的字段 {extra}", spec.label));
        }
        let mut s = self.load()?;
        for f in &spec.fields {
            s.credentials.insert(f.env.clone(), values[&f.env].trim().to_owned());
        }
        self.save(&s)
    }

    /// 还没填全的凭据组（按单机配置的顺序）。
    pub fn missing_groups(&self, profile: &Profile) -> Result<Vec<String>> {
        let s = self.load()?;
        Ok(profile
            .credentials
            .iter()
            .filter(|g| g.fields.iter().any(|f| s.credentials.get(&f.env).is_none_or(|v| v.is_empty())))
            .map(|g| g.group.clone())
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Memory(Mutex<Option<String>>);
    impl SecretBackend for Memory {
        fn load(&self) -> Result<Option<String>> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn save(&self, value: &str) -> Result<()> {
            *self.0.lock().unwrap() = Some(value.to_owned());
            Ok(())
        }
    }

    fn secrets() -> Secrets {
        Secrets::new(Box::new(Memory::default()))
    }

    #[test]
    fn internal_secrets_are_generated_once() {
        let s = secrets();
        let a = s.ensure_internal(false).unwrap();
        let b = s.ensure_internal(true).unwrap();
        assert_eq!(a.db_password, b.db_password, "第二次必须读回同一份，否则已有数据库打不开");
        assert_eq!(a.jwt_secret.len(), 64);
    }

    #[test]
    fn refuses_to_regenerate_when_a_database_exists() {
        assert!(secrets().ensure_internal(true).is_err());
    }

    #[test]
    fn corrupt_record_is_an_error_not_a_reset() {
        let s = Secrets::new(Box::new(Memory(Mutex::new(Some("{not json".into())))));
        assert!(s.ensure_internal(false).is_err());
    }

    #[test]
    fn credential_groups_are_checked_against_the_profile() {
        let p = Profile::embedded().unwrap();
        let s = secrets();
        assert_eq!(s.missing_groups(&p).unwrap(), ["deepseek", "aliyun-guard", "amap"]);
        let partial = BTreeMap::from([("AMAP_SERVER_KEY".to_owned(), "k".to_owned())]);
        assert!(s.set_group(&p, "amap", &partial).is_err(), "三个字段缺两个");
        let extra = BTreeMap::from([("DEEPSEEK_API_KEY".to_owned(), "sk".to_owned()), ("X".to_owned(), "y".to_owned())]);
        assert!(s.set_group(&p, "deepseek", &extra).is_err());
        let ok = BTreeMap::from([("DEEPSEEK_API_KEY".to_owned(), " sk-1 ".to_owned())]);
        s.set_group(&p, "deepseek", &ok).unwrap();
        assert_eq!(s.load().unwrap().credentials["DEEPSEEK_API_KEY"], "sk-1");
        assert_eq!(s.missing_groups(&p).unwrap(), ["aliyun-guard", "amap"]);
    }
}
