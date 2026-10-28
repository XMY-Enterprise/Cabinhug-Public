//! 本机数据库的初始化与起停（随包的 PG 闭包，ACR-060）。
//!
//! - 只监听 127.0.0.1、口令鉴权（scram-sha-256），本地套接字关掉：同机其它用户也连不进来。
//! - 端口每次启动随机分配，写进 `postgresql.auto.conf`（PG 自己的配置覆盖文件），不改 `postgresql.conf`。
//! - 上一次宿主没正常退出时数据库可能还开着（pg_ctl 起的 postmaster 不随宿主退出）：先停掉再按新端口起。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use tokio::process::Command;

use crate::error::{fail, Result};
use crate::layout::Layout;

pub const DB_USER: &str = "cabinhug";
pub const DB_NAME: &str = "cabinhug";

pub struct Postgres {
    bin: PathBuf,
    data: PathBuf,
    log: PathBuf,
    work: PathBuf,
    pub port: u16,
}

impl Postgres {
    pub fn new(layout: &Layout, data_root: &Path, logs: &Path, port: u16) -> Self {
        Self {
            bin: layout.pg_root.join("bin"),
            data: data_root.join("db"),
            log: logs.join("postgres.log"),
            work: data_root.join("tmp"),
            port,
        }
    }

    pub fn exists(data_root: &Path) -> bool {
        data_root.join("db").join("PG_VERSION").is_file()
    }

    fn tool(&self, name: &str) -> PathBuf {
        self.bin.join(if cfg!(windows) { format!("{name}.exe") } else { name.to_owned() })
    }

    /// PG 工具的环境：从零拼，不继承使用者的 PG* 变量（它们会把 psql 指到别的库上）。
    fn env(&self, extra: &BTreeMap<&str, String>) -> BTreeMap<String, String> {
        let mut env = base_env(&self.bin, &self.work);
        for (k, v) in extra {
            env.insert((*k).to_owned(), v.clone());
        }
        env
    }

    async fn run(&self, tool: &str, args: &[&str], extra: &BTreeMap<&str, String>, what: &str) -> Result<String> {
        let out = Command::new(self.tool(tool))
            .args(args)
            .env_clear()
            .envs(self.env(extra))
            .output()
            .await?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return fail(format!("{what}失败：{}", stderr.trim()));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// 第一次启动时建库目录。返回是否新建。
    pub async fn ensure_initialized(&self, password: &str) -> Result<bool> {
        if self.data.join("PG_VERSION").is_file() {
            return Ok(false);
        }
        std::fs::create_dir_all(&self.work)?;
        let pwfile = self.work.join("initdb-password");
        std::fs::write(&pwfile, password)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&pwfile, std::fs::Permissions::from_mode(0o600))?;
        }
        let data = self.data.to_string_lossy().into_owned();
        let pw = pwfile.to_string_lossy().into_owned();
        let result = self
            .run(
                "initdb",
                &["-D", &data, "-U", DB_USER, "--pwfile", &pw, "--auth-host=scram-sha-256", "--auth-local=reject", "--encoding=UTF8", "--locale=C"],
                &BTreeMap::new(),
                "初始化本机数据库",
            )
            .await;
        let _ = std::fs::remove_file(&pwfile);
        result.map(|_| true)
    }

    async fn running(&self) -> bool {
        let data = self.data.to_string_lossy().into_owned();
        Command::new(self.tool("pg_ctl"))
            .args(["-D", &data, "status"])
            .env_clear()
            .envs(self.env(&BTreeMap::new()))
            .output()
            .await
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    pub async fn start(&self) -> Result<()> {
        if self.running().await {
            self.stop().await?;
        }
        let socket_line = if cfg!(unix) { "unix_socket_directories = ''\n" } else { "" };
        std::fs::write(
            self.data.join("postgresql.auto.conf"),
            format!("listen_addresses = '127.0.0.1'\nport = {}\n{socket_line}max_connections = 60\nshared_buffers = '64MB'\n", self.port),
        )?;
        if let Some(dir) = self.log.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let data = self.data.to_string_lossy().into_owned();
        let log = self.log.to_string_lossy().into_owned();
        self.run("pg_ctl", &["-D", &data, "-l", &log, "-w", "-t", "60", "start"], &BTreeMap::new(), "启动本机数据库")
            .await
            .map(|_| ())
    }

    pub async fn stop(&self) -> Result<()> {
        let data = self.data.to_string_lossy().into_owned();
        self.run("pg_ctl", &["-D", &data, "-m", "fast", "-w", "-t", "30", "stop"], &BTreeMap::new(), "停止本机数据库")
            .await
            .map(|_| ())
    }

    fn psql_env(&self, password: &str, database: &str) -> BTreeMap<&'static str, String> {
        BTreeMap::from([
            ("PGHOST", "127.0.0.1".to_owned()),
            ("PGPORT", self.port.to_string()),
            ("PGUSER", DB_USER.to_owned()),
            ("PGPASSWORD", password.to_owned()),
            ("PGDATABASE", database.to_owned()),
        ])
    }

    pub async fn ensure_database(&self, password: &str) -> Result<()> {
        let env = self.psql_env(password, "postgres");
        let exists = self
            .run("psql", &["-X", "-t", "-A", "-c", &format!("SELECT 1 FROM pg_database WHERE datname = '{DB_NAME}'")], &env, "查询本机数据库")
            .await?;
        if exists.trim() != "1" {
            self.run("psql", &["-X", "-v", "ON_ERROR_STOP=1", "-c", &format!("CREATE DATABASE {DB_NAME}")], &env, "建库")
                .await?;
        }
        Ok(())
    }

    pub fn url(&self, password: &str) -> String {
        format!("postgresql://{DB_USER}:{password}@127.0.0.1:{}/{DB_NAME}", self.port)
    }
}

/// 子进程的最小环境：只放给定目录与系统目录进 PATH，HOME / 临时目录落在数据目录里。
pub fn base_env(first_path: &Path, work: &Path) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    let tmp = work.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        let root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        env.insert("PATH".into(), format!("{};{root}\\System32;{root}", first_path.display()));
        env.insert("SystemRoot".into(), root.clone());
        env.insert("WINDIR".into(), root);
        env.insert("TEMP".into(), tmp.clone());
        env.insert("TMP".into(), tmp.clone());
        env.insert("USERPROFILE".into(), tmp.clone());
        env.insert("LOCALAPPDATA".into(), tmp.clone());
        env.insert("APPDATA".into(), tmp);
    }
    #[cfg(unix)]
    {
        env.insert("PATH".into(), format!("{}:/usr/bin:/bin:/usr/sbin:/sbin", first_path.display()));
        env.insert("HOME".into(), tmp.clone());
        env.insert("TMPDIR".into(), tmp);
    }
    env.insert("LANG".into(), "C".into());
    env
}
