//! ⑥用车流水上报（§7⑥ 两段式的第一段）。
//!
//! # 与 cabinhug-telemetry 的分工
//!
//!  - `cabinhug-telemetry` 是崩溃与诊断埋点，不含网络发送；
//!  - 本模块是业务数据：行程里程、路况、充电 SOC，服务端有明确的接收端点
//!    （`POST /v1/telemetry/trips`）与消费方（双路检索的第二路、用车画像聚合）。
//!
//! 端点路径里的 "telemetry" 是网关侧的命名，与那个 crate 无关。
//!
//! # id 由端上生成，且重试时必须不变
//!
//! 服务端 `append` 是 upsert 语义，幂等完全依赖 id。
//! 重试换 id 会让一次弱网重发变成两条重复行程，服务端无法识别，日均里程被重复计入。
//! 因此 id 在行程记录产生时生成一次，随行程一起排队，重试沿用同一个。

use serde::{Deserialize, Serialize};

use crate::upload::{GatewayClient, NetError};

/// 一段行程。字段与服务端 `TripInput` 对齐（camelCase 上线）。
///
/// 不含 userId：归属由服务端按鉴权上下文注入，端上给了也会被丢弃；
/// 端上因此不需要知道自己是谁。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TripReport {
    /// 端上生成的稳定 id；重试沿用。
    pub id: String,
    pub started_at: i64,
    pub ended_at: i64,
    pub distance_km: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vin: Option<String>,
    /// `city` / `highway` / `mixed`
    #[serde(skip_serializing_if = "Option::is_none")]
    pub road_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ambient_temp_c: Option<f64>,
    /// 本次行程折算的满电续航表现（km）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_range_km: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub charge: Option<ChargeSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChargeSegment {
    pub start_soc: f64,
    pub end_soc: f64,
    pub at: i64,
}

/// 服务端逐条结果。**部分成功是正常返回**，不是错误。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TripReportResult {
    pub accepted: usize,
    pub rejected: Vec<RejectedTrip>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RejectedTrip {
    pub id: String,
    pub reason: String,
}

/// 单批上限，与服务端 `MAX_BATCH` 对齐。超了服务端返回 413，整批不落库。
pub const MAX_BATCH: usize = 100;

impl GatewayClient {
    /// 上报一批行程（`POST /v1/telemetry/trips`）。
    ///
    /// 返回逐条结果：被拒的条目是校验不通过的脏数据，不重试，否则队列永远清不空。
    /// 需要重试的是网络错误与 5xx，二者以 `Err` 返回。
    pub async fn report_trips(&self, trips: &[TripReport]) -> Result<TripReportResult, NetError> {
        if trips.is_empty() {
            return Ok(TripReportResult { accepted: 0, rejected: Vec::new() });
        }
        if trips.len() > MAX_BATCH {
            return Err(NetError::Rejected {
                status: 413,
                body: format!("单批最多 {MAX_BATCH} 条，本次 {}", trips.len()),
            });
        }

        let res = self
            .post_trips_once(trips)
            .await
            .map_err(crate::upload::net_err)?;

        let status = res.status();
        if status.is_success() {
            return res
                .json::<TripReportResult>()
                .await
                .map_err(|e| NetError::BadResponse(e.to_string()));
        }
        if status.is_client_error() {
            let body = res.text().await.unwrap_or_default();
            // 4xx 是请求本身的问题，重试无意义，由调用方丢弃这一批并记录。
            return Err(NetError::Rejected { status: status.as_u16(), body });
        }
        Err(NetError::Server(status.as_u16()))
    }
}

/// 待上报队列。
///
/// # 用途
///
/// 车机断网是常态（地库、隧道）。队列保证断网期间的行程不丢失；
/// ⑥依赖数据连续，缺几天会让"日均里程"偏低且不易察觉。
///
/// # 上限
///
/// 车机可能连开数天不重启，无界队列在长时间断网后会吃满内存。
/// 溢出时丢最旧的：新数据对画像更有价值，且旧数据越旧越可能已被别的途径覆盖。
/// 丢弃计数，使缺失的数据可追查。
#[derive(Debug, Default)]
pub struct TripQueue {
    pending: Vec<TripReport>,
    capacity: usize,
    dropped: usize,
}

