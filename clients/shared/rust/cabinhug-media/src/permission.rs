//! 系统麦克风权限。
//!
//! # 不能等 cpal 报错
//!
//! macOS 上 CoreAudio 对未授权的进程**照常枚举设备、照常回调**，只是回调里
//! 全是零样本——cpal 一路不报错，`PttHandle::start` 照样成功，空音频被一路
//! 送进 ASR，转出空文本，端上于是毫无反应。所以权限必须在采集之前显式问系统
//! （AVCaptureDevice），而不是指望采集失败。
//!
//! # 拒绝后的「拉起授权」是打开系统设置
//!
//! macOS 的授权框一个进程只弹一次：`denied` 之后系统不再弹，能做的只有把
//! 车主带到系统设置的麦克风页。所以 `Undetermined` 走 [`request_blocking`]，
//! `Denied` 走 [`open_settings`]，两条路都算"拉起授权"，都要处理。

/// 系统麦克风授权现状。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicPermission {
    Granted,
    /// 问过、被拒了（含 MDM 限制的 restricted）——系统不会再弹框。
    Denied,
    /// 还没问过：下一次 `request_blocking` 会弹系统授权框。
    Undetermined,
}

impl MicPermission {
    /// 跨到前端的稳定短标识（进 Tauri command 的返回值，别改措辞）。
    pub fn as_str(self) -> &'static str {
        match self {
            MicPermission::Granted => "granted",
            MicPermission::Denied => "denied",
            MicPermission::Undetermined => "undetermined",
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::MicPermission;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, Bool};
    use objc2_foundation::NSString;

    /// `AVMediaTypeAudio` 常量的**值**就是 `"soun"`（FourCC，Apple 文档公开）。
    /// 用字面量而不是链接框架的数据符号：方法比对的是字符串值，不是指针。
    fn media_type() -> objc2::rc::Retained<NSString> {
        NSString::from_str("soun")
    }

    fn capture_device() -> Option<&'static AnyClass> {
        // 类查不到 = AVFoundation 没链接进来（build.rs 负责链接）。
        // 那时**宁可放行**：权限门失效退回 cpal 的旧行为，不该把语音整个锁死。
        AnyClass::get(c"AVCaptureDevice")
    }

    pub fn status() -> MicPermission {
        let Some(cls) = capture_device() else {
            return MicPermission::Granted;
        };
        // AVAuthorizationStatus: 0 NotDetermined / 1 Restricted / 2 Denied / 3 Authorized
        let code: isize = unsafe { msg_send![cls, authorizationStatusForMediaType: &*media_type()] };
        match code {
            3 => MicPermission::Granted,
            0 => MicPermission::Undetermined,
            _ => MicPermission::Denied,
        }
    }

    /// 弹系统授权框并等车主作答。**会阻塞**（车主可能盯着弹窗想半天），
    /// 调用方放 blocking 池；只在 `Undetermined` 时有意义，其余状态立即返回现状。
    pub fn request_blocking() -> bool {
        let Some(cls) = capture_device() else {
            return true;
        };
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let handler = block2::RcBlock::new(move |granted: Bool| {
            let _ = tx.send(granted.as_bool());
        });
        unsafe {
            let _: () = msg_send![
                cls,
                requestAccessForMediaType: &*media_type(),
                completionHandler: &*handler,
            ];
        }
        rx.recv().unwrap_or(false)
    }

    pub fn open_settings() {
        // 系统设置 › 隐私与安全性 › 麦克风。spawn 失败只记日志：
        // 打不开设置页不该让长按手势本身报一个莫名其妙的错。
        if let Err(err) = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            .spawn()
        {
            eprintln!("[media] 打开系统设置失败: {err}");
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::MicPermission;

    // 非 macOS（车机 Linux/Windows、iOS 待接）：没有可查的授权中心，
    // 视为已授权，异常仍走 cpal 的 NoDevice 报错路径。
    pub fn status() -> MicPermission {
        MicPermission::Granted
    }

    pub fn request_blocking() -> bool {
        true
    }

    pub fn open_settings() {}
}

/// 查询系统麦克风授权现状（同步、便宜，可以每次长按都问）。
pub fn mic_permission() -> MicPermission {
    imp::status()
}

/// 拉起系统授权框，阻塞至车主作答；返回是否授权。放 blocking 池调用。
pub fn request_mic_permission_blocking() -> bool {
    imp::request_blocking()
}

/// 打开系统设置的麦克风隐私页（`Denied` 后唯一的"拉起授权"方式）。
pub fn open_mic_settings() {
    imp::open_settings()
}

/// "什么都没录到"的两种形态。**必须分开报**：它们指向完全不同的一层，
/// 合并成一个说法会把排查引向错误的方向。
///
/// # 两种形态的区分
///
/// cpal 的输入流没起来（`StartIOThread: the IO thread failed to start`）时一次回调都没有：
/// 这不是"录到的内容是静音"，而是"根本没有内容"。
/// **一帧都没收到** 与 **收到了帧但逐点为零** 靠 `samples.is_empty()` 就能分开。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureFault {
    /// 一帧都没收到：输入流没跑起来。
    ///
    /// iOS 上的典型成因是 CoreAudio 的 IO 线程起不来
    /// （`kAudioHardwareNotRunningError`），此时设备侧其余检查都能通过：
    /// 权限已授、会话已切到 `playAndRecord`、格式协商一致、`start()` 同步返回 Ok。
    /// **不在这里重试**：重试只是再等一个 5 秒超时；如实报成设备故障。
    IoNotStarted,
    /// 收到了帧，但逐点为零：设备在转，声音没进来。
    ///
    /// macOS 未授权时 CoreAudio 的典型输出就是这样（照常回调、全是零）。
    SilentInput,
}

impl CaptureFault {
    /// 跨到前端的稳定短标识（进 `CaptureStatus::Failed` 的 reason，别改措辞）。
    pub fn as_str(self) -> &'static str {
        match self {
            CaptureFault::IoNotStarted => "audio_io_not_started",
            CaptureFault::SilentInput => "empty_capture",
        }
    }
}

/// 这段采集是不是"什么都没录到"；是的话说清是哪一种。`None` = 录到了真实声音。
///
/// 这样的段**不该上传**：ASR 只会转出空文本，端上表现为"说了话没任何反应"。
/// 真人说话哪怕再轻，采样值也不可能逐点为零。
pub fn classify_capture(samples: &[f32]) -> Option<CaptureFault> {
    if samples.is_empty() {
        return Some(CaptureFault::IoNotStarted);
    }
    // 精确等于 0.0，不设阈值：未授权时 CoreAudio 给的是**逐点为零**，
    // 而阈值会把真人的气声误杀（那是产品事故，不是防御）。
    if samples.iter().all(|s| *s == 0.0) {
        return Some(CaptureFault::SilentInput);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 一帧都没收到判为输入流没起来() {
        assert_eq!(classify_capture(&[]), Some(CaptureFault::IoNotStarted));
        assert_eq!(CaptureFault::IoNotStarted.as_str(), "audio_io_not_started");
    }

    #[test]
    fn 收到帧但全零判为没有声音进来() {
        assert_eq!(classify_capture(&[0.0; 480]), Some(CaptureFault::SilentInput));
        assert_eq!(CaptureFault::SilentInput.as_str(), "empty_capture");
    }

    #[test]
    fn 有一个非零样本就不算没录到() {
        let mut samples = vec![0.0f32; 480];
        samples[240] = 1e-6;
        assert_eq!(classify_capture(&samples), None);
    }
}
