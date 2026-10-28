//! 运行布局：node、服务端代码、PG 闭包各在哪。
//!
//! 开发布局 = 仓库检出 + 本机 node 24 + `target/standalone-postgres/<平台>`（ACR-060 构建产物）。
//! 安装包布局（随包的 node 与服务端运行闭包）在打包那一步（ARCH-002 路线第 6 步）补上，
//! 宿主的其余部分只认这个结构，不关心东西从哪来。

use std::path::{Path, PathBuf};

use crate::error::{fail, Result};

#[derive(Debug, Clone)]
pub struct Layout {
    /// 运行服务用的 node（不经 PATH 解析第二次：子进程一律用这个绝对路径）。
    pub node: PathBuf,
    /// 服务端代码的根：开发布局下是仓库根。
    pub server_root: PathBuf,
    /// PG 闭包根（含 `bin/ lib/ share/`）。
    pub pg_root: PathBuf,
    /// 宿主自带的小文件（如 `exit-with-parent.mjs`）。
    pub assets: PathBuf,
}

/// PG 闭包目录名，与 `build-standalone-postgres.mjs` 的输出约定一致。
pub fn platform_dir() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "darwin-arm64"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "win32-x64"
    } else {
        "unsupported"
    }
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(name)).find(|p| p.is_file())
}

impl Layout {
    /// 开发布局。`CABINHUG_NODE_BIN` 可指定 node；不设则从 PATH 找一次。
    pub fn dev(repo: impl Into<PathBuf>) -> Result<Self> {
        let repo: PathBuf = repo.into();
        let node = match std::env::var_os("CABINHUG_NODE_BIN") {
            Some(p) => PathBuf::from(p),
            None => match find_on_path(&exe("node")) {
                Some(p) => p,
                None => return fail("找不到 node：装好 Node 24 或设 CABINHUG_NODE_BIN"),
            },
        };
        let pg_root = repo.join("target/standalone-postgres").join(platform_dir());
        let layout = Layout { node, assets: repo.join("standalone/host/assets"), server_root: repo, pg_root };
        if !layout.pg_bin("pg_ctl").is_file() {
            return fail(format!(
                "没有本机数据库闭包：{}。先运行 corepack pnpm release:standalone-postgres target/standalone-postgres/{}",
                layout.pg_root.display(),
                platform_dir()
            ));
        }
        Ok(layout)
    }

    pub fn package_dir(&self, package: &str) -> PathBuf {
        self.server_root.join(package)
    }

    pub fn pg_bin(&self, tool: &str) -> PathBuf {
        self.pg_root.join("bin").join(exe(tool))
    }

    pub fn db_package(&self) -> PathBuf {
        self.server_root.join("enterprise/backend/shared/db")
    }

    pub fn prisma_cli(&self) -> PathBuf {
        self.db_package().join("node_modules/prisma/build/index.js")
    }

    pub fn prisma_schema(&self) -> PathBuf {
        self.db_package().join("prisma/schema.prisma")
    }

    /// 给本机账号设口令（ARCH-002 路线第 5 步换成正式的本机身份前，沿用开发播种脚本）。
    pub fn seed_owner_script(&self) -> PathBuf {
        self.server_root.join("enterprise/backend/gateway/scripts/seed-dev-credentials.ts")
    }

    pub fn exit_with_parent(&self) -> PathBuf {
        self.assets.join("exit-with-parent.mjs")
    }

    /// node 所在目录：服务进程的 PATH 只放它与系统目录，不继承使用者的 PATH。
    pub fn node_dir(&self) -> &Path {
        self.node.parent().unwrap_or_else(|| Path::new("."))
    }
}
