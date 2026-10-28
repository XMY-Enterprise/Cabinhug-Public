//! 本次绑定期间的「谁在用车」，跨重启持久化。
//!
//! # 用途
//!
//! 车机拿的是车辆级 token，它不代表任何人（设计裁决 R4），所以
//! `POST /v1/session` 要求显式声明 activeUserId，缺失返回 400。
//! 上车声明屏（`BoardingGate`）收集这个声明，这里记住答案，供「新建对话」、
//! 唤醒词等所有建会话的路径复用。
//!
//! # 持久化
//!
//! 声明过身份后重启直接沿用，家庭场景不需要每次开机重选。声明落盘在 app
//! 数据目录；换人走设置页的「更换使用人」这一显式动作，不靠重启擦除。
//! 切换设备角色时清空声明。
//!
//! # 两层 Option
//!
//! 外层 = "声明过没有"，内层 = "声明的是谁（`None` 就是访客）"。
//! 访客模式能建会话，"还没声明"必须回到声明屏，二者需要区分。

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

struct Inner {
    path: Option<PathBuf>,
    declared: Option<Option<String>>,
}

static STATE: OnceLock<Mutex<Inner>> = OnceLock::new();

fn cell() -> &'static Mutex<Inner> {
    STATE.get_or_init(|| Mutex::new(Inner { path: None, declared: None }))
}

/// 启动时绑定持久化路径并载入上次的声明（`lib.rs` 的 setup 里调）。
/// 文件损坏按"没声明过"处理——回到声明屏还能救，启动崩溃救不了。
pub fn init(path: PathBuf) {
    let declared = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| {
            let obj = v.as_object()?;
            if !obj.get("declared")?.as_bool()? {
                return None;
            }
            Some(match obj.get("activeUserId") {
                Some(serde_json::Value::String(id)) => Some(id.clone()),
                _ => None, // 访客
            })
        });
    let mut guard = cell().lock().expect("boarding poisoned");
    guard.path = Some(path);
    guard.declared = declared;
}

fn persist(guard: &Inner) {
    let Some(path) = &guard.path else { return };
    match &guard.declared {
        Some(who) => {
            let json = serde_json::json!({ "declared": true, "activeUserId": who });
            if let Err(e) = std::fs::write(path, json.to_string()) {
                eprintln!("[boarding] 声明落盘失败（{e}）——重启后要重新选择使用人");
            }
        }
        None => {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// 记住这次上车声明的人（`None` = 访客模式，是个显式选择）。
pub fn set(active_user_id: Option<String>) {
    let mut guard = cell().lock().expect("boarding poisoned");
    guard.declared = Some(active_user_id);
    persist(&guard);
}

/// 已声明的人。外层 `None` = **还没声明**，该回上车声明屏。
pub fn declared() -> Option<Option<String>> {
    cell().lock().expect("boarding poisoned").declared.clone()
}

/// 清空（切角色、设置页「更换使用人」）。
pub fn clear() {
    let mut guard = cell().lock().expect("boarding poisoned");
    guard.declared = None;
    persist(&guard);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 三态互相区分得开，且声明穿越"重启"（重新 init 同一路径）仍在。
    #[test]
    fn 声明持久化且访客与没声明不是同一件事() {
        let path = std::env::temp_dir().join(format!("cabinhug-boarding-test-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        init(path.clone());
        assert_eq!(declared(), None, "初始就是「还没声明」");
        set(None);
        assert_eq!(declared(), Some(None), "访客是**声明过**的，能建会话");
        set(Some("u-1".into()));
        assert_eq!(declared(), Some(Some("u-1".into())));

        // "重启"：清内存重载同一文件，声明必须还在。
        cell().lock().unwrap().declared = None;
        init(path.clone());
        assert_eq!(declared(), Some(Some("u-1".into())), "重启后声明丢了");

        clear();
        assert_eq!(declared(), None, "更换使用人后必须回到「还没声明」");
        // 清空也要持久化，重启后不能恢复旧声明。
        cell().lock().unwrap().declared = Some(Some("鬼".into()));
        init(path.clone());
        assert_eq!(declared(), None, "clear 没落盘，重启后旧声明诈尸");
        let _ = std::fs::remove_file(&path);
    }
}
