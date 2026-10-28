//! cabinhug-core — 会话状态、鉴权、本地 SQLite 缓存
//!
//! 模块：
//!  - `contract`：端云契约单一真相源
//!  - `cache`：端上消息缓存（SQLite，非权威源）
//!  - `fanout`：事件 → 桥接动作投影 + 双写
//!  - `location`：端上定位授权与地图视图（车机与手机共用同一份行为）
//!  - `auth`：端上凭证持有（F-07-03；内存态，Keychain 待 ACR）
//!  - `device`：设备注册实例 id（F-56-01；标识符落盘，与凭证不同）
//!  - `env`：环境变量读取与改名前旧名的回退（ACR-051）

pub mod acting;
pub mod auth;
pub mod cache;
pub mod device;
pub mod env;
pub mod contract;
pub mod fanout;
pub mod location;
