/**
 * 会话试听：`GET /console/messages/:id/audio`。
 *
 *   车主那句（`source=voice`）→ 端上录进来的原始波形，建轮时已转存。
 *   助手那句            → 服务端没有当时播的字节（豆包档端上直连火山），
 *                        第一次点播放时按当时下发的档位补一次合成并存下，
 *                        之后不再向供应商请求。
 *
 * # 按提权对待
 *
 * 文本在列表里默认脱敏，音频无法脱敏（录音里手机号是读出来的）。
 * 因此这条路径与 `POST /console/sessions/:id/reveal` 同级：先写审计再返回字节，
 * 审计写不进去就拒绝。
 *
 * # 只有建轮的会话有音频
 *
 * 哨兵那条 `/v1/asr/transcribe` 不建轮、不落消息，它采到的段不会出现在这里：
 * 存在性挂在 messageId 上，边界由结构保证（AC-52-5）。
 */

import { Router } from "express";
import type { Response } from "express";

import type {
  AuditRepository,
  ChatRepository,
  ConfigStore,
  MessageAudioKind,
  MessageAudioRepository,
} from "@cabinhug/db";

import { requireAnyRole, CONSOLE_READERS, type ConsoleRequest } from "../auth/console";
import type { DailyQuota } from "../quota/daily-quota";
import { synthesizeSpeech, TtsSynthesisError } from "../tts/synthesize";
import type { ObjectStore } from "../upload";

export interface MessageAudioDeps {
  chat: ChatRepository;
  audit: AuditRepository;
  audio: MessageAudioRepository;
  config: ConfigStore;
  /** 对象存储。未接入时只能试听当场合成的那一次，无法存下，并如实告知。 */
  store?: ObjectStore;
  /**
   * 日字符闸门（ACR-016）。控制台补合成与端上合成计入同一个额度池，
   * 不单独开一个不设限的口子。
   */
  quota?: DailyQuota;
  /** 测试注入；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

/** 对象键：按会话分目录。 */
export function audioObjectKey(
  sessionId: string,
  messageId: string,
  kind: MessageAudioKind,
  mime: string,
): string {
  const ext = mime === "audio/wav" ? "wav" : mime === "audio/mpeg" ? "mp3" : "bin";
  return `session-audio/${sessionId}/${messageId}.${kind}.${ext}`;
}

export function createMessageAudioRouter(deps: MessageAudioDeps): Router {
  const router = Router();

  router.get(
    "/console/messages/:id/audio",
    requireAnyRole(CONSOLE_READERS),
    async (req: ConsoleRequest, res: Response) => {
      const messageId = String(req.params.id);
      const message = await deps.chat.consoleMessage(messageId);
      if (!message) {
        res.status(404).json({ error: "message_not_found" });
        return;
      }
      const kind: MessageAudioKind = message.role === "assistant" ? "tts" : "asr";

      // 与 reveal 同一条例外：审计写失败就拒绝放行。音频等于原文。
      try {
        await deps.audit.recordStrict({
          actor: req.console?.subject ?? "unknown",
          actorRole: req.console!.role,
          action: "message.audio",
          result: "ok",
          target: messageId,
          detail: { kind },
          sessionId: message.sessionId,
          ip: req.ip ?? null,
        });
      } catch (err) {
        console.error(`[console] 试听审计写入失败，拒绝放行 message=${messageId}`, err);
        res.status(503).json({ error: "audit_unavailable" });
        return;
      }

      // ① 已经存过就直接给，补合成只发生一次。
      const existing = await deps.audio.get(messageId, kind);
      if (existing && deps.store) {
        const obj = await deps.store.get(existing.objectKey);
        if (obj) {
          res.setHeader("x-audio-origin", existing.origin);
          res.setHeader("x-audio-engine", existing.engine);
          res.type(existing.mime).send(Buffer.from(obj.body));
          return;
        }
        // 索引在、对象没了（桶被清过）：不报 500，落到下面的补合成分支去。
        console.warn(`[console] 音频对象缺失，将尝试重新生成 key=${existing.objectKey}`);
      }

      // ② 车主那句的录音只能是当时存下的，无法补出。
      if (kind === "asr") {
        res.status(404).json({ error: "audio_not_stored" });
        return;
      }

      if (message.content.trim().length === 0) {
        res.status(404).json({ error: "empty_content" });
        return;
      }

      let values: ReadonlyMap<string, string>;
      try {
        values = await deps.config.runtimeValues();
      } catch (err) {
        console.error("[console] 试听：配置读取失败", err);
        res.status(503).json({ error: "config_unavailable" });
        return;
      }

      // 档位取当时下发的那个，配置层当前值只在老数据（没记档位）时兜底，
      // 避免切换引擎后整部历史的音色跟着变。
      const engine =
        message.ttsEngine === "doubao" || message.ttsEngine === "aliyun" || message.ttsEngine === "mock"
          ? message.ttsEngine
          : undefined;

      if (deps.quota) {
        const limit = Number(values.get("TTS_DAILY_CHAR_LIMIT"));
        const decision = await deps.quota.consume(
          "tts",
          message.content.length,
          Number.isFinite(limit) ? limit : 0,
        );
        if (!decision.allowed) {
          res.status(429).json({
            error: "tts_quota_exceeded",
            detail: `今日合成字符已达上界（${decision.used}/${decision.limit}），` +
              "调高后台 TTS_DAILY_CHAR_LIMIT 或置 0 解除后再试听",
          });
          return;
        }
      }

      let audio;
      try {
        audio = await synthesizeSpeech(values, message.content, { engine, fetchImpl: deps.fetchImpl });
      } catch (err) {
        console.error(`[console] 试听合成失败 message=${messageId}`, err);
        res.status(502).json({
          error: "synthesis_failed",
          detail: err instanceof TtsSynthesisError ? err.message : String(err),
        });
        return;
      }

      // 存一份，下次不再合成。存不下来也照样返回这次的字节，
      // 存储不可用不表现为"这条没法听"。
      if (deps.store) {
        const key = audioObjectKey(message.sessionId, messageId, kind, audio.mime);
        try {
          await deps.store.put(key, audio.bytes, audio.mime);
          await deps.audio.put({
            messageId,
            kind,
            engine: audio.engine,
            voice: audio.voice,
            // 逐字节不是当时播出去的那段——界面据此措辞，见 schema 注释。
            origin: "resynth",
            mime: audio.mime,
            bytes: audio.bytes.length,
            objectKey: key,
          });
        } catch (err) {
          console.error(`[console] 试听音频落库失败（本次仍返回字节）message=${messageId}`, err);
        }
      }

      res.setHeader("x-audio-origin", "resynth");
      res.setHeader("x-audio-engine", audio.engine);
      res.type(audio.mime).send(audio.bytes);
    },
  );

  return router;
}
