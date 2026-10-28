//! 下行流与历史命令。
//!
//! `start_session_stream`：真实 SSE 消费（同一时刻一路，重复调用替换旧流）；
//! `start_mock_stream`：标准样例序列（与真实流共用 fan-out 路径，开发模式）；
//! `refresh_history`：权威历史回源 → 整体替换本地缓存（差异修复入口）；
//! `read_cached_messages` / `clear_message_cache`：对话层 UI 与开发用。

use std::sync::Arc;

use cabinhug_core::contract::ChatMessage;
use cabinhug_net::GatewayClient;
use tauri::{AppHandle, State};

use crate::events::{run_mock_stream, spawn_session_stream, spawn_user_events_stream, StreamState};

pub(crate) fn gateway_env() -> (String, String) {
    // 统一走设置层（ACR-004）：env → 端上持久化 → 默认。
    // iOS 没有环境变量，直接读 env 会让 iPad 始终连 localhost。
    crate::settings::gateway()
}

#[tauri::command]
pub fn start_session_stream(
    app: AppHandle,
    state: State<'_, Arc<StreamState>>,
    session_id: String,
) {
    let (base_url, token) = gateway_env();
    spawn_session_stream(app, Arc::clone(&state), base_url, token, session_id);
}

/// 账号级事件流（ACR-032）：订阅的键是人而不是会话，所以不接收 session_id。
///
/// 换人（上车声明）时前端须再调一次：服务端按连接建立时的那个人订阅，
/// 不重建的话换人之后收到的仍是上一个人的会话变动。
#[tauri::command]
pub fn start_user_events_stream(app: AppHandle, state: State<'_, Arc<StreamState>>) {
    let (base_url, _token) = gateway_env();
    spawn_user_events_stream(app, Arc::clone(&state), base_url);
}

#[tauri::command]
pub fn start_mock_stream(app: AppHandle, state: State<'_, Arc<StreamState>>) {
    run_mock_stream(&app, &state);
}

#[tauri::command]
pub async fn refresh_history(
    state: State<'_, Arc<StreamState>>,
    session_id: String,
) -> Result<Vec<ChatMessage>, String> {
    let (base_url, token) = gateway_env();
    let page = GatewayClient::new(base_url, token)
        .fetch_history(&session_id, 100)
        .await
        .map_err(|e| e.to_string())?;
    state
        .cache
        .replace_session(&session_id, &page.messages)
        .map_err(|e| e.to_string())?;
    Ok(page.messages)
}

/// 车主自己的会话列表（车机端左侧历史）。原样 JSON，解析在 TS。
///
/// 懒加载：`limit` 缺省 20，`cursor` 传上一页的 `nextCursor`。
#[tauri::command]
pub async fn list_sessions(limit: Option<u32>, cursor: Option<String>) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_sessions(limit.unwrap_or(20), cursor.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// 当前已确认行程的原样 JSON。网络在 Rust 侧（§2.2 C2），
/// WebView 只 invoke；解析与 HUD 映射在 TS（shared 是契约真相源）。
#[tauri::command]
pub async fn fetch_trip_plan(refresh_pretrip: Option<bool>) -> Result<String, String> {
    // 参数可选：不传时行为不变；只有"打开 App"那一次传 true。
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_trip_plan_with(refresh_pretrip.unwrap_or(false))
        .await
        .map_err(|e| e.to_string())
}

/// 景区导览简报。点击行程上的景点 → 这一跳。
///
/// 与 `fetch_trip_plan` 相同：入参出参都是原样 JSON（契约在 TS/shared 的
/// `GuideBriefResponse`），Rust 只搬运不解析。耗时较长：冷启三分支采集
/// 最坏 90s 量级（缓存命中毫秒级），net 层已按 110s 兜底，前端自带"采集中"占位。
#[tauri::command]
pub async fn get_guide_brief(body_json: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_guide_brief(&body_json)
        .await
        .map_err(|e| e.to_string())
}

/// 出发导航规划。点「开始行程」→ 这一跳，与动画并行。
///
/// 与 `get_guide_brief` 相同：入参出参原样 JSON（契约在 TS/shared 的
/// `NavPlanRequest` / `NavPlanResponse`），Rust 只搬运不解析。耗时较长：一条 nav-task
/// 分支约 8 s、预算 60 s，net 层 65 s 兜底，前端自带「正在规划导航 N s…」占位与 60 s 硬顶。
/// 手机端不加镜像命令：出发卡只在车机 HUD 上。
#[tauri::command]
pub async fn plan_departure_nav(body_json: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .post_nav_plan(&body_json)
        .await
        .map_err(|e| e.to_string())
}

/// 导览采集任务状态。进度面板轮询它；快路径 10s 超时在 net 层。
#[tauri::command]
pub async fn get_guide_jobs() -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_guide_jobs()
        .await
        .map_err(|e| e.to_string())
}

