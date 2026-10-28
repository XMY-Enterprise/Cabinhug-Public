//! tts — 语音播报（F-02-06，§2.2 C6）。
//!
//! 【引擎】豆包 seed-tts-2.0（云端合成，
//! 客户端在 `cabinhug-net::tts`）+ 端上播放。合成失败时降级到系统 `say`
//! （macOS），保证播报链路不因网络中断而完全失效（FL-05 离线兜底方向）。
//!
//! 与架构 §2.2 C6"本地播报"的差异：C6 的动机是离线可用与低延迟，
//! 车机目标平台（§13-2）未定案前，云端合成的中文自然度显著更好；
//! 本地引擎作为降级路径保留，平台定案后按 C6 补齐。已回填架构文档。
//!
//! 【speaking 对齐】`speaking` 由播放起止驱动，
//! 不由 token 流驱动；代际计数守卫防止旧播放的结束事件覆盖新状态。
//!
//! 引擎由网关下发（后台 TTS_ENGINE 热切，ACR-017 起唯一开关）；出不出声由
//! 端上播报开关（设置页）决定。音色 `BYTEDANCE_TTS_SPEAKER`（豆包档）。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cabinhug_core::contract::AssistantState;
use cabinhug_core::fanout::EVENT_ASSISTANT_STATE;
use cabinhug_net::TtsClient;
use tauri::{AppHandle, Emitter};

/// 让路：播报期间压低车内音乐。
///
/// 本模块里所有 `TTS_PLAYING` 的写入都走它的 `set_tts_playing`，
/// 不直接 `store`：置位与让路必须同边沿，否则音乐可能一直压低不恢复。
pub mod ducking;
pub mod segment;
pub mod stream;
use crate::tts::stream as stream_mod;

/// 合成端点的端上缓存（后台 TTS 引擎开关的端上一侧）。
pub mod endpoint;

/// 一次在播的播报（ACR-004）。
///
/// # 使用枚举
///
/// 播放走 rodio（WAV 字节直接进声卡，macOS/iOS 同一条路径；iOS 沙盒
/// 禁止 spawn 子进程）；而 macOS 的 `say` 降级仍然是子进程，作为
/// "没有云端密钥也能出声"的兜底，不单独维护本地合成。两种句柄的生命周期
/// 语义不同，由枚举分别处理。
///
/// 状态机（代际守卫、replace 必杀旧者、轮询收尾）不依赖句柄类型：
/// 本枚举只是把「kill / 是否播完」两个动作从 `Child` 上抽象出来。
enum Playback {
    /// rodio 输出。`_device` 必须一起存着，drop 设备槽后声音立刻中断。
    Sink {
        player: rodio::Player,
        _device: rodio::MixerDeviceSink,
    },
    /// macOS `say` 子进程（降级路径）。
    #[cfg(target_os = "macos")]
    Proc(std::process::Child),
}

impl Playback {
    /// 立刻停止并回收。对子进程是 kill+wait（drop 一个 `Child` 不会杀进程，
    /// 会留下孤儿播放进程）；对 rodio 是 `stop`。
    fn halt(&mut self) {
        match self {
            Playback::Sink { player, .. } => player.stop(),
            #[cfg(target_os = "macos")]
            Playback::Proc(child) => {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    /// 往同一个输出队列里再排一段（只有 rodio 路径支持）。
    ///
    /// 分段播报必须走它，不能每段新开一个 `DeviceSink`：`is_finished()` 用的
    /// `player.empty()` 只说明"所有 source 都送进混音了"，设备缓冲里还有一截。
    /// 那时把 sink drop 掉，rodio 会打 `Dropping DeviceSink, audio playing through
    /// this sink will stop`，尾部被切掉；分成 N 段时每段都会丢失尾部。
    ///
    /// 排进同一个队列也保证了段间衔接：rodio 连续播放，没有换设备的空档。
    fn append_audio(&mut self, audio: Vec<u8>) -> Result<(), String> {
        match self {
            Playback::Sink { player, .. } => {
                let decoder = rodio::Decoder::new(std::io::Cursor::new(audio))
                    .map_err(|e| format!("音频解码失败: {e}"))?;
                // AEC 参考信号旁路与首段相同：开关关闭时不包装。
                if crate::voice::aec_bridge::enabled() {
                    player.append(crate::voice::aec_bridge::RenderTap::new(decoder));
                } else {
                    player.append(decoder);
                }
                Ok(())
            }
            #[cfg(target_os = "macos")]
            Playback::Proc(_) => Err("say 子进程不支持追加".into()),
        }
    }

    /// 是否已自然播完。rodio 播完即队列空；子进程看退出状态。
    /// 判定失败（try_wait 出错）按"已结束"处理：
    /// 卡在"永远在播"会吞掉后面所有播报，比提前收尾更糟。
    fn is_finished(&mut self) -> bool {
        match self {
            Playback::Sink { player, .. } => player.empty(),
            #[cfg(target_os = "macos")]
            Playback::Proc(child) => !matches!(child.try_wait(), Ok(None)),
        }
    }
}

#[derive(Default)]
pub struct TtsState {
    current: Mutex<Option<Playback>>,
    generation: AtomicU64,
    /// 用户侧播报总开关（F-02-12）。
    ///
    /// 这是用户偏好而不是运维配置，所以持久化在端上，
    /// 不进配置注册表（那里只放 A/B 类运维项）。
    /// "夜间克制/别跟我说话"这类情境化偏好依赖 Mem0 ③（FL-21 未实现），
    /// 当前只有全局开关。
    muted: AtomicBool,
    prefs_path: Mutex<Option<PathBuf>>,
    /// 播报音量（百分比，0~100，默认 15）。设置页「播报音量」滑块。
    ///
    /// 与 `muted` 是两个量：0 不等于关。关的语义是"不合成、不出声、
    /// 状态机不进 speaking"，而音量 0 仍然走完整条播报链路（哨兵照样让路、
    /// 回采判定照样有原文）。合成一个字段会让"调到最小再拉回来"改变开关状态。
    ///
    /// 只作用于 rodio 那条路：macOS 的 `say` 降级没有音量参数，
    /// 按系统音量出声，这是降级路径的限制。
    volume: VolumePercent,
    volume_prefs_path: Mutex<Option<PathBuf>>,
    /// 当前播的是不是垫场话（F-45-07）。
    ///
    /// `current` 只知道"有个子进程在播"，不知道播的是什么。没有这个标志就只能
    /// "收到 delta 就无条件 stop"，会误停正文自己的播报。
    speaking_filler: AtomicBool,
    /**
     * 已经有一句垫场在等前一句播完。
     *
     * 没有它的话，服务端连发三句时会有三个协程同时挂在 `await_filler_end` 上，
     * 前一句一结束就一起争抢，互相中断。
     */
    filler_pending: AtomicBool,
    /// 垫场话开关。与 `muted` 分开：用户可能要正文播报但不要垫场。
    filler_muted: AtomicBool,
    filler_prefs_path: Mutex<Option<PathBuf>>,
    /// 垫场话的收尾方式。`false` = 衔接（默认），`true` = 抢占。
    ///
    /// 存成 bool 而不是枚举：`AtomicBool` 够用且默认值正确
    /// （`Default` 给 false = `AfterSentence`）；对外仍以 `FillerPreemptMode` 表达。
    preempt_immediate: AtomicBool,
    preempt_prefs_path: Mutex<Option<PathBuf>>,
    /**
     * 一段正文从进入等待到播完的整个生命周期。
     *
     * # 防止"垫场把正文顶掉"的竞态
     *
     * 衔接模式下正文等垫场①说完；此时垫场②已在排队，两个协程挂在同一个
     * `await_filler_end` 上。垫场①一结束两者同时醒来，各自 `stop()` 再各自
     * 起播，后 `replace` 者生效：垫场②生效时会顶掉刚起播的正文，
     * 而正文没有重试，这一轮正文不会播出。
     *
     * 回复较快时，turn_end 正落在垫场①还在播、垫场②已排队的窗口里，
     * 该竞态必然发生。
     *
     * 本标志在位期间：新垫场一律 Drop、排队中的垫场醒来后自行退出。
     * 在位要覆盖正文的整个播放期，不能在起播时就清，否则晚醒的排队垫场
     * 仍会进入该窗口。
     */
    body_active: AtomicBool,
    /// 当前这句垫场话的**内容属性**（契约 `UpdateFiller.interruptible`）。
    /// 与 `preempt_mode` 是两码事，见 `should_preempt` 的说明。
    ///
    /// 初值是 `false`（`AtomicBool` 的 `Default`），但初值不会被使用：
    /// 抢占判定里它与 `stop_if_filler` 串联，后者要求 `speaking_filler` 为真，
    /// 即必然有一句垫场正在播，而 `speak_filler` 在播之前已写过这个字段。
    filler_interruptible: AtomicBool,
    /**
     * 此刻正在播的那句话的原文。
     *
     * 播报期哨兵不整段丢帧（AC-45-6 的前提），麦克风采到的大部分是
     * 暖暖自己的声音。`voice::echo::is_echo` 靠这句原文过滤回采，
     * 无需声学回声消除的整条音频链路。
     *
     * 起播时写、`stop()` 与自然结束时清。垫场与正文都写：它们同样从扬声器出来。
     */
    speaking_text: Mutex<Option<String>>,
    /**
     * 最近一次途中提醒的原文（F-62-08；「再说一遍」重播的就是它）。
     *
     * 与 `speaking_text` / `last_spoken` 分开：那两个是回采判定用的、垫场与正文都写；
     * 这个只记提醒，「再说一遍」不重播暖暖的对话回复。
     */
    /// 流式播报（边收边播）的一轮状态。
    ///
    /// 默认关：只有后台 `TTS_STREAM_SPEECH=on` 且 `events.rs` 判过开关时才用到它。
    /// 关闭时这个字段始终为空，走整段播报路径。
    pub stream: Arc<stream::StreamSpeech>,
    last_reminder_text: Mutex<Option<String>>,
    /**
     * 刚播完的那句原文 + 播完时刻。
     *
     * 回采段在播报结束后才判定：VAD 要 750ms 静音才收段，再加一趟
     * ASR，那时 `speaking_text` 已被清空，`is_echo(text, None)` 一律放行，
     * 播报尾部会被当作用户语音。这一档用于迟到的比对：
     * 段与播报重叠（哨兵按时间重叠判，见 sentinel_loop）但转写晚到时，
     * 拿它当原文。只在窄通道消费，正常路径不拿旧话比对新语音。
     */
    last_spoken: Mutex<Option<(String, std::time::Instant)>>,
}

/// 播报音量的存放（百分比）。
///
/// 单独包一层：`TtsState` 是 `#[derive(Default)]`，而 `AtomicU32`
/// 的默认值是 0，直接放进去会让从未设置音量的车机静音。
/// 默认必须是 `DEFAULT_VOLUME_PERCENT`。
struct VolumePercent(AtomicU32);

impl Default for VolumePercent {
    fn default() -> Self {
        Self(AtomicU32::new(DEFAULT_VOLUME_PERCENT))
    }
}

/// 出厂音量 15：车内近场、豆包合成本身响度偏高，满格音量过响。
/// 与车内音乐的出厂 20 同一量级。
pub const DEFAULT_VOLUME_PERCENT: u32 = 15;

/// 百分比 → 下发给 rodio 的增益。纯函数：越界的百分比钳到 100，
/// 损坏的偏好文件不会把增益推到 2.55 倍。
pub fn gain_for_percent(percent: u32) -> f32 {
    percent.min(100) as f32 / 100.0
}

/// 垫场话被正文接管的方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FillerPreemptMode {
    /// 正文首字到达即停止，允许在句中停止。
    Immediate,
    /// 垫场话自然说完，正文接在它后面。默认值：
    /// 句中截断比不说更像故障。
    AfterSentence,
}

impl Default for FillerPreemptMode {
    fn default() -> Self {
        Self::AfterSentence
    }
}

/// 该不该立即停止。纯函数，两个条件都要成立。
///
/// `interruptible` 是内容属性（这句话本身能不能被打断），
/// `mode` 是用户偏好。告警类垫场（"前方急弯"）的
/// `interruptible` 为 `false`，与用户选择的模式无关，
/// 所以两者是独立的两个开关。
pub fn should_preempt(mode: FillerPreemptMode, interruptible: bool) -> bool {
    matches!(mode, FillerPreemptMode::Immediate) && interruptible
}

/// 一句新垫场该怎么处置。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FillerSlot {
    /// 没人在播，直接播。
    Play,
    /// 正在播上一句垫场：等它播完，而不是停掉它。
    Queue,
    /// 已经有一句在等了，丢掉这一句。
    Drop,
}

/// 判定放在纯函数里（同 `should_preempt`），可以被逐条断言；
/// `speak_filler` 需要 `AppHandle`，在单测里无法构造。
///
/// # `Queue` 而不是停掉上一句
///
/// 服务端的 `speakingUntil` 按字数估算，间隔 500ms 时没有余量吸收估算误差，
/// 停掉上一句会截断半句。服务端拿不到播完回执（也不为此加上行通道），
/// 只有端上知道实际播放状态。
///
/// # 第三句 `Drop` 而不是继续排队
///
/// 多句排队时，前一句一结束几个协程会一起争抢，互相中断。
/// 丢弃是安全的：服务端下一拍还会再产一句。
pub fn filler_slot(speaking_filler: bool, filler_pending: bool, body_active: bool) -> FillerSlot {
    // 正文在场（等垫场让位，或正在播）：垫场一律丢弃。
    // 排进队里会在正文起播的窗口与正文争抢 stop/replace，可能顶掉正文。
    if body_active {
        return FillerSlot::Drop;
    }
    match (speaking_filler, filler_pending) {
        (false, _) => FillerSlot::Play,
        (true, false) => FillerSlot::Queue,
        (true, true) => FillerSlot::Drop,
    }
}

/// 正文等垫场自然结束的上限。
///
/// 没有上限时，垫场的播放进程若因合成失败、`afplay` 卡住等原因不结束，
/// 正文将永远播不出来。所以它是故障兜底，不是"最多让垫场说这么久"的策略闸。
///
/// 第 1 句垫场带进度前缀，有 45~49 字，约 9~10 秒；上限低于此值时
/// "等垫场讲完再接管"不会生效。12 秒 = 最长一句（约 10 秒）留两秒余量。
const FILLER_WAIT_CAP_MS: u64 = 12_000;

impl TtsState {
    /// 绑定持久化路径并载入上次的选择（跨重启保持）。
    pub fn load_prefs(&self, path: PathBuf) {
        let muted = std::fs::read_to_string(&path)
            .map(|c| c.trim() == "muted")
            .unwrap_or(false);
        self.muted.store(muted, Ordering::SeqCst);
        *self.prefs_path.lock().expect("tts prefs poisoned") = Some(path);
    }

