//! AEC 参考信号桥（ACR-010）。
//!
//! # 它连接的两端
//!
//! ```text
//! 播放线程（rodio）          本模块              哨兵线程
//!  Decoder ─ RenderTap ──→ 有界队列 ──→ StreamConverter → AecProcessor
//!     │                                                        │
//!     └→ 声卡（原样透传）                    converter 出的采集帧 ┘
//! ```
//!
//! 回声消除要的是"扬声器此刻在放什么"。这份信号只存在于播放线程里，
//! 而对消发生在哨兵线程，本模块提供两者之间的跨线程桥。
//!
//! # 第一原则：不阻塞播放线程
//!
//! `RenderTap::next` 跑在 rodio 的播放路径上，它变慢会让声音卡顿。
//! 卡顿比偶发回声对体验的影响更大。所以：
//!
//! - 队列有界，`try_send` 满了就丢，不用阻塞的 `send`；
//! - 播放线程只攒一批原始样本推走。重采样、格式转换全在
//!   哨兵线程做（它本来就在做同样的处理）。
//!
//! # 开关关闭时零开销
//!
//! `CABINHUG_AEC_ENABLED` 没开时：不包 `RenderTap`（播放走不带旁路的路径，
//! 没有额外函数调用）、不建 `AecProcessor`、不碰队列，行为与未接入 AEC 时逐字节一致。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Mutex, OnceLock};

/// 一批参考样本的目标大小（交错样本个数）。
///
/// 取值权衡：太小则播放线程频繁 `try_send`（每次一个原子操作 + 一次可能的
/// 内存分配），太大则参考信号到达 AEC 的时间粒度变粗、延迟估计跟着变糙。
/// 1024 个交错样本在 44.1k 立体声下约 11.6ms，与 APM 的 10ms 帧同量级。
const BATCH_SAMPLES: usize = 1024;

/// 队列容量（批数）。64 批在上述批大小下约 0.7s。
///
/// 它缓冲的是"哨兵线程偶尔慢一拍"，不是"哨兵卡死"；后者无法靠缓冲解决，
/// 由丢弃计数反映（见 `DROPPED_BATCHES`）。
const QUEUE_BATCHES: usize = 64;

/// 播放线程发给哨兵线程的消息。
pub enum RenderMsg {
    /// 新一段播放开始，带上源格式，每段都要发：
    /// 不同播报段与曲目的采样率不一定相同，消费侧据此重建重采样器。
    Start { sample_rate: u32, channels: u16 },
    /// 一批交错的原始播放样本。
    Samples(Vec<f32>),
}

/*
 * 延迟提示按平台各一份（ACR-010）。
 *
 * # 两平台不共用
 *
 * `set_stream_delay_ms` 要的是"播出去"到"采回来"的延迟。iOS 的 IO buffer duration
 * 由 `AVAudioSession` 决定，与桌面不是一个量级。错误的固定值比自适应更差
 * （上游实测：对齐正确 > 自适应 > 对齐错误，且第一与第三差三个数量级）。
 *
 * # 当前两个都是 None
 *
 * `None` = 交给 AEC3 自适应估计。真值需要真机实测，实测前不填估计值，
 * 因为错误值比不填更差。调参时把实测值填进对应的那一行即可，不必改别处。
 *
 * 起点参考：iOS 侧用 `cabinhug_media::audio_session::audio_latency()` 读一次
 * `outputLatency + inputLatency + IOBufferDuration`——它只覆盖硬件与驱动那一段，
 * 不含 rodio 解码缓冲与本模块的队列，所以是扫描起点不是答案。
 */
#[cfg(target_os = "ios")]
const PLATFORM_STREAM_DELAY_MS: Option<u16> = None; // 待 iPad 真机实测填入
#[cfg(not(target_os = "ios"))]
const PLATFORM_STREAM_DELAY_MS: Option<u16> = None; // 待 macOS 真机实测填入

