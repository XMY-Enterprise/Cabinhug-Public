//! 崩溃捕获。
//!
//! # 为什么需要：Tauri 应用 panic 时无输出退出
//!
//! 车机上没人看着终端。不装 hook 时，一次 panic 只表现为 App 消失，
//! 事后无从归因。装上之后留下：文件与行号、panic 消息，以及崩溃前
//! 缓冲里的事件，后者往往是主要线索。
//!
//! # 保留原 hook，不取代它
//!
//! 默认 hook 会往 stderr 打印回溯，开发时有用。这里在它之前记录，然后仍然调用它，
//! 保留开发期的调试输出。

use std::panic::PanicHookInfo;
use std::sync::Arc;

use crate::buffer::{Severity, TelemetryBuffer};

/// 安装 panic hook，把崩溃写进给定缓冲。
///
/// 返回值是同一个 `Arc`，便于调用方接着 `manage()` 进 Tauri 状态。
///
/// 可重复调用是安全的（后装的包住先装的），但没有意义；
/// 正常用法是在 `setup()` 里装一次。
pub fn install_panic_hook(buffer: Arc<TelemetryBuffer>) -> Arc<TelemetryBuffer> {
    let sink = Arc::clone(&buffer);
    let previous = std::panic::take_hook();

    std::panic::set_hook(Box::new(move |info: &PanicHookInfo<'_>| {
        sink.record(Severity::Crash, "app.panic", &describe(info));
        // 仍然走原 hook：开发期的 stderr 回溯不能丢
        previous(info);
    }));

    buffer
}

/// 把 panic 信息渲染成一行。
///
/// 位置放在前面：`src/foo.rs:42` 比消息本身更常是排查的起点，
/// 而这一行可能会被截断。
pub fn describe(info: &PanicHookInfo<'_>) -> String {
    let location = info
        .location()
        .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
        .unwrap_or_else(|| "未知位置".to_string());

    let message = info
        .payload()
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| info.payload().downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "无消息".to_string());

    format!("{location} — {message}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buffer::Severity;
    use std::sync::Mutex;

    /*
     * 串行守卫：只挡住同样要装 hook 的测试，挡不住别的测试 panic。
     *
     * panic hook 是进程全局的，而 `cargo test` 默认多线程并行。
     * `buffer::tests::survives_poisoned_lock` 故意在线程里 panic 且不碰 hook，
     * 那次 panic 会被这里装上的全局 hook 记进同一个 buffer。
     *
     * 所以断言不能取"第一条 Crash"，要按本测试独有的标记找自己那条。
     * 别的测试的 panic 被记下来不是 bug，说明 hook 是全局生效的。
     */
    static PANIC_HOOK_GUARD: Mutex<()> = Mutex::new(());

    /// 本测试专用标记，用来在混入了其它线程 panic 的 buffer 里认出自己那条。
    const MARKER: &str = "cabinhug-telemetry-test-marker-9f3c";

    #[test]
    fn captures_panic_into_buffer() {
        // 中毒也要拿到：上一个持有者 panic 过不代表这把锁该失效
        let _guard = PANIC_HOOK_GUARD
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        let buffer = Arc::new(TelemetryBuffer::new(16));
        // 存下现场的 hook，测完原样放回去；不还原会让后续测试的 panic
        // 全部流进这个已经没人看的 buffer
        let previous = std::panic::take_hook();
        install_panic_hook(Arc::clone(&buffer));

        let _ = std::panic::catch_unwind(|| {
            panic!("测试用崩溃 {MARKER}");
        });

        // 先还原再断言：断言失败本身也是 panic，
        // 不还原的话它会被刚装的 hook 吃掉，报错信息就看不见了
        let _ = std::panic::take_hook();
        std::panic::set_hook(previous);

        let events = buffer.snapshot();
        // 按标记找自己那条：并行跑时别的测试的 panic 也会进这个 buffer
        let crash = events
            .iter()
            .find(|e| e.severity == Severity::Crash && e.detail.contains(MARKER))
            .unwrap_or_else(|| {
                panic!(
                    "没找到本测试的崩溃记录。buffer 里有：{:?}",
                    events.iter().map(|e| &e.detail).collect::<Vec<_>>()
                )
            });
        assert_eq!(crash.name, "app.panic");
        assert!(crash.detail.contains("测试用崩溃"), "消息要留下：{}", crash.detail);
        assert!(crash.detail.contains("panic.rs"), "位置要留下：{}", crash.detail);
    }

    #[test]
    fn crash_detail_is_redacted_too() {
        let buffer = Arc::new(TelemetryBuffer::new(16));
        // 不装 hook，直接验证走的是同一条脱敏路径
        buffer.record(Severity::Crash, "app.panic", "src/x.rs:1:1 — 号码 13800138000");
        assert!(!buffer.snapshot()[0].detail.contains("13800138000"));
    }
}