/// 手动「获取导览」。body 只带 spotName，行程上下文网关补齐。
#[tauri::command]
pub async fn trigger_guide_job(body_json: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .trigger_guide_job(&body_json)
        .await
        .map_err(|e| e.to_string())
}

/// 行程核查「知道了」。列表卡上点带点的那程 → 弹层 → 这一跳。
/// 与 `trigger_guide_job` 相同：原样 JSON，Rust 只搬运不解析。
#[tauri::command]
pub async fn ack_trip_review(plan_id: String, body_json: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .ack_trip_review(&plan_id, &body_json)
        .await
        .map_err(|e| e.to_string())
}

/// 车辆档案列表的原样 JSON。与 `fetch_trip_plan` 相同：
/// Rust 只搬运不解析，契约真相源在 TS/shared。车机端档案只读，
/// 建档走手机端向导（FL-23：车机仅手动录入，本期未开）。
#[tauri::command]
pub async fn fetch_vehicles() -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_vehicles()
        .await
        .map_err(|e| e.to_string())
}

/// 新增 / 修改常用人员。
///
/// 带 `id` 即更新（网关 `http/vehicle-member.ts` 同一路由）：漏传 id 会静默
/// 新建一个同名的人，名单里出现重复成员。
///
/// # 车机端允许增、改、删
///
/// 与手机端对齐。删除是不可逆级联，确认文案必须说清后果，而驾驶态阅读长文案
/// 不安全；`vehicle_signal.rs` 尚未提供驻车态，无法做"仅驻车可删"，
/// 因此以与手机端一致的确认文案加二次点击作为补偿。驻车门控列为技术债。
#[tauri::command]
pub async fn save_member(vin: String, body_json: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .post_member(&vin, &body_json)
        .await
        .map_err(|e| e.to_string())
}

/// 删除常用人员。幂等：删不到也返回 200 `{removed:false}`，
/// 端上按 `removed` 决定措辞，不把"已经删过了"当成错误（与网关端点一致）。
#[tauri::command]
pub async fn delete_member(vin: String, id: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .delete_member(&vin, &id)
        .await
        .map_err(|e| e.to_string())
}