/// 本平台的延迟提示，可用 `CABINHUG_AEC_DELAY_MS` 覆盖。
///
/// 环境变量这一档用于桌面调参：扫档位时不必每换一个值就重编译。
/// iOS 无法传入环境变量，只能改上面的常量后重装，因此 iOS 上需有选择地扫档位。
pub fn stream_delay_ms() -> Option<u16> {
    match cabinhug_core::env::env_var("CABINHUG_AEC_DELAY_MS") {
        Ok(v) if v.eq_ignore_ascii_case("auto") => None,
        Ok(v) => match v.parse::<u16>() {
            Ok(ms) => Some(ms),
            Err(_) => {
                eprintln!("[aec] CABINHUG_AEC_DELAY_MS={v:?} 不是合法毫秒数，按平台默认值处理");
                PLATFORM_STREAM_DELAY_MS
            }
        },
        Err(_) => PLATFORM_STREAM_DELAY_MS,
    }
}

/// AEC 总开关。进程启动时从 `CABINHUG_AEC_ENABLED` 读一次。
///
/// 默认关（ACR-010 兼容策略：并行运行 + 开关）。调参期它是工程开关而非
/// 用户偏好，所以只读环境变量、不做端上偏好页，重启生效。
static AEC_ENABLED: AtomicBool = AtomicBool::new(false);
static AEC_ENABLED_INIT: OnceLock<()> = OnceLock::new();

/// 因队列满而丢弃的批数。非零说明消费侧跟不上，调参时要看它。
static DROPPED_BATCHES: AtomicU64 = AtomicU64::new(0);
/// 已送达消费侧的批数，`CABINHUG_SENTINEL_DEBUG=1` 时打印。
/// 它反映参考信号链路是否接通：AEC 不生效时，
/// 先看这个数是否为 0，以区分"没接上"与"接上了但没消掉"。
static FED_BATCHES: AtomicU64 = AtomicU64::new(0);

type Bridge = (SyncSender<RenderMsg>, Mutex<Option<Receiver<RenderMsg>>>);

/// 进程级单例队列。
///
/// 用全局而不是"哨兵启动时创建、传给 tts"，因为两端的生命周期不一致：
/// 播放可能发生在哨兵重建流的间隙（起流失败时它 3s 才重试一次），
/// 此时若没有队列，这段播报就没有参考信号，AEC 会把它当作未知回声。
fn bridge() -> &'static Bridge {
    static BRIDGE: OnceLock<Bridge> = OnceLock::new();
    BRIDGE.get_or_init(|| {
        let (tx, rx) = sync_channel::<RenderMsg>(QUEUE_BATCHES);
        (tx, Mutex::new(Some(rx)))
    })
}

/// 读一次环境变量并锁定本进程的开关状态。
pub fn init_from_env() {
    AEC_ENABLED_INIT.get_or_init(|| {
        let on = cabinhug_core::env::env_var("CABINHUG_AEC_ENABLED").is_ok_and(|v| v == "1");
        AEC_ENABLED.store(on, Ordering::SeqCst);
        if on {
            eprintln!("[aec] 已启用（CABINHUG_AEC_ENABLED=1）——采集帧将过声学回声消除");
        }
    });
}

/// AEC 此刻是否启用。
pub fn enabled() -> bool {
    init_from_env();
    AEC_ENABLED.load(Ordering::Relaxed)
}

/// 取走消费端。只有第一个调用者拿得到（哨兵循环）。
pub fn take_receiver() -> Option<Receiver<RenderMsg>> {
    bridge().1.lock().ok().and_then(|mut g| g.take())
}

/// 已喂 / 已丢的批数——观测用。
pub fn counters() -> (u64, u64) {
    (FED_BATCHES.load(Ordering::Relaxed), DROPPED_BATCHES.load(Ordering::Relaxed))
}

/// 把播放样本旁路一份给 AEC 的 Source 包装器。
///
/// 对 rodio 完全透明：`next()` 原样返回内部 Source 的样本，
/// 同时复制一份。播放路径上不做任何可能阻塞的操作。
pub struct RenderTap<S> {
    inner: S,
    buf: Vec<f32>,
    tx: SyncSender<RenderMsg>,
    /// 首个样本前要先发 `Start`，消费侧靠它建重采样器。
    announced: bool,
}

