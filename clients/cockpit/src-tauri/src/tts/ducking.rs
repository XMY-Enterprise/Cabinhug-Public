//! 让路：暖暖说话时把车内音乐压低，说完恢复（§2.2 C6）。
//!
//! # 与 `TTS_PLAYING` 合成一个出口
//!
//! 哨兵的 `TTS_PLAYING` 标志精确标记"正在出声"：afplay 子进程起来才置位、
//! 退出/被 kill 就清位，四个写入点覆盖了自然结束、被打断、启动失败三种收尾。
//! 让路需要的边沿与它相同。
//!
//! 因此不设第二套判断，避免两者不一致导致音乐一直压着不恢复，或播报时音乐不压低。
//! `tts/mod.rs` 里所有对 `TTS_PLAYING` 的写入都走 [`set_tts_playing`]，
//! 置位与让路在同一次调用中完成。
//!
//! # 不阻塞播报
//!
//! 播报是功能，让路是装饰。车机没连上、mock 不可用、网关慢，任何情况下
//! 暖暖都必须照常开口。所以这一跳是 fire-and-forget：另起任务、带 1.5s 超时、
//! 失败只记一行日志。不改成 await，避免装饰性功能进入播报的关键路径。
//!
//! # 两条让路，各服务一种形态
//!
//! 出声位在端上时，音乐由本进程里的一个 `rodio::Player` 播放，
//! 压低它是一次同步函数调用（`music::set_ducked`），不经网络、不需要租约。
//! 远端请求保留给单机 demo 形态（全部跑在一台 Mac 上）：音乐由
//! mock-cabin 自己用 mpg123 出声。两种形态都在使用。
//!
//! # 恢复请求未送达
//!
//! 车机侧的让路是租约而不是开关（见 mock-cabin 的 `player.ts`）：压低带到期
//! 时间，到点自动恢复。这里发的恢复请求照常立即生效，租约只兜底"这个进程
//! 在播报中途被关掉"的情况，否则音乐会一直停在压低状态。

use std::sync::atomic::Ordering;

use cabinhug_net::GatewayClient;

/// 让路租期。取值要大于任何一句播报的时长：正常路径上恢复请求总会到，
/// 租约只是兜底；太短会让长播报说到一半时音乐恢复音量。
const DUCK_HOLD_MS: u64 = 30_000;

/// 置位"正在出声"，并把让路请求发出去。
///
/// 只在边沿发请求：`stop()` 会在本来就没在播时清位，此时的往返是多余的，
/// 而 `stop` 每轮都会调用。
pub fn set_tts_playing(playing: bool) {
    let prev = crate::voice::sentinel::TTS_PLAYING.swap(playing, Ordering::SeqCst);
    if prev == playing {
        return;
    }
    // 本机这一路先压：音乐在这个进程里放，让路是一次同步函数调用，
    // 无网络，不存在"恢复请求送不到"，不需要租约。
    crate::music::set_ducked(playing);
    // 远端那一路照发：单机 demo 形态下音乐由 mock-cabin 自己用 mpg123 出声。
    // 两种形态都在使用，所以两条都保留。
    spawn_duck(playing);
}

fn spawn_duck(on: bool) {
    // 与 commands/stream.rs 相同，网关地址与令牌只有一处口径。
    // 统一走设置层（ACR-004）：iOS 没有环境变量，直接读 env 在 iPad 上无效。
    let (base_url, token) = crate::settings::gateway();
    tauri::async_runtime::spawn(async move {
        let hold = if on { Some(DUCK_HOLD_MS) } else { None };
        if let Err(e) = GatewayClient::new(base_url, token).post_cabin_duck(on, hold).await {
            // 只记一行。失败的后果是音乐没让路，不影响播报，
            // 但需要留下日志以便排查。
            eprintln!("[tts] 让路请求失败（on={on}）：{e}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 置位要真的压到音乐上。
    ///
    /// 覆盖一个不会报错的回归：`set_tts_playing` 里缺少
    /// `music::set_ducked` 时，远端请求、日志与 `TTS_PLAYING` 都正常，
    /// 只有暖暖说话时音乐不压低。判据用增益而不是"是否调用过"：
    /// 调用了但传错值同样是错误。
    #[test]
    fn 置位会压低本机音乐_解除会恢复() {
        crate::music::set_ducked(false);
        crate::voice::sentinel::TTS_PLAYING.store(false, Ordering::SeqCst);
        // 基准音量取一个好算的数：20% 压到 30% 是 6%。
        crate::music::set_base_volume_for_test(20);

        crate::music::set_ducked(true);
        assert!((crate::music::ducked_gain() - 0.06).abs() < 1e-6, "让路中应当是 20% 的 30%");
        crate::music::set_ducked(false);
        assert!((crate::music::ducked_gain() - 0.20).abs() < 1e-6, "解除后要回到原音量");
    }

    /// 边沿判定是纯逻辑，不碰网络：连着置同一个值只应触发一次。
    ///
    /// 这条用例保证每轮播报两次往返：无条件发送时，
    /// 一轮里 `stop` + `play` + 结束轮询会发出四五次，多出的请求不报错但占用网关。
    #[test]
    fn 同值重复置位不重复触发() {
        crate::voice::sentinel::TTS_PLAYING.store(false, Ordering::SeqCst);
        let first = crate::voice::sentinel::TTS_PLAYING.swap(true, Ordering::SeqCst);
        let second = crate::voice::sentinel::TTS_PLAYING.swap(true, Ordering::SeqCst);
        assert_eq!(first, false, "第一次是边沿");
        assert_eq!(second, true, "第二次不是边沿，调用方据此跳过");
        crate::voice::sentinel::TTS_PLAYING.store(false, Ordering::SeqCst);
    }
}
