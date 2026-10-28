/**
 * 演示数据预置与一键重置。
 *
 * # 与个性化演示的关系
 *
 * §6 的双路检索里，RAG 那一路答的是"锂电池为什么会衰减"，⑥那一路答的是
 * "你这辆车掉得正不正常"。`trips` / `vehicles` 为空时第二路恒返回空，
 * 系统只能回答"给不出个性化结论"。
 *
 * # 预置数据必须可识别、可清理
 *
 * 以命名本身判定：
 *  - 车辆 VIN 以 `DEMO` 开头；保养/维修记录经 `onDelete: Cascade` 跟着走
 *  - 行程 id 以 `demo-trip-` 开头
 *  - Mem0 记忆 metadata 带 `provenance: "simulated"` + `seed: "demo"`
 * `--reset` 只删这些前缀，不触及真实数据；真实数据也不会被误判成预置。
 *
 * # 模拟数据必须标注
 *
 * 保养/维修记录的 `source` 字段用于表明记录的可信度，
 * 预置数据一律写成 `模拟（demo:seed）`。车辆与行程表没有这个字段，
 * 因此由前缀 + 演示大屏的"预置数据"面板承担可见性。
 *
 * # 为什么是这两辆车
 *
 * Model Y 在三个数据集里都有资料（手册 / 保养 / 参数），是主线用车；
 * 2017 迈锐宝是燃油车、有厂商标称保养周期，用来演"同一个问题、两辆车、
 * 检索到的是各自的手册"（F-23-07 车型限定），这需要两辆车。
 *
 * 运行：
 *   corepack pnpm demo:seed          # 预置（幂等，可重复跑）
 *   corepack pnpm demo:seed --status # 只看当前预置了什么
 *   corepack pnpm demo:reset         # 一键清理
 */

import { createVehicleRepository, getPrisma } from "@cabinhug/db";
import { getMemoryClient } from "@cabinhug/memory";
import { createCabinClient, createHttpCabinBackend, type CabinBindingStore, type CabinClient } from "@cabinhug/tools";

// ── 可识别前缀：reset 的唯一依据 ────────────────────────────

export const DEMO_VIN_PREFIX = "DEM0";   // 是数字 0 不是字母 O：VIN 标准排除 I/O/Q（见下）
/** 旧前缀（VIN 含字母 O，非法）。只用于 reset 清理，不再产出。 */
const LEGACY_VIN_PREFIX = "DEMO";
export const DEMO_TRIP_PREFIX = "demo-trip-";
/** 预置数据的归属用户；与网关 demoAuth 的 `demo-user` 一致。 */
export const DEMO_USER = "demo-user";
/** 写进 maintenance/repair 的 `source`，在后台与回答里都会展示。 */
export const SIMULATED_SOURCE = "模拟（demo:seed）";

const DAY = 86_400_000;

// 下面两个 VIN 里的 0 是数字零，MAL1BU 里的 1 是数字一：
// VIN 标准排除字母 I/O/Q（与 1/0 易混），`isValidVin` 按 /^[A-HJ-NPR-Z0-9]{17}$/ 拦。
// VIN 非法时对演示车的任何档案写入（补录、问诊留档、里程推进）都会静默失败。
// demo-seed.test.ts 校验这两个值。
/** 主线用车：纯电，三个数据集都有它的资料。 */
const VIN_EV = "DEM00SEED0M0DELY1";
/** 对照用车：燃油，有厂商标称保养周期。 */
const VIN_ICE = "DEM00SEED0MAL1BU1";

// ── 行程流水：按夏季温度生成，不编低温数据 ─────────────
//
// 为演示"低温续航衰减"而塞入 ≤5℃ 的行程，属于拿假数据冒充个性化（F-16-08 禁止）。
// 夏季温度下 `aggregate` 得出 `lowTempRangeKm: undefined`，系统会如实说"没有低温样本"。

interface SeedTrip {
  id: string;
  startedAt: number;
  endedAt: number;
  distanceKm: number;
  roadType: "city" | "highway" | "mixed";
  ambientTempC: number;
  observedRangeKm?: number;
  charge?: { startSoc: number; endSoc: number; at: number };
}

