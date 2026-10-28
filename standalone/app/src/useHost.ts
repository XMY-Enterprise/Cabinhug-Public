import { useEffect, useState } from "react";

import { host } from "./api";
import type { HostStatus } from "./types";

/** 轮询宿主状态：起的过程中 0.6 秒一次，就绪后 5 秒一次（服务挂了要能看出来）。 */
export function useHostStatus(): HostStatus | null {
  const [status, setStatus] = useState<HostStatus | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const s = await host.status();
        if (!alive) return;
        setStatus(s);
        timer = setTimeout(tick, s.phase === "ready" ? 5000 : 600);
      } catch {
        if (alive) timer = setTimeout(tick, 1000);
      }
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  return status;
}
