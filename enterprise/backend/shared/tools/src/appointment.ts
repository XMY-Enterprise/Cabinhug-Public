/**
 * `appointment` —— 试驾/维修预约与工单（§5 工具表 /
 * FL-15 F-15-10 / FL-20 F-20-12）。
 *
 * # 敏感动作，走 §8.4 的需确认档
 *
 * `sensitive: true` → 裁决点在 `agent-runtime/src/tools-endpoint.ts` 的
 * `POST /internal/guard/check`：需确认 → `interrupt()` 挂起该 HTTP 请求 →
 * 用户经网关 resume → 才真正提交。工具自己不判断该不该执行：
 * 那是安全边界的职责，分散到各工具里容易遗漏。
 *
 * # 外发个人信息必须能被列出来（F-26-09，P0）
 *
 * FL-15/FL-20 都写明确认弹窗要显示「将提供给门店的信息」。
 * 弹窗无法可靠推断工具会发什么，所以本工具把它做成
 * 入参的一等结构 `contact`，并提供 `describeDisclosure()` 由确认层直接渲染。
 *
 * 反过来说：不在 `contact` 里的字段一律不外发。工具没有别的出口能把
 * 用户信息带给门店，弹窗上列出的就是全部。
 *
 * # 数据来源是模拟系统
 *
 * §5 工具表原文"试驾 / 维修预约、工单，数据来源：模拟系统"。
 * 四件套的 `source.kind` 会如实标注（F-39-12），不会被当成真的下了单。
 */

import { defineExternalTool, ToolError, type ExternalTool } from "./external";
import { resolveContactSecret } from "./contact";

export type AppointmentKind = "test_drive" | "service";

/**
 * 外发给门店的联系信息。
 *
 * 字段是白名单：类型收窄到这三项，
 * 意味着 VIN、住址、行程、日历内容这些都没有出口能流到门店。
 */
export interface AppointmentContact {
  /** 称呼。用姓氏 + 先生/女士即可，不需要全名。 */
  name: string;
  /** 手机号——门店回拨用，是本次外发里最敏感的一项。 */
  phone: string;
  /** 备注，可选。由用户自己填，模型不代拟。 */
  note?: string;
}

export interface AppointmentArgs {
  kind: AppointmentKind;
  /** 门店标识（来自 car_catalog / 售后网点查询）。 */
  storeId: string;
  storeName: string;
  /** 期望时间（ISO 8601，带时区）。 */
  at: string;
  /** 口述联系方式。档案里有号时该走 memberId，不该走这条。 */
  contact?: AppointmentContact;
  /**
   * 走档案里已登记的联系方式（与 test_drive_book 同一形态）。
   *
   * 给了它就不需要也不应该再填 `contact`：真号由工具层按 id 自己去库里取，
   * 全程不经过模型。`contact_lookup` 只给后四位就是为了这条路成立。
   */
  memberId?: string;
  /** 由编排层注入，模型不用填。 */
  userId?: string;
  /** 试驾：车型；维修：预估项目。 */
  subject: string;
  /** 幂等键：同一次确认重复提交不该下两单。 */
  idempotencyKey?: string;
}

/** 交给后端的形状：联系人已解析定妥——后端是外发边界，不该再管"号从哪来"。 */
export interface AppointmentSubmission extends AppointmentArgs {
  contact: AppointmentContact;
}

export interface AppointmentResult {
  orderId: string;
  kind: AppointmentKind;
  storeName: string;
  at: string;
  status: "confirmed" | "pending_store";
  /** 本次实际外发给门店的字段名清单，随结果留档（F-20-13 / AC-26-*）。 */
  disclosed: string[];
}

/**
 * 渲染「将提供给门店的信息」。
 *
 * 确认弹窗与审计留档都读它，不各写一份，保证用户看到的与实际发出去的一致。
 *
 * 手机号在展示层做掩码：用户要确认的是"发不发手机号给这家店"，
 * 不需要在弹窗上再看一遍自己的号码，而弹窗可能出现在车机大屏上。
 */
export function describeDisclosure(contact: AppointmentContact): { field: string; value: string }[] {
  const items = [
    { field: "称呼", value: contact.name },
    { field: "手机号", value: maskPhone(contact.phone) },
  ];
  if (contact.note?.trim()) items.push({ field: "备注", value: contact.note.trim() });
  return items;
}

