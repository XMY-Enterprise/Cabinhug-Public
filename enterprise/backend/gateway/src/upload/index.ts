/**
 * 多模态上传（§3 / FL-09）。
 *
 * 用户拍的照片与同时说的话要一起到达 Agent，本模块提供这条通路。
 *
 * # 三条硬性质
 *
 * 1. 网关只接收与转存，不解析内容（AC-09-8）。见 `storage.ts` 的说明。
 * 2. 句柄不可枚举（F-09-02），且句柄不是授权凭证，取件仍比对归属：
 *    猜不到，猜到了也拿不到别人的。
 * 3. 不静默丢弃用户拍的照片（F-09-05）。幂等键让弱网重传不产生重复记录，
 *    重传同一个幂等键直接返回原句柄，端上因此可以放心重试。
 *
 * # 大文件不进 LLM 上下文（§3）
 *
 * 上传返回的是句柄，Agent 拿到的也是句柄，需要看内容时自行去取。
 * 把图片 base64 塞进上下文会同时推高成本、占满上下文窗口。
 */

import { Router, type Response } from "express";

import type { AttachmentRepository } from "@cabinhug/db";

import type { AuthedRequest } from "../auth";
import { photoOffBody } from "../http/capabilities";
import { checkUpload, newHandle, objectKeyFor, type AttachmentKind } from "./policy";
import type { ObjectStore } from "./storage";

export { createObjectStore, type ObjectStore, type StorageConfig } from "./storage";
export { checkUpload, newHandle, objectKeyFor, LIMITS, type AttachmentKind, type PolicyVerdict } from "./policy";

/** 单次请求体上限：比最大的白名单项（视频 64 MiB）再宽一点，防止在读完之前就被截断。 */
const BODY_LIMIT = 72 * 1024 * 1024;