/**
 * 生成 45 天流水。
 *
 * 确定性（由 `now` 与序号推导，不用随机数）：演示需要重复跑出同一份数据。
 */
export function buildTrips(now: number): SeedTrip[] {
  const trips: SeedTrip[] = [];
  // 锚在当地零点，不是"当前时刻减 N 天"。
  // 后者会把 22 点充电算成次日 12 点，`commonChargeHours` 给出 [12]，
  // 与这份数据要支撑的"夜间谷电充电"结论不符。
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const base = midnight.getTime();

  for (let d = 44; d >= 0; d -= 1) {
    const dayStart = base - d * DAY;
    const weekday = new Date(dayStart).getDay();
    const isWeekend = weekday === 0 || weekday === 6;

    /*
     * 工作日通勤两段；周末一段长途，隔周才有。
     *
     * 长途那一段是这份数据里唯一带实测续航的，其落点必须与播种日是周几无关。
     * 按 `d % 14` 选日会只落在两个固定的星期几上，多数播种日生成不出长途，
     * `observedRangeKm` 为零条，助手会回答"没有可用的实测续航数据"。
     *
     * 因此按「第几个 7 天窗口」定：每个整窗恰含一个周六，隔窗取一次。
     */
    const legs: Array<Omit<SeedTrip, "id">> = [];
    const temp = 27 + ((d * 7) % 11); // 27~37℃，夏天
    if (!isWeekend) {
      const out = dayStart + 8 * 3_600_000;
      const back = dayStart + 19 * 3_600_000;
      legs.push({
        startedAt: out,
        endedAt: out + 42 * 60_000,
        distanceKm: 18.4,
        roadType: "city",
        ambientTempC: temp,
      });
      legs.push({
        startedAt: back,
        endedAt: back + 51 * 60_000,
        distanceKm: 18.9,
        roadType: "city",
        ambientTempC: temp - 2,
      });
    } else if (weekday === 6 && Math.floor(d / 7) % 2 === 0) {
      const out = dayStart + 9 * 3_600_000;
      legs.push({
        startedAt: out,
        endedAt: out + 172 * 60_000,
        distanceKm: 183.6,
        roadType: "highway",
        ambientTempC: temp,
        // 满电折算续航：45 天里由 452 缓慢降到 418。
        // 这不是故障级衰减，让系统能给出"属于正常范围"的有依据的结论。
        observedRangeKm: 418 + Math.round((d / 44) * 34),
      });
    }

    // 充电：工作日隔天一次，固定在夜间谷电时段（22 点），
    // 使 `commonChargeHours` 有稳定结论。
    if (!isWeekend && d % 2 === 0 && legs.length > 0) {
      legs[legs.length - 1].charge = {
        startSoc: 34 + (d % 9),
        endSoc: 90,
        at: dayStart + 22 * 3_600_000,
      };
    }

    legs.forEach((leg, i) => {
      // 今天尚未发生的那几段不生成：未来行程会使 staleDays
      // （最后一条流水与现在之差）计算错误。
      if (leg.endedAt > now) return;
      trips.push({ id: `${DEMO_TRIP_PREFIX}${44 - d}-${i}`, ...leg });
    });
  }
  return trips;
}

// ── 车辆档案与只追加记录 ────────────────────────────────────

function vehicles(now: number) {
  return [
    {
      vin: VIN_EV,
      ownerId: DEMO_USER,
      model: "Model Y",
      modelYear: 2023,
      // 能源类型必须显式给：编排层要靠它决定问"续航余量"还是"油耗与加油点"。
      energyType: "bev",
      purchasedAt: new Date(now - 780 * DAY),
      odometerKm: 41_280,
      // 特斯拉是条件式保养，没有厂商标称的公里周期。
      // 这里留空：下游按通用值推算并标注"厂商未给周期"；填具体数值会伪造厂商口径。
      maintenanceIntervalKm: null,
      isDefault: true,
    },
    {
      vin: VIN_ICE,
      ownerId: DEMO_USER,
      model: "迈锐宝",
      modelYear: 2017,
      energyType: "icev",
      purchasedAt: new Date(now - 3_100 * DAY),
      odometerKm: 118_640,
      maintenanceIntervalKm: 10_000,
      isDefault: false,
    },
  ];
}

