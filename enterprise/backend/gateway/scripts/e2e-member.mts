/**
 * 常用人员端点的端到端自检（F-46-11）。
 *
 * 单测用的是内存 store，验的是路由逻辑；本脚本连真实 PG、走真实仓储，
 * 验的是"这条链路真的能落库、能读回、能删干净"。
 *
 * 纯逻辑层单测在仓储是空壳、表未建时也能全绿，
 * 所以端点类交付要有一条真跑数据路径的证据。
 *
 * 跑法：`corepack pnpm e2e:member`（跑在测试库 carlife_test 上，先 `db:test:setup`；
 * 另需 `CABINHUG_PII_MASTER_KEY`——常用人员的称呼与手机号是 PII，入库即加密）。
 * 用完即清：脚本自己建车、自己删车，不留测试数据。
 */
import express from "express";
import { PrismaClient, resolveTestDatabaseUrl } from "@cabinhug/db";
import {
  createVehicleMemberRepository,
  createVehicleRepository,
  createTripRepository,
} from "@cabinhug/db";
import { createVehicleMemberRouter } from "../src/http/vehicle-member";

const VIN = "LSJA24U91NE2E0001";
const OWNER = "e2e-m17-owner";
// 显式连测试库，不吃环境里的 DATABASE_URL：本机 .env 被 source 过时它指向开发库，
// 而"测试不碰开发库"这条不变量没有例外。
const prisma = new PrismaClient({ datasources: { db: { url: resolveTestDatabaseUrl() } } });
const vehicles = createVehicleRepository(prisma);
const members = createVehicleMemberRepository(prisma);

await prisma.vehicle.deleteMany({ where: { ownerId: OWNER } });
await vehicles.upsert({
  vin: VIN, ownerId: OWNER, model: "E2E 测试车", modelYear: 2024,
  purchasedAt: Date.UTC(2024, 0, 1), odometerKm: 100, maintenance: [], repairs: [], updatedAt: 0,
});

const app = express();
app.use((req, _res, next) => { (req as any).userId = OWNER; next(); });
const logs: string[] = [];
app.use(createVehicleMemberRouter({
  members, vehicles, trips: createTripRepository(prisma),
  audit: (e) => logs.push(JSON.stringify(e)),
}));
const server = app.listen(0);
const port = (server.address() as any).port;
const base = `http://127.0.0.1:${port}/v1/vehicles/${VIN}/members`;
const j = async (r: Response) => ({ status: r.status, body: await r.json() });

const empty = await j(await fetch(base));
console.log("1) 空名单:", empty.status, JSON.stringify(empty.body));

const created = await j(await fetch(base, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ displayName: "妈", relation: "母亲", roles: ["passenger"], ageBand: "senior", needs: ["motion_sickness", "restroom"], note: "不舒服不会主动说" }),
}));
console.log("2) 新增:", created.status, JSON.stringify(created.body));
const id = (created.body as any).member.id;

const listed = await j(await fetch(base));
console.log("3) 列表:", listed.status, JSON.stringify(listed.body));

const bad = await j(await fetch(base, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ displayName: "娃", roles: ["passenger"], needs: ["晕车"] }),
}));
console.log("4) 词表外:", bad.status, JSON.stringify(bad.body));

const updated = await j(await fetch(base, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ id, displayName: "妈", roles: ["passenger", "driver"], needs: ["motion_sickness"] }),
}));
console.log("5) 更新:", updated.status, JSON.stringify((updated.body as any).member?.roles));

const del1 = await j(await fetch(`${base}/${id}`, { method: "DELETE" }));
const del2 = await j(await fetch(`${base}/${id}`, { method: "DELETE" }));
console.log("6) 删除:", JSON.stringify(del1.body), "→ 再删:", JSON.stringify(del2.body));

const after = await j(await fetch(base));
console.log("7) 删后:", after.status, JSON.stringify(after.body));
console.log("8) 审计:", logs.join(" | "));
console.log("   审计含称呼?", logs.some((l) => l.includes("妈")));

server.close();
await prisma.vehicle.deleteMany({ where: { ownerId: OWNER } });
await prisma.$disconnect();
