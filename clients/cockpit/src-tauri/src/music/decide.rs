//! 「服务端说该放什么」→「端上下一步做什么」的纯函数。
//!
//! # 独立模块、不碰声卡
//!
//! 换歌、暂停、被抢、掉线、车辆被重建，每一种的收尾都不一样，出错时不报错，
//! 只表现为歌不对或没声。写成纯函数后这些分支可以被用例逐条覆盖。
//!
//! # 端是从动方
//!
//! 放哪首、放不放、repeat/shuffle 全在服务端状态里。端只做三件事：跟随、拉字节、
//! 如实上报。端上不自行选曲（例如"队列空了就随便挑一首"）。

use cabinhug_net::{PlayerStatus, PlayerView};

/// 这一拍该做的一件事。轮询 1 秒一次，一拍只做一件，状态更易对齐。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// 什么都不用做。
    Idle,
    /// 认领出声位（首次、被抢之后、或车机侧车辆被重建之后）。
    Claim,
    /// 拉这首的字节并起播。
    Load(String),
    Resume,
    Pause,
    Stop,
    /// 只改音量，不重新起播，调音量不能让歌从头开始。
    SetVolume(u32),
    /// 出声位不是我的了：停下来，不与另一个端同时播放。
    Yield,
}

/// 端上此刻的实况。字段只需足以回答"和服务端差在哪"。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LocalState {
    /// 这台端的出声位标识。
    pub sink_id: String,
    /// 已经认领过（且还没被告知失去）。
    pub claimed: bool,
    /// 正在放（或暂停在）哪首。
    pub track_id: Option<String>,
    pub status: PlayerStatus,
    /// 已经下发给播放器的音量（0..=100）。
    pub volume: u32,
}

/// 出声位是不是另一个还活着的端在拿着。
///
/// 与"不是我的"不是一回事：`kind` 是 `host` / `none` 时出声位是空的，该去认领；
/// 只有 `client` 且 id 不是我，才是别人正拿着。
fn held_by_other(local: &LocalState, remote: &PlayerView) -> bool {
    remote
        .sink
        .as_ref()
        .is_some_and(|s| s.kind == "client" && s.sink_id.as_deref() != Some(local.sink_id.as_str()))
}

/// 下一步做什么。
///
/// 判定顺序本身就是语义，不能调换：
///
/// 1. 没认领过就先认领：认领之前收到的状态都不驱动播放。
///    但别人正拿着的时候不去抢，见下节。
/// 2. 车辆被重建 ⇒ 重新认领：队列跟着车机侧车辆走，重建即队列失效。
/// 3. 出声位不是我的 ⇒ 让出。放在换歌之前：被抢之后再 Load 会导致两个端同时播放。
///    服务端没回 `sink` 段（旧版本）时也走这条：宁可不放，也不要两台机器同时放。
/// 4. 服务端停了 ⇒ 停。
/// 5. 换歌 ⇒ Load。它比暂停/继续优先：换歌本来就包含"从头开始放"。
/// 6. 暂停 / 继续。
/// 7. 音量。放在最后：前面几条都不成立时才轮到它，所以调音量不会打断播放。
///
/// # 让出之后不立即抢回
///
/// `Yield` 后 `claimed` 为 false；若下一拍按第 1 条立即认领，两个端会每秒互夺一次
/// 出声位，`audible` 始终为 false（活锁）。
///
/// 服务端的 `claim` 与续租区分（`media/player.ts` 的 `SinkBeat.claim`）只防止
/// "续租被当成抢占"，不防止端主动抢回；谁该退让由端决定。因此别人还活着时
/// 一直 `Idle` 等待，等对方退出（`alive:false`）或租约过期、`kind` 变回
/// `host`/`none` 时再认领。
pub fn decide(local: &LocalState, remote: &PlayerView) -> Action {
    if !local.claimed || remote.rebuilt {
        return if held_by_other(local, remote) { Action::Idle } else { Action::Claim };
    }
    if !remote.sink_is(&local.sink_id) {
        return Action::Yield;
    }

    let remote_track = remote.now_playing.as_ref().map(|t| t.track_id.as_str());
    if remote.status == PlayerStatus::Stopped || remote_track.is_none() {
        return if local.status == PlayerStatus::Stopped { Action::Idle } else { Action::Stop };
    }
    let remote_track = remote_track.expect("上一句已排除 None");

    if local.track_id.as_deref() != Some(remote_track) {
        return Action::Load(remote_track.to_string());
    }
    match (remote.status, local.status) {
        (PlayerStatus::Paused, PlayerStatus::Playing) => return Action::Pause,
        (PlayerStatus::Playing, PlayerStatus::Paused) => return Action::Resume,
        // 本地是 stopped 而服务端在放同一首（如字节拉取失败）：重来一次。
        (PlayerStatus::Playing, PlayerStatus::Stopped) => return Action::Load(remote_track.to_string()),
        _ => {}
    }
    if remote.output_volume != local.volume {
        return Action::SetVolume(remote.output_volume);
    }
    Action::Idle
}