/**
 * 一辆预置车的 upsert 载荷。单独导出以便断言"已存在的车不覆盖里程"。
 */
export function vehicleUpsertPayload(v: ReturnType<typeof vehicles>[number], now: Date) {
  const { vin, isDefault: _isDefault, odometerKm, ...rest } = v;
  return {
    where: { vin },
    /*
     * 新建时连时刻一起写。缺 `odometerAt` 时新鲜度体检恒判 `unknown`，
     * 补录询问会在每个合适的轮次重复触发，不收敛。
     */
    create: { vin, ...rest, odometerKm, odometerAt: now },
    /*
     * 已存在的车不碰里程（`rest` 不含 odometerKm），与"已有默认车就不抢"同理。
     *
     * 这里是绕过仓储层的裸 upsert，不经 `advanceOdometerWithin` 的"只前进"约束；
     * 若写入里程，每次 `demo:seed`（评测前会跑）都会把用户录入的里程覆盖回预置值。
     *
     * seed 负责准备演示环境，不覆盖用户录入的数据。
     * 回到预置状态用显式的 `demo:reset`。
     */
    update: rest,
  };
}

function maintenance(now: number) {
  return [
    { vin: VIN_EV, at: new Date(now - 210 * DAY), odometerKm: 32_100, items: "空调滤芯更换、轮胎换位" },
    { vin: VIN_ICE, at: new Date(now - 400 * DAY), odometerKm: 104_500, items: "机油机滤、空气滤芯" },
    { vin: VIN_ICE, at: new Date(now - 95 * DAY), odometerKm: 113_200, items: "机油机滤、刹车油更换" },
  ];
}

function repairs(now: number) {
  return [
    {
      vin: VIN_ICE,
      at: new Date(now - 60 * DAY),
      odometerKm: 116_050,
      symptom: "怠速时空调不凉，跑起来恢复",
      resolution: "冷凝器翅片清洗；冷媒压力正常未补加",
    },
  ];
}

// ── Mem0 ②③：偏好与情景 ────────────────────────────────────
//
// 只写能从上面这批流水里推出的结论，不写系统未观察到的事实（如"用户喜欢开山路"）。

const PREFERENCES = [
  {
    content: "习惯夜间 22 点左右在家充电，充到 90% 停",
    meta: { domain: "charging", confidence: 0.82 },
  },
  {
    content: "工作日通勤以市区路况为主，单程约 18 公里",
    meta: { domain: "commute", confidence: 0.9 },
  },
];

const EPISODES = [
  {
    content: "两个月前迈锐宝出现怠速空调不凉，清洗冷凝器后恢复，未补加冷媒",
    daysAgo: 60,
    meta: { subType: "incident" as const, vin: VIN_ICE },
  },
  {
    content: "近期长途多走高速，单程约 180 公里，中途不充电",
    daysAgo: 12,
    meta: { subType: "trip" as const, vin: VIN_EV },
  },
];

// ── 执行 ────────────────────────────────────────────────────

interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function seedPostgres(now: number): Promise<StepResult[]> {
  const prisma = getPrisma();
  const out: StepResult[] = [];

  /*
   * 车辆档案：先写本体（不含 isDefault），再经仓储设默认车。
   *
   * 直接 upsert `isDefault: true` 不会清掉旧的默认车，同一 owner 下会出现两辆默认车，
   * `listByOwner` 退化为按购入日期排序，助手会针对错误的车辆作答。
   *
   * `setDefault` 把"先清后设"收进一个事务，是唯一修改 isDefault 的入口。
   */
  const vs = vehicles(now);
  let defaultVin: string | undefined;
  const seededAt = new Date();
  for (const v of vs) {
    if (v.isDefault) defaultVin = v.vin;
    await prisma.vehicle.upsert(vehicleUpsertPayload(v, seededAt));
  }
  /*
   * 已有默认车就不抢（除非它本来就是预置车）。
   *
   * 预置数据与用户自己建的真车共用 `demo-user`。无条件设默认会在每次 demo:seed 时
   * 静默顶掉用户设的默认车。
   *
   * seed 负责准备演示环境，不替用户决定默认车辆。
   * 回到预置状态用显式的 `demo:reset`。
   */
  let defaultNote = "";
  if (defaultVin) {
    const repo = createVehicleRepository(prisma);
    const current = (await repo.listByOwner(DEMO_USER))[0];
    const currentIsSeeded = current?.vin.startsWith(DEMO_VIN_PREFIX) ?? true;
    if (currentIsSeeded) {
      await repo.setDefault(DEMO_USER, defaultVin);
    } else {
      defaultNote = `；默认车保留用户已设的 ${current!.model}（未被预置车顶掉）`;
    }
  }
  out.push({
    name: "④车辆档案",
    ok: true,
    detail: `${vs.length} 辆（${vs.map((v) => v.model).join("、")}）${defaultNote}`,
  });

  // 只追加表用 upsert 保幂等：重复跑 demo:seed 不产生重复记录。
  // id 由 vin + 时间推导，与仓储 append 的命名一致。
  const ms = maintenance(now);
  for (const m of ms) {
    const id = `mnt-${m.vin}-${m.at.getTime()}`;
    const data = { ...m, source: SIMULATED_SOURCE };
    await prisma.maintenanceRecord.upsert({ where: { id }, create: { id, ...data }, update: data });
  }
  out.push({ name: "保养记录", ok: true, detail: `${ms.length} 条，source=${SIMULATED_SOURCE}` });

  const rs = repairs(now);
  for (const r of rs) {
    const id = `rep-${r.vin}-${r.at.getTime()}`;
    const data = { ...r, source: SIMULATED_SOURCE };
    await prisma.repairRecord.upsert({ where: { id }, create: { id, ...data }, update: data });
  }
  out.push({ name: "维修记录", ok: true, detail: `${rs.length} 条，source=${SIMULATED_SOURCE}` });

  const trips = buildTrips(now);
  for (const t of trips) {
    const data = {
      userId: DEMO_USER,
      vin: VIN_EV,
      startedAt: new Date(t.startedAt),
      endedAt: new Date(t.endedAt),
      distanceKm: t.distanceKm,
      roadType: t.roadType,
      ambientTempC: t.ambientTempC,
      observedRangeKm: t.observedRangeKm ?? null,
      chargeStartSoc: t.charge?.startSoc ?? null,
      chargeEndSoc: t.charge?.endSoc ?? null,
      chargeAt: t.charge ? new Date(t.charge.at) : null,
    };
    await prisma.trip.upsert({ where: { id: t.id }, create: { id: t.id, ...data }, update: data });
  }
  const withRange = trips.filter((t) => t.observedRangeKm !== undefined).length;
  out.push({
    name: "⑥用车流水",
    ok: true,
    detail: `${trips.length} 条（45 天，其中 ${withRange} 条带续航实测；夏季温度，无低温样本——系统会如实说"没有低温对比"）`,
  });

  return out;
}

// ── 车机绑定：默认演示车必须是"已绑定" ──────────────────────
//
// 绑定只有两个入口：档案页的「绑定车机」按钮，和这里。seed 负责绑定，
// 使任何新灌数据的库里演示车都能读电量、执行座舱指令；未绑定时座舱指令
// 全部回"这辆车还没绑定车机"，而 mock-cabin、网关与日志都无异常。
//
// 只绑默认车（Model Y）。迈锐宝留成未绑定，用于演示「未绑定 → 绑定」引导（AC-49-8）。
//
// `MOCK_CABIN_URL` 必须指向目标库那套服务用的同一个 mock-cabin。
// 拿本机的 mock 给线上库建号，写回去的是一个线上 mock 不认识（或属于别的车）的 id。
// 前者会被 CabinClient 的悬空重建自愈，后者不会。

/**
 * 绑一辆车并报告结果。单独导出以便断言：绑不上必须是 `ok: false`，不静默失败。
 */
