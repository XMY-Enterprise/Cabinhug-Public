/**
 * 发文字消息时的会话过期处置（纯函数，便于单测）。
 *
 * 服务端是会话过期的权威；端上计时器只管形象（`session-lifecycle.ts`）。端上漏判
 * （比如手机在后台期间计时器没跑）时，`send` 会拿到含 `SESSION_EXPIRED` 的错，
 * 这表示"换一个会话重发"，车主的话不能丢。
 * 别的错原样抛：把网络错也当过期重发，会把同一句话在新会话里发两遍。
 */
export async function sendWithSessionRetry(args: {
  /** 拿一个此刻能用的会话（会话退休判定在里面）。 */
  ensure: () => Promise<string>;
  send: (sessionId: string, content: string) => Promise<void>;
  /** 建一个新会话并接管；只在过期时调，且最多一次。 */
  startNew: () => Promise<string>;
  isExpired: (err: unknown) => boolean;
  content: string;
}): Promise<void> {
  const sid = await args.ensure();
  try {
    await args.send(sid, args.content);
  } catch (err) {
    if (!args.isExpired(err)) throw err;
    const fresh = await args.startNew();
    await args.send(fresh, args.content);
  }
}