#[cfg(test)]
mod tests {
    use super::*;
    use cabinhug_net::{PlayerTrack, SinkView};

    fn remote(status: PlayerStatus, track: Option<&str>, sink_id: Option<&str>, vol: u32) -> PlayerView {
        PlayerView {
            status,
            audible: status == PlayerStatus::Playing,
            now_playing: track.map(|t| PlayerTrack { track_id: t.into(), ..Default::default() }),
            output_volume: vol,
            sink: sink_id.map(|s| SinkView {
                kind: "client".into(),
                sink_id: Some(s.into()),
                note: String::new(),
            }),
            rebuilt: false,
        }
    }

    fn local(claimed: bool, track: Option<&str>, status: PlayerStatus, vol: u32) -> LocalState {
        LocalState {
            sink_id: "me".into(),
            claimed,
            track_id: track.map(str::to_string),
            status,
            volume: vol,
        }
    }

    #[test]
    fn 没认领过先认领() {
        let l = local(false, None, PlayerStatus::Stopped, 20);
        assert_eq!(decide(&l, &remote(PlayerStatus::Playing, Some("t1"), Some("me"), 20)), Action::Claim);
        // 出声位空着（服务端后端或没人）也该认领。
        assert_eq!(decide(&l, &remote(PlayerStatus::Playing, Some("t1"), None, 20)), Action::Claim);
    }

    /// 别人拿着的时候不去抢。
    ///
    /// 防止活锁：两个车机端各跑一份这个循环，让出之后立刻抢回，
    /// 出声位每秒在两个 id 之间跳一次，`audible` 始终为 false。
    #[test]
    fn 别人正拿着时不抢_等它让出来再说() {
        let fresh = local(false, None, PlayerStatus::Stopped, 20);
        let held = remote(PlayerStatus::Playing, Some("t1"), Some("别的端"), 20);
        assert_eq!(decide(&fresh, &held), Action::Idle, "没认领过也不能去抢别人手里的");

        // 让出之后（claimed 被置回 false）同样不抢回，否则形成活锁。
        let after_yield = local(false, None, PlayerStatus::Stopped, 20);
        assert_eq!(decide(&after_yield, &held), Action::Idle);

        // 对方退出 / 租约过期 → kind 变回 host 或 none，这时才轮到我。
        let freed = remote(PlayerStatus::Playing, Some("t1"), None, 20);
        assert_eq!(decide(&after_yield, &freed), Action::Claim);
    }

    /// 车辆被重建也一样：队列没了要重新认领，但别人拿着就先等着。
    #[test]
    fn 重建时别人拿着也不抢() {
        let l = local(true, Some("t1"), PlayerStatus::Playing, 20);
        let mut r = remote(PlayerStatus::Playing, Some("t1"), Some("别的端"), 20);
        r.rebuilt = true;
        assert_eq!(decide(&l, &r), Action::Idle);
    }