export async function bindSeedCabin(client: Pick<CabinClient, "bind">, vin: string): Promise<StepResult> {
  try {
    const r = await client.bind(vin);
    return {
      name: "车机绑定",
      ok: true,
      detail: `${vin} → ${r.vehicleId}${r.rebuilt ? "（车机侧已重建）" : ""}；网关的档案缓存最多滞后 60 秒`,
    };
  } catch (err) {
    return {
      name: "车机绑定",
      ok: false,
      detail: `${vin} 没绑上：${err instanceof Error ? err.message : String(err)}——mock-cabin 起了吗（dev:status）？`,
    };
  }
}

async function seedCabinBinding(): Promise<StepResult[]> {
  const url = (process.env.MOCK_CABIN_URL ?? "").trim();
  if (!url) {
    // 没接车机的环境里 seed 不报失败，但明确输出"跳过"，与"已绑定"区分。
    return [{ name: "车机绑定", ok: true, detail: "跳过：MOCK_CABIN_URL 未配，演示车保持未绑定（电量与座舱指令会如实报未绑定）" }];
  }
  const prisma = getPrisma();
  // 与网关装配的那份同形（gateway/src/index.ts）：绑定回写落在④档案的 cabin_vehicle_id。
  const store: CabinBindingStore = {
    async load(vin) {
      const v = await prisma.vehicle.findUnique({ where: { vin }, select: { model: true, cabinVehicleId: true } });
      return v ? { model: v.model, cabinVehicleId: v.cabinVehicleId ?? undefined } : null;
    },
    async save(vin, cabinVehicleId) {
      await prisma.vehicle.update({ where: { vin }, data: { cabinVehicleId } });
    },
  };
  return [await bindSeedCabin(createCabinClient(createHttpCabinBackend(url), store), VIN_EV)];
}

async function seedMemory(now: number): Promise<StepResult[]> {
  const client = getMemoryClient();
  const ready = await client.ensureReady();
  if (!ready) {
    return [
      {
        name: "②③记忆",
        ok: false,
        detail:
          "Mem0 不可用（检查 embedder：MEM0_EMBEDDING_BASE_URL 指向的 Ollama 是否在跑、" +
          "nomic-embed-text 是否已拉取；以及 DATABASE_URL 的 pgvector 扩展）",
      },
    ];
  }

  for (const p of PREFERENCES) {
    // 用 upsert 而不是 add，保证②③记忆同样幂等，重复 seed 不产生重复条目。
    await client.upsertPreference(DEMO_USER, p.meta.domain, p.content, {
      confidence: p.meta.confidence,
      lastConfirmedAt: new Date(now).toISOString(),
      provenance: "simulated",
      seed: "demo",
    });
  }
  for (const e of EPISODES) {
    const occurredAt = now - e.daysAgo * DAY;
    // 指纹与运行时的 `episodeFingerprint` 同构（子类 + 发生日），
    // 避免 seed 的条目与运行时学到的重复。
    const fingerprint = `${e.meta.subType}:${Math.floor(occurredAt / DAY)}`;
    await client.upsertEpisodic(DEMO_USER, fingerprint, e.content, {
      ...e.meta,
      occurredAt: new Date(occurredAt).toISOString(),
      provenance: "simulated",
      seed: "demo",
    });
  }
  return [
    { name: "③偏好", ok: true, detail: `${PREFERENCES.length} 条，metadata.provenance=simulated` },
    { name: "②情景", ok: true, detail: `${EPISODES.length} 条，metadata.provenance=simulated` },
  ];
}