    pub fn is_muted(&self) -> bool {
        self.muted.load(Ordering::SeqCst)
    }

    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::SeqCst);
        if let Some(path) = self.prefs_path.lock().expect("tts prefs poisoned").as_ref() {
            if let Err(e) = std::fs::write(path, if muted { "muted" } else { "on" }) {
                eprintln!("[tts] 播报偏好持久化失败: {e}");
            }
        }
    }

    /// 播报音量的持久化路径。文件内容是一个百分比整数；读不出（没有、写坏）= 出厂默认。
    pub fn load_volume_prefs(&self, path: PathBuf) {
        let percent = std::fs::read_to_string(&path)
            .ok()
            .and_then(|c| c.trim().parse::<u32>().ok())
            .map(|v| v.min(100))
            .unwrap_or(DEFAULT_VOLUME_PERCENT);
        self.volume.0.store(percent, Ordering::SeqCst);
        *self.volume_prefs_path.lock().expect("tts prefs poisoned") = Some(path);
    }

    /// 当前播报音量（百分比）。
    pub fn volume_percent(&self) -> u32 {
        self.volume.0.load(Ordering::SeqCst)
    }

    /// 设置播报音量；对正在播的那句立即生效并持久化。返回实际落下的值（钳过）。
    ///
    /// 车主拖滑块时暖暖通常正在说话，立即生效让车主当场听到变化。
    pub fn set_volume_percent(&self, percent: u32) -> u32 {
        let percent = percent.min(100);
        self.volume.0.store(percent, Ordering::SeqCst);
        if let Some(Playback::Sink { player, .. }) =
            self.current.lock().expect("tts state poisoned").as_ref()
        {
            player.set_volume(gain_for_percent(percent));
        }
        if let Some(path) = self.volume_prefs_path.lock().expect("tts prefs poisoned").as_ref() {
            if let Err(e) = std::fs::write(path, percent.to_string()) {
                eprintln!("[tts] 播报音量持久化失败: {e}");
            }
        }
        percent
    }

    /// 垫场话开关的持久化路径。与播报开关同一形状，分开存。
    pub fn load_filler_prefs(&self, path: PathBuf) {
        let muted = std::fs::read_to_string(&path)
            .map(|c| c.trim() == "muted")
            .unwrap_or(false);
        self.filler_muted.store(muted, Ordering::SeqCst);
        *self.filler_prefs_path.lock().expect("tts prefs poisoned") = Some(path);
    }

    pub fn is_filler_muted(&self) -> bool {
        self.filler_muted.load(Ordering::SeqCst)
    }

    /**
     * 把垫场槽位的三个标志复位。
     *
     * # 打断时必须复位
     *
     * `body_active` 的语义是"正文从进入等待到播完的整个生命周期"，
     * 它由 `speak()` 自己置起与清掉。打断发生在播放中途，
     * `speak()` 的那条协程被 `stop()` 的代际判定挡住，不会清这个标志。
     *
     * `filler_slot()` 第一条就是 `if body_active { return Drop }`：
     * 不复位的话，打断一次之后这个进程里不再播出任何垫场。
     * `stop()` 只清另外两个标志；端上丢弃的垫场也不会记入服务端的
     * `sidecarCounters`。
     *
     * `speaking_filler` 与 `filler_pending` 已由 `stop()` 清过（见它的实现），
     * 这里一并置一次使本函数自成一体：调用顺序变化或在没有 `stop()` 的路径上
     * 复用时，也不会遗漏。
     */
    /// 记下 / 清掉"此刻正在播的那句"。
    /// 清掉时把原文挪进 `last_spoken`，供迟到的回采比对使用。
    /// 最近一次途中提醒的原文（「再说一遍」用）。
    pub fn last_reminder_text(&self) -> Option<String> {
        self.last_reminder_text.lock().expect("tts state poisoned").clone()
    }

    pub fn set_speaking_text(&self, text: Option<&str>) {
        let mut cur = self.speaking_text.lock().expect("tts state poisoned");
        if text.is_none() {
            if let Some(prev) = cur.take() {
                *self.last_spoken.lock().expect("tts state poisoned") =
                    Some((prev, std::time::Instant::now()));
            }
        }
        *cur = text.map(str::to_string);
    }

    /// 正在播的那句；没在播时，`within` 内刚播完的那句也算。
    ///
    /// 只给窄通道用：窄通道里的段都与播报重叠过，拿刚播完的原文比对可以
    /// 正确判定回采。正常路径不调用它，否则拿旧话比对新语音会过滤掉真实指令
    /// （`stop()` 清 `speaking_text` 也是为此）。
    pub fn recently_spoken(&self, within: std::time::Duration) -> Option<String> {
        if let Some(cur) = self.speaking_text.lock().expect("tts state poisoned").clone() {
            return Some(cur);
        }
        self.last_spoken
            .lock()
            .expect("tts state poisoned")
            .as_ref()
            .filter(|(_, at)| at.elapsed() <= within)
            .map(|(text, _)| text.clone())
    }

    pub fn reset_filler_slots(&self) {
        self.body_active.store(false, Ordering::SeqCst);
        self.speaking_filler.store(false, Ordering::SeqCst);
        self.filler_pending.store(false, Ordering::SeqCst);
        self.set_speaking_text(None);
    }

    pub fn set_filler_muted(&self, muted: bool) {
        self.filler_muted.store(muted, Ordering::SeqCst);
        if let Some(path) = self
            .filler_prefs_path
            .lock()
            .expect("tts prefs poisoned")
            .as_ref()
        {
            if let Err(e) = std::fs::write(path, if muted { "muted" } else { "on" }) {
                eprintln!("[tts] 垫场偏好持久化失败: {e}");
            }
        }
    }

    pub fn filler_interruptible(&self) -> bool {
        self.filler_interruptible.load(Ordering::SeqCst)
    }

    pub fn is_speaking_filler(&self) -> bool {
        self.speaking_filler.load(Ordering::SeqCst)
    }

    pub fn is_filler_pending(&self) -> bool {
        self.filler_pending.load(Ordering::SeqCst)
    }

    /// 收尾方式的持久化。单独一个文件，不与 `filler-pref` 合并，
    /// 以便单独重置其中一个。
    pub fn load_preempt_prefs(&self, path: PathBuf) {
        let immediate = std::fs::read_to_string(&path)
            .map(|c| c.trim() == "immediate")
            .unwrap_or(false); // 读不到 / 没这个文件 ⇒ 默认衔接
        self.preempt_immediate.store(immediate, Ordering::SeqCst);
        *self.preempt_prefs_path.lock().expect("tts prefs poisoned") = Some(path);
    }

    pub fn preempt_mode(&self) -> FillerPreemptMode {
        if self.preempt_immediate.load(Ordering::SeqCst) {
            FillerPreemptMode::Immediate
        } else {
            FillerPreemptMode::AfterSentence
        }
    }

    pub fn set_preempt_mode(&self, mode: FillerPreemptMode) {
        let immediate = matches!(mode, FillerPreemptMode::Immediate);
        self.preempt_immediate.store(immediate, Ordering::SeqCst);
        if let Some(path) = self
            .preempt_prefs_path
            .lock()
            .expect("tts prefs poisoned")
            .as_ref()
        {
            if let Err(e) = std::fs::write(path, if immediate { "immediate" } else { "after_sentence" })
            {
                eprintln!("[tts] 垫场收尾偏好持久化失败: {e}");
            }
        }
    }
}

