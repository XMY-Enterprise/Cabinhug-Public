/**
 * 上传策略：句柄生成、类型与大小白名单。
 *
 * 纯函数，零依赖：上传规则可以脱离网络与对象存储被断言。
 */

import { randomBytes } from "node:crypto";

import { TURN_ATTACHMENT_LIMITS, normalizeMime } from "@cabinhug/shared";

import { sniffContentType } from "./sniff";

export type AttachmentKind = "image" | "audio" | "pdf" | "video";

/**
 * 白名单。超限拒绝且提示清晰（F-09-10）：提示要让用户知道该换照片还是换网络，
 * 而不是笼统的"上传失败"。
 */
export const LIMITS: Record<AttachmentKind, { types: readonly string[]; maxBytes: number }> = {
  // 500KB 是端上压缩的目标（F-09-03）；服务端放到 8MB，
  // 端上压缩未生效时也不丢弃用户拍的照片（F-09-05）。
  //
  // 格式面：相册里能选出来的都收。HEIC / AVIF / BMP / TIFF 视觉模型读不了，
  // 但不在这里拒，建轮时由 `normalizeImageForModel` 转成 JPEG（ACR-027）。
  image: {
    types: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/avif", "image/gif", "image/bmp", "image/tiff"],
    maxBytes: 8 * 1024 * 1024,
  },
  // 留档回听用途，与 ASR 路径无关。60s 上限对应端上的单条录音时长。
  audio: { types: ["audio/wav", "audio/mpeg", "audio/mp4", "audio/aac", "audio/ogg"], maxBytes: 10 * 1024 * 1024 },
  pdf: { types: ["application/pdf"], maxBytes: 32 * 1024 * 1024 },
  // 视频（ACR-027）：iPhone 相册经 WebView 文件选择器导出的 60 秒 720p 约 15–40 MB；
  // 上限与 `@cabinhug/shared` 的 `TURN_ATTACHMENT_LIMITS.videoMaxBytes` 同一个数（端上预检用那份）。
  // 时长不在这里卡：超过 60 秒的照收，网关解析时只取前 60 秒并如实写进上下文，
  // 不要求用户回去剪辑。
  video: { types: ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v", "video/3gpp"], maxBytes: TURN_ATTACHMENT_LIMITS.videoMaxBytes },
};

export interface PolicyVerdict {
  ok: boolean;
  kind?: AttachmentKind;
  /**
   * 归一化后的 MIME（别名归并 + 魔数纠正）。落库与转发都用它，不用端上声明的值：
   * 后者可能为空、是别名，或是改过扩展名的。
   */
  contentType?: string;
  /** 拒绝理由。面向用户，可直接展示，所以写的是"怎么办"而不是"什么错了"。 */
  reason?: string;
  /** 机器可读的拒绝码，供端上决定 UI 分支。 */
  code?: "type_unsupported" | "too_large" | "empty";
}

/**
 * 判定一个上传是否被接受。
 *
 * # 视频
 *
 * 视频是白名单里的一项：每轮一段、只分析前 60 秒、抽帧成帧序图 + 分段转写（ACR-027）。
 * 不在白名单里的容器（如 `video/x-msvideo`）按 `type_unsupported` 拒绝并列出支持范围。
 */
export function checkUpload(contentType: string, bytes: number, body?: Uint8Array | Buffer): PolicyVerdict {
  if (bytes <= 0) {
    return { ok: false, code: "empty", reason: "文件是空的，可能没拍上或传输中断了，请重试。" };
  }

  const ct = resolveContentType(contentType, body);

  for (const [kind, limit] of Object.entries(LIMITS) as Array<[AttachmentKind, typeof LIMITS.image]>) {
    if (!limit.types.includes(ct)) continue;
    if (bytes > limit.maxBytes) {
      return {
        ok: false,
        code: "too_large",
        reason: `文件 ${(bytes / 1024 / 1024).toFixed(1)}MB，超过了 ${limit.maxBytes / 1024 / 1024}MB 上限。` +
          (kind === "image" ? "可以拍近一点、只拍关键部位，通常会小很多。" : kind === "video" ? "试试只拍关键的那十几秒，或在相册里先剪短一点。" : "试试缩短时长。"),
      };
    }
    return { ok: true, kind, contentType: ct };
  }

  return {
    ok: false,
    code: "type_unsupported",
    contentType: ct,
    reason: `暂不支持 ${ct || "这种格式"}。目前可以传照片（JPEG/PNG/WebP/HEIC/HEIF/AVIF/GIF/BMP/TIFF）、视频（MP4/MOV/WebM，1 分钟以内）、录音和 PDF。`,
  };
}

/**
 * 判定文件格式：魔数优先，认不出才用端上声明的值（归一化后）。
 *
 * 声明值在两种常见情形下是错的：相册给不出 MIME（空 / octet-stream），以及扩展名与
 * 内容不符。而这个值决定能不能进白名单、回看时怎么渲染、要不要为模型转码。
 */
export function resolveContentType(declared: string, body?: Uint8Array | Buffer): string {
  const sniffed = body ? sniffContentType(body) : null;
  return sniffed ?? normalizeMime(declared);
}

/**
 * 引用句柄（F-09-02）。
 *
 * 不可枚举、不可猜测是隐私约束：句柄一旦可推导，由自己的句柄就能推出别人的。
 *
 * 因此：192 bit 随机（base64url 32 字符），不含时间戳、不含序号、
 * 不含用户 id 的任何投影。UUIDv7 之类有序 id 会泄露上传时间，
 * 也让相邻上传变得可猜。
 *
 * 句柄本身不是授权凭证，取件时仍比对归属（见 `router.ts`）。
 */
export function newHandle(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * 对象存储的 key。
 *
 * 不用原始文件名：它由端上可控，可能含 `../` 或超长路径。
 * 按 `kind/句柄` 组织：对象存储不需要人类可读的目录结构，可读结构意味着可遍历。
 */
export function objectKeyFor(kind: AttachmentKind, handle: string): string {
  return `${kind}/${handle}`;
}
