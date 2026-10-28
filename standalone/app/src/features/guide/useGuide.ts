/**
 * 景点导览的数据面（ACR-065）：逐景点采集进度 + 打开某一站的导览页。
 *
 * 只走异步那条路，不调同步采集：冷启一个景点要 50~100 秒，而桌面端的网关转发（Rust 的 `gateway_request`）
 * 超时 60 秒、还在整个请求期间握着网关会话的锁——一次同步采集会把对话与轮询一起卡住。所以：
 *   - 已就绪的点：`POST /v1/guide/brief` 只是读持久层 / ⑤缓存，毫秒级返回；
 *   - 其余的点：`POST /v1/guide/jobs/trigger` 排进后台队列（立刻返回），页面显示「采集中」，
 *     轮询 `GET /v1/guide/jobs` 到它就绪再取简报。
 * 节流（有在途任务才轮询）与乐观更新是 `@cabinhug/ui` 的共享逻辑，与车机端、手机端一字一样。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { guideBriefIsEmpty, type GuideBriefResponse, type GuideJobsResponse, type GuideJobsStatus } from "@cabinhug/shared";
import { applyGuideFetchOptimistic, GUIDE_JOBS_POLL_MS, shouldPollGuideJobs, type GuideScreenState } from "@cabinhug/ui";

import { gw } from "../../api";

export interface GuideApi {
  jobs: GuideJobsStatus | null;
  /** 打开着的导览页：哪一站、处在哪一态。 */
  open: { spot: string; state: GuideScreenState } | null;
  stateOf(spot: string): GuideJobsStatus["spots"][number]["state"] | undefined;
  openSpot(spot: string): void;
  /** 只排队、不开页（详情里的「获取导览」）。 */
  fetchSpot(spot: string): void;
  close(): void;
}

/** `active`：有已确认的行程。草案阶段没有采集任务，不拉不轮。 */
export function useGuide(active: boolean): GuideApi {
  const [jobs, setJobs] = useState<GuideJobsStatus | null>(null);
  const [open, setOpen] = useState<{ spot: string; state: GuideScreenState } | null>(null);
  const busy = useRef(false);
  const openSeq = useRef(0);
  /** 这一页已经去取简报的那一站：轮询每 10 秒换一份 jobs，不记着就会对同一站重复取。 */
  const requested = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      setJobs((await gw<GuideJobsResponse>("GET", "/v1/guide/jobs")).jobs ?? null);
    } catch {
      // 轮询面不出声：拿不到保持上一份。
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
    else setJobs(null);
  }, [active, refresh]);

  // 有在途任务、或导览页正等着某一站采完，才 10 秒一轮。
  const waiting = open?.state.status === "collecting";
  useEffect(() => {
    if (!active || (!shouldPollGuideJobs(jobs) && !waiting)) return;
    const t = setInterval(() => void refresh(), GUIDE_JOBS_POLL_MS);
    return () => clearInterval(t);
  }, [active, jobs, waiting, refresh]);

  const stateOf = useCallback((spot: string) => jobs?.spots.find((s) => s.spotName === spot)?.state, [jobs]);

  const loadBrief = useCallback(async (spot: string, seq: number) => {
    let resp: GuideBriefResponse;
    try {
      resp = await gw<GuideBriefResponse>("POST", "/v1/guide/brief", { spotName: spot, selfDrive: true });
    } catch {
      resp = { status: "failed" };
    }
    if (openSeq.current !== seq) return;
    // 还在采（持久层与缓存都还没有）：放开闸，下一轮轮询见到就绪再取。
    if (resp.status === "collecting") requested.current = null;
    setOpen((cur) =>
      cur?.spot === spot
        ? {
            spot,
            // 三支全空的 ready 按 failed 呈现（有重试钮），不显示空栏目页（与两个端同一判据）。
            state:
              resp.status === "ready" && resp.brief && !guideBriefIsEmpty(resp.brief)
                ? { status: "ready", brief: resp.brief, cached: resp.cached }
                : resp.status === "collecting"
                  ? { status: "collecting" }
                  : { status: "failed" },
          }
        : cur,
    );
  }, []);

  const trigger = useCallback(
    async (spot: string) => {
      setJobs((j) => (j ? applyGuideFetchOptimistic(j, spot) : j));
      try {
        await gw("POST", "/v1/guide/jobs/trigger", { spotName: spot });
      } finally {
        void refresh();
      }
    },
    [refresh],
  );

  const openSpot = useCallback(
    (spot: string) => {
      openSeq.current += 1;
      requested.current = null;
      setOpen({ spot, state: { status: "collecting" } });
      const state = jobs?.spots.find((s) => s.spotName === spot)?.state;
      // 就绪的交给下面那个 effect 去取；在途的等轮询；其余（未采、失败、不在列表里）排进队列。
      if (state !== "ready" && state !== "pending" && state !== "processing") void trigger(spot).catch(() => undefined);
    },
    [jobs, trigger],
  );

  // 页面等着的那一站就绪了 → 取一次简报；采集失败 → 页面转失败态（有「再试一次」）。
  useEffect(() => {
    if (!open || open.state.status !== "collecting") return;
    const state = jobs?.spots.find((s) => s.spotName === open.spot)?.state;
    if (state === "ready" && requested.current !== open.spot) {
      requested.current = open.spot;
      void loadBrief(open.spot, openSeq.current);
    } else if (state === "failed") {
      setOpen({ spot: open.spot, state: { status: "failed" } });
    }
  }, [jobs, open, loadBrief]);

  return {
    jobs,
    open,
    stateOf,
    openSpot,
    fetchSpot: (spot) => void trigger(spot).catch(() => undefined),
    close: () => {
      openSeq.current += 1;
      setOpen(null);
    },
  };
}
