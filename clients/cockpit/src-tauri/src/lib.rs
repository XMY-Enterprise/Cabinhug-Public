// cockpit src-tauri — 车机端装配（HUD+助手 语音优先 / 大字号）
//
// # 装配放在 lib.rs（ACR-004）
//
// Tauri 的 iOS/Android 目标不经过 main：移动端入口是本文件的 `run()`
// （`#[cfg_attr(mobile, tauri::mobile_entry_point)]` 生成 FFI 符号，由
// gen/apple 的 Swift 壳调起）。桌面端的 main.rs 只有三行，同样调用它，
// 两个平台共用同一份装配。
//
// push-to-talk 桥接命令在 commands/media；下行流 fan-out 在 events，
// 缓存/历史命令在 commands/stream。
// capability 白名单见 capabilities/default.json：不暴露任何车辆控制能力（§8.5）。

mod boarding;
mod commands;
mod dev_env;
mod settings;
mod events;
mod interrupt;
mod location;
mod music;
mod tts;
mod vehicle_signal;
mod voice;

use std::sync::Arc;

use cabinhug_core::cache::MessageCache;
use cabinhug_core::location::LocationStore;
use cabinhug_telemetry::TelemetryBuffer;
use events::StreamState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    dev_env::load_repo_env();

    // 崩溃捕获要先于一切装配：setup 里的 SQLite 打开、TTS 初始化都可能 panic，
    // 装得晚会漏掉这些崩溃（§2.2 C7）。
    let telemetry = cabinhug_telemetry::install_panic_hook(std::sync::Arc::new(
        TelemetryBuffer::with_default_capacity(),
    ));

    tauri::Builder::default()
        .manage(commands::vision::VisionState::default())
        .manage(commands::media::VoiceState::default())
        // 打断计数：用于判断打断是否生效。
        .manage(Arc::new(interrupt::InterruptCounters::default()))
        .manage(commands::voice::SentinelState::default())
        .manage(Arc::clone(&telemetry))
        .setup(|app| {
            // 端上消息缓存（§2.2 C5）：app 数据目录，非权威源可安全清空。
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let cache = MessageCache::open(&dir.join("messages.sqlite"))?;
            app.manage(Arc::new(StreamState::new(cache)));
            // 网关连接设置（ACR-004）：iOS 没有环境变量，地址从这里来。
            // 必须先于一切网关调用初始化，否则首批请求会发往默认 localhost。
            settings::init(dir.join("gateway-settings.json"));
            // 上车声明的持久化：声明过身份后重启直接沿用，
            // 换人走设置页「更换使用人」。必须先于 WebView 的首次 boarding_declared。
            boarding::init(dir.join("boarding.json"));
            // 设备注册实例 id：与网关设置同一时机，它必须先于任何
            // 需要"我是哪台设备"的调用存在，而那也包括绑定流程本身。
            cabinhug_core::device::init(dir.clone());
            /*
             * 凭证保鲜。
             *
             * access token 只有 15 分钟有效期，而 `GatewayClient` 的带鉴权请求点中
             * 只有上车声明两处接了 401 重试。保鲜循环让 token 不过期：冷启动先刷一次
             * （车机隔夜后首个请求的 token 已过期），此后每 10 分钟一次。
             *
             * 放在 `settings::init` 之后：它要读网关地址。
             * 没登录过时 `keep_fresh` 返回 false 且不做任何事，不是错误。
             */
            tauri::async_runtime::spawn(async {
                /*
                 * 失败快速退避重试。
                 *
                 * 端可能先于网关可达（开发机先起端后起服务、车上点火后 Wi-Fi 未连上），
                 * 首次保鲜会得到 `Connection refused`；若等满 10 分钟，期间 access
                 * 过期会导致全部请求 401。
                 *
                 * 成功回到 10 分钟（< 15 分钟 TTL，留一次失败余量）；
                 * 失败从 15 秒起翻倍，封顶在常规间隔。
                 */
                const OK_GAP: u64 = 600;
                let mut gap = OK_GAP;
                loop {
                    let (base_url, _) = settings::gateway();
                    gap = if cabinhug_net::keep_fresh(&base_url).await {
                        OK_GAP
                    } else {
                        // 没登录过时也走这条：只是每 15 秒读一次空槽位，不发请求。
                        (if gap >= OK_GAP { 15 } else { gap * 2 }).min(OK_GAP)
                    };
                    tokio::time::sleep(std::time::Duration::from_secs(gap)).await;
                }
            });
            // 定位授权与地图视图（与网关设置分两个文件：那份是"连哪台服务器"、
            // 必须先于一切网关通信；这份只影响地图与定位，损坏时不阻塞启动）。
            app.manage(Arc::new(LocationStore::open(dir.join("location.json"))));
            // 本地 TTS 播报：播放起止驱动 speaking/idle
            //
            // 启动时打印引擎横幅：引擎选择发生在每次播放内部，横幅让启动日志
            // 能看出这台端使用的是免费还是计费引擎。
            // 实际端点由网关下发（TTS_ENGINE，后台可热切），第一次合成时
            // 才确定，那时会打「[tts] 合成端点更新：…」。这里只说明兜底方向，
            // 措辞不写成断言，因为后台可能已切换引擎。
            // 兜底恒为 say（免费，ACR-017）：不回落本地环境变量里的端点，
            // 网关异常时不会接上计费引擎。
            eprintln!("[tts] 引擎：网关下发（TTS_ENGINE，后台热切）；问不到则降级 say（免费）");
            // 旧端侧逃生阀已退休（ACR-017）：发现即告警，不生效。
            // 出不出声用车机设置页的播报开关；选引擎用后台 TTS_ENGINE。
            if let Ok(v) = std::env::var("CARLIFE_TTS") {
                eprintln!(
                    "[config] ⚠️ CARLIFE_TTS={v} 已废弃且未生效（ACR-017）——\
                     关声音用设置页「播报开关」；选引擎用后台 TTS_ENGINE；请从 .env 删除该行"
                );
            }
            /*
             * 车内音乐。
             *
             * 起在 `settings::init` / `device::init` 之后：它每一拍都要网关地址与
             * 设备 id。任务本身自带守卫：没绑定车辆、或一键静音关着时，
             * 它只是空转，不发请求。
             *
             * 横幅说明这条通路是否启动。"车主听不到歌"有四类原因
             * （端没起、端没认领、端报错、服务端在调试形态），横幅是排查起点。
             */
            eprintln!("[music] 车内音乐跟随已启动：每秒一拍，出声位在本机（服务端只留状态机）");
            music::start();

            let tts_state = Arc::new(tts::TtsState::default());
            // 播报开关跨重启保持（F-02-12）
            if let Some(p) = commands::prefs::prefs_path(app.handle()) {
                tts_state.load_prefs(p);
            }
            // 播报音量跨重启保持；文件缺省 = 100，不是 0。
            if let Some(p) = commands::prefs::volume_prefs_path(app.handle()) {
                tts_state.load_volume_prefs(p);
            }
            // 播报期语音打断的偏好：跨重启保持，默认开。
            commands::prefs::load_barge_in_pref(app.handle());
            /*
             * 哨兵监听总开关：跨重启保持，默认关。
             *
             * 必须在 `sentinel_start` 之前载入：那条命令由前端 bootstrap 调，
             * 而循环的 `switch_on` 初值就是这个静态量。载入晚了，
             * 设置为关时开机头几秒麦克风仍会打开。
             */
            commands::prefs::load_sentinel_pref(app.handle());
            if let Some(p) = commands::prefs::filler_prefs_path(app.handle()) {
                tts_state.load_filler_prefs(p);
            }
            if let Some(p) = commands::prefs::filler_preempt_prefs_path(app.handle()) {
                tts_state.load_preempt_prefs(p);
            }
            app.manage(tts_state);
            // 途中提醒的开关与密度档：跨重启保持，缺省 开 / 适中。
            commands::reminders::load_en_route_prefs(app.handle());
            /*
             * 预热合成配置。
             *
             * 不预热时，本次启动的第一轮对话拿不到"边收边播"开关：
             * `stream_speech_cached()` 读的是缓存，而缓存要等第一次播报时
             * `effective()` 请求网关才填上。
             *
             * 失败不影响启动：取不到就按整段播报，与不预热时一致。
             */
            tauri::async_runtime::spawn(async {
                let _ = tts::endpoint::effective().await;
            });
            // ⑥用车流水的采集开关与待发队列。
            let trip_state = Arc::new(commands::trips::TripState::default());
            if let Some(p) = commands::trips::collect_pref_path(app.handle()) {
                trip_state.load_prefs(p);
            }
            app.manage(trip_state);
            Ok(())
        })
        // opener：WebView 里 target=_blank 在各平台不生效，统一经 opener 打开。
        // iOS 走 UIApplication openURL（能唤起 iosamap:// 的高德 App），macOS 开默认浏览器。
        // 能开哪些 URL 由 capabilities/default.json 的 opener 权限白名单限定。
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            // 端侧指示灯检测（ACR-044）：输入字节、输出检测框，不出端。
            commands::vision::vision_detect,
            commands::attachments::fetch_attachment,
            commands::attachments::upload_attachment,
            // 车内音乐的现场逃生阀：没有界面入口，见该命令的文档注释。
            music::set_music_enabled,
            // 只读：出发动画的音景据此决定要不要降级，它不压音乐。
            music::music_is_audible,
            // 鉴权：返回值里没有 token。
            commands::auth::auth_login,
            commands::auth::auth_status,
            commands::auth::auth_logout,
            // 设备与车机绑定。
            commands::device::device_id,
            commands::device::device_role,
            commands::device::switch_device_role,
            commands::device::confirm_pairing,
            // 上车声明。
            commands::device::bound_vin,
            commands::device::resync_bound_vin,
            commands::device::boarding_declared,
            commands::device::boarding_reset,
            commands::device::vehicle_members,
            commands::device::create_session_as,
            // 端上身份：降级播报与"本机存不住登录状态"提示。
            commands::device::announce_downgrade,
            commands::device::credential_storage_degraded,
            commands::media::create_session,
            // 漏注册时端上报 command not found，该错误不会出现在服务端日志里
            commands::media::close_session,
            commands::media::start_push_to_talk,
            commands::media::stop_push_to_talk,
            commands::media::mic_permission_status,
            commands::media::send_text_message,
            commands::voice::sentinel_start,
            commands::voice::sentinel_stop,
            commands::voice::sentinel_set_switch,
            commands::voice::sentinel_bind_session,
            commands::voice::sentinel_set_windows,
            commands::prefs::get_broadcast_enabled,
            commands::prefs::set_broadcast_enabled,
            // 播报音量（设置页滑块）：读 / 写 / 试听。
            commands::prefs::get_broadcast_volume,
            commands::prefs::set_broadcast_volume,
            commands::prefs::preview_broadcast_volume,
            commands::prefs::get_filler_enabled,
            commands::prefs::set_filler_enabled,
            commands::prefs::get_barge_in_enabled,
            commands::prefs::set_barge_in_enabled,
            // 哨兵监听（语音唤醒）总开关：设置页与 HUD 麦克风图标共用。
            commands::prefs::get_sentinel_enabled,
            commands::prefs::set_sentinel_enabled,
            commands::prefs::get_filler_preempt_mode,
            commands::prefs::set_filler_preempt_mode,
            // 途中提醒：端上直接说一句、取最近一句提醒原文；开关、密度档、端侧日志。
            commands::reminders::speak_reminder,
            commands::reminders::last_reminder_text,
            commands::reminders::get_en_route_reminders,
            commands::reminders::set_en_route_reminders,
            commands::reminders::get_en_route_density,
            commands::reminders::set_en_route_density,
            commands::reminders::log_en_route_event,
            commands::reminders::export_en_route_log,
            commands::stream::start_session_stream,
            commands::stream::start_user_events_stream,
            commands::stream::start_mock_stream,
            commands::stream::refresh_history,
            commands::stream::list_sessions,
            commands::stream::fetch_trip_plan,
            commands::stream::get_guide_brief,
            commands::stream::plan_departure_nav,
            commands::stream::get_guide_jobs,
            commands::stream::trigger_guide_job,
            commands::stream::ack_trip_review,
            commands::stream::fetch_vehicles,
            commands::stream::fetch_cabin,
            commands::stream::fetch_vehicle_energy,
            commands::stream::bind_cabin,
            commands::stream::fetch_vehicle_catalog,
            commands::stream::fetch_vehicle_usage,
            commands::stream::fetch_members,
            commands::stream::fetch_member_usage,
            commands::stream::fetch_preferences,
            commands::stream::delete_preference,
            commands::stream::create_vehicle,
            commands::stream::set_default_vehicle,
            commands::stream::append_maintenance,
            commands::stream::backfill_vin,
            commands::stream::fetch_vehicle_changes,
            commands::stream::save_member,
            commands::stream::delete_member,
            commands::stream::resume_interrupt,
            // 打断暖暖：单击手势的入口；长按与语音在 Rust 侧直调。
            interrupt::interrupt_assistant_cmd,
            interrupt::interrupt_stats,
            commands::stream::read_cached_messages,
            commands::stream::clear_message_cache,
            settings::get_gateway_settings,
            location::get_location_state,
            location::set_location_enabled,
            location::set_location_precision,
            location::record_location_fix,
            location::get_map_viewport,
            location::set_map_viewport,
            settings::set_gateway_settings,
            commands::trips::get_trip_collect_enabled,
            commands::trips::set_trip_collect_enabled,
            commands::trips::record_trip,
            commands::trips::flush_trips
        ])
        .run(tauri::generate_context!())
        .expect("error while running cockpit app");
}
