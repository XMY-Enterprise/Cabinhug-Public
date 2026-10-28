//! 无头调试入口：不开窗口，把宿主跑起来看每一步。安装包里不带它。
//!
//!   cargo run -p cabinhug-standalone-host -- run [--data-dir 目录] [--secrets-file 文件]
//!   cargo run -p cabinhug-standalone-host -- import-credentials-from-env [--secrets-file 文件]
//!
//! `--secrets-file` 只给开发用：凭据写进 0600 文件而不是钥匙串，免得调试往开发机的钥匙串里留东西。
//! `import-credentials-from-env` 从当前环境变量读三组凭据（例如先 `set -a; . .env`），不打印任何值。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use cabinhug_standalone_host::{FileBackend, Host, HostConfig, KeychainBackend, Layout, Phase, Profile, Secrets};

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn secrets(args: &[String]) -> cabinhug_standalone_host::Result<Secrets> {
    Ok(match arg(args, "--secrets-file") {
        Some(p) => Secrets::new(Box::new(FileBackend::new(p))),
        None => Secrets::new(Box::new(KeychainBackend::new("com.cabinhug.standalone.dev")?)),
    })
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let code = match args.get(1).map(String::as_str) {
        Some("run") => run(&args).await,
        Some("import-credentials-from-env") => import(&args),
        _ => {
            eprintln!("用法：cabinhug-standalone-host run | import-credentials-from-env [--data-dir 目录] [--secrets-file 文件]");
            2
        }
    };
    std::process::exit(code);
}

fn import(args: &[String]) -> i32 {
    let result = (|| {
        let profile = Profile::embedded()?;
        let secrets = secrets(args)?;
        for g in &profile.credentials {
            let values: BTreeMap<String, String> =
                g.fields.iter().filter_map(|f| std::env::var(&f.env).ok().map(|v| (f.env.clone(), v))).collect();
            match secrets.set_group(&profile, &g.group, &values) {
                Ok(()) => println!("✓ {} 已保存", g.label),
                Err(e) => println!("✗ {}：{e}", g.label),
            }
        }
        Ok::<_, cabinhug_standalone_host::HostError>(())
    })();
    match result {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

async fn run(args: &[String]) -> i32 {
    let data_dir = arg(args, "--data-dir").map(PathBuf::from).unwrap_or_else(|| repo_root().join("target/standalone-dev/data"));
    let built = (|| {
        let cfg = HostConfig { profile: Profile::embedded()?, layout: Layout::dev(repo_root())?, data_dir };
        Host::new(cfg, secrets(args)?)
    })();
    let mut host = match built {
        Ok(h) => h,
        Err(e) => {
            eprintln!("✗ {e}");
            return 1;
        }
    };
    let handle = host.status_handle();
    let printer = tokio::spawn(async move {
        let mut last = String::new();
        loop {
            let s = handle.lock().unwrap().clone();
            let line = s.steps.iter().map(|st| format!("{}:{:?}", st.id, st.state)).collect::<Vec<_>>().join(" ");
            if line != last {
                println!("[host] {:?} {line}", s.phase);
                last = line;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    });
    let result = host.start().await;
    printer.abort();
    let status = host.status();
    for st in &status.steps {
        println!("  {:<14} {:?}{}", st.label, st.state, st.detail.as_deref().map(|d| format!(" — {d}")).unwrap_or_default());
    }
    if let Err(e) = result {
        eprintln!("✗ 启动失败：{e}");
        return 1;
    }
    if status.phase == Phase::NeedsCredentials {
        eprintln!("✗ 凭据没填全：{:?}（先跑 import-credentials-from-env）", status.missing_credentials);
        host.stop().await;
        return 1;
    }
    if let Some(access) = host.access() {
        println!("✓ 就绪：本机网关 {}（日志 {}）。Ctrl-C 退出", access.base_url, status.log_dir);
    }
    let _ = tokio::signal::ctrl_c().await;
    println!("[host] 正在停止…");
    host.stop().await;
    println!("[host] 已停止");
    0
}
