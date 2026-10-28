/**
 * 费用明细的数据面（ACR-066）：`GET /v1/billing?range=…`，换时间段就重取。
 *
 * 404 单独成一态：网关没开这个接口（`CABINHUG_OWNER_BILLING` 不是 on），设置里就不显示这个页签。
 * 余额由网关缓存 60 秒，这里不再缓存；「刷新」只是重取一次。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import type { BillingRange, OwnerBillingSummary } from "@cabinhug/shared";

import { gw, GatewayError } from "../../api";

export type BillingState =
  | { kind: "loading"; data?: OwnerBillingSummary }
  | { kind: "ready"; data: OwnerBillingSummary }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

export interface BillingApi {
  range: BillingRange;
  setRange(range: BillingRange): void;
  state: BillingState;
  refresh(): void;
}

export function useBilling(): BillingApi {
  const [range, setRange] = useState<BillingRange>("today");
  const [state, setState] = useState<BillingState>({ kind: "loading" });
  const seq = useRef(0);

  const load = useCallback(async (r: BillingRange) => {
    const mine = ++seq.current;
    // 换时间段时上一份先留着（灰掉），不闪回骨架。
    setState((cur) => ({ kind: "loading", data: cur.kind === "ready" || cur.kind === "loading" ? cur.data : undefined }));
    try {
      const data = await gw<OwnerBillingSummary>("GET", `/v1/billing?range=${r}`);
      if (mine === seq.current) setState({ kind: "ready", data });
    } catch (e) {
      if (mine !== seq.current) return;
      if (e instanceof GatewayError && e.status === 404) setState({ kind: "unavailable" });
      else
        setState({
          kind: "error",
          message: e instanceof GatewayError ? `网关回了 ${e.status}${e.code ? `（${e.code}）` : ""}` : "本地服务还没就绪",
        });
    }
  }, []);

  useEffect(() => {
    void load(range);
  }, [range, load]);

  return { range, setRange, state, refresh: () => void load(range) };
}
