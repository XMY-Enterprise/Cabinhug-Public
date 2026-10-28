/**
 * 汇总报告抽样口径的守卫。
 *
 * # 走「spawn 真跑 + 断言产物」而不是导出纯函数直测
 *
 * `run.ts` 是顶层执行的脚本（载入数据集、探端侧白名单、渲染、退出码），导出内部
 * 函数直测要么把整个脚本重构成 main() 形态，要么 import 即执行。
 * 这里用 fixture 产物 spawn 真跑一遍、断言生成的 markdown：慢几秒，但
 * 参数解析、产物读取、旧格式兼容一起被测到，抽样口径的失真都发生在这条真实链路上。
 *
 * fixture 说明：旧格式 = evals/runs/ 的 4 份基线（无 selected/total 的旧形状）；
 * 抽样格式 = 本文件现场构造（从基线产物截取子集并写入 selected < total）。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = new URL("../..", import.meta.url).pathname;
const RUNS = join(ROOT, "evals/runs");

function render(args: string[]): string {
  const out = join(mkdtempSync(join(tmpdir(), "m55-")), "report.md");
  const r = spawnSync("npx", ["tsx", "evals/ownership-service/run.ts", ...args, "--out", out], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.notEqual(r.status, null, "run.ts 超时");
  return readFileSync(out, "utf8");
}

/** 从基线产物截取 id 子集并打上抽样元数据。 */
function sampleFixture(dir: string, src: string, ids: string[], total: number): string {
  const a = JSON.parse(readFileSync(join(RUNS, src), "utf8")) as { outcomes: Array<{ id: string }> };
  const fixture = {
    ...a,
    total,
    selected: ids.length,
    outcomes: a.outcomes.filter((o) => ids.includes(o.id)),
  };
  const p = join(dir, src);
  writeFileSync(p, JSON.stringify(fixture));
  return p;
}

describe("汇总报告的抽样口径（spawn 真跑）", () => {
  it("旧格式基线产物（无 selected/total）：无横幅、未跑全 0、四个头条数字与基线一致", () => {
    const md = render([]);
    assert.ok(!md.includes("本报告含抽样运行"), "全量运行不该出抽样横幅");
    assert.ok(md.includes("**覆盖率：18/18 = 100%**"), "覆盖率分母应为 18（M57-02 加 sub:clarification）");
    // 头条数字随基线产物刷新（新增列不得改动它们）：
    // fake 91/0；real 85/6（93%，M-W1 退役后不再按 warning_must 判失败）；全护栏硬禁 70拦/0漏（100%）
    assert.ok(md.includes("| **总计** | | **91** | **0** | **0** | **100%** |"), "fake 档总计变了");
    assert.ok(md.includes("| **总计** | | **85** | **6** | **0** | **93%** |"), "real 档总计变了");
    assert.ok(md.includes("**100%**"), "硬禁合计变了");
    assert.ok(!md.includes("⚠ 口径不平衡"), "全量运行不该有口径不平衡");
  });

  it("抽样产物：横幅点名各产物 n/N，覆盖率一节带分母口径声明", () => {
    const dir = mkdtempSync(join(tmpdir(), "m55fix-"));
    const rf = sampleFixture(dir, "risk-full.json", ["r-20", "r-70", "r-60"], 110);
    const md = render(["--risk-full", rf]);
    assert.ok(md.includes("本报告含抽样运行（风险全护栏 3/110）"), "横幅缺失或 n/N 不对");
    assert.ok(md.includes("本节分母是数据集"), "覆盖率口径声明缺失");
  });

  it("矩阵恒等式：题数 = 拦住+漏拦+未覆盖+未触达+未跑（抽样行未跑=9，行不消失）", () => {
    const dir = mkdtempSync(join(tmpdir(), "m55fix-"));
    const rf = sampleFixture(dir, "risk-full.json", ["r-20"], 110);
    const md = render(["--risk-full", rf]);
    const row = md.split("\n").filter((l) => l.includes("自动驾驶决策属硬禁")).pop()!;
    // r-20 在基线里是 intercepted：10 = 1 + 0 + 0 + 0 + 9
    const cells = row.split("|").map((c) => c.trim());
    const [total, ic, lk, uc, nr, notRun] = cells.slice(3, 9).map(Number);
    assert.equal(total, 10);
    assert.equal(ic + lk + uc + nr + notRun, total, `恒等式不成立：${row}`);
    assert.equal(notRun, 9);
    assert.ok(!row.includes("口径不平衡"));
    // 没抽到的类别整行仍在（未跑=10），不许消失
    const doorRow = md.split("\n").filter((l) => l.includes("门窗控制属硬禁")).pop()!;
    assert.ok(doorRow.includes("| 10 | 0 | 0 | 0 | 0 | 10 |"), `未抽到的类别行消失或未跑不对：${doorRow}`);
  });

  it("小样本标注：分母 <10 的比率带（n=X）⚠，≥10 的保持纯百分比", () => {
    // 用硬禁行验证 rate 标注（pii 类已退役）。
    const dir = mkdtempSync(join(tmpdir(), "m55fix-"));
    const rf = sampleFixture(dir, "risk-full.json", ["r-20"], 110);
    const md = render(["--risk-full", rf]);
    const row = md.split("\n").filter((l) => l.includes("自动驾驶决策属硬禁")).pop()!;
    assert.ok(row.includes("100%（n=1）⚠"), `硬禁行缺小样本标注：${row}`);
    // 全量档（scenario fake 基线，分母 91，总计 100%）保持纯百分比
    assert.ok(md.includes("| **100%** |"), "大分母比率不该带 n 标注");
  });
});
