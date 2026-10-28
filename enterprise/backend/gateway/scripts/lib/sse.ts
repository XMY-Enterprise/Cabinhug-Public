/**
 * SSE 收流助手，`e2e.ts` 与 `e2e-identity.mts` 共用。
 *
 * 两个 e2e 共用同一套收流逻辑，避免各自对 SSE 的理解漂移。
 */

import type { EventEnvelope } from "@cabinhug/shared";

export interface CollectSseOptions {
  /** 断线重连用；不传就是从头收。 */
  lastEventId?: string;
  /** 收够了就停。 */
  until: (all: EventEnvelope[]) => boolean;
  timeoutMs?: number;
  /** 每收到一个封套调一次——刷新那条用例要在流进行中插动作。 */
  onEnvelope?: (e: EventEnvelope, all: EventEnvelope[]) => void;
}

/**
 * 消费 SSE 直到谓词满足或超时，返回收到的封套序列。
 *
 * `authHeaders` 是个函数而不是固定对象：刷新用例会在流进行中换 token，
 * 而这一条流的 header 在建立时就已确定，因此能验证"换了 token 流也不断"。
 */
export async function collectSse(
  gatewayUrl: string,
  sessionId: string,
  authHeaders: () => Record<string, string>,
  opts: CollectSseOptions,
): Promise<EventEnvelope[]> {
  const url = new URL(`${gatewayUrl}/v1/session/${sessionId}/stream`);
  if (opts.lastEventId) url.searchParams.set("lastEventId", opts.lastEventId);
  const controller = new AbortController();
  const res = await fetch(url, { headers: authHeaders(), signal: controller.signal });
  if (!res.ok || !res.body) throw new Error(`stream status=${res.status}`);

  const envelopes: EventEnvelope[] = [];
  let buffer = "";
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);

  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += Buffer.from(chunk).toString("utf8");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!dataLine) continue;
        const env = JSON.parse(dataLine.slice(6)) as EventEnvelope;
        envelopes.push(env);
        opts.onEnvelope?.(env, envelopes);
      }
      if (opts.until(envelopes) || Date.now() > deadline) {
        controller.abort();
        break;
      }
    }
  } catch (err) {
    if ((err as Error).name !== "AbortError") throw err;
  }
  return envelopes;
}

export const hasTurnEnd = (all: EventEnvelope[]): boolean =>
  all.some((e) => e.event.type === "update" && e.event.kind === "turn_end");

export const deltaText = (all: EventEnvelope[]): string =>
  all
    .filter((e) => e.event.type === "update" && e.event.kind === "delta")
    .map((e) => (e.event as { text: string }).text)
    .join("");
