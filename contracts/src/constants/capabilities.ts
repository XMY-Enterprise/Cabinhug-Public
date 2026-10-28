/**
 * 能力开关（ACR-056）：部署形态可以关掉的能力，闭集。
 *
 * 单机版（REQ-0004 / ARCH-002）首版只做行程、只配三组凭据（DeepSeek、阿里云审核、高德），
 * 依赖其他凭据、知识库或 mock 的能力要能按部署关掉，而不是半残运行。
 *
 * 消费方共用这一份：`@cabinhug/db` 的配置注册表（`CABINHUG_CAPABILITIES_OFF` 的取值校验）、
 * 网关（拒收照片、视频与语音，`GET /v1/capabilities` 下发）、编排层（路由收口为固定话术）、
 * 工具表（工具声明所服务的能力，全部关闭时剔除，ACR-059）、端上（按下发结果隐藏入口，ACR-057）。
 *
 * 只有「关」的清单，没有「开」的清单：缺省什么都不关，分离部署的行为不因本表多一项而变。
 */

export const CAPABILITIES = [
  /** 照片与视频进对话（拍照问诊）。依赖视觉检测与手册图标目录。 */
  "photo-diagnosis",
  /** 用车助手问答（路由目标 ownership）。依赖 `vehicle-manuals` 知识库。 */
  "ownership-qa",
  /** 售后问答与维修预约（路由目标 service）。依赖 `repair-kb` 知识库与门店系统。 */
  "service-qa",
  /** 购车顾问（路由目标 buying）：车型库、报价、贷款与保险测算。依赖 `car-catalog` 知识库、门店与保险系统（ACR-059）。 */
  "buying-advice",
  /** 试驾预约（路由目标 testDrive）。依赖门店系统（ACR-059）。 */
  "test-drive",
  /** 座舱控制与车内媒体（路由目标 cabin）。依赖座舱系统（ACR-059）。 */
  "cabin-control",
  /** 语音识别与播报（ASR / TTS）。依赖语音凭据（ACR-059）。 */
  "voice",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function isCapability(v: string): v is Capability {
  return (CAPABILITIES as readonly string[]).includes(v);
}

function tokensOf(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(/[\s,，]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * 解析配置值：逗号或空白分隔，大小写敏感。
 *
 * 不认识的项丢弃而不是抛错：注册表的 `validate` 在后台写入时已经拦过，
 * 剩下的只可能来自手写的环境变量；为一个错字让网关与编排层起不来，代价比少关一项大。
 * 错字由 `unknownCapabilities` 报给启动日志。
 */
export function parseCapabilitiesOff(raw: string | null | undefined): Set<Capability> {
  return new Set(tokensOf(raw).filter(isCapability));
}

/** 配置值里不认识的项（注册表校验与启动告警用）。 */
export function unknownCapabilities(raw: string | null | undefined): string[] {
  return tokensOf(raw).filter((t) => !isCapability(t));
}

/** `GET /v1/capabilities` 的响应形状。只下发关掉了什么，不下发任何凭据。 */
export interface CapabilitiesPayload {
  off: Capability[];
  /** 端上多久复查一次（毫秒）。 */
  refreshMs: number;
}

/**
 * 端上解析下发结果。形状不对返回 undefined，调用方沿用上一次的值：
 * 旧网关没有这个端点、或网络抖动时，不能因此把入口藏起来。
 */
export function capabilitiesFromPayload(json: unknown): Set<Capability> | undefined {
  if (!json || typeof json !== "object") return undefined;
  const off = (json as { off?: unknown }).off;
  if (!Array.isArray(off)) return undefined;
  return new Set(off.filter((v): v is Capability => typeof v === "string" && isCapability(v)));
}