async function reset(): Promise<StepResult[]> {
  const prisma = getPrisma();
  const out: StepResult[] = [];

  const trips = await prisma.trip.deleteMany({ where: { id: { startsWith: DEMO_TRIP_PREFIX } } });
  out.push({ name: "⑥用车流水", ok: true, detail: `删除 ${trips.count} 条` });

  // 保养/维修经 onDelete: Cascade 跟着车辆删除，不单独删，避免漏掉后续追加的记录。
  // 同时清 `LEGACY_VIN_PREFIX`（字母 O 版前缀）的旧车，否则它们无法被 reset 清理。
  const cars = await prisma.vehicle.deleteMany({
    where: { OR: [{ vin: { startsWith: DEMO_VIN_PREFIX } }, { vin: { startsWith: LEGACY_VIN_PREFIX } }] },
  });
  out.push({ name: "④车辆档案（含保养/维修，级联）", ok: true, detail: `删除 ${cars.count} 辆` });

  try {
    const client = getMemoryClient();
    if (await client.ensureReady()) {
      // Mem0 没有按 metadata 批删的接口，预置用户的记忆整体清掉。
      // 因此预置数据必须挂在专用 demo 用户下，否则会连真实记忆一起删。
      await client.deleteAll(DEMO_USER);
      out.push({ name: "②③记忆", ok: true, detail: `清空用户 ${DEMO_USER} 的 Mem0 记忆` });
    } else {
      out.push({ name: "②③记忆", ok: false, detail: "Mem0 不可用，未清理（PG 侧已清）" });
    }
  } catch (err) {
    out.push({ name: "②③记忆", ok: false, detail: `清理失败：${(err as Error).message}` });
  }

  return out;
}

export async function status(): Promise<StepResult[]> {
  const prisma = getPrisma();
  const [cars, trips, mnt, rep] = await Promise.all([
    prisma.vehicle.count({ where: { vin: { startsWith: DEMO_VIN_PREFIX } } }),
    prisma.trip.count({ where: { id: { startsWith: DEMO_TRIP_PREFIX } } }),
    prisma.maintenanceRecord.count({ where: { vin: { startsWith: DEMO_VIN_PREFIX } } }),
    prisma.repairRecord.count({ where: { vin: { startsWith: DEMO_VIN_PREFIX } } }),
  ]);
  // 默认演示车是否已绑车机；没接车机的环境（MOCK_CABIN_URL 未配）不算缺。
  const ev = await prisma.vehicle.findUnique({ where: { vin: VIN_EV }, select: { cabinVehicleId: true } });
  const cabinConfigured = (process.env.MOCK_CABIN_URL ?? "").trim() !== "";
  return [
    { name: "④车辆档案", ok: cars > 0, detail: `${cars} 辆` },
    { name: "⑥用车流水", ok: trips > 0, detail: `${trips} 条` },
    { name: "保养记录", ok: mnt > 0, detail: `${mnt} 条` },
    { name: "维修记录", ok: rep > 0, detail: `${rep} 条` },
    {
      name: "车机绑定",
      ok: Boolean(ev?.cabinVehicleId) || !cabinConfigured,
      detail: ev?.cabinVehicleId
        ? `${VIN_EV} → ${ev.cabinVehicleId}`
        : cabinConfigured
          ? `${VIN_EV} 未绑定——电量读不到、座舱指令全部回"还没绑定车机"`
          : "未绑定（MOCK_CABIN_URL 未配，这个环境没接车机）",
    },
  ];
}

function report(title: string, steps: readonly StepResult[]): boolean {
  console.log(`\n${title}`);
  for (const s of steps) console.log(`  ${s.ok ? "✓" : "✗"} ${s.name.padEnd(24)} ${s.detail}`);
  const failed = steps.filter((s) => !s.ok).length;
  if (failed) console.error(`\n${failed} 项未完成——**不要把这次运行当成"预置好了"**。`);
  return failed === 0;
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const now = Date.now();

  if (args.has("--status")) {
    const ok = report("演示预置数据现状：", await status());
    process.exit(ok ? 0 : 1);
  }

  if (args.has("--reset")) {
    const ok = report("演示数据已重置：", await reset());
    process.exit(ok ? 0 : 1);
  }

  const steps = [...(await seedPostgres(now)), ...(await seedCabinBinding()), ...(await seedMemory(now))];
  const ok = report("演示数据已预置（全部标注为模拟）：", steps);
  console.log(
    `\n归属用户 ${DEMO_USER}；车辆 VIN 前缀 ${DEMO_VIN_PREFIX}、行程 id 前缀 ${DEMO_TRIP_PREFIX}。` +
      `\n清理：corepack pnpm demo:reset`,
  );
  process.exit(ok ? 0 : 1);
}

// 直接执行时才跑 main，被测试 import 时无副作用。
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("预置失败：", err);
    process.exit(1);
  });
}
