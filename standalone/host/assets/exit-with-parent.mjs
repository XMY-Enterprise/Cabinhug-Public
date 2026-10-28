/**
 * 父进程没了就退出（单机版宿主，ACR-061）。宿主经 `node --import` 把它挂进每个服务进程。
 *
 * 宿主被强杀（崩溃、任务管理器结束进程）时，子进程收不到任何信号：Unix 上会被 launchd / init 收养，
 * Windows 上父 pid 原样留着但进程已经不在。两种都查：ppid 变了，或原父进程探不到了。
 * 只用 node 内置能力，不打印任何东西；定时器 unref，不拖住正常退出。
 */
const parent = process.ppid;

setInterval(() => {
  let gone = process.ppid !== parent;
  if (!gone) {
    try {
      process.kill(parent, 0);
    } catch {
      gone = true;
    }
  }
  if (gone) process.exit(0);
}, 2000).unref();
