/**
 * ⑥用车流水上报入口（§7⑥ 两段式的第一段）。
 *
 * 端上经此把行程送进 `trips` 表，供第二段（`usage_profile` 工具、聚合任务、
 * 双路消费端）使用。
 *
 * # 网关只做协议转换与鉴权（§3）
 *
 * 校验用 `@cabinhug/memory` 的 `validateTrip`，落库用 `@cabinhug/db` 的 `TripRepository`。
 * 这里不写业务规则，避免出现第二份规则。
 */

import { Router, json } from "express";
import type { Response } from "express";

import {
  ingestTrip,
  TripValidationError,
  type MemberStore,
  type TripInput,
  type TripStore,
} from "@cabinhug/memory";

import type { AuthedRequest } from "../auth";

/**
 * 单批上限。
 *
 * 端上会攒一批再传（弱网下尤其如此），但一次几千条既拖垮请求也让部分成功的结果难读。
 * 100 条足够覆盖"离线一整天再上线"的场景（一天通常只有几十段行程）。
 */
export const MAX_BATCH = 100;

/** 上报项：`TripInput` 去掉 userId（服务端注入），加上端上生成的稳定 id。 */
type ReportedTrip = Omit<TripInput, "userId"> & { id?: unknown };

export interface TripReportResult {
  accepted: number;
  rejected: Array<{ id: string; reason: string }>;
}

/**
 * `members` 可选：传了就校验人员归属属于同一辆车，不传则跳过这层校验。
 * ⑥的写入不因人员表不可用而失败：归属是增强信息，行程本身才是要保住的数据。
 */
export function createTelemetryRouter(trips: TripStore, members?: MemberStore): Router {
  const router = Router();

  /**
   * `POST /v1/telemetry/trips`
   *
   * 三条硬约束，违反任一条都会产生表面正常而数据错误的结果：
   *
   * 1. userId 取自鉴权上下文，不接受请求体里的。否则任何客户端都能往别人账下写流水
   *    （F-21-12）。
   * 2. id 必须由端上给且稳定。`append` 是 upsert 语义，重发同一条行程才会幂等覆盖；
   *    服务端随机生成 id 会让一次弱网重试变成两条重复流水，日均里程翻倍。
   * 3. 一条非法不让整批失败。端上批次里混进脏数据是常态，
   *    整批拒绝会让端上无限重试同一批。
   */
  router.post("/v1/telemetry/trips", json({ limit: "1mb" }), async (req: AuthedRequest, res: Response) => {
    const userId = req.userId;
    if (!userId) {
      // 鉴权中间件在前，正常到不了这里；缺用户维度不能落库。
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const body = req.body as { trips?: unknown };
    if (!Array.isArray(body?.trips)) {
      res.status(400).json({ error: "invalid_body", detail: "需要 { trips: [...] }" });
      return;
    }
    if (body.trips.length === 0) {
      res.status(400).json({ error: "empty_batch" });
      return;
    }
    if (body.trips.length > MAX_BATCH) {
      res.status(413).json({ error: "batch_too_large", max: MAX_BATCH, got: body.trips.length });
      return;
    }

    const result: TripReportResult = { accepted: 0, rejected: [] };

    for (const raw of body.trips as ReportedTrip[]) {
      const id = typeof raw?.id === "string" ? raw.id.trim() : "";
      if (!id) {
        result.rejected.push({
          id: "(缺失)",
          reason: "缺少 id。id 必须由端上生成且重试时保持不变，否则重复上报会变成两条行程",
        });
        continue;
      }

      // 丢掉请求体里的 userId（如果有）：归属只认鉴权上下文。
      const { id: _ignored, userId: _spoofed, ...rest } = raw as ReportedTrip & { userId?: unknown };
      const trip = { ...rest, userId } as TripInput;

      try {
        await ingestTrip(trips, id, trip, { members });
        result.accepted += 1;
      } catch (err) {
        // 校验失败要说明违反的是哪一条规则，端上才能据此修正。
        const reason =
          err instanceof TripValidationError
            ? err.message
            : `落库失败：${err instanceof Error ? err.message : String(err)}`;
        result.rejected.push({ id, reason });
      }
    }

    console.log(
      `[telemetry] trips user=${userId} accepted=${result.accepted} rejected=${result.rejected.length}`,
    );
    // 部分成功仍是 200：端上据 `rejected` 决定丢弃哪几条，而不是整批重试。
    res.status(200).json(result);
  });

  return router;
}
