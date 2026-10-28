//! 下行链端到端冒烟（无 UI）。
//!
//! 前置：gateway(18787) + runtime(18788, fake LLM) 已启动。
//! 链路：建会话 → 启动 SSE 消费（SseClient）→ POST 文本消息 →
//! 事件经 `fanout::apply` 双写进内存 SQLite → 断言状态序列与缓存内容。
//! 与 cockpit `events.rs` 走的是同一套 cabinhug-core/net 代码。
//!
//! 运行：`cargo run -p cabinhug-net --example downlink_smoke`

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use cabinhug_core::cache::MessageCache;
use cabinhug_core::fanout::{apply, BridgeAction, TurnAccumulator};
use cabinhug_net::{GatewayClient, SseClient, SseSignal};

#[tokio::main]
async fn main() {
    let base = cabinhug_core::env::env_var("CABINHUG_GATEWAY_URL")
        .unwrap_or_else(|_| "http://localhost:18787".into());
    let token = "demo-token";

    let gateway = GatewayClient::new(&base, token);
    let session_id = gateway.create_session().await.expect("建会话失败").session_id;
    println!("[smoke] session = {session_id}");

    let cache = Arc::new(MessageCache::open_in_memory().expect("cache"));
    let stop = Arc::new(AtomicBool::new(false));
    let seen_states: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

    let sse = SseClient::new(&base, token);
    let sse_cache = Arc::clone(&cache);
    let sse_stop = Arc::clone(&stop);
    let sse_states = Arc::clone(&seen_states);
    let sid = session_id.clone();
    let consumer = tokio::spawn(async move {
        let mut acc = TurnAccumulator::default();
        sse.run(&sid, &sse_stop, |signal| {
            if let SseSignal::Envelope(env) = signal {
                let (actions, errors) = apply(&env, &sse_cache, &mut acc);
                assert!(errors.is_empty(), "缓存写入不应失败");
                for action in actions {
                    match action {
                        BridgeAction::AssistantState(s) => {
                            sse_states.lock().unwrap().push(format!("{s:?}"));
                        }
                        BridgeAction::MessageAppended(m) => {
                            println!("[smoke] message {:?}: {}", m.role, m.content);
                        }
                        _ => {}
                    }
                }
                if let cabinhug_core::contract::SessionEvent::Update(
                    cabinhug_core::contract::SessionUpdate::TurnEnd(_),
                ) = env.event
                {
                    sse_stop.store(true, Ordering::Relaxed);
                }
            }
        })
        .await;
    });

    // 发一条文本消息触发一轮
    let client = reqwest::Client::new();
    client
        .post(format!("{base}/v1/session/{session_id}/messages"))
        .header("authorization", format!("Bearer {token}"))
        .json(&serde_json::json!({ "content": "下行链冒烟测试" }))
        .send()
        .await
        .expect("发消息失败");

    tokio::time::timeout(std::time::Duration::from_secs(15), consumer)
        .await
        .expect("15s 内未收到 turn_end")
        .expect("消费任务失败");

    // 断言：状态序列含 thinking→idle；缓存里有本轮 assistant 消息（fake 模型确定性内容）
    let states = seen_states.lock().unwrap().clone();
    let page = cache.recent_page(&session_id, None, 10).expect("读缓存");
    let assistant = page
        .iter()
        .find(|m| matches!(m.role, cabinhug_core::contract::ChatRole::Assistant))
        .expect("缓存缺 assistant 消息");

    let ok_states = states.contains(&"Thinking".to_string()) && states.ends_with(&["Idle".into()]);
    let ok_content = assistant.content.contains("下行链冒烟测试");
    println!("[smoke] states = {states:?}");
    println!("[smoke] cached assistant = {}", assistant.content);
    if ok_states && ok_content {
        println!("✓ 下行链端到端：SSE → fanout → 状态序列 + 缓存双写 全部正确");
    } else {
        println!("✗ 断言失败 states_ok={ok_states} content_ok={ok_content}");
        std::process::exit(1);
    }
}