    #[test]
    fn 车辆被重建后重新认领_队列跟着车走已经没了() {
        let l = local(true, Some("t1"), PlayerStatus::Playing, 20);
        let mut r = remote(PlayerStatus::Playing, Some("t1"), Some("me"), 20);
        r.rebuilt = true;
        assert_eq!(decide(&l, &r), Action::Claim);
    }

    #[test]
    fn 空闲时服务端在放就拉起来() {
        let l = local(true, None, PlayerStatus::Stopped, 20);
        assert_eq!(
            decide(&l, &remote(PlayerStatus::Playing, Some("t1"), Some("me"), 20)),
            Action::Load("t1".into())
        );
    }

    #[test]
    fn 换歌() {
        let l = local(true, Some("t1"), PlayerStatus::Playing, 20);
        assert_eq!(
            decide(&l, &remote(PlayerStatus::Playing, Some("t2"), Some("me"), 20)),
            Action::Load("t2".into())
        );
    }

    #[test]
    fn 暂停与继续() {
        let playing = local(true, Some("t1"), PlayerStatus::Playing, 20);
        assert_eq!(decide(&playing, &remote(PlayerStatus::Paused, Some("t1"), Some("me"), 20)), Action::Pause);
        let paused = local(true, Some("t1"), PlayerStatus::Paused, 20);
        assert_eq!(decide(&paused, &remote(PlayerStatus::Playing, Some("t1"), Some("me"), 20)), Action::Resume);
    }

    #[test]
    fn 服务端停了就停() {
        let l = local(true, Some("t1"), PlayerStatus::Playing, 20);
        assert_eq!(decide(&l, &remote(PlayerStatus::Stopped, Some("t1"), Some("me"), 20)), Action::Stop);
        assert_eq!(decide(&l, &remote(PlayerStatus::Playing, None, Some("me"), 20)), Action::Stop);
    }

    #[test]
    fn 出声位不是我的就让出_放在换歌之前判_否则两个端一起放() {
        let l = local(true, Some("t1"), PlayerStatus::Playing, 20);
        assert_eq!(decide(&l, &remote(PlayerStatus::Playing, Some("t2"), Some("别人"), 20)), Action::Yield);
    }

    #[test]
    fn 服务端没回_sink_段时也让出_宁可不放也不要两台一起放() {
        let l = local(true, Some("t1"), PlayerStatus::Playing, 20);
        assert_eq!(decide(&l, &remote(PlayerStatus::Playing, Some("t1"), None, 20)), Action::Yield);
    }

    #[test]
    fn 只改音量不重新起播() {
        let l = local(true, Some("t1"), PlayerStatus::Playing, 60);
        assert_eq!(
            decide(&l, &remote(PlayerStatus::Playing, Some("t1"), Some("me"), 20)),
            Action::SetVolume(20)
        );
    }

    #[test]
    fn 什么都没变就什么都不做_否则每秒重放一次() {
        let l = local(true, Some("t1"), PlayerStatus::Playing, 20);
        assert_eq!(decide(&l, &remote(PlayerStatus::Playing, Some("t1"), Some("me"), 20)), Action::Idle);
        let stopped = local(true, None, PlayerStatus::Stopped, 20);
        assert_eq!(decide(&stopped, &remote(PlayerStatus::Stopped, None, Some("me"), 20)), Action::Idle);
    }

    #[test]
    fn 本地掉了但服务端还在放同一首_重来一次而不是干等() {
        let l = local(true, Some("t1"), PlayerStatus::Stopped, 20);
        assert_eq!(
            decide(&l, &remote(PlayerStatus::Playing, Some("t1"), Some("me"), 20)),
            Action::Load("t1".into())
        );
    }
}