impl TripQueue {
    pub fn with_capacity(capacity: usize) -> Self {
        Self { pending: Vec::new(), capacity: capacity.max(1), dropped: 0 }
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }
    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }
    /// 因溢出被丢弃的条数，对外可见。
    pub fn dropped(&self) -> usize {
        self.dropped
    }

    /// 入队。同 id 视为同一段行程的更新（覆盖），不产生第二条。
    pub fn push(&mut self, trip: TripReport) {
        if let Some(slot) = self.pending.iter_mut().find(|t| t.id == trip.id) {
            *slot = trip;
            return;
        }
        if self.pending.len() >= self.capacity {
            self.pending.remove(0);
            self.dropped += 1;
        }
        self.pending.push(trip);
    }

    /// 取一批待发（不移除：发成功才移除，网络失败时数据仍在）。
    pub fn peek_batch(&self) -> Vec<TripReport> {
        self.pending.iter().take(MAX_BATCH).cloned().collect()
    }

    /// 按 id 移除已确认处理的条目（含被拒的：重试无意义，见 `report_trips`）。
    pub fn ack(&mut self, ids: &[String]) {
        self.pending.retain(|t| !ids.iter().any(|i| i == &t.id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trip(id: &str) -> TripReport {
        TripReport {
            id: id.into(),
            started_at: 1_700_000_000_000,
            ended_at: 1_700_000_600_000,
            distance_km: 12.5,
            vin: None,
            road_type: Some("city".into()),
            ambient_temp_c: None,
            observed_range_km: None,
            charge: None,
        }
    }

    /// 同一段行程重复记录不产生两条：服务端靠 id 幂等，端上也不先制造重复。
    #[test]
    fn same_id_updates_in_place() {
        let mut q = TripQueue::with_capacity(10);
        q.push(trip("a"));
        let mut updated = trip("a");
        updated.distance_km = 20.0;
        q.push(updated);
        assert_eq!(q.len(), 1);
        assert_eq!(q.peek_batch()[0].distance_km, 20.0);
    }

    /// 溢出丢最旧的，且丢弃计数可见。
    #[test]
    fn overflow_drops_oldest_and_counts() {
        let mut q = TripQueue::with_capacity(2);
        q.push(trip("a"));
        q.push(trip("b"));
        q.push(trip("c"));
        assert_eq!(q.len(), 2);
        assert_eq!(q.dropped(), 1);
        let ids: Vec<_> = q.peek_batch().into_iter().map(|t| t.id).collect();
        assert_eq!(ids, vec!["b", "c"], "丢的应该是最旧的 a");
    }

    /// 发送前不移除：网络失败时数据必须还在队列里。
    #[test]
    fn peek_does_not_remove() {
        let mut q = TripQueue::with_capacity(10);
        q.push(trip("a"));
        let _ = q.peek_batch();
        assert_eq!(q.len(), 1);
    }

    #[test]
    fn ack_removes_only_acked() {
        let mut q = TripQueue::with_capacity(10);
        q.push(trip("a"));
        q.push(trip("b"));
        q.ack(&["a".to_string()]);
        assert_eq!(q.len(), 1);
        assert_eq!(q.peek_batch()[0].id, "b");
    }

    /// 打真实网关的联调（默认跳过，需显式 `--ignored` 运行）。
    ///
    /// 单测只覆盖队列逻辑；契约不一致时两侧单测都会通过，只有真实请求能发现。
    ///
    /// 前置：网关在 CABINHUG_GATEWAY_URL（默认 8790）上跑着。
    #[tokio::test]
    #[ignore = "需要真实网关，用 cargo test -p cabinhug-net -- --ignored 跑"]
    async fn live_report_against_gateway() {
        let base = cabinhug_core::env::env_var("CABINHUG_GATEWAY_URL")
            .unwrap_or_else(|_| "http://localhost:8790".into());
        let token = cabinhug_core::env::env_var("CABINHUG_DEMO_TOKEN").unwrap_or_else(|_| "demo-token".into());
        let client = GatewayClient::new(base, token);

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;

        let good = TripReport {
            id: format!("rust-live-{now}"),
            started_at: now - 40 * 60_000,
            ended_at: now,
            distance_km: 21.7,
            vin: None,
            road_type: Some("highway".into()),
            ambient_temp_c: Some(26.0),
            observed_range_km: None,
            charge: None,
        };
        // 故意混一条脏数据：验证"部分成功"而不是整批失败。
        let bad = TripReport { id: format!("rust-live-bad-{now}"), distance_km: -1.0, ..good.clone() };

        let r = client.report_trips(&[good.clone(), bad]).await.expect("上报应当返回结果");
        assert_eq!(r.accepted, 1, "合法那条应被接受");
        assert_eq!(r.rejected.len(), 1, "非法那条应被拒且不拖垮整批");
        assert!(r.rejected[0].reason.contains("distanceKm"), "拒绝原因要指到具体规则：{:?}", r.rejected);

        // 幂等：同一 id 重发，服务端仍报 accepted（upsert），但库里不会多一行。
        let again = client.report_trips(&[good]).await.expect("重发应当成功");
        assert_eq!(again.accepted, 1);
    }

    /// 端上不发 userId：归属由服务端按鉴权注入，序列化里根本不该出现这个字段。
    #[test]
    fn payload_has_no_user_id() {
        let json = serde_json::to_string(&trip("a")).unwrap();
        assert!(!json.contains("userId"), "端上不得自报归属：{json}");
        assert!(json.contains("\"distanceKm\""), "字段必须是 camelCase：{json}");
    }

    /// 未设置的可选字段不序列化，避免服务端区分"没有"与"显式为空"。
    #[test]
    fn optional_fields_omitted_when_absent() {
        let json = serde_json::to_string(&trip("a")).unwrap();
        assert!(!json.contains("charge"));
        assert!(!json.contains("vin"));
    }
}