impl<S> RenderTap<S>
where
    S: rodio::Source,
{
    pub fn new(inner: S) -> Self {
        Self::with_sender(inner, bridge().0.clone())
    }

    /// 指定发送端。生产路径始终走 [`RenderTap::new`]（使用进程级单例队列，
    /// 理由见 [`bridge`]）；这个入口只给用例。
    ///
    /// # 用例需要独立通道
    ///
    /// 队列是全局的，而 `cargo test` 默认并行运行，读到的样本数可能混入
    /// 别的用例推的批次（`aec队列满时丢弃不阻塞播放` 灌 200 批且不取走），
    /// 导致偶发的计数偏差（差值恰好一个 `BATCH_SAMPLES`）。
    ///
    /// 给每个要读队列的用例一条自己的通道，消除这类干扰，不依赖执行顺序。
    fn with_sender(inner: S, tx: SyncSender<RenderMsg>) -> Self {
        Self {
            inner,
            buf: Vec::with_capacity(BATCH_SAMPLES),
            tx,
            announced: false,
        }
    }

    /// 推走当前批次。满则丢并计数，不阻塞（见模块头）。
    fn flush(&mut self) {
        if self.buf.is_empty() {
            return;
        }
        let batch = std::mem::replace(&mut self.buf, Vec::with_capacity(BATCH_SAMPLES));
        match self.tx.try_send(RenderMsg::Samples(batch)) {
            Ok(()) => {
                FED_BATCHES.fetch_add(1, Ordering::Relaxed);
            }
            Err(_) => {
                DROPPED_BATCHES.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

impl<S> Iterator for RenderTap<S>
where
    S: rodio::Source,
{
    type Item = rodio::Sample;

    fn next(&mut self) -> Option<Self::Item> {
        let Some(sample) = self.inner.next() else {
            // 播完了：把不足一批的尾部也送走，保留最后几十毫秒的参考信号，
            // 播报末尾是车主最可能插话的时刻。
            self.flush();
            return None;
        };

        if !self.announced {
            self.announced = true;
            let _ = self.tx.try_send(RenderMsg::Start {
                sample_rate: self.inner.sample_rate().get(),
                channels: self.inner.channels().get(),
            });
        }

        self.buf.push(sample);
        if self.buf.len() >= BATCH_SAMPLES {
            self.flush();
        }
        Some(sample)
    }
}

impl<S> rodio::Source for RenderTap<S>
where
    S: rodio::Source,
{
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }

    fn channels(&self) -> rodio::ChannelCount {
        self.inner.channels()
    }

    fn sample_rate(&self) -> rodio::SampleRate {
        self.inner.sample_rate()
    }

    fn total_duration(&self) -> Option<std::time::Duration> {
        self.inner.total_duration()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::num::NonZero;

    /// 最小可用的测试 Source：固定格式的一串样本。
    struct TestSource {
        samples: std::vec::IntoIter<f32>,
        rate: u32,
        ch: u16,
    }

    impl Iterator for TestSource {
        type Item = rodio::Sample;
        fn next(&mut self) -> Option<f32> {
            self.samples.next()
        }
    }

    impl rodio::Source for TestSource {
        fn current_span_len(&self) -> Option<usize> {
            None
        }
        fn channels(&self) -> rodio::ChannelCount {
            NonZero::new(self.ch).expect("测试声道数非零")
        }
        fn sample_rate(&self) -> rodio::SampleRate {
            NonZero::new(self.rate).expect("测试采样率非零")
        }
        fn total_duration(&self) -> Option<std::time::Duration> {
            None
        }
    }

    fn source(n: usize) -> TestSource {
        let samples: Vec<f32> = (0..n).map(|i| (i % 100) as f32 / 100.0).collect();
        TestSource { samples: samples.into_iter(), rate: 44_100, ch: 2 }
    }

    /// tee 不能改变播放的样本。
    ///
    /// 违反时表现为声音变形或杂音，容易被误判为 TTS 引擎、网络或音量问题。
    #[test]
    fn aec旁路逐样本透传不改变播放() {
        let expect: Vec<f32> = source(5_000).collect();
        let got: Vec<f32> = RenderTap::new(source(5_000)).collect();
        assert_eq!(got, expect, "旁路必须逐样本透传");
    }

    /// Source 的元信息也要透传，否则 rodio 会按错误的格式送进声卡。
    #[test]
    fn aec旁路透传源格式() {
        let tap = RenderTap::new(source(10));
        assert_eq!(rodio::Source::sample_rate(&tap).get(), 44_100);
        assert_eq!(rodio::Source::channels(&tap).get(), 2);
    }

    /// 队列满时丢弃而不阻塞，保证播报不会因为 AEC 卡住。
    ///
    /// 没有消费者时灌远超容量的样本：它必须跑完，且丢弃计数增长。
    #[test]
    fn aec队列满时丢弃不阻塞播放() {
        let before = DROPPED_BATCHES.load(Ordering::Relaxed);
        // 容量 64 批 × 1024 样本；灌 200 批的量，且不取走任何东西
        let n = BATCH_SAMPLES * 200;
        let got = RenderTap::new(source(n)).count();
        assert_eq!(got, n, "样本必须全部透传，一个都不能因为队列满而少");
        assert!(
            DROPPED_BATCHES.load(Ordering::Relaxed) > before,
            "队列满后应计入丢弃，而不是阻塞播放线程"
        );
    }

    /// 一条只属于本用例的通道。见 `RenderTap::with_sender` 的文档注释。
    fn private_channel() -> (SyncSender<RenderMsg>, Receiver<RenderMsg>) {
        sync_channel::<RenderMsg>(QUEUE_BATCHES)
    }

    /// 播完的尾部要送走：播报末尾是车主最可能插话的时刻。
    ///
    /// # 不走全局队列
    ///
    /// 全局队列可能已混入并行用例推的批次（`aec队列满时丢弃不阻塞播放`
    /// 灌 200 批且从不取走），只防"接收端被别人拿走"不足以隔离。
    /// 自带一条通道后，读到的样本只来自本用例的播放，不依赖执行顺序。
    #[test]
    fn aec播放结束时冲刷尾批() {
        let (tx, rx) = private_channel();
        let n = BATCH_SAMPLES + 100; // 一整批 + 不足一批的尾巴
        let _: Vec<f32> = RenderTap::with_sender(source(n), tx).collect();

        let mut total = 0usize;
        while let Ok(msg) = rx.try_recv() {
            if let RenderMsg::Samples(b) = msg {
                total += b.len();
            }
        }
        assert_eq!(total, n, "整批与尾批都应送达，合计等于播放的样本数");
    }

    /// 起播前必须先发一次 `Start`，消费侧靠它建重采样器。
    ///
    /// 同样使用独立通道：全局队列里可能混有别的用例推的 `Start`，
    /// 无法验证本次播放发出过 `Start`。
    #[test]
    fn aec起播先发一次_start_且只发一次() {
        let (tx, rx) = private_channel();
        let _: Vec<f32> = RenderTap::with_sender(source(BATCH_SAMPLES * 3), tx).collect();

        let mut starts = 0usize;
        let mut first_is_start = None;
        while let Ok(msg) = rx.try_recv() {
            let is_start = matches!(msg, RenderMsg::Start { .. });
            if first_is_start.is_none() {
                first_is_start = Some(is_start);
            }
            if let RenderMsg::Start { sample_rate, channels } = msg {
                starts += 1;
                assert_eq!(sample_rate, 44_100, "Start 要带真实源格式");
                assert_eq!(channels, 2);
            }
        }
        assert_eq!(first_is_start, Some(true), "Start 必须排在第一批样本前面");
        assert_eq!(starts, 1, "一段播放只 announce 一次");
    }
}
