/**
 * 进程入口。
 *
 * 与 `index.ts` 分开，测试可以 `import { createDealerServer }` 而不触发监听。
 * `import.meta.url === process.argv[1]` 之类的自启判断在 tsx/ESM 下路径形态不稳定，
 * 分文件最可靠。
 */
import { createDealerServer } from "./index";
import { MODELS, STORES } from "./store";

const PORT = Number(process.env.MOCK_DEALER_PORT ?? 8792);

createDealerServer().listen(PORT, () => {
  // 打印种子数量，区分"已启动"与"已启动但种子为空"。
  console.log(`[mock-dealer] listening on :${PORT} (stores=${STORES.length}, models=${MODELS.length})`);
});
