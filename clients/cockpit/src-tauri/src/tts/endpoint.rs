//! 合成端点的端上缓存：后台引擎开关在端上的生效点。
//!
//! # 端上主动拉取
//!
//! 合成客户端在端上（`cabinhug_net::TtsClient`）。车机是长跑进程，
//! 后台切换引擎（如 mock 切到豆包）必须无需重启即可生效。所以端上按 TTL 复查
//! `GET /v1/tts/config`，把 URL / 音色 / 资源 id 套到客户端上。
//!
//! # 拉不到时沿用旧值，而不是回落默认
//!
//! 端上没有默认端点（ACR-018：`TtsClient` 没有 `new`，URL 只能来自下发），
//! 网络抖动不会把开发机切到计费引擎，这一点由类型系统保证。
//!
//! 降级顺序：新值 → 上一次的值（即使过期）→ `None`（本次不合成，
//! 交给调用方降级系统 say），避免一次网络抖动变成一次静音。
//! 降级方向始终是更省的那个。
//!
//! # 不阻塞播报
//!
//! 与 `ducking.rs` 相同：播报是功能，配置刷新是装饰。这一跳带 1.5s 超时，
//! 超时即用旧值继续。不改成"拿不到就不播"，避免配置调用进入播报的关键路径。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use cabinhug_net::{GatewayClient, TtsRuntimeConfig};

/// 拉取超时。见文件头：宁可用旧值也不让播报等。
const FETCH_TIMEOUT: Duration = Duration::from_millis(1_500);
/// 服务端没给 `refreshMs` 时的兜底复查间隔。
const FALLBACK_TTL: Duration = Duration::from_secs(30);

static CACHE: Mutex<Option<(TtsRuntimeConfig, Instant)>> = Mutex::new(None);

fn ttl(cfg: &TtsRuntimeConfig) -> Duration {
    if cfg.refresh_ms == 0 {
        FALLBACK_TTL
    } else {
        Duration::from_millis(cfg.refresh_ms)
    }
}

fn cached(allow_stale: bool) -> Option<TtsRuntimeConfig> {
    let guard = CACHE.lock().expect("tts endpoint cache poisoned");
    let (cfg, at) = guard.as_ref()?;
    if allow_stale || at.elapsed() < ttl(cfg) {
        Some(cfg.clone())
    } else {
        None
    }
}

/// 仅供测试与重启：清掉缓存。
#[cfg(test)]
pub fn __reset() {
    *CACHE.lock().expect("tts endpoint cache poisoned") = None;
}

/// 当前该用的合成端点；`None` 表示服务端问不到且本地没有旧值。
///
/// 锁不跨 await：命中判断与写回各自取一次锁，中间的网络调用不持锁。
/// 持锁发请求时，一次网关卡顿会挂住所有等待播报的任务。
/// 同步读缓存里的流式播报开关。
///
/// 只读缓存、不发请求：它在 SSE 的同步分发路径上被调用（每条 delta 都要问一次），
/// 那里不能 await，也不能每条 delta 请求一次网关。
///
/// 缓存为空（本次启动还没播过任何一句）时回 `false`，保守地按整段播报。
/// 第一次播报会填上缓存，之后即为准确值；首轮可能较慢，但不会擅自改变播报形式。
pub fn stream_speech_cached() -> bool {
    CACHE
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|(cfg, _)| cfg.stream_speech))
        .unwrap_or(false)
}

pub async fn effective() -> Option<TtsRuntimeConfig> {
    if let Some(cfg) = cached(false) {
        return Some(cfg);
    }

    // 统一走设置层（ACR-004）：iOS 没有环境变量，直接读 env 在 iPad 上无效。
    let (base_url, token) = crate::settings::gateway();

    let fetched = tokio::time::timeout(
        FETCH_TIMEOUT,
        GatewayClient::new(base_url, token).fetch_tts_config(),
    )
    .await;

    match fetched {
        Ok(Ok(cfg)) => {
            let changed = cached(true).is_none_or(|prev| prev.url != cfg.url);
            if changed {
                // 换端点需要留痕：事后核对"这段时间在用哪个引擎"
                // 依赖这一行，它区分计费与不计费。
                eprintln!(
                    "[tts] 合成端点更新：{}（{}）{}，边收边播 {}",
                    cfg.engine,
                    cfg.url,
                    if cfg.billed { " ⚠️ 按合成字数计费" } else { "" },
                    // 记录端上收到的档位，便于排查开关未生效的问题。
                    if cfg.stream_speech { "开" } else { "关" }
                );
            }
            *CACHE.lock().expect("tts endpoint cache poisoned") = Some((cfg.clone(), Instant::now()));
            Some(cfg)
        }
        Ok(Err(e)) => {
            eprintln!("[tts] 取合成端点失败，沿用上一次的值：{e}");
            cached(true)
        }
        Err(_) => {
            eprintln!("[tts] 取合成端点超时（{FETCH_TIMEOUT:?}），沿用上一次的值");
            cached(true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 串行闸：本模块的用例共享进程级的 `CACHE`，必须串行执行。
    ///
    /// 否则在 `cargo test --workspace` 这类高负载下会偶发失败：
    /// `stale_entry_…` 写完 CACHE 尚未断言，`fresh_entry_…` 的 `__reset()` 就把它清掉，
    /// `cached(true).unwrap()` 随之 panic。
    ///
    /// 用测试专用锁而不是把 `CACHE` 改成可注入：生产代码不变，
    /// 这里只需要"不同时运行"。
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    /// 取串行闸。中毒也照常拿：某个用例 panic 后锁会被标记为 poisoned，
    /// 若在这里 `unwrap()`，后续用例会全部以 `PoisonError` 失败，
    /// 掩盖真正的第一个失败。
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn cfg(url: &str, refresh_ms: u64) -> TtsRuntimeConfig {
        TtsRuntimeConfig {
            engine: "mock".into(),
            url: url.into(),
            resource_id: "seed-tts-2.0".into(),
            speaker: "zh_female_vv_uranus_bigtts".into(),
            billed: false,
            stream_speech: false,
            refresh_ms,
        }
    }

    #[test]
    fn stale_entry_is_still_returned_when_allowed() {
        let _serial = serial();
        __reset();
        // TTL 1ms 且已过期：新鲜读拿不到，允许陈旧则拿得到。
        *CACHE.lock().unwrap() = Some((cfg("http://a", 1), Instant::now() - Duration::from_secs(1)));
        assert!(cached(false).is_none());
        assert_eq!(cached(true).unwrap().url, "http://a");
        __reset();
    }

    #[test]
    fn missing_refresh_ms_falls_back_to_default_ttl() {
        let _serial = serial();
        // 服务端漏发 refreshMs 时不能退化成"每次都拉"，否则每句播报多一次往返。
        assert_eq!(ttl(&cfg("http://a", 0)), FALLBACK_TTL);
        assert_eq!(ttl(&cfg("http://a", 5_000)), Duration::from_millis(5_000));
    }

    #[test]
    fn fresh_entry_hits_cache() {
        let _serial = serial();
        __reset();
        *CACHE.lock().unwrap() = Some((cfg("http://b", 60_000), Instant::now()));
        assert_eq!(cached(false).unwrap().url, "http://b");
        __reset();
    }
}
