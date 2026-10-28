//! 单机版宿主（ARCH-002，ACR-061）。
//!
//! 在车主自己的电脑上托管本机数据库与服务端进程（agent-runtime / gateway / worker），
//! 保管三组凭据与内部密钥，按单机配置生成服务的环境，就绪后核对能力开关。
//! 桌面应用（`standalone/app`）经它拿到本机网关地址与登录口令；Rust 侧之外不出现任何密钥。

pub mod error;
pub mod host;
pub mod layout;
pub mod postgres;
pub mod profile;
pub mod secrets;
pub mod services;
pub mod validate;

pub use error::{HostError, Result};
pub use host::{GatewayAccess, Host, HostConfig, HostStatus, Phase};
pub use layout::Layout;
pub use profile::Profile;
pub use secrets::{FileBackend, KeychainBackend, Secrets};
