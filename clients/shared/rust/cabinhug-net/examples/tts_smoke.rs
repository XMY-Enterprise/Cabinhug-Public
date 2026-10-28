//! TTS 合成冒烟：走完整的端上路径合成一句中文并播放（macOS afplay）。
//!
//! 取端点的方式与 cockpit 一致：问网关 `GET /v1/tts/config`，拿它给的 URL
//! 打过去。端上没有第二条路（ACR-018）：没有本地默认端点、没有 vendor 密钥、
//! 没有"网关问不到就用环境变量"的兜底。本工具验证端上能否只靠一个网关地址
//! 和一枚设备 JWT 出声。
//!
//! 前置：
//!   - 网关在跑（`CABINHUG_GATEWAY_URL`，默认 `http://localhost:8790`）
//!   - `CABINHUG_SMOKE_TOKEN` = 一枚有效的 access token（登录或设备配对拿到），
//!     没有默认值
//!   - vendor 密钥不需要配在本机：它在服务端
//!
//! 运行：`cargo run -p cabinhug-net --example tts_smoke -- "要合成的文本"`

use cabinhug_net::{GatewayClient, TtsClient};

#[tokio::main]
async fn main() {
    let text = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "好的，明天从深圳到黄山的长途我记下了。".to_string());

    let base_url =
        cabinhug_core::env::env_var("CABINHUG_GATEWAY_URL").unwrap_or_else(|_| "http://localhost:8790".into());
    let Ok(token) = cabinhug_core::env::env_var("CABINHUG_SMOKE_TOKEN").map(|t| t.trim().to_string()) else {
        eprintln!(
            "缺 CABINHUG_SMOKE_TOKEN：ACR-018 之后端上只有设备 JWT 一种凭证，\n\
             没有它连不上网关，也就没有任何合成路径可走。\n\
             先登录换一枚 access token 再来。"
        );
        std::process::exit(1);
    };
    if token.is_empty() {
        eprintln!("CABINHUG_SMOKE_TOKEN 是空的——空 token 会被网关 401，与没配没有区别");
        std::process::exit(1);
    }

    let cfg = match GatewayClient::new(base_url.clone(), token.clone()).fetch_tts_config().await {
        Ok(cfg) => cfg,
        Err(e) => {
            // 端上此刻的行为就是这个：问不到端点就不合成、降级系统 say。
            eprintln!("网关取不到合成端点（{e}）——端上此时会降级系统 say，不存在别的路");
            std::process::exit(1);
        }
    };
    println!(
        "端点来自网关：{}（{}）{}",
        cfg.engine,
        cfg.url,
        if cfg.billed { " ⚠️ 按合成字数计费" } else { "" }
    );
    // 下发的地址必须是网关自己（ACR-018）：若是供应商域名，端上就需要 vendor 密钥。
    if !cfg.url.starts_with(&base_url) {
        eprintln!(
            "⚠️ 下发的合成端点不在网关下（{}）——ACR-018 要求端上只认识网关",
            cfg.url
        );
    }

    let client = TtsClient::for_runtime(&cfg, token);
    let started = std::time::Instant::now();
    match client.synthesize(&text).await {
        Ok(audio) => {
            let elapsed = started.elapsed();
            let path = std::env::temp_dir().join("cabinhug-tts-smoke.wav");
            std::fs::write(&path, &audio).expect("写文件");
            println!(
                "✓ 合成成功：{} 字 → {} 字节 WAV，耗时 {:.2}s",
                text.chars().count(),
                audio.len(),
                elapsed.as_secs_f32()
            );
            println!("  文件：{}", path.display());
            let played = std::process::Command::new("afplay").arg(&path).status();
            match played {
                Ok(s) if s.success() => println!("✓ 播放完成"),
                _ => println!("（播放跳过：无 afplay 或无音频设备）"),
            }
        }
        Err(e) => {
            eprintln!("✗ 合成失败：{e}");
            std::process::exit(1);
        }
    }
}
