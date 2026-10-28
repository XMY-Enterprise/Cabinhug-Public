/**
 * 在飞闸：同一件事同时被要求两次时，只做一次。
 *
 * # 要解决的竞态
 *
 * 两个端都渲染在 `<React.StrictMode>` 里，React 18 的开发构建会把每个 effect
 * 跑成 effect → cleanup → effect（`target/debug/*` 连的是 vite dev server，
 * 用的就是开发构建）。引导流程从「读 localStorage 的旧 sid」到「写回新 sid」
 * 之间全是 await，没有互斥时两次运行都会判"不可复用"、各建一个会话。
 * 被覆盖的那个再无人访问，而服务端的会话过期是懒关闭（只在下次访问时才落
 * `closed_at`），它会一直以零消息、"活着"的状态留在库里。
 *
 * # 共享 promise 而不是丢弃第二次
 *
 * 第二次运行需要拿到 sid 才能起流、绑哨兵；丢弃式的闸（在飞就 `return`）会让它
 * 拿到 undefined。共享同一个 promise 让两次运行拿到同一个 sid，行为与只跑一次一致。
 *
 * # 三条不变量
 *
 *   · 不是缓存：settle 之后就释放，串行的两次调用照常各做一次；
 *   · 失败也释放：否则网关未就绪时的一次失败会导致此后永远建不出会话；
 *   · 按 key 隔离：引导与「新建对话」是两件事，不互相合并。
 */

export interface Inflight {
  /**
   * 同 key 有在飞的调用就返回同一个 promise，否则执行 `fn`。
   *
   * 返回值也是同一个引用，调用方各自 setState 时不会变成两份。
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** 这个 key 此刻在飞吗。只给测试与诊断用。 */
  busy(key: string): boolean;
}

export function createInflight(): Inflight {
  const pending = new Map<string, Promise<unknown>>();
  return {
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const running = pending.get(key);
      if (running) return running as Promise<T>;
      // `fn()` 抛同步异常时也要把 key 清掉，所以整段包在 try 之外用 finally 收尾。
      const p = (async () => fn())().finally(() => {
        // 只清掉自己那一次：慢的那次收尾时，新的一次可能已经在飞了。
        if (pending.get(key) === p) pending.delete(key);
      });
      pending.set(key, p);
      return p;
    },
    busy(key) {
      return pending.has(key);
    },
  };
}

/**
 * 引导（复用或新建当前会话）。StrictMode 的两次运行合并在这里。
 *
 * 手机端没有「新建对话」入口与「退下」按钮（车机 HUD 才有），引导只用这一个 key。
 * 与车机各存一份：两端的引导结构不同（车机有 `canResume`、哨兵绑定、会话列表），
 * 跨 app 共享代码属结构变更，要先立 ACR。
 */
export const INFLIGHT_BOOTSTRAP = "session:bootstrap";
/** 第一次说话时现建会话（手机端唯一会建出会话的路径）。 */
export const INFLIGHT_NEW_SESSION = "session:new";
