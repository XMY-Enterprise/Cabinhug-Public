//! 服务进程（agent-runtime / gateway / worker）的起停与探活。
//!
//! # 进程树跟着宿主走
//!
//! - 正常退出：每个服务自成一个进程组（Unix）或进程树（Windows），停的时候整组发信号，
//!   runtime 拉起的 pi-acp 与 pi 一起走，不留孤儿。
//! - 宿主被强杀：子进程收不到任何通知。每个 node 先加载 `exit-with-parent.mjs`，
//!   发现父进程没了就自己退出（ARCH-002「宿主一退出子进程全部跟着退」）。
//!
//! # 端口
//!
//! 先在 127.0.0.1 上要一个空闲端口再交给服务。拿到与服务真正 listen 之间有极短的窗口，
//! 被抢时服务起不来、探活超时，宿主报失败而不是连到别人身上。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::process::{Child, Command};

use crate::error::{fail, Result};
use crate::layout::Layout;
use crate::profile::ServiceSpec;

pub fn free_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

pub struct RunningService {
    pub name: String,
    pub port: u16,
    child: Child,
    pub log: PathBuf,
}

/// 文件 URL：放进 `--import`，路径带空格或中文时裸路径会被切开。
fn file_url(path: &Path) -> String {
    let s = path.to_string_lossy().replace('\\', "/");
    let encoded: String = s
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'_' | b'.' | b'~' | b':' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect();
    if encoded.starts_with('/') {
        format!("file://{encoded}")
    } else {
        format!("file:///{encoded}")
    }
}

pub async fn spawn(layout: &Layout, spec: &ServiceSpec, port: u16, env: &BTreeMap<String, String>, logs: &Path) -> Result<RunningService> {
    std::fs::create_dir_all(logs)?;
    let log = logs.join(format!("{}.log", spec.name));
    let out = std::fs::OpenOptions::new().create(true).append(true).open(&log)?;
    let err = out.try_clone()?;
    let mut cmd = Command::new(&layout.node);
    cmd.arg(format!("--import={}", file_url(&layout.exit_with_parent())))
        .args(["--import", "tsx", "src/index.ts"])
        .current_dir(layout.package_dir(&spec.package))
        .env_clear()
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err))
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    {
        // CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW：不弹控制台窗口，停的时候按进程树杀。
        cmd.creation_flags(0x0000_0200 | 0x0800_0000);
    }
    let child = cmd.spawn().map_err(|e| crate::error::HostError::Message(format!("{} 起不来：{e}", spec.name)))?;
    Ok(RunningService { name: spec.name.clone(), port, child, log })
}

impl RunningService {
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// 等到探活返回 200。进程中途退出就立刻报错，不等到超时。
    pub async fn wait_healthy(&mut self, path: &str, timeout: Duration) -> Result<()> {
        let client = reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(3)).build()?;
        let url = format!("{}{path}", self.url());
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.try_wait()? {
                return fail(format!("{} 启动后退出了（{status}），日志：{}", self.name, self.log.display()));
            }
            if let Ok(r) = client.get(&url).send().await {
                if r.status().is_success() {
                    return Ok(());
                }
            }
            if Instant::now() >= deadline {
                return fail(format!("{} 在 {} 秒内没有就绪，日志：{}", self.name, timeout.as_secs(), self.log.display()));
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    /// 先礼后兵：整组 SIGTERM，等 `grace`，还在就 SIGKILL（Windows 直接杀进程树）。
    pub async fn stop(&mut self, grace: Duration) {
        let Some(pid) = self.child.id() else { return };
        #[cfg(unix)]
        {
            // 进程组号就是 pid（spawn 时 process_group(0)）。
            unsafe { libc::kill(-(pid as i32), libc::SIGTERM) };
            if tokio::time::timeout(grace, self.child.wait()).await.is_err() {
                unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
                let _ = self.child.wait().await;
            }
        }
        #[cfg(windows)]
        {
            let _ = grace;
            let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output().await;
            let _ = self.child.wait().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_url_escapes_spaces_and_cjk() {
        let u = file_url(Path::new("/Users/a b/应用/exit.mjs"));
        assert!(u.starts_with("file:///Users/a%20b/"));
        assert!(!u.contains(' '));
        assert!(u.ends_with("/exit.mjs"));
    }

    #[test]
    fn free_port_is_nonzero() {
        assert_ne!(free_port().unwrap(), 0);
    }
}
