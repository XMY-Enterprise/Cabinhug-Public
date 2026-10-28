/**
 * 进程入口。
 *
 * 与 `index.ts` 分开的理由同 mock-dealer：测试要能 import 工厂而不触发监听。
 */
import { createRepairServer } from "./index";
import { STATIONS, HISTORY, SEED_QUOTES } from "./store";

const PORT = Number(process.env.MOCK_REPAIR_PORT ?? 8797);

createRepairServer().listen(PORT, () => {
  // 打印种子数量，区分"已启动"与"已启动但种子为空"。
  console.log(
    `[mock-repair] listening on :${PORT} (stations=${STATIONS.length}, history=${HISTORY.length}, quotes=${SEED_QUOTES.length})`,
  );
});
