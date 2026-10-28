/**
 * 进程入口。与 `index.ts` 分开（同 mock-dealer 的 main.ts），
 * 测试可以 `import { createCabinServer }` 而不触发监听。
 */
import { createCabinServer } from "./index";
import { SEED_MODELS } from "./capabilities";
import { backendCaps } from "./media/backend";
import { scanLibrary } from "./media/library";
import { __resetPlayers } from "./media/player";

const PORT = Number(process.env.MOCK_CABIN_PORT ?? 8793);

const lib = await scanLibrary();
const audio = backendCaps();

createCabinServer().listen(PORT, () => {
  // 打印种子数：否则无法区分"已启动"与"已启动但种子为空"。
  console.log(`[mock-cabin] listening on :${PORT} (seedModels=${SEED_MODELS.length}, synthesizesAnyModel=true)`);
  // 音频同理：后端探测失败或曲库为空时，服务照样健康、点歌照样返回 200，只是不出声。
  console.log(`[mock-cabin] audio backend=${audio.name} tracks=${lib.tracks.length} dir=${lib.dir}`);
  if (audio.name === "none") console.warn(`[mock-cabin] ⚠️ 主机不会出声：${audio.note}`);
  if (lib.tracks.length === 0) console.warn(`[mock-cabin] ⚠️ 曲库是空的，往 ${lib.dir} 里放 FLAC`);
});

// 退出时收掉播放子进程，否则 mpg123 会被 launchd 收养，在服务退出后继续放歌。
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    __resetPlayers();
    process.exit(0);
  });
}
process.on("exit", () => __resetPlayers());
