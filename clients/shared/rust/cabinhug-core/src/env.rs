//! 端上环境变量的读取与改名前旧名的回退（ACR-051）：`CARLIFE_*` → `CABINHUG_*`。
//!
//! 代码只点名新名。新名缺失时回退到**同一个变量**的旧名并打一次弃用提示——
//! 只回退调用方点名的这一项，不扫整个环境，所以拼错的旧变量不会被静默接住。
//! 服务端的等价实现是 `enterprise/backend/shared/db/src/config/legacy-env.ts`，
//! 那边在进程入口按显式名单一次性搬运；端上读取点少，按点回退更直接。

use std::collections::HashSet;
use std::env::VarError;
use std::sync::{Mutex, OnceLock};

const CURRENT_PREFIX: &str = "CABINHUG_";
const LEGACY_PREFIX: &str = "CARLIFE_";

/// 新名对应的旧名；不是新前缀的名字没有旧名。
pub fn legacy_name(current: &str) -> Option<String> {
    current
        .strip_prefix(CURRENT_PREFIX)
        .map(|rest| format!("{LEGACY_PREFIX}{rest}"))
}

/// 旧名对应的新名；不是旧前缀的名字返回 `None`。
pub fn current_name(legacy: &str) -> Option<String> {
    legacy
        .strip_prefix(LEGACY_PREFIX)
        .map(|rest| format!("{CURRENT_PREFIX}{rest}"))
}

/// 读环境变量：先新名，缺失时回退旧名。语义与 `std::env::var` 相同（包括非 UTF-8 的报错）。
pub fn env_var(current: &str) -> Result<String, VarError> {
    match std::env::var(current) {
        Err(VarError::NotPresent) => {}
        found => return found,
    }
    let Some(legacy) = legacy_name(current) else {
        return Err(VarError::NotPresent);
    };
    let value = std::env::var(&legacy)?;
    warn_once(&legacy, current);
    Ok(value)
}

/// 同一个旧名只提示一次：有的读取点在热路径上（每帧、每次播报）。
fn warn_once(legacy: &str, current: &str) {
    static WARNED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let warned = WARNED.get_or_init(|| Mutex::new(HashSet::new()));
    let first = warned
        .lock()
        .map(|mut seen| seen.insert(legacy.to_string()))
        .unwrap_or(false);
    if first {
        eprintln!("[config] 环境变量 {legacy} 已弃用，本次按 {current} 生效；请改用新名");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 每条用例用自己独有的变量名：cargo test 默认并行，共享名字会互相踩。

    #[test]
    fn 只设旧名时新名读到旧名的值() {
        std::env::set_var("CARLIFE_TEST_ENV_ONLY_LEGACY", "old");
        assert_eq!(env_var("CABINHUG_TEST_ENV_ONLY_LEGACY").as_deref(), Ok("old"));
    }

    #[test]
    fn 新旧都设时以新名为准() {
        std::env::set_var("CARLIFE_TEST_ENV_BOTH", "old");
        std::env::set_var("CABINHUG_TEST_ENV_BOTH", "new");
        assert_eq!(env_var("CABINHUG_TEST_ENV_BOTH").as_deref(), Ok("new"));
    }

    #[test]
    fn 都不设时照常报缺失() {
        assert_eq!(env_var("CABINHUG_TEST_ENV_NEITHER"), Err(VarError::NotPresent));
    }

    #[test]
    fn 非新前缀的名字不回退() {
        std::env::set_var("CARLIFE_TEST_ENV_OTHER", "old");
        assert_eq!(env_var("OTHER_TEST_ENV_OTHER"), Err(VarError::NotPresent));
    }

    #[test]
    fn 新旧名互为映射() {
        assert_eq!(legacy_name("CABINHUG_GATEWAY_URL").as_deref(), Some("CARLIFE_GATEWAY_URL"));
        assert_eq!(current_name("CARLIFE_GATEWAY_URL").as_deref(), Some("CABINHUG_GATEWAY_URL"));
        assert_eq!(legacy_name("DATABASE_URL"), None);
        assert_eq!(current_name("DATABASE_URL"), None);
    }
}