/// 档案变更记录。原样 JSON，Rust 只搬运。
#[tauri::command]
pub async fn fetch_vehicle_changes(vin: String, cursor: Option<String>) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_vehicle_changes(&vin, cursor.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/// 占位 VIN → 真 VIN 补录。入参与返回都是原样 JSON，Rust 只搬运。
#[tauri::command]
pub async fn backfill_vin(vin: String, body_json: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .backfill_vin(&vin, &body_json)
        .await
        .map_err(|e| e.to_string())
}

/// 手动记一笔保养。入参与返回都是原样 JSON，Rust 只搬运。
#[tauri::command]
pub async fn append_maintenance(vin: String, body_json: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .append_maintenance(&vin, &body_json)
        .await
        .map_err(|e| e.to_string())
}

/// 剩余电量 / 剩余油量。仿真读数，`provenance:"simulated"` 在响应体里。
#[tauri::command]
pub async fn fetch_vehicle_energy(vin: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_vehicle_energy(&vin)
        .await
        .map_err(|e| e.to_string())
}

/// 车机绑定状态。三态在响应体里，Rust 只搬运。
#[tauri::command]
pub async fn fetch_cabin(vin: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_cabin(&vin)
        .await
        .map_err(|e| e.to_string())
}

/// 触发车机绑定（幂等）。
#[tauri::command]
pub async fn bind_cabin(vin: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .post_cabin_bind(&vin)
        .await
        .map_err(|e| e.to_string())
}

/// 车型目录 + 车型↔知识库关联关系。建档向导用它决定
/// "这一款有没有对应的知识库"，拿不到时 TS 侧说"读不到"而不是"没有资料"。
#[tauri::command]
pub async fn fetch_vehicle_catalog() -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_vehicle_catalog()
        .await
        .map_err(|e| e.to_string())
}

/// 这辆车的⑥用车画像。503 也带响应体："未接入"与"没有数据"
/// 在端上是两句不同的话，判定与措辞都在 TS 侧。
#[tauri::command]
pub async fn fetch_vehicle_usage(vin: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_vehicle_usage(&vin)
        .await
        .map_err(|e| e.to_string())
}

/// 常用人员名单。契约同手机端，端点不变。
#[tauri::command]
pub async fn fetch_members(vin: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_members(&vin)
        .await
        .map_err(|e| e.to_string())
}

/// 某位成员的画像。常驾/常乘两种口径由服务端选，端上只渲染。
#[tauri::command]
pub async fn fetch_member_usage(vin: String, member_id: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_member_usage(&vin, &member_id)
        .await
        .map_err(|e| e.to_string())
}

/// ③偏好（"我希望助手记住"）。车机端只读。
#[tauri::command]
pub async fn fetch_preferences() -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .fetch_preferences()
        .await
        .map_err(|e| e.to_string())
}

/// 删除一条③偏好（车机端"我希望助手记住"那一栏的删除按钮）。
#[tauri::command]
pub async fn delete_preference(id: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .delete_preference(&id)
        .await
        .map_err(|e| e.to_string())
}

/// 车机端手动建档（FL-23："车机和 Web 仅支持手动录入"）。
///
/// 与手机端同一个端点、同一份请求体形状。建档逻辑（目录、校验）在
/// `@cabinhug/ui` 共享，保证同一辆车在两端建出的车型名一致。
#[tauri::command]
pub async fn create_vehicle(body_json: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .post_vehicle(&body_json)
        .await
        .map_err(|e| e.to_string())
}

/// 设默认车。默认车决定检索侧的车型限定，车机端也要能切。
#[tauri::command]
pub async fn set_default_vehicle(vin: String) -> Result<String, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .post_vehicle_default(&vin)
        .await
        .map_err(|e| e.to_string())
}

/// HITL 确认/拒绝。返回 true=网关受理（含 duplicate），false=中断已过期；
/// 两者对 UI 都是"收起弹窗"，都不重试。
#[tauri::command]
pub async fn resume_interrupt(
    session_id: String,
    interrupt_id: String,
    approved: bool,
) -> Result<bool, String> {
    let (base_url, token) = gateway_env();
    GatewayClient::new(base_url, token)
        .post_resume(&session_id, &interrupt_id, approved)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_cached_messages(
    state: State<'_, Arc<StreamState>>,
    session_id: String,
    before: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<ChatMessage>, String> {
    state
        .cache
        .recent_page(&session_id, before.as_deref(), limit.unwrap_or(50) as usize)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_message_cache(
    state: State<'_, Arc<StreamState>>,
    session_id: String,
) -> Result<(), String> {
    state.cache.clear_session(&session_id).map_err(|e| e.to_string())
}