/// 引擎层面是否可用（与用户开关无关）。
///
/// "出不出声"是用户偏好，由 [`TtsState::set_muted`] 负责
/// （端上持久化 + 两端设置页 UI，ACR-017），本函数只回答平台能力。
pub fn enabled() -> bool {
    /*
     * 恒为 true（ACR-018）。
     *
     * 端上没有任何 vendor 密钥，云端合成对任何平台都只是一次请求网关的
     * HTTP；`say` 兜底只有 macOS/iOS 有，它是降级路径而不是准入条件。
     *
     * 保留这个函数而不删调用点：它回答的问题（"这台设备的引擎层能不能
     * 出声"）仍然成立，只是当前所有平台的答案都是能。真不可用会在合成那一步
     * 失败并如实降级（日志 + idle）；在这里拦截会导致网关能给出端点时
     * 端上仍然静音。
     */
    true
}

fn emit_state(app: &AppHandle, state: AssistantState) {
    if let Err(e) = app.emit(EVENT_ASSISTANT_STATE, state) {
        eprintln!("[tts] emit state failed: {e}");
    }
}

/// 停止当前播放（若有）。代际+1，使旧播放的监视线程不再发结束状态。
///
/// 返回停完之后的代际，调用方必须用这个返回值，不要自己再 `load` 一次。
/// `stop(); load()` 是两步：A 线程 `stop()` 把代际推到 5，B 线程紧接着推到 6，
/// 两个线程各自 `load()` 都拿到 6，两次播放都通过代际守卫，同时出声。
pub fn stop(state: &TtsState) -> u64 {
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    state.speaking_filler.store(false, Ordering::SeqCst);
    // 排队标志一并清除：打断时若留下永远为真的 pending，
    // 之后所有垫场都会被"已经有一句在等"这条判据丢弃。
    state.filler_pending.store(false, Ordering::SeqCst);
    // 没在播就没有"正在播的那句"。若保留，播完之后的第一段
    // 用户语音会与已结束的话比对，真实的打断会被过滤。
    state.set_speaking_text(None);
    // 流式播报的队列也要清：否则打断之后消费任务仍会播完队列里剩下的句子。
    state.stream.abandon();
    if let Some(mut playback) = state.current.lock().expect("tts state poisoned").take() {
        playback.halt();
    }
    // 声音停了，哨兵恢复收音。若紧接着有新播报，它会再置回。
    crate::tts::ducking::set_tts_playing(false);
    generation
}

/// 只在播垫场话时停（F-45-07 / AC-45-3）。
///
/// 返回是否真的停了：`events.rs` 用它做断言，也用它计"被抢占"这个指标。
///
/// # 不能"收到 delta 就无条件 stop"
///
/// 那会误停正文自己的播报。边收边播时正文与 delta 同时进行，
/// 抢占逻辑不能假设正文只在 `turn_end` 才播。
pub fn stop_if_filler(state: &TtsState) -> bool {
    if !state.speaking_filler.load(Ordering::SeqCst) {
        return false;
    }
    let _ = stop(state);
    true
}

/// 播放音频字节（ACR-004）：rodio 从内存直接解码进声卡。
///
/// 网关一律下发 WAV（ACR-067）；端上只带 WAV / FLAC / Vorbis 解码，不带 MP3/AAC（ACR-068）。
///
/// 不经临时文件与子进程：iOS 沙盒禁止 spawn，临时文件还存在同名并发冲突与
/// /tmp 清扫问题。内存直解不存在文件名冲突。
///
/// 输出流每次新开而不是全局共享：流的生命周期就是这一次播报的生命周期，
/// 与 `Playback` 一起被 `halt`/drop 回收，不用管理"全局流该何时关"。
fn start_playback(audio: Vec<u8>, gain: f32) -> Result<Playback, String> {
    let device = rodio::DeviceSinkBuilder::open_default_sink()
        .map_err(|e| format!("打开音频输出失败: {e}"))?;
    let player = rodio::Player::connect_new(device.mixer());
    // 音量在 append 之前设，否则每句开头会有一小段原始响度。
    player.set_volume(gain);
    let decoder = rodio::Decoder::new(std::io::Cursor::new(audio))
        .map_err(|e| format!("音频解码失败: {e}"))?;
    /*
     * AEC 参考信号旁路（ACR-010）。
     *
     * 回声消除要知道"扬声器此刻在放什么"，而这份 PCM 只在这里存在：
     * 解码器的输出直接进声卡，没有其他挂钩点。`RenderTap`
     * 逐样本透传给 player，同时复制一份给哨兵线程。
     *
     * 开关关闭时不包装：直接 `append(decoder)`，播放路径上没有额外函数调用。
     */
    if crate::voice::aec_bridge::enabled() {
        player.append(crate::voice::aec_bridge::RenderTap::new(decoder));
    } else {
        player.append(decoder);
    }
    Ok(Playback::Sink { player, _device: device })
}