async function readBody(req: AuthedRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as unknown as AsyncIterable<Buffer>) {
    total += chunk.length;
    // 提前掐断，不把超过 BODY_LIMIT 的内容读进内存。
    // 这一条与白名单无关，它防的是恶意的超大 body。
    if (total > BODY_LIMIT) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export interface UploadRouterOptions {
  /** 拍照问诊是否关闭（ACR-056）。不注入 = 开着；关闭时照片与视频一律不收，音频与 PDF 照常。 */
  photoOff?: () => Promise<boolean>;
}

export function createUploadRouter(store: ObjectStore, repo: AttachmentRepository, opts: UploadRouterOptions = {}): Router {
  const router = Router();

  /**
   * 上传。用原始 body + 头部元数据，不用 multipart：
   * 一次请求只传一个文件，引入 multipart 解析依赖会模糊"不解析内容"这条边界。
   *
   *   POST /v1/session/:id/attachments
   *   headers: content-type, x-filename?, x-turn-id?, x-idempotency-key?
   */
  router.post("/v1/session/:id/attachments", async (req: AuthedRequest, res: Response) => {
    const sessionId = String(req.params.id);
    // 车辆级 token 无归属，附件必须挂在具体的人名下。
    const userId = req.userId;
    if (!userId) {
      res.status(400).json({ error: "active_user_required" });
      return;
    }
    const contentType = String(req.headers["content-type"] ?? "");
    const idempotencyKey = header(req, "x-idempotency-key");

    // 能力开关（ACR-056）：按声明的类型先判一次，不把几十 MB 的视频读进内存再拒；
    // 声明不可信（相册给 octet-stream），读完按魔数纠正后的 kind 再判一次，见下方。
    const photoOff = (await opts.photoOff?.()) === true;
    if (photoOff && /^\s*(image|video)\//i.test(contentType)) {
      res.status(403).json(photoOffBody);
      return;
    }

    // 幂等最先判：弱网重传直接返回原句柄，不产生第二条记录（F-09-05）。
    if (idempotencyKey) {
      const existing = await repo.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        res.status(200).json({ handle: existing.id, kind: existing.kind, bytes: existing.bytes, deduped: true });
        return;
      }
    }

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      res.status(413).json({ error: "too_large", reason: "文件太大，传输被中断了。" });
      return;
    }

    // 魔数与声明一起判：相册给不出 MIME 的 HEIC 不被当成"不支持的格式"拒掉。
    const verdict = checkUpload(contentType, body.length, body);
    if (!verdict.ok) {
      // 拒绝一律带面向用户的 reason（F-09-10）：写的是"怎么办"，不是"什么错了"。
      res.status(verdict.code === "too_large" ? 413 : 415).json({
        error: verdict.code,
        reason: verdict.reason,
      });
      return;
    }

    const kind = verdict.kind as AttachmentKind;
    if (photoOff && (kind === "image" || kind === "video")) {
      res.status(403).json(photoOffBody);
      return;
    }
    // 落库用纠正后的 MIME：回看渲染与"要不要为模型转码"都读这一列。
    const resolvedType = verdict.contentType ?? contentType.split(";")[0].trim().toLowerCase();
    const handle = newHandle();
    const objectKey = objectKeyFor(kind, handle);

    // 先落对象存储再写元数据：反过来的话，元数据存在而文件不在，
    // 用户会看到一个点开就 404 的附件。
    await store.put(objectKey, body, resolvedType);
    await repo.create({
      id: handle,
      sessionId,
      turnId: header(req, "x-turn-id"),
      userId,
      kind,
      contentType: resolvedType,
      bytes: body.length,
      filename: decodeFilename(header(req, "x-filename")),
      objectKey,
      idempotencyKey,
    });

    res.status(201).json({ handle, kind, bytes: body.length, contentType: resolvedType });
  });

  /**
   * 取件。句柄不是授权凭证，这里比对归属。
   *
   * 回看以句柄向对象存储取原件，不依赖端上缓存（F-09-09）：
   * 端上缓存会被 LRU 淘汰，而用户可能很久之后才回看。
   */
  router.get("/v1/attachments/:handle", async (req: AuthedRequest, res: Response) => {
    const handle = String(req.params.handle);
    // 车辆级 token 无归属，附件必须挂在具体的人名下。
    const userId = req.userId;
    if (!userId) {
      res.status(400).json({ error: "active_user_required" });
      return;
    }

    const meta = await repo.get(handle);
    // 归属不符与不存在返回同一个 404：区分二者等于向枚举者确认句柄存在。
    if (!meta || meta.userId !== userId) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const obj = await store.get(meta.objectKey);
    if (!obj) {
      res.status(410).json({ error: "gone", reason: "文件已不在存储中。" });
      return;
    }

    res.setHeader("content-type", meta.contentType);
    res.setHeader("content-length", String(obj.body.length));
    // 一律作为附件下载，不内联渲染：用户上传的 HTML/SVG 内联渲染会变成 XSS。
    res.setHeader("content-disposition", "attachment");
    res.status(200).end(Buffer.from(obj.body));
  });

  /** 某轮 / 某会话的附件列表——历史回看的入口。 */
  router.get("/v1/session/:id/attachments", async (req: AuthedRequest, res: Response) => {
    const sessionId = String(req.params.id);
    // 车辆级 token 无归属，附件必须挂在具体的人名下。
    const userId = req.userId;
    if (!userId) {
      res.status(400).json({ error: "active_user_required" });
      return;
    }
    const turnId = typeof req.query.turnId === "string" ? req.query.turnId : undefined;
    res.json({ attachments: await repo.list(sessionId, userId, turnId) });
  });

  return router;
}

function header(req: AuthedRequest, name: string): string | undefined {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim().length > 0 ? s.trim() : undefined;
}

/**
 * 文件名走 percent-encoding。
 *
 * HTTP 头是 ByteString（每字符 ≤ 255），"故障灯.png"这类中文名直接放进头里，
 * fetch 在客户端就会抛错。所以约定 `x-filename` 是 `encodeURIComponent` 后的值。
 *
 * 解码失败不报错、退回原值：文件名只用于展示，
 * 不因文件名编码问题拒收用户拍的照片（F-09-05）。
 */
function decodeFilename(raw?: string): string | undefined {
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
