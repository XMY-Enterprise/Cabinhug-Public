/**
 * 进程入口。与 index.ts 分开的理由同 mock-dealer/mock-repair。
 */
import { createInsuranceServer, POLICIES } from "./index";

const PORT = Number(process.env.MOCK_INSURANCE_PORT ?? 8798);

createInsuranceServer().listen(PORT, () => {
  // 打印种子数量，区分"已启动"与"已启动但种子为空"。
  console.log(`[mock-insurance] listening on :${PORT} (policies=${POLICIES.length})`);
});
