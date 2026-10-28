/**
 * 在飞闸：同一件事同时被要求两次时，只做一次。
 *
 * # 要解决的问题
 *
 * 不加闸时，车机与手机端每启动一次会建两个会话，用掉一个、丢掉一个。
 * 成因是两件事叠加：
 *
 *   1. 两个端都渲染在 `<React.StrictMode>` 里，React 18 的开发构建
 *      会把每个 effect 跑成 effect → cleanup → effect（`target/debug/*` 连的是
 *      vite dev server，用的正是 dev 构建）；
 *   2. 引导流程从「读 localStorage 的旧 sid」到「写回新 sid」之间全是 await，
 *      中间没有互斥，两次运行都读到同一个旧值、都判"不可复用"、各建一个。
 *
 * 后完成的那个覆盖存储，先建的那个再也没人碰；而服务端的会话过期是懒关闭
 * （只在下次访问时才落 `closed_at`），于是它永远零消息、永远显示成"活着"。
 *
 * # 共享 promise，而不是丢弃第二次
 *
 * 丢弃式的闸（在飞就 `return`）对点击够用，对 StrictMode 不够：
 * 第二次运行需要拿到 sid 才能起流、绑哨兵，丢弃会让它拿到 undefined，
 * 要么报错、要么自己再建一个。共享同一个 promise 则让两次运行拿到同一个 sid，
 * 行为与只跑一次一致。
 *
 * # 三条不变量
 *
 *   · 不是缓存：settle 之后就释放，串行的两次调用照常各做一次；
 *   · 失败也释放：否则"网关还没起来"那一次失败会变成"永远建不出会话"；
 *   · 按 key 隔离：引导与「新建对话」是两件事，不该互相合并。
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

/** 引导（复用或新建当前会话）。StrictMode 的两次运行合并在这里。 */
export const INFLIGHT_BOOTSTRAP = "session:bootstrap";
/** 显式新建一段对话（「新建对话」按钮、「退下」之后、会话过期重发）。 */
export const INFLIGHT_NEW_SESSION = "session:new";
/**
 * 上车声明整段探测（`BoardingGate` 的挂载 effect）。
 *
 * 与 `INFLIGHT_BOOTSTRAP` 是两回事，不要合并。App 的引导只复用不新建，
 * 车机唯一会建出会话的启动路径是这道门：探测末尾的
 * `create_session_as` 发一次就是一个会话。闸挡在 `probe()` 的进入处：
 * 只挡 `create_session_as` 不够，两次运行走的是同一串 await
 * （device_role → bound_vin → boarding_declared），先跑的那次若在后跑的那次
 * 到达之前就拿到了 201，闸已释放，照样建出两个。
 */
export const INFLIGHT_BOARDING_PROBE = "boarding:probe";
/**
 * 建会话并声明谁在用（`create_session_as`）。按声明的人分键——
 * 「访客」与「车主」是两个不同的诉求，合并会让后到的那次拿到别人的身份。
 */
export const INFLIGHT_DECLARE = "session:declare";