/** 中国大陆手机号掩码：保留前 3 后 4。非 11 位的原样打码到只剩首尾。 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11) return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  if (digits.length <= 2) return "*".repeat(digits.length);
  return `${digits[0]}${"*".repeat(digits.length - 2)}${digits.slice(-1)}`;
}

const PHONE_RE = /^1[3-9]\d{9}$/;

export interface AppointmentBackend {
  submit(args: AppointmentSubmission): Promise<{ orderId: string; status: AppointmentResult["status"] }>;
}

/**
 * 模拟门店系统（§5 指定的数据来源形态）。
 *
 * 按 `idempotencyKey` 去重：HITL 确认后网络抖动重发，不能下两单。
 * 预约是有副作用的动作，重复提交要打电话取消。
 */
export function createMockAppointmentBackend(): AppointmentBackend {
  const placed = new Map<string, { orderId: string; status: AppointmentResult["status"] }>();
  let seq = 0;
  return {
    async submit(args) {
      const key = args.idempotencyKey ?? `${args.kind}:${args.storeId}:${args.at}:${args.contact.phone}`;
      const existing = placed.get(key);
      if (existing) return existing;
      seq += 1;
      const record = {
        orderId: `${args.kind === "test_drive" ? "TD" : "SV"}-${String(seq).padStart(6, "0")}`,
        // 试驾当场确认，维修要门店回执——两者的真实语义不同，不统一成 confirmed
        status: (args.kind === "test_drive" ? "confirmed" : "pending_store") as AppointmentResult["status"],
      };
      placed.set(key, record);
      return record;
    },
  };
}

/**
 * 走门店系统的后端。
 *
 * # 维修不用 slotId
 *
 * 服务中心没有"可预约时段"这个概念——维修要先看车才知道多久。
 * 所以 `appointment` 的 schema 仍收时间字符串，
 * 这一层只校验"这个 storeId 是不是真的存在"。
 *
 * # 防止维修预约编造门店
 *
 * storeId 查不到就抛不可重试的错，让模型回去用 `dealer_stores?type=service` 查。
 */
export function createDealerAppointmentBackend(dealer: {
  stores(a: { model: string; type?: "experience" | "service" }): Promise<{
    stores: Array<{ storeId: string; name: string }>;
  }>;
  book(a: {
    slotId: string;
    model: string;
    contact: { name: string; phone: string; note?: string };
    idempotencyKey?: string;
  }): Promise<{ orderId: string; status: string }>;
}): AppointmentBackend {
  return {
    async submit(args) {
      // 维修网点是另一套（`type=service`）——拿体验店去做维修预约是错的，
      // 而它不会报错，只会让车主开到一家不修车的店门口。
      const { stores } = await dealer.stores({ model: args.subject, type: "service" });
      const known = stores.some((s) => s.storeId === args.storeId);
      if (!known) {
        throw new ToolError(
          "appointment",
          "invalid",
          `门店 ${args.storeId} 不在服务网点里——请先用 dealer_stores（type=service）查真实的服务中心，不要自己填门店`,
          false,
        );
      }
      // 维修没有 slotId，用「门店 + 时间」拼一个稳定键交给门店系统去重。
      const r = await dealer.book({
        slotId: `${args.storeId}#${args.at}`,
        model: args.subject,
        contact: args.contact,
        idempotencyKey: args.idempotencyKey ?? `${args.storeId}:${args.at}:${args.contact.phone}`,
      });
      return { orderId: r.orderId, status: "pending_store" };
    },
  };
}

/**
 * 走 4S 维修系统的后端。
 *
 * 维修预约落在独立的维修系统（而不是 mock-dealer 的 `type=service` 门店）：
 * schema 与披露与门店后端相同，只是校验与落单的对象不同。
 *
 * # 时间必须落在维修站的进厂窗口上
 *
 * 维修站每天 09/11/14/16 点四个进厂窗口（mock-repair 的固定营业形态，
 * 不是伪随机时段）。用户说"明天上午十点"时模型拍 10:00 会被拒，错误消息
 * 直接给出窗口清单——让模型回去跟用户对时间，而不是擅自挪到别的时刻
 * （擅自挪单等于替用户改了约定）。
 */
