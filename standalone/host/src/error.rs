//! 宿主的错误类型。面向车主的话写在 `Message` 里（界面原样显示），其余是底层错误的透传。

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("{0}")]
    Message(String),
    #[error("读写文件失败：{0}")]
    Io(#[from] std::io::Error),
    #[error("配置格式不对：{0}")]
    Json(#[from] serde_json::Error),
    #[error("网络请求失败：{0}")]
    Http(#[from] reqwest::Error),
}

pub type Result<T> = std::result::Result<T, HostError>;

pub(crate) fn fail<T>(message: impl Into<String>) -> Result<T> {
    Err(HostError::Message(message.into()))
}