/// macOS 降级：系统 `say`。iOS 上没有这条路（沙盒禁止子进程，
/// 系统合成走 AVSpeechSynthesizer，不为降级维护 Swift 桥，见 ACR-004）；
/// iOS 合成失败的降级是"文字仍在对话里，静默回 idle"。
///
/// 这条路径拿不到 AEC 参考信号：音频在 `say` 自己的进程里合成、
/// 直接进声卡，没有 PCM 可以旁路。走 `say` 时回声消除无效，
/// 只靠 `voice/echo.rs` 的文本比对，这是该路径的限制。
/// iPad 不受影响：iOS 没有 `say` 降级，每一次出声都走 rodio，参考信号全覆盖。
#[cfg(target_os = "macos")]
fn spawn_say(text: &str) -> std::io::Result<Playback> {
    use std::process::{Command, Stdio};
    let mut cmd = Command::new("say");
    if let Ok(voice) = cabinhug_core::env::env_var("CABINHUG_TTS_SAY_VOICE") {
        cmd.arg("-v").arg(voice);
    }
    cmd.arg(text)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(Playback::Proc)
}

/// 把 markdown 记号从播报文本里剥掉。
///
/// 模型的回答带 `**加粗**`、`- 列表` 这类记号，屏幕上渲染正常，
/// 但 TTS 会把 `**` 逐字读成「星星」。prompt 的要求无法保证模型不输出记号，
/// 所以在播报入口用代码剥除。
/// 只删记号不动内容：链接保留可读文字，列表符换成顿号停顿。
fn strip_markdown_for_speech(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        // 行首的标题/引用/列表记号
        let trimmed = line.trim_start();
        let body = trimmed
            .trim_start_matches('#')
            .trim_start_matches('>')
            .trim_start_matches(['-', '*', '+'])
            .trim_start();
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(body);
    }
    // 成对/行内记号：**  __  *  _  `  以及 [文字](链接) 只留文字
    let mut s = out.replace("**", "").replace("__", "").replace('`', "");
    s = s.replace(['*', '_'], "");
    // [text](url) → text：手写小状态机，不引正则依赖
    let mut cleaned = String::with_capacity(s.len());
    let mut rest = s.as_str();
    while let Some(open) = rest.find('[') {
        if let Some(close) = rest[open..].find("](") {
            if let Some(end) = rest[open + close + 2..].find(')') {
                cleaned.push_str(&rest[..open]);
                cleaned.push_str(&rest[open + 1..open + close]);
                rest = &rest[open + close + 2 + end + 1..];
                continue;
            }
        }
        break;
    }
    cleaned.push_str(rest);
    cleaned
}

/// 播报一段文本：合成（豆包）→ 播放；失败降级系统 `say`。
/// 网络合成在后台线程完成，不阻塞事件处理。
/// 播报一段正文，实现在 `play`。
pub fn speak(app: &AppHandle, state: &Arc<TtsState>, text: &str) {
    if state.is_muted() {
        return;
    }
    /*
     * 衔接模式：正文要等还在说的垫场话说完。
     *
     * 仅关闭 `events.rs` 的 `stop_if_filler` 不够：`play` 的第一件事
     * 就是 `stop()`，`turn_end` 时仍会停掉垫场。所以这里显式判一次。
     */
    let wait = matches!(state.preempt_mode(), FillerPreemptMode::AfterSentence)
        && state.is_speaking_filler();
    // 正文登场即挂牌（见 body_active 的说明）；生命周期各出口由 play 收。
    state.body_active.store(true, Ordering::SeqCst);
    play(app, state, text, false, wait);
}

/// 播报一句垫场话（F-45-07）。
///
/// 与 `speak` 的两处差别：
///  1. 受 `filler_muted` 单独控制：用户可能要正文播报但不要垫场；
///  2. 全程不发 `AssistantState`。`thinking` 与 `speaking` 同时成立的状态
///     在 §2.3 的状态机里没有定义（架构 §13-16 未决），垫场期保持 `thinking`，
///     不在这里新增状态。
pub fn speak_filler(app: &AppHandle, state: &Arc<TtsState>, text: &str, interruptible: bool) {
    if state.is_muted() || state.is_filler_muted() {
        return;
    }
    // 记下这一句的内容属性，供抢占判定用。
    state.filler_interruptible.store(interruptible, Ordering::SeqCst);

    // 播 / 排队 / 丢弃三选一，判据与理由见 `filler_slot`。
    // 排队复用"正文等垫场"的同一套 `await_filler_end`。
    let wait = match filler_slot(
        state.is_speaking_filler(),
        state.is_filler_pending(),
        state.body_active.load(Ordering::SeqCst),
    ) {
        FillerSlot::Drop => return,
        FillerSlot::Queue => {
            state.filler_pending.store(true, Ordering::SeqCst);
            true
        }
        FillerSlot::Play => false,
    };
    play(app, state, text, true, wait);
}

/// 途中提醒能不能播、要不要等（F-62-15）。纯函数，三种处置：
///
/// | 此刻 | 处置 |
/// |---|---|
/// | 播报总开关关着 | 拒绝（前端当只卡片） |
/// | 正文在播（暖暖在回话） | 拒绝：提醒不打断正文；前端的闸会在下一帧再问 |
/// | 垫场在播 | 按 `preempt_mode`：衔接 → 等它说完再播；抢占 → 立即 |
/// | 空闲 | 立即 |
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReminderAdmit {
    Refuse,
    Play { wait_for_filler: bool },
}

pub fn reminder_admit(muted: bool, body_active: bool, speaking_filler: bool, mode: FillerPreemptMode) -> ReminderAdmit {
    if muted || body_active {
        return ReminderAdmit::Refuse;
    }
    if speaking_filler {
        return ReminderAdmit::Play { wait_for_filler: matches!(mode, FillerPreemptMode::AfterSentence) };
    }
    ReminderAdmit::Play { wait_for_filler: false }
}

/// 播一句途中提醒（F-62-08）。返回是否真的播了。
///
/// 走 `play` 的正常路径（受播报开关、进 speaking 态、让路哨兵、回采判定有原文），与 `speak` 只差两点：
/// 不置 `body_active`（提醒不是正文，垫场排队判据不把它当正文），并记 `last_reminder_text`
/// 供「再说一遍」重播。不经会话：它是端上闸门算出的固定文案。
pub fn speak_reminder(app: &AppHandle, state: &Arc<TtsState>, text: &str) -> bool {
    match reminder_admit(
        state.is_muted(),
        state.body_active.load(Ordering::SeqCst),
        state.is_speaking_filler(),
        state.preempt_mode(),
    ) {
        ReminderAdmit::Refuse => false,
        ReminderAdmit::Play { wait_for_filler } => {
            *state.last_reminder_text.lock().expect("tts state poisoned") = Some(text.to_string());
            play(app, state, text, false, wait_for_filler);
            true
        }
    }
}

