//! 开发期环境加载（手机端；与 `clients/cockpit/src-tauri/src/dev_env.rs` 逐字一致，
//! 改一处必须同步改另一处）：把仓库根 `.env` 里**属于客户端的那几项**读进进程环境。
//!
//! 仅服务于 `tauri dev`（免去每次手动 source）。已存在的环境变量优先，
//! 不覆盖外部注入。打包分发时环境由运行环境提供，此逻辑找不到文件即静默跳过。
//!
//! # 为什么是白名单，不是"整份 .env 灌进来"
//!
//! 仓库根的 `.env` 约 87% 是纯服务端配置：`DATABASE_URL`、`CABINHUG_JWT_SECRET`、
//! `CABINHUG_PII_MASTER_KEY`、`DEEPSEEK_API_KEY`、阿里云与火山的 AK/SK、S3 凭证等。
//! 环境变量对整个进程可见，客户端代码不读它们，也会经内存转储、第三方 crate 的
//! debug 打印或崩溃报告泄露。车机与手机是面向车主的消费端，只需要知道网关在哪。
//!
//! 因此只载入这里列出的键，其余一律忽略并计数。新增客户端配置项须在此显式加一行，
//! 使"往客户端塞一个服务端配置"成为一个看得见的改动。

use std::path::PathBuf;

/// 客户端自己的配置项。新增前须说明车主的设备为什么需要它。
const CLIENT_KEYS: &[&str] = &[
    // 网关在哪——客户端唯一必需的配置（`settings.rs`，取值顺序见那里）。
    "CABINHUG_GATEWAY_URL",
    // 端侧播报/语音的本地开关与调参，都是"这台设备怎么表现"，与服务端无关。
    "CABINHUG_TTS_SAY_VOICE",
    "CABINHUG_AEC_ENABLED",
    "CABINHUG_AEC_DELAY_MS",
    "CABINHUG_SENTINEL_DEBUG",
    // 已废弃但仍要读到才能打那句告警（`lib.rs`，ACR-017）。
    // 不载入则告警不会触发。
    "CARLIFE_TTS",
];

/// 载入结果，仅用于启动横幅。
struct Loaded {
    taken: usize,
    ignored: usize,
}

pub fn load_repo_env() {
    // 编译期已知的 crate 目录 → 仓库根（clients/mobile/src-tauri → ../../..）
    let candidates = [
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../.env"),
        PathBuf::from(".env"),
    ];
    for path in candidates {
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let stat = apply(&content);
        /*
         * 打印忽略的项数：这是白名单生效的运行时证据，
         * 也表明客户端进程里没有服务端密钥。
         */
        eprintln!(
            "[dev-env] 载入 {} 项客户端配置，忽略 {} 项（服务端配置不进客户端进程）",
            stat.taken, stat.ignored
        );
        return;
    }
}

/// 纯函数芯：解析 + 按白名单注入，返回计数（可单测，不依赖仓库里那份 .env）。
///
/// 改名前的旧名（ACR-051：`CARLIFE_X` → `CABINHUG_X`）只要新名在白名单里就照收，
/// 载入为新名。旧名放在第二遍处理：同一份 `.env` 新旧都写了时，新名先落位，旧名不覆盖它。
fn apply(content: &str) -> Loaded {
    let mut taken = 0;
    let mut ignored = 0;
    let mut legacy: Vec<(String, &str)> = Vec::new();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim().trim_matches('"');
        if CLIENT_KEYS.contains(&key) {
            set_if_absent(key, value);
            taken += 1;
            continue;
        }
        match cabinhug_core::env::current_name(key) {
            Some(current) if CLIENT_KEYS.contains(&current.as_str()) => {
                eprintln!("[dev-env] .env 里的 {key} 已弃用，载入为 {current}；请改用新名");
                legacy.push((current, value));
            }
            _ => ignored += 1,
        }
    }
    for (current, value) in legacy {
        set_if_absent(&current, value);
        taken += 1;
    }
    Loaded { taken, ignored }
}

/// 已存在的环境变量优先，不覆盖外部注入。
fn set_if_absent(key: &str, value: &str) {
    if std::env::var_os(key).is_none() {
        std::env::set_var(key, value);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 白名单的全部契约：列上的进来，没列的一个都不进来。
    #[test]
    fn 服务端配置不会进客户端进程() {
        let env = "\
# 注释行
DATABASE_URL=\"postgres://u:p@h/db\"
CABINHUG_JWT_SECRET=\"super-secret\"
DEEPSEEK_API_KEY=\"sk-xxx\"
CABINHUG_GATEWAY_URL=\"http://127.0.0.1:8790\"
";
        let stat = apply(env);
        assert_eq!(stat.taken, 1, "只有 CABINHUG_GATEWAY_URL 该被载入");
        assert_eq!(stat.ignored, 3, "另外三项是服务端的，必须被忽略");
        // 关键断言：进程环境里不该出现它们（本测试进程即客户端进程的替身）。
        for key in ["DATABASE_URL", "CABINHUG_JWT_SECRET", "DEEPSEEK_API_KEY"] {
            assert!(
                std::env::var_os(key).is_none(),
                "{key} 不该出现在客户端进程环境里"
            );
        }
    }

    /// 改名前的旧名照收、载入为新名；同一份文件新旧都写时新名为准（ACR-051）。
    /// 用 AEC_DELAY_MS 而不是 GATEWAY_URL：上面那条用例会写 GATEWAY_URL，并行时互相踩。
    #[test]
    fn 旧名载入为新名且不压过新名() {
        let env = "\
CARLIFE_AEC_DELAY_MS=\"40\"
CABINHUG_AEC_DELAY_MS=\"60\"
CARLIFE_JWT_SECRET=\"super-secret\"
";
        let stat = apply(env);
        assert_eq!(stat.taken, 2, "新名一项、旧名一项都算载入");
        assert_eq!(stat.ignored, 1, "旧名的服务端配置同样被忽略");
        assert_eq!(std::env::var("CABINHUG_AEC_DELAY_MS").as_deref(), Ok("60"));
        assert!(std::env::var_os("CARLIFE_AEC_DELAY_MS").is_none(), "旧名本身不进进程环境");
        assert!(std::env::var_os("CABINHUG_JWT_SECRET").is_none());
        assert!(std::env::var_os("CARLIFE_JWT_SECRET").is_none());
    }

    /// 白名单里不许出现 vendor 密钥。
    #[test]
    fn 白名单里没有任何供应商密钥() {
        for key in CLIENT_KEYS {
            let k = key.to_ascii_uppercase();
            assert!(
                !k.contains("KEY") && !k.contains("SECRET") && !k.contains("TOKEN"),
                "{key} 看起来是凭证——客户端不持有任何 vendor 凭证"
            );
        }
    }
}
