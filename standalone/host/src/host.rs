//! 宿主编排：本机数据库 → 迁移 → 本机账号 → agent-runtime → gateway → worker → 启动核对。
//!
//! 状态（`HostStatus`）随每一步更新，界面轮询它画首启页的进度。退出时倒序：worker → gateway →
//! runtime → 数据库（ARCH-002「进程与生命周期」）。
//!
//! # 启动核对不是可选项
//!
//! 能力开关以环境变量钉档，宿主每次拉起服务都从单机配置生成它。就绪后再向网关要一次
//! `GET /v1/capabilities`，下发的关闭清单与单机配置不一致就判启动失败、不放出界面：
//! 关掉的能力在单机版里意外开放，比起不来更糟（ARCH-002「单机配置只由宿主注入，并在启动后核对」）。

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;

use crate::error::{fail, HostError, Result};
use crate::layout::Layout;
use crate::postgres::{base_env, Postgres};
use crate::profile::Profile;
use crate::secrets::{InternalSecrets, Secrets};
use crate::services::{self, RunningService};

/// 本机账号（ARCH-002 路线第 5 步换成正式的本机身份前，沿用迁移种下的 `demo` 账号）。
pub const OWNER_USERNAME: &str = "demo";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Idle,
    NeedsCredentials,
    Starting,
    Ready,
    Failed,
    Stopping,
    Stopped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StepState {
    Waiting,
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct Step {
    pub id: &'static str,
    pub label: &'static str,
    pub state: StepState,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatus {
    pub phase: Phase,
    pub steps: Vec<Step>,
    pub message: Option<String>,
    pub missing_credentials: Vec<String>,
    pub log_dir: String,
}

const STEPS: [(&str, &str); 7] = [
    ("database", "本地数据库"),
    ("migrate", "数据迁移"),
    ("account", "本机账号"),
    ("agent-runtime", "智能体服务"),
    ("gateway", "本机网关"),
    ("worker", "后台任务"),
    ("selfcheck", "启动核对"),
];

/// 界面经 Rust 侧登录网关用的东西。口令只在宿主与应用的 Rust 侧之间传，不进 WebView。
#[derive(Debug, Clone)]
pub struct GatewayAccess {
    pub base_url: String,
    pub username: String,
    pub password: String,
}

pub struct HostConfig {
    pub profile: Profile,
    pub layout: Layout,
    pub data_dir: PathBuf,
}

pub struct Host {
    cfg: HostConfig,
    secrets: Secrets,
    status: Arc<Mutex<HostStatus>>,
    pg: Option<Postgres>,
    services: Vec<RunningService>,
    access: Option<GatewayAccess>,
    _lock: File,
}

impl Host {
    /// 建数据目录、取单实例锁。第二个宿主进程在这里就失败，不会把同一份数据库再起一遍。
    pub fn new(cfg: HostConfig, secrets: Secrets) -> Result<Self> {
        for sub in ["logs", "tmp", "home"] {
            std::fs::create_dir_all(cfg.data_dir.join(sub))?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&cfg.data_dir, std::fs::Permissions::from_mode(0o700))?;
        }
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(cfg.data_dir.join("app.lock"))?;
        if lock.try_lock().is_err() {
            return fail("本机已有一个 Cabinhug 在运行，不再启动第二个");
        }
        let status = HostStatus {
            phase: Phase::Idle,
            steps: STEPS.iter().map(|(id, label)| Step { id, label, state: StepState::Waiting, detail: None }).collect(),
            message: None,
            missing_credentials: Vec::new(),
            log_dir: cfg.data_dir.join("logs").to_string_lossy().into_owned(),
        };
        Ok(Self { cfg, secrets, status: Arc::new(Mutex::new(status)), pg: None, services: Vec::new(), access: None, _lock: lock })
    }

    pub fn status(&self) -> HostStatus {
        self.status.lock().unwrap().clone()
    }

    pub fn status_handle(&self) -> Arc<Mutex<HostStatus>> {
        Arc::clone(&self.status)
    }

    pub fn secrets(&self) -> &Secrets {
        &self.secrets
    }

    pub fn profile(&self) -> &Profile {
        &self.cfg.profile
    }

    pub fn access(&self) -> Option<GatewayAccess> {
        self.access.clone()
    }

    /// 界面要的凭据（高德 JS Key 与安全密钥，单机配置里标了 `client` 的字段）。
    pub fn client_credentials(&self) -> Result<BTreeMap<String, String>> {
        let stored = self.secrets.load()?;
        Ok(self
            .cfg
            .profile
            .credentials
            .iter()
            .flat_map(|g| g.fields.iter())
            .filter(|f| f.client)
            .filter_map(|f| stored.credentials.get(&f.env).map(|v| (f.env.clone(), v.clone())))
            .collect())
    }

    fn set_phase(&self, phase: Phase, message: Option<String>) {
        let mut s = self.status.lock().unwrap();
        s.phase = phase;
        s.message = message;
    }

    fn set_step(&self, id: &str, state: StepState, detail: Option<String>) {
        let mut s = self.status.lock().unwrap();
        if let Some(step) = s.steps.iter_mut().find(|x| x.id == id) {
            step.state = state;
            step.detail = detail;
        }
    }

    async fn step<T>(&self, id: &'static str, fut: impl std::future::Future<Output = Result<T>>) -> Result<T> {
        self.set_step(id, StepState::Running, None);
        match fut.await {
            Ok(v) => {
                self.set_step(id, StepState::Done, None);
                Ok(v)
            }
            Err(e) => {
                self.set_step(id, StepState::Failed, Some(e.to_string()));
                Err(e)
            }
        }
    }

    /// 起全部。凭据没填全时停在 `NeedsCredentials`（返回 Ok），由界面收齐后再调一次。
    pub async fn start(&mut self) -> Result<()> {
        let missing = self.secrets.missing_groups(&self.cfg.profile)?;
        if !missing.is_empty() {
            self.status.lock().unwrap().missing_credentials = missing;
            self.set_phase(Phase::NeedsCredentials, Some("先填写三组密钥".into()));
            return Ok(());
        }
        self.status.lock().unwrap().missing_credentials.clear();
        self.set_phase(Phase::Starting, None);
        match self.start_inner().await {
            Ok(()) => {
                self.set_phase(Phase::Ready, None);
                Ok(())
            }
            Err(e) => {
                self.set_phase(Phase::Failed, Some(e.to_string()));
                self.stop_processes().await;
                Err(e)
            }
        }
    }

    async fn start_inner(&mut self) -> Result<()> {
        let data_dir = self.cfg.data_dir.clone();
        let logs = data_dir.join("logs");
        let internal = self.secrets.ensure_internal(Postgres::exists(&data_dir))?;

        let pg = Postgres::new(&self.cfg.layout, &data_dir, &logs, services::free_port()?);
        self.step("database", async {
            pg.ensure_initialized(&internal.db_password).await?;
            pg.start().await?;
            pg.ensure_database(&internal.db_password).await
        })
        .await?;
        let database_url = pg.url(&internal.db_password);
        self.pg = Some(pg);

        self.step("migrate", self.migrate(&database_url)).await?;
        self.step("account", self.seed_owner(&database_url, &internal)).await?;

        // 先把三个服务的端口都定下：网关启动时就要知道 runtime 与 worker 在哪。
        let mut ports = BTreeMap::new();
        for spec in &self.cfg.profile.services {
            ports.insert(spec.name.clone(), services::free_port()?);
        }
        let env = self.service_env(&database_url, &internal, &ports)?;
        let specs = self.cfg.profile.services.clone();
        for spec in &specs {
            let id: &'static str = STEPS.iter().find(|(s, _)| *s == spec.name).map(|(s, _)| *s).unwrap_or("worker");
            self.set_step(id, StepState::Running, None);
            let mut svc = match services::spawn(&self.cfg.layout, spec, ports[&spec.name], &env, &logs).await {
                Ok(svc) => svc,
                Err(e) => {
                    self.set_step(id, StepState::Failed, Some(e.to_string()));
                    return Err(e);
                }
            };
            // runtime 首启要做 ACP 自检、拉起 pi，给足时间。
            let wait = svc.wait_healthy(&spec.health, Duration::from_secs(120)).await;
            // 先登记再判：没就绪的也要在 stop 时收掉。
            self.services.push(svc);
            match wait {
                Ok(()) => self.set_step(id, StepState::Done, None),
                Err(e) => {
                    self.set_step(id, StepState::Failed, Some(e.to_string()));
                    return Err(e);
                }
            }
        }

        let gateway = format!("http://127.0.0.1:{}", ports["gateway"]);
        let access = GatewayAccess { base_url: gateway, username: OWNER_USERNAME.into(), password: internal.owner_password.clone() };
        self.step("selfcheck", self.self_check(&access)).await?;
        self.access = Some(access);
        Ok(())
    }

    async fn run_node(&self, cwd: &Path, args: &[String], extra: &BTreeMap<String, String>, what: &str) -> Result<()> {
        let mut env = base_env(self.cfg.layout.node_dir(), &self.cfg.data_dir.join("tmp"));
        env.extend(extra.clone());
        let out = tokio::process::Command::new(&self.cfg.layout.node)
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .envs(&env)
            .output()
            .await?;
        if !out.status.success() {
            let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
            let tail: String = text.chars().rev().take(1200).collect::<Vec<_>>().into_iter().rev().collect();
            return fail(format!("{what}失败：{}", tail.trim()));
        }
        Ok(())
    }

    async fn migrate(&self, database_url: &str) -> Result<()> {
        let layout = &self.cfg.layout;
        let args = vec![
            layout.prisma_cli().to_string_lossy().into_owned(),
            "migrate".into(),
            "deploy".into(),
            "--schema".into(),
            layout.prisma_schema().to_string_lossy().into_owned(),
        ];
        let env = BTreeMap::from([
            ("DATABASE_URL".to_owned(), database_url.to_owned()),
            ("CHECKPOINT_DISABLE".to_owned(), "1".to_owned()),
            ("PRISMA_HIDE_UPDATE_MESSAGE".to_owned(), "1".to_owned()),
        ]);
        self.run_node(&layout.db_package(), &args, &env, "数据迁移").await
    }

    async fn seed_owner(&self, database_url: &str, internal: &InternalSecrets) -> Result<()> {
        let layout = &self.cfg.layout;
        let script = layout.seed_owner_script();
        let gateway_dir = script.parent().and_then(Path::parent).map(Path::to_path_buf).unwrap_or_else(|| layout.server_root.clone());
        let args = vec!["--import".into(), "tsx".into(), script.to_string_lossy().into_owned(), "--force".into()];
        let env = BTreeMap::from([
            ("DATABASE_URL".to_owned(), database_url.to_owned()),
            ("CABINHUG_DEV_PASSWORD".to_owned(), internal.owner_password.clone()),
        ]);
        self.run_node(&gateway_dir, &args, &env, "设置本机账号").await
    }

    /// 每个服务进程拿到同一份环境：单机配置 + 能力开关 + 凭据 + 内部密钥 + 三个服务的地址。
    fn service_env(&self, database_url: &str, internal: &InternalSecrets, ports: &BTreeMap<String, u16>) -> Result<BTreeMap<String, String>> {
        let mut env = base_env(self.cfg.layout.node_dir(), &self.cfg.data_dir.join("tmp"));
        #[cfg(unix)]
        env.insert("HOME".into(), self.cfg.data_dir.join("home").to_string_lossy().into_owned());
        env.insert("LANG".into(), "en_US.UTF-8".into());
        // 开发布局下服务代码就在仓库里，不跳过的话 runtime 与网关会去读开发者的 .env（ACR-062）。
        env.insert("CABINHUG_SKIP_ROOT_ENV".into(), "1".into());
        env.extend(self.cfg.profile.env.clone());
        env.insert("CABINHUG_CAPABILITIES_OFF".into(), self.cfg.profile.capabilities_off_value());
        env.extend(self.secrets.load()?.credentials);
        env.extend(internal.service_env());
        env.insert("DATABASE_URL".into(), database_url.to_owned());
        // ⑤环境缓存与高德额度台账（ACR-064）：单机版没有 Redis，三个服务共用数据目录下的一个 SQLite 文件。
        // 删掉它只是一次冷缓存，不是数据丢失。
        env.insert(
            "CABINHUG_CACHE_SQLITE".into(),
            self.cfg.data_dir.join("cache").join("env-cache.sqlite").to_string_lossy().into_owned(),
        );
        for spec in &self.cfg.profile.services {
            let port = ports[&spec.name];
            env.insert(spec.port_env.clone(), port.to_string());
            env.insert(spec.bind_env.clone(), "127.0.0.1".into());
            env.insert(spec.url_env.clone(), format!("http://127.0.0.1:{port}"));
        }
        Ok(env)
    }

    async fn self_check(&self, access: &GatewayAccess) -> Result<()> {
        let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(10)).build()?;
        let login: serde_json::Value = client
            .post(format!("{}/v1/auth/login", access.base_url))
            .json(&serde_json::json!({ "username": access.username, "password": access.password }))
            .send()
            .await?
            .error_for_status()
            .map_err(|e| HostError::Message(format!("本机账号登录失败：{e}")))?
            .json()
            .await?;
        let Some(token) = login.get("accessToken").and_then(|v| v.as_str()) else {
            return fail("本机账号登录没有返回令牌");
        };
        let caps: serde_json::Value = client
            .get(format!("{}/v1/capabilities", access.base_url))
            .bearer_auth(token)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let served: BTreeSet<String> = caps
            .get("off")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect())
            .unwrap_or_default();
        let expected: BTreeSet<String> = self.cfg.profile.capabilities_off.iter().cloned().collect();
        if served != expected {
            return fail(format!("能力开关与单机配置不一致：网关下发 {served:?}，应为 {expected:?}；不放出界面"));
        }
        Ok(())
    }

    async fn stop_processes(&mut self) {
        while let Some(mut svc) = self.services.pop() {
            svc.stop(Duration::from_secs(8)).await;
        }
        if let Some(pg) = self.pg.take() {
            let _ = pg.stop().await;
        }
        self.access = None;
    }

    /// 倒序停：worker → gateway → runtime → 数据库。
    pub async fn stop(&mut self) {
        self.set_phase(Phase::Stopping, None);
        self.stop_processes().await;
        self.set_phase(Phase::Stopped, None);
    }
}
