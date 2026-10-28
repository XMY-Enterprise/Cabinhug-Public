/**
 * 消息音频索引仓储。字节在对象存储，这里只有索引与来路。
 *
 * 消费方只有运营控制台的"试听"：`GET /console/messages/:id/audio`
 * 先查这里，有就直接取对象，没有才补合成。补完写回一行，
 * 因此同一句话最多只向供应商请求一次合成。
 *
 * `origin`：`captured` 是端上录入的波形，`resynth` 是事后按同档位补合成的。
 * 界面据此措辞，不把补合成的音频说成"当时播放的那段"。
 */

import { PrismaClient } from "@prisma/client";

export type MessageAudioKind = "asr" | "tts";
export type MessageAudioOrigin = "captured" | "resynth";

export interface MessageAudioMeta {
  messageId: string;
  kind: MessageAudioKind;
  engine: string;
  voice?: string;
  origin: MessageAudioOrigin;
  mime: string;
  bytes: number;
  objectKey: string;
  createdAt: number;
}

export interface MessageAudioRepository {
  /** 幂等写入：同一 (messageId, kind) 重复补合成时覆盖索引（对象键也一并更新）。 */
  put(m: Omit<MessageAudioMeta, "createdAt">): Promise<void>;
  get(messageId: string, kind: MessageAudioKind): Promise<MessageAudioMeta | null>;
  /**
   * 批量存在性查询：会话详情一次要查几十条消息有没有音频，
   * 逐条 `get` 会形成 N+1 查询。
   */
  presenceOf(messageIds: string[]): Promise<Map<string, MessageAudioKind[]>>;
}

type Row = {
  messageId: string;
  kind: string;
  engine: string;
  voice: string | null;
  origin: string;
  mime: string;
  bytes: number;
  objectKey: string;
  createdAt: Date;
};

const toDomain = (r: Row): MessageAudioMeta => ({
  messageId: r.messageId,
  kind: r.kind as MessageAudioKind,
  engine: r.engine,
  voice: r.voice ?? undefined,
  origin: r.origin as MessageAudioOrigin,
  mime: r.mime,
  bytes: r.bytes,
  objectKey: r.objectKey,
  createdAt: r.createdAt.getTime(),
});

export function createMessageAudioRepository(prisma: PrismaClient): MessageAudioRepository {
  return {
    async put(m) {
      const data = {
        engine: m.engine,
        voice: m.voice ?? null,
        origin: m.origin,
        mime: m.mime,
        bytes: m.bytes,
        objectKey: m.objectKey,
      };
      await prisma.messageAudio.upsert({
        where: { messageId_kind: { messageId: m.messageId, kind: m.kind } },
        create: { messageId: m.messageId, kind: m.kind, ...data },
        update: data,
      });
    },

    async get(messageId, kind) {
      const r = await prisma.messageAudio.findUnique({
        where: { messageId_kind: { messageId, kind } },
      });
      return r ? toDomain(r as Row) : null;
    },

    async presenceOf(messageIds) {
      const out = new Map<string, MessageAudioKind[]>();
      if (messageIds.length === 0) return out;
      const rows = await prisma.messageAudio.findMany({
        where: { messageId: { in: messageIds } },
        select: { messageId: true, kind: true },
      });
      for (const r of rows) {
        const list = out.get(r.messageId) ?? [];
        list.push(r.kind as MessageAudioKind);
        out.set(r.messageId, list);
      }
      return out;
    },
  };
}