/// 等当前垫场话自然结束。返回 `true` = 它自己结束的；`false` = 撞上限了。
///
/// 轮询间隔与既有播放轮询一致（120ms），不另立一个节奏。
async fn await_filler_end(state: &Arc<TtsState>, cap_ms: u64) -> bool {
    let mut waited = 0u64;
    while state.is_speaking_filler() {
        if waited >= cap_ms {
            eprintln!("[tts] 垫场话超过 {cap_ms}ms 未结束，强制让位给正文");
            return false;
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
        waited += 120;
    }
    true
}

/// 合成 → 播放 → 收尾的公共实现。
///
/// markdown 剥离与降级路径对两条入口必须同源，否则降级到 say 时
/// 记号会被读出。
/// 流水线的一块：要么是合成好的音频，要么是"剩下的交给 say"。
enum Chunk {
    Audio(Vec<u8>),
    Say(String),
}

/// 分段合成的流水线。
///
/// 只领先一段：播放比合成慢 7 倍（见 `segment.rs`），多领先无收益，
/// 却会在打断时浪费已经合成的段（按字计费）。
struct Pipeline {
    /// 整段原文，回采比对的语料（见 `Source::echo_text`）。
    full_text: String,
    client: Option<std::sync::Arc<TtsClient>>,
    segments: Vec<String>,
    state: Arc<TtsState>,
    generation: u64,
    is_filler: bool,
    engine_label: String,
    /// 下一个要取的段号。
    idx: usize,
    pending: Option<tauri::async_runtime::JoinHandle<Result<Vec<u8>, String>>>,
}

impl Pipeline {
    fn new(
        client: Option<TtsClient>,
        segments: Vec<String>,
        state: Arc<TtsState>,
        generation: u64,
        is_filler: bool,
        engine_label: String,
        full_text: String,
    ) -> Self {
        let mut p = Self {
            full_text,
            client: client.map(std::sync::Arc::new),
            segments,
            state,
            generation,
            is_filler,
            engine_label,
            idx: 0,
            pending: None,
        };
        p.pending = p.spawn_at(0);
        p
    }

    /// 发起第 `i` 段的合成。越界或无客户端时返回 None。
    fn spawn_at(&self, i: usize) -> Option<tauri::async_runtime::JoinHandle<Result<Vec<u8>, String>>> {
        let client = self.client.clone()?;
        let seg = self.segments.get(i)?.clone();
        let state = Arc::clone(&self.state);
        let generation = self.generation;
        let is_filler = self.is_filler;
        let engine = self.engine_label.clone();
        let total = self.segments.len();
        Some(tauri::async_runtime::spawn(async move {
            // 打断即停：后面的段不再合成。这是计费路径，
            // 少发一次请求即少一段费用。
            if state.generation.load(Ordering::SeqCst) != generation {
                return Err("已被打断，本段不再合成".to_string());
            }
            let bytes = client.synthesize(&seg).await.map_err(|e| e.to_string())?;
            /*
             * 每次计费合成都要留痕，用于核对用量。
             *
             * 带上「第几段/共几段」：打断时能看出实际合成了多少，
             * 按整段记会高估。引擎名与字数一起记录，
             * 因为是否计费取决于当时连的是哪一档。
             */
            eprintln!(
                "[tts] 合成 {} 字（{}，{}，第 {}/{} 段），{} bytes",
                seg.chars().count(),
                if is_filler { "垫场" } else { "正文" },
                engine,
                i + 1,
                total,
                bytes.len()
            );
            Ok(bytes)
        }))
    }

    /// 取下一块。None = 没有更多了。
    async fn next(&mut self) -> Option<Chunk> {
        // 没有合成端点：整段交给 say，一次念完，不分段，本地合成没有云端的等待。
        if self.client.is_none() {
            if self.idx > 0 {
                return None;
            }
            self.idx = self.segments.len().max(1);
            return Some(Chunk::Say(self.segments.join("")));
        }
        let handle = self.pending.take()?;
        let cur = self.idx;
        self.idx += 1;
        // 领先一段：当前这块还没播，下一段已经在合成路上。
        self.pending = self.spawn_at(self.idx);
        let err = match handle.await {
            Ok(Ok(bytes)) => return Some(Chunk::Audio(bytes)),
            Ok(Err(e)) => e,
            Err(join) => join.to_string(),
        };
        // 打断导致的失败不降级：那是用户主动要求停止，不是故障。
        if self.state.generation.load(Ordering::SeqCst) != self.generation {
            if let Some(h) = self.pending.take() {
                h.abort();
            }
            return None;
        }
        Some(self.degrade(cur, &err))
    }

    /// 某一段合成失败：把剩下的交给 say 一次念完，而不是只补这一段：
    /// 逐段重试会让一句话中途切换音色。
    fn degrade(&mut self, from: usize, err: &str) -> Chunk {
        eprintln!(
            "[tts] 第 {}/{} 段合成失败，剩余降级 say: {err}",
            from + 1,
            self.segments.len()
        );
        // 丢弃已发起的下一段，它也是计费的。
        if let Some(h) = self.pending.take() {
            h.abort();
        }
        let rest = self.segments[from..].join("");
        self.idx = self.segments.len();
        Chunk::Say(rest)
    }
}

/// macOS 的 say 降级；其它平台如实说没出声。
fn say_fallback(text: &str, is_filler: bool) -> Result<Playback, String> {
    #[cfg(target_os = "macos")]
    {
        // say 路径同样记录日志，与云端路径的「合成 N 字」对应，
        // 以区分"暖暖不出声"与"没走到播报"。
        eprintln!(
            "[tts] say 播报 {} 字（{}）",
            text.chars().count(),
            if is_filler { "垫场" } else { "正文" }
        );
        spawn_say(text).map_err(|e| format!("say 启动失败: {e}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        // iOS 没有 say（ACR-004）：文字仍在对话里，这里如实说没出声。
        let _ = (text, is_filler);
        Err("本平台无本地合成降级（云端合成不可用），本次不出声".to_string())
    }
}

/// 流式消费任务的一次产出。
enum StreamItem {
    Audio(Vec<u8>),
    /// 这一段合成失败，用 say 念它。只降级这一段：流式下"剩余"还没到齐，
    /// 没有"把剩下的一起交给 say"这个选项。
    SayFallback(String),
    /// 没有更多了（输入已结束且队列空）。
    End,
}

/// 流式播报的数据源。与 `Pipeline` 并列，喂给同一个播放循环。
///
/// 和整段模式的差别只有一处：下一段从队列里等，而不是从一个已知的数组里取。
/// 等待本身也放在后台任务里，否则"领先一段"会退化成"播完才开始等下一段"，
/// 出现停顿。
struct StreamSource {
    stream: Arc<stream::StreamSpeech>,
    client: Option<std::sync::Arc<TtsClient>>,
    state: Arc<TtsState>,
    generation: u64,
    engine_label: String,
    pending: Option<tauri::async_runtime::JoinHandle<StreamItem>>,
    taken: usize,
}

impl StreamSource {
    fn new(
        stream: Arc<stream::StreamSpeech>,
        client: Option<TtsClient>,
        state: Arc<TtsState>,
        generation: u64,
        engine_label: String,
    ) -> Self {
        let mut s = Self {
            stream,
            client: client.map(std::sync::Arc::new),
            state,
            generation,
            engine_label,
            pending: None,
            taken: 0,
        };
        s.pending = Some(s.spawn_next());
        s
    }

    /// 起一个后台任务：等到有段可播，再合成它。
    fn spawn_next(&self) -> tauri::async_runtime::JoinHandle<StreamItem> {
        let stream = Arc::clone(&self.stream);
        let state = Arc::clone(&self.state);
        let client = self.client.clone();
        let generation = self.generation;
        let engine = self.engine_label.clone();
        let idx = self.taken;
        tauri::async_runtime::spawn(async move {
            let seg = loop {
                // 打断即停：不再取、不再合成。这是计费路径。
                if state.generation.load(Ordering::SeqCst) != generation {
                    return StreamItem::End;
                }
                // 用 `next_speech_segment` 而不是 `next_segment`：记号要在送合成前剥掉。
                // 流式这条路不经过 `play()`，剥的那一步只能在这里，理由见
                // `stream::StreamSpeech::next_speech_segment`。
                match stream.next_speech_segment() {
                    stream_mod::Next::Seg(s) => break s,
                    stream_mod::Next::Done => return StreamItem::End,
                    // 还在等模型输出。40 ms 一轮，比 120 ms 的播放轮询密，
                    // 因为这一跳直接决定"模型说完一句后多久开口"。
                    stream_mod::Next::Wait => tokio::time::sleep(Duration::from_millis(40)).await,
                }
            };
            let Some(client) = client else {
                return StreamItem::SayFallback(seg);
            };
            match client.synthesize(&seg).await {
                Ok(bytes) => {
                    // 与整段模式相同的用量记录：字数 + 引擎 + 第几段。
                    // 流式不知道总共几段，所以只记序号。
                    eprintln!(
                        "[tts] 合成 {} 字（正文流式，{}，第 {} 段），{} bytes",
                        seg.chars().count(),
                        engine,
                        idx + 1,
                        bytes.len()
                    );
                    StreamItem::Audio(bytes)
                }
                Err(e) => {
                    eprintln!("[tts][stream] 第 {} 段合成失败，这一段降级 say: {e}", idx + 1);
                    StreamItem::SayFallback(seg)
                }
            }
        })
    }

    async fn next(&mut self) -> Option<Chunk> {
        let handle = self.pending.take()?;
        self.taken += 1;
        // 领先一段：这一块还没播，下一段已经在"等 + 合成"的路上。
        self.pending = Some(self.spawn_next());
        match handle.await {
            Ok(StreamItem::Audio(bytes)) => Some(Chunk::Audio(bytes)),
            Ok(StreamItem::SayFallback(t)) => Some(Chunk::Say(t)),
            Ok(StreamItem::End) | Err(_) => {
                if let Some(h) = self.pending.take() {
                    h.abort();
                }
                None
            }
        }
    }
}

/// 播放循环的数据源。两种模式共用同一个循环，
/// 保证代际守卫、摘牌、回 idle 的逻辑只有一份。
enum Source {
    Whole(Pipeline),
    Stream(StreamSource),
}

impl Source {
    async fn next(&mut self) -> Option<Chunk> {
        match self {
            Source::Whole(p) => p.next().await,
            Source::Stream(s) => s.next().await,
        }
    }

    /// 回采比对的语料。
    ///
    /// 整段模式给固定全文；流式模式给"到目前为止已送播的全文"，
    /// 都必须跨段：`is_echo` 找的是连续子串，而哨兵采到的一段
    /// 常横跨两段边界，只给当前段时无法识别，助手会被自己打断。
    fn echo_text(&self) -> String {
        match self {
            Source::Whole(p) => p.full_text.clone(),
            Source::Stream(s) => s.stream.spoken_so_far(),
        }
    }
}

/// 队列播空之后再等这么久才 drop 输出槽。
///
/// `player.empty()` 只说明所有 source 都送进混音了，设备缓冲里还有一截；
/// 立刻 drop `DeviceSink` 会把它切掉（见 `Playback::append_audio`）。
/// 250 ms 足以覆盖 rodio 默认缓冲，代价是"播完到回 idle"延后这么久。
const TAIL_DRAIN_MS: u64 = 250;

/// 等当前队列播空。返回 false = 被打断（调用方应立即退出）。
///
/// 不 take 句柄：take 就是 drop，而这里只是"排空"，后面可能还要往同一个
/// 队列里追加。真正的 take 留到整轮收尾，且要先等 `TAIL_DRAIN_MS`。
async fn wait_drained(state: &Arc<TtsState>, generation: u64, is_filler: bool) -> bool {
    loop {
        tokio::time::sleep(Duration::from_millis(120)).await;
        if state.generation.load(Ordering::SeqCst) != generation {
            if !is_filler {
                state.body_active.store(false, Ordering::SeqCst);
            }
            return false;
        }
        let finished = {
            let mut guard = state.current.lock().expect("tts state poisoned");
            guard.as_mut().map(|p| p.is_finished()).unwrap_or(true)
        };
        if finished {
            return true;
        }
    }
}

/// 播放循环：从数据源逐块取，排进同一个输出队列，直到没有更多。
///
/// 整段模式与流式模式共用它。摘牌与回 idle 只在这里做一次：
/// 放进每块的循环里时，每块播完都会回一次 idle，形象会反复闪动。
async fn drive(
    app: AppHandle,
    state: Arc<TtsState>,
    mut source: Source,
    mut generation: u64,
    is_filler: bool,
    wait_for_filler: bool,
) {
    let mut started = false;
    let gain = gain_for_percent(state.volume_percent());

    while let Some(chunk) = source.next().await {
        // 合成期间若已被打断（用户长按说话），放弃本次播放。
        if state.generation.load(Ordering::SeqCst) != generation {
            if !is_filler {
                state.body_active.store(false, Ordering::SeqCst);
            }
            return;
        }

        if !started {
            /*
             * 衔接模式：等垫场自然说完，然后才轮到自己。
             *
             * 等完必须重取 generation：下面的 stop() 会让它 +1，
             * 仍拿旧值比对会把自己判成"已被打断"，衔接模式下正文不播。
             */
            if wait_for_filler {
                await_filler_end(&state, FILLER_WAIT_CAP_MS).await;
                /*
                 * 排队垫场醒来后先看正文在不在（见 body_active）。
                 *
                 * 正文与排队垫场挂在同一个 await 上、同时醒来。不让位的话，
                 * 两者各自 stop/replace，垫场可能顶掉刚起播的正文，
                 * 正文没有重试，这一轮正文不会播出。
                 */
                if is_filler && state.body_active.load(Ordering::SeqCst) {
                    state.filler_pending.store(false, Ordering::SeqCst);
                    return;
                }
                state.filler_pending.store(false, Ordering::SeqCst);
                generation = stop(&state);
                state.speaking_filler.store(is_filler, Ordering::SeqCst);
            }
            // 出声即让哨兵进窄通道（只听打断词）：
            // 自己的声音不应被当作用户语音转写。垫场也算，它同样从扬声器出来。
            crate::tts::ducking::set_tts_playing(true);
            if !is_filler {
                emit_state(&app, AssistantState::Speaking);
            }
            started = true;
        }

        // 回采语料每块都要更新：流式下它是"到目前为止播过的全文"，持续增长。
        let echo = source.echo_text();
        if !echo.is_empty() {
            state.set_speaking_text(Some(&echo));
        }

        match chunk {
            Chunk::Audio(bytes) => {
                /*
                 * 排进同一个队列，不新建 sink（见 `append_audio` 的说明）。
                 * 因此不必"等这一段播完再取下一段"：rodio 会连续播放，
                 * 取的节奏由合成速度限流（合成一段才有一段）。
                 */
                let mut guard = state.current.lock().expect("tts state poisoned");
                // 持锁时再验一次代际：验在锁外时，验过之后、拿到锁之前
                // 可能被 stop() 清掉，这一段会延续已经打断的那一轮。
                if state.generation.load(Ordering::SeqCst) != generation {
                    if !is_filler {
                        state.body_active.store(false, Ordering::SeqCst);
                    }
                    return;
                }
                let queued = match guard.as_mut() {
                    Some(p) => p.append_audio(bytes),
                    None => start_playback(bytes, gain).map(|p| {
                        *guard = Some(p);
                    }),
                };
                drop(guard);
                if let Err(e) = queued {
                    eprintln!("[tts] 播放启动失败: {e}");
                    break;
                }
            }
            Chunk::Say(text) => {
                /*
                 * say 是子进程，进不了 rodio 队列：先把已排的放完，再让它接上，
                 * 放完再摘牌，下一段音频需要新开一个 sink。
                 */
                if !wait_drained(&state, generation, is_filler).await {
                    return;
                }
                let proc = match say_fallback(&text, is_filler) {
                    Ok(p) => p,
                    Err(e) => {
                        eprintln!("[tts] 播放启动失败: {e}");
                        break;
                    }
                };
                /*
                 * 占位时必须把上一个停掉：drop 一个 `Child` 不会杀进程，
                 * 它会播到自然结束且没有句柄能停止它（孤儿播放进程）。
                 */
                if let Some(mut prev) = state
                    .current
                    .lock()
                    .expect("tts state poisoned")
                    .replace(proc)
                {
                    prev.halt();
                }
                if !wait_drained(&state, generation, is_filler).await {
                    return;
                }
                state.current.lock().expect("tts state poisoned").take();
            }
        }
    }

    // 所有块都排完了，等队列自己播空。
    if started && !wait_drained(&state, generation, is_filler).await {
        return;
    }

    /*
     * 队列空了，但声音还没完：设备缓冲里还有一截（见 `TAIL_DRAIN_MS`）。
     * 等它排完再摘句柄，否则结尾会被切掉。
     */
    if started && state.generation.load(Ordering::SeqCst) == generation {
        tokio::time::sleep(Duration::from_millis(TAIL_DRAIN_MS)).await;
    }
    {
        let mut guard = state.current.lock().expect("tts state poisoned");
        // 等待结束时可能已经换了轮：那时句柄是新一轮的，不能摘。
        if state.generation.load(Ordering::SeqCst) == generation {
            guard.take();
        }
    }

    /*
     * 收尾：自然播完、或某一块播放启动失败。
     *
     * 摘牌与回 idle 只在这里做一次：放进每块的循环里时，
     * 每块播完都会回一次 idle，形象会在整段播报期间反复闪动。
     */
    state.speaking_filler.store(false, Ordering::SeqCst);
    // 正文自然播完，摘牌，之后的垫场恢复正常受理。
    if !is_filler {
        state.body_active.store(false, Ordering::SeqCst);
    }
    crate::tts::ducking::set_tts_playing(false);
    if state.generation.load(Ordering::SeqCst) == generation && !is_filler && started {
        emit_state(&app, AssistantState::Idle);
        // 播报自然结束：开追问窗口。垫场结束不开：
        // 垫场不是回复，不应因此获得免唤醒词的许可。
        crate::commands::voice::on_tts_finished(&app);
    }
}

/// 取合成客户端与它的日志标签。两条入口（整段 / 流式）共用。
async fn resolve_client() -> (Option<TtsClient>, String) {
    // 端点以服务端下发的为准（后台可热切 mock ↔ 豆包 ↔ aliyun）。
    let runtime_cfg = endpoint::effective().await;
    /*
     * 客户端构造（ACR-018）。
     *
     * 三档都请求网关下发的那一个 URL，都带同一个凭证：设备 JWT。
     * 端上没有任何 vendor 密钥。未登录时 token 是空串：请求会被网关 401 → 降级 say。
     * 这里不使用占位值，避免把"没登录"表现为"合成失败"。
     */
    let client = match &runtime_cfg {
        Some(cfg) => {
            let (_base, token) = crate::settings::gateway();
            Some(TtsClient::for_runtime(cfg, token))
        }
        /*
         * 网关不可达：直接走 say。
         *
         * 不退回本地环境变量端点（ACR-017）：否则网关异常时可能接上计费引擎。
         * 降级方向始终是更省的那个：say 免费、恒可用（macOS）。
         */
        None => {
            eprintln!("[tts] 网关问不到合成端点，本次降级 say（端上没有可回落的端点）");
            None
        }
    };
    let label = match &runtime_cfg {
        Some(c) if c.billed => format!("{} **计费**", c.engine),
        Some(c) => c.engine.clone(),
        None => "本地配置".to_string(),
    };
    (client, label)
}

// ── 流式播报的三个入口 ────────────────────────
//
// 与 speak() 的关系：speak 是"这一整段，播"；下面三个是"这一轮，边来边播"。
// 一轮里 begin 一次、push 若干次、finish 一次。开关关闭时这三个都不会被调用
// （判据在 events.rs），走整段播报路径。

/// 一轮流式播报开始。
///
/// 幂等靠轮次归属，不靠"消费任务在不在跑"：后者做闸时，上一轮的任务还没退出
/// 就会让这里直接返回，而 `stream_push` 照常推入，新一轮的句子进入旧队列，
/// 两轮内容交错播出；且 `begin` 没执行，归属仍是旧的，turn_end 判定落到 `speak`，
/// 整段会重播。
///
/// 同一轮重复调 → 直接返回；换轮 → `stop()` 推代际清队列，
/// 旧的消费任务在下一次轮询看到代际变化自己退出，新的从干净的队列开始。
pub fn stream_begin(app: &AppHandle, state: &Arc<TtsState>, turn_id: &str) {
    if state.is_muted() || !enabled() {
        return;
    }
    // 同一轮的后续 delta：已经在播了，什么都不用做。
    if state.stream.owns(turn_id) {
        return;
    }
    /*
     * 衔接模式：正文要等还在说的垫场话说完。判据与 speak() 同一份。
     */
    let wait = matches!(state.preempt_mode(), FillerPreemptMode::AfterSentence)
        && state.is_speaking_filler();
    // 正文登场即挂牌（见 body_active 的说明）；生命周期各出口由 drive 收。
    state.body_active.store(true, Ordering::SeqCst);
    let generation = if !wait {
        let g = stop(state);
        state.speaking_filler.store(false, Ordering::SeqCst);
        g
    } else {
        state.generation.load(Ordering::SeqCst)
    };
    // begin 清掉上一轮的残留并认领这一轮，必须在 spawn 之前，
    // 否则紧跟着的第二条 delta 会看到旧归属，又起一个消费任务。
    state.stream.begin(generation, turn_id);

    let app = app.clone();
    let state_for_task = Arc::clone(state);
    let stream = Arc::clone(&state.stream);
    tauri::async_runtime::spawn(async move {
        let (client, label) = resolve_client().await;
        let source = Source::Stream(StreamSource::new(
            stream,
            client,
            Arc::clone(&state_for_task),
            generation,
            label,
        ));
        drive(app, state_for_task, source, generation, false, wait).await;
    });
}

/// 喂一段增量文本。成段的部分会自动进队列；不是当前这一轮的一律丢弃。
pub fn stream_push(state: &Arc<TtsState>, turn_id: &str, delta: &str) {
    state.stream.push(turn_id, delta);
}

/// 这一轮的文字到齐了。`final_text` 是落库的那份正文，用来补差额。
pub fn stream_finish(state: &Arc<TtsState>, turn_id: &str, final_text: Option<&str>) {
    state.stream.finish(turn_id, final_text);
}

fn play(app: &AppHandle, state: &Arc<TtsState>, text: &str, is_filler: bool, wait_for_filler: bool) {
    // 记号在这里剥，两条路径（豆包/say）都使用剥离后的文本。
    let text = strip_markdown_for_speech(text);
    let text = text.as_str();
    // 引擎不可用或空文本直接不播。`muted` 已由两个入口各自判过。
    if !enabled() || text.trim().is_empty() {
        // 这条提前 return 必须把排队标志清掉。留成 true 时，
        // 之后所有垫场都会被"已经有一句在等"丢弃，且没有日志。
        if wait_for_filler {
            state.filler_pending.store(false, Ordering::SeqCst);
        }
        // 正文没播成也要摘牌：否则之后所有垫场都被 Drop。
        if !is_filler {
            state.body_active.store(false, Ordering::SeqCst);
        }
        return;
    }
    /*
     * 衔接模式下不在这里 stop，以免截断垫场。
     * 在 spawn 内、首段合成完成之后再停：首段合成约 0.7 秒，
     * 多数情况下等待时间是 0。
     */
    // 代际必须取自 `stop()` 的返回值：`handle_envelope` 由每条 SSE 流各自的任务调用，
    // 若用 `stop(); load()` 两步，多条流同时进来时 A 把代际推到 5、B 推到 6，
    // 两者各自 `load()` 都拿到 6，同时通过下面的守卫并起播。
    let generation = if !wait_for_filler {
        let g = stop(state);
        state.speaking_filler.store(is_filler, Ordering::SeqCst);
        g
    } else {
        state.generation.load(Ordering::SeqCst)
    };

    let app = app.clone();
    let state = Arc::clone(state);
    let text = text.to_string();

    tauri::async_runtime::spawn(async move {
        /*
         * 分段流水线。
         *
         * 合成耗时实测为 723 ms 固定开销 + 30.3 ms 一个字，484 字整段合成需 14.4 秒
         * 才出第一声。分段后首段二十来字、约 1.6 秒起播，后面的段在前一段播放期间
         * 合成。判据与切法见 `segment.rs`。
         */
        let segments = segment::split_for_speech(&text);
        if segments.is_empty() {
            if !is_filler {
                state.body_active.store(false, Ordering::SeqCst);
            }
            return;
        }
        let (client, engine_label) = resolve_client().await;
        let source = Source::Whole(Pipeline::new(
            client,
            segments,
            Arc::clone(&state),
            generation,
            is_filler,
            engine_label,
            text,
        ));
        drive(app, state, source, generation, is_filler, wait_for_filler).await;
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn 播报音量_默认十五_越界钳到一百() {
        let state = super::TtsState::default();
        assert_eq!(state.volume_percent(), 15, "出厂默认 15：既不哑（0）也不吓人（100）");
        assert_eq!(state.set_volume_percent(30), 30);
        assert_eq!(state.volume_percent(), 30);
        assert_eq!(state.set_volume_percent(255), 100, "写坏的值不能把喇叭推过原始响度");
        assert_eq!(super::gain_for_percent(0), 0.0);
        assert_eq!(super::gain_for_percent(50), 0.5);
        assert_eq!(super::gain_for_percent(999), 1.0);
    }

    use super::{
        await_filler_end, filler_slot, should_preempt, stop, stop_if_filler, strip_markdown_for_speech,
        FillerSlot,
        FillerPreemptMode, TtsState, FILLER_WAIT_CAP_MS,
    };
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    /// 播完之后的保留窗内，迟到的回采比对仍拿得到原文。
    #[test]
    fn 刚播完的原文在保留窗内仍可取到() {
        let state = TtsState::default();
        state.set_speaking_text(Some("冬天续航下降主要有几个原因"));
        assert_eq!(
            state.recently_spoken(Duration::ZERO).as_deref(),
            Some("冬天续航下降主要有几个原因"),
            "正在播时不看窗口长短"
        );
        state.set_speaking_text(None);
        assert_eq!(
            state.recently_spoken(Duration::from_secs(8)).as_deref(),
            Some("冬天续航下降主要有几个原因"),
            "刚清掉（自然播完 / stop）之后，窗内仍能比对"
        );
        assert_eq!(
            state.recently_spoken(Duration::ZERO),
            None,
            "窗外不返回——拿旧话比对新语音挡掉的会是真指令"
        );
    }
    use std::sync::Arc;

    // ── 两种收尾方式 ────────────────────────────────────────────

    // ── 途中提醒的仲裁 ────────────────────────────────────────
    #[test]
    fn reminder_slot_途中提醒仲裁三态() {
        use super::{reminder_admit, ReminderAdmit};
        assert_eq!(reminder_admit(true, false, false, FillerPreemptMode::AfterSentence), ReminderAdmit::Refuse, "总开关关着不播");
        assert_eq!(reminder_admit(false, true, false, FillerPreemptMode::AfterSentence), ReminderAdmit::Refuse, "正文在播不掐");
        assert_eq!(
            reminder_admit(false, false, true, FillerPreemptMode::AfterSentence),
            ReminderAdmit::Play { wait_for_filler: true },
            "垫场在播、衔接模式 → 等它说完"
        );
        assert_eq!(
            reminder_admit(false, false, true, FillerPreemptMode::Immediate),
            ReminderAdmit::Play { wait_for_filler: false },
            "垫场在播、抢占模式 → 立即"
        );
        assert_eq!(reminder_admit(false, false, false, FillerPreemptMode::AfterSentence), ReminderAdmit::Play { wait_for_filler: false });
    }

    #[test]
    fn reminder_slot_原文默认为空_与回采原文分开() {
        let state = TtsState::default();
        assert_eq!(state.last_reminder_text(), None);
        state.set_speaking_text(Some("暖暖的对话回复"));
        assert_eq!(state.last_reminder_text(), None, "对话回复不进提醒原文");
    }

    /// 默认必须是衔接。这是产品决策，用断言固定：
    /// 默认值被意外改变时，表现为垫场话被截断，难以归因。
    #[test]
    fn 默认收尾方式是衔接() {
        assert_eq!(TtsState::default().preempt_mode(), FillerPreemptMode::AfterSentence);
        assert_eq!(FillerPreemptMode::default(), FillerPreemptMode::AfterSentence);
    }

    /// 立即停止要两个条件同时成立：用户偏好且内容属性。
    #[test]
    fn 抢占判定是两个独立开关的与() {
        assert!(should_preempt(FillerPreemptMode::Immediate, true));
        // 用户选了抢占，但这句话本身不可打断（告警类垫场）
        assert!(!should_preempt(FillerPreemptMode::Immediate, false));
        // 内容可打断，但用户选了衔接
        assert!(!should_preempt(FillerPreemptMode::AfterSentence, true));
        assert!(!should_preempt(FillerPreemptMode::AfterSentence, false));
    }

    #[test]
    fn 收尾方式可切换且跨重启保持() {
        let dir = std::env::temp_dir().join(format!("cabinhug-preempt-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("filler-preempt-pref");
        let _ = std::fs::remove_file(&path);

        let a = TtsState::default();
        a.load_preempt_prefs(path.clone());
        assert_eq!(a.preempt_mode(), FillerPreemptMode::AfterSentence, "文件不存在 ⇒ 默认衔接");

        a.set_preempt_mode(FillerPreemptMode::Immediate);
        assert_eq!(a.preempt_mode(), FillerPreemptMode::Immediate);

        // 换一个实例重新载入——模拟重启
        let b = TtsState::default();
        b.load_preempt_prefs(path.clone());
        assert_eq!(b.preempt_mode(), FillerPreemptMode::Immediate);

        let _ = std::fs::remove_file(&path);
    }

    /// 等待有上限。没有它，垫场的播放进程卡住时正文永远播不出来。
    #[test]
    fn 等垫场结束有上限() {
        let state = Arc::new(TtsState::default());
        state.speaking_filler.store(true, Ordering::SeqCst); // 永远不结束

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("runtime");
        let started = std::time::Instant::now();
        let ended_naturally = rt.block_on(await_filler_end(&state, 240));
        assert!(!ended_naturally, "撞上限应返回 false");
        assert!(started.elapsed().as_millis() < 2_000, "不该一直等下去");
        /*
         * 上限必须够念完最长的那一句，否则"等垫场讲完再接管"每次都撞上限，
         * 衔接模式不生效。
         *
         * 服务端 `sidecar/l1.ts` 的 `FIRST_MAX_CHARS` 是 60 字，
         * `budget.ts` 的 `speechMsPerChar` 是 200ms —— 12 秒是那两个数乘出来的。
         * 任何一边调大，这条断言会失败。
         */
        assert!(
            FILLER_WAIT_CAP_MS >= 60 * 200,
            "上限念不完最长的第一句（60 字 × 200ms/字），衔接模式会每次都被截断"
        );
    }

    #[test]
    fn 垫场自己结束时立刻返回() {
        let state = Arc::new(TtsState::default());
        // speaking_filler 为 false ⇒ 没有要等的
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("runtime");
        assert!(rt.block_on(await_filler_end(&state, FILLER_WAIT_CAP_MS)));
    }

    /// 衔接路径会在等待之后自己调 `stop()`，代际因此 +1。
    /// 仍拿等待之前的代际比对会把自己判成"已被打断"，衔接模式下正文不播。
    #[test]
    fn 衔接路径的代际必须重取() {
        let state = TtsState::default();
        let before = state.generation.load(Ordering::SeqCst);
        stop(&state);
        let after = state.generation.load(Ordering::SeqCst);
        assert_ne!(before, after, "stop 必须让代际前进，否则守卫失效");
    }

    // ── 抢占本身 ───────────────────────────────────────────────

    /// 抢占只针对垫场话（F-45-07 / AC-45-3）。
    #[test]
    fn 抢占只停垫场_不误杀正文() {
        let state = TtsState::default();

        // 没在播任何东西 → 不该报告"停了"
        assert!(!stop_if_filler(&state), "没在播垫场时不该返回 true");

        // 模拟正在播垫场话
        state.speaking_filler.store(true, Ordering::SeqCst);
        let before = state.generation.load(Ordering::SeqCst);
        assert!(stop_if_filler(&state), "正在播垫场 → 必须停");
        assert_eq!(
            state.generation.load(Ordering::SeqCst),
            before + 1,
            "代际必须 +1，否则旧播放的监视线程还会发结束状态"
        );
        assert!(!state.is_speaking_filler());

        // 模拟正在播正文（speaking_filler 为 false）
        state.speaking_filler.store(false, Ordering::SeqCst);
        let g = state.generation.load(Ordering::SeqCst);
        assert!(!stop_if_filler(&state), "正在播正文时收到 delta 不该停");
        assert_eq!(state.generation.load(Ordering::SeqCst), g, "正文不该被打断");
    }

    /// 正文在场时垫场必须让路，三种入场状态一致（防止 replace 竞态）。
    /// 判定过松时表现为正文不播、垫场持续播放。
    #[test]
    fn 正文在场时垫场一律丢弃() {
        assert_eq!(filler_slot(false, false, true), FillerSlot::Drop);
        assert_eq!(filler_slot(true, false, true), FillerSlot::Drop);
        assert_eq!(filler_slot(true, true, true), FillerSlot::Drop);
    }

    /// `stop` 同时清位：用户长按说话打断时，垫场标志不能留在置位态，
    /// 否则下一次 delta 会误判成"正在播垫场"而多停一次。
    ///
    /// 新垫场不能无条件停掉上一句：服务端间隔 500ms、`speakingUntil` 按字数估算，
    /// 估算偏短会截断正在播的垫场；只有端上知道实际播放状态。
    #[test]
    fn 垫场不掐垫场_三种处置逐条可断言() {
        // 没人在播 → 直接播
        assert_eq!(filler_slot(false, false, false), FillerSlot::Play);
        // 正在播上一句垫场 → 等它播完，而不是停掉它
        assert_eq!(filler_slot(true, false, false), FillerSlot::Queue);
        // 已经有一句在等 → 丢掉。多句排队时前一句一结束几个协程会一起争抢，
        // 互相中断
        assert_eq!(filler_slot(true, true, false), FillerSlot::Drop);
        // pending 为真但没在播（上一句刚自然结束的那个瞬间）→ 照播
        assert_eq!(filler_slot(false, true, false), FillerSlot::Play);
    }

    #[test]
    fn 垫场排队与正文抢占是两套判据_互不影响() {
        // 正文的抢占仍由 should_preempt 决定，与 filler_slot 无关：
        // 一个管"垫场之间怎么让"，一个管"正文来了停不停垫场"。
        assert_eq!(filler_slot(true, false, false), FillerSlot::Queue);
        assert!(should_preempt(FillerPreemptMode::Immediate, true));
        assert!(!should_preempt(FillerPreemptMode::AfterSentence, true));
    }

    /// 打断把 `body_active` 也清掉。
    ///
    /// `stop()` 不清它，因此需要本函数。留成 true 时
    /// `filler_slot()` 第一条判据永远命中 `Drop`：打断一次之后这个进程里
    /// 不再播出任何垫场。
    #[test]
    fn 打断复位垫场槽位_含stop清不掉的body_active() {
        let state = TtsState::default();
        state.body_active.store(true, Ordering::SeqCst);
        state.speaking_filler.store(true, Ordering::SeqCst);
        state.filler_pending.store(true, Ordering::SeqCst);

        // 先验证 stop() 不清 body_active，否则本函数是多余的
        stop(&state);
        assert!(
            state.body_active.load(Ordering::SeqCst),
            "stop() 清不掉 body_active；哪天它清了，本测试与 reset_filler_slots 一起删"
        );
        assert_eq!(filler_slot(false, false, true), FillerSlot::Drop, "此刻垫场全被丢");

        state.reset_filler_slots();
        assert!(!state.body_active.load(Ordering::SeqCst));
        assert!(!state.is_speaking_filler());
        assert!(!state.is_filler_pending());
        assert_eq!(filler_slot(false, false, false), FillerSlot::Play, "打断之后垫场回得来");
    }

    /// 留成 true 时之后所有垫场都被丢弃，且没有日志。
    #[test]
    fn stop_把排队标志一起清掉() {
        let state = Arc::new(TtsState::default());
        state.speaking_filler.store(true, Ordering::SeqCst);
        state.filler_pending.store(true, Ordering::SeqCst);
        stop(&state);
        assert!(!state.is_speaking_filler());
        assert!(
            !state.is_filler_pending(),
            "用户长按打断后留下一个永远为真的 pending，之后所有垫场都会被静默丢掉"
        );
    }

    /// `enabled()` 只回答平台能力，不受任何环境变量影响（ACR-017、ACR-018）。
    /// 这条断言防止重新加入 env 判据，否则后台引擎开关会被环境变量静默覆盖。
    #[test]
    fn enabled_不受任何环境变量影响() {
        std::env::set_var("CARLIFE_TTS", "off");
        std::env::remove_var("BYTEDANCE_TTS_API_KEY");
        let on = crate::tts::enabled();
        std::env::remove_var("CARLIFE_TTS");
        assert!(on, "引擎层的可用性不该由端上的任何环境变量决定");
    }

    #[test]
    fn stop_清掉垫场标志() {
        let state = TtsState::default();
        state.speaking_filler.store(true, Ordering::SeqCst);
        stop(&state);
        assert!(!state.is_speaking_filler());
    }

    /// 两个开关分开：用户可能要正文播报但不要垫场。
    #[test]
    fn 垫场开关与播报开关互不影响() {
        let state = TtsState::default();
        assert!(!state.is_muted());
        assert!(!state.is_filler_muted());

        state.set_filler_muted(true);
        assert!(state.is_filler_muted());
        assert!(!state.is_muted(), "关垫场不该顺带关掉正文播报");

        state.set_muted(true);
        state.set_filler_muted(false);
        assert!(state.is_muted(), "开垫场不该顺带打开正文播报");
    }

    #[test]
    fn 剥掉加粗与行内记号() {
        assert_eq!(
            strip_markdown_for_speech("换成**里白酒店**，评分`4.9`，*很方便*"),
            "换成里白酒店，评分4.9，很方便"
        );
    }

    #[test]
    fn 剥掉行首列表与标题_保留内容() {
        assert_eq!(
            strip_markdown_for_speech("# 第1天\n- 越秀公园\n> 提示"),
            "第1天\n越秀公园\n提示"
        );
    }

    #[test]
    fn 链接只留文字() {
        assert_eq!(strip_markdown_for_speech("详见[官网](https://x.cn)哦"), "详见官网哦");
    }

    #[test]
    fn 纯文本原样通过() {
        assert_eq!(strip_markdown_for_speech("你好，一路平安"), "你好，一路平安");
    }
}