export function createRepairAppointmentBackend(repair: {
  stations(a: { city?: string }): Promise<{ stations: Array<{ stationId: string; name: string }> }>;
  book(a: {
    vin: string;
    slotId: string;
    items?: string[];
    contact: { name: string; phone: string };
    idempotencyKey?: string;
  }): Promise<{ orderId: string; status: string }>;
}): AppointmentBackend {
  return {
    async submit(args) {
      if (args.kind !== "service") {
        // 试驾有自己的整条链路（dealer_slots + test_drive_book），不该绕道走这里。
        throw new ToolError(
          "appointment",
          "invalid",
          "试驾预约请走 dealer_stores → dealer_slots → test_drive_book，这条通道只处理维修",
          false,
        );
      }
      const { stations } = await repair.stations({});
      const known = stations.some((s) => s.stationId === args.storeId);
      if (!known) {
        throw new ToolError(
          "appointment",
          "invalid",
          `维修站 ${args.storeId} 不存在——请先用 repair_history/维修站查询拿真实的 stationId，不要自己填`,
          false,
        );
      }
      // subject 在维修语境下是"预估项目"；VIN 从 note 之外没有入口，
      // 由编排层把当前车辆注入 subject 前缀（形如 "VIN:xxx 机油保养"）或走档案。
      // 这里如实拆：取不到 VIN 时用空占位让维修系统以联系人为准建单。
      const vinMatch = /VIN[:：]\s*([A-HJ-NPR-Z0-9]{11,17})/i.exec(args.subject);
      const r = await repair.book({
        vin: vinMatch?.[1] ?? "UNKNOWN-VIN",
        slotId: `${args.storeId}#${args.at}`,
        items: [args.subject.replace(/VIN[:：]\s*[A-HJ-NPR-Z0-9]{11,17}\s*/i, "").trim() || "常规保养"],
        contact: { name: args.contact.name, phone: args.contact.phone },
        idempotencyKey: args.idempotencyKey ?? `${args.storeId}:${args.at}:${args.contact.phone}`,
      });
      return { orderId: r.orderId, status: "pending_store" };
    },
  };
}

export function createAppointmentTool(
  backend: AppointmentBackend,
): ExternalTool<AppointmentArgs, AppointmentResult> {
  return defineExternalTool<AppointmentArgs, AppointmentResult>({
    name: "appointment",
    provider: "mock-dealer",
    // 有后果但合法的动作 → §8.4 需确认档，权限门在 tools-endpoint 统一拦。
    sensitive: true,
    timeoutMs: 10_000,
    // 有副作用，绝不重试：重试一次预约就是下两次单。
    retries: 0,

    real: async (args) => {
      if (!args.storeId?.trim() || !args.storeName?.trim()) {
        throw new ToolError("appointment", "invalid", "缺少门店信息", false);
      }
      if (Number.isNaN(Date.parse(args.at))) {
        throw new ToolError("appointment", "invalid", `预约时间不是合法的 ISO 时间：${args.at}`, false);
      }

      /*
       * 联系人解析：memberId 优先——与 test_drive_book 同语义
       * （dealer.ts:320-341）。真号只在本函数与后端之间流动，不进返回值。
       */
      const contact =
        args.memberId && args.userId
          ? await resolveContactSecret(args.userId, args.memberId)
          : args.contact;
      if (args.memberId && args.userId && !contact) {
        throw new ToolError(
          "appointment",
          "invalid",
          "档案里没有这位成员的登记手机号——请让车主口述联系方式，或先用 contact_update 补录",
          false,
        );
      }
      if (!contact?.name?.trim()) {
        throw new ToolError("appointment", "invalid", "缺少称呼——门店需要知道找谁", false);
      }
      if (!PHONE_RE.test(contact.phone.replace(/\D/g, ""))) {
        // 号码错了门店打不通，用户以为约上了。这条必须硬失败，不能"尽力提交"。
        throw new ToolError("appointment", "invalid", "手机号格式不正确，门店将无法回拨", false);
      }

      const { orderId, status } = await backend.submit({ ...args, contact });
      return {
        orderId,
        kind: args.kind,
        storeName: args.storeName,
        at: args.at,
        status,
        // 留档的是字段名不是值：审计表里不该再存一份手机号（与 audit_logs 同一条纪律）
        disclosed: describeDisclosure(contact).map((d) => d.field),
      };
    },

    mock: (args) => ({
      orderId: "MOCK-000000",
      kind: args.kind,
      storeName: args.storeName,
      at: args.at,
      status: "confirmed",
      disclosed: args.contact ? describeDisclosure(args.contact).map((d) => d.field) : ["称呼", "手机号"],
    }),
  });
}

/**
 * 默认走内存 mock；装配层可换成 dealer 后端。
 *
 * 用可替换的引用而不是模块加载时定死：加载时固化的默认实例若未被装配层替换，
 * 任何调用都会抛 unconfigured。
 */
let currentBackend: AppointmentBackend = createMockAppointmentBackend();

export function setAppointmentBackend(b: AppointmentBackend): void {
  currentBackend = b;
}

export const appointmentTool = createAppointmentTool({
  submit: (args) => currentBackend.submit(args),
});
