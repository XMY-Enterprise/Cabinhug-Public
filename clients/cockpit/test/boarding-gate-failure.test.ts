/**
 * [F-56-07][AC-56-7] 上车声明门在取不到成员名单时的行为。
 *
 * # 为什么读源码
 *
 * 守的是错误分支的形状：这类缺陷不报错、不留日志，行为上只表现为门不渲染。
 *
 * 车机保存的网关地址失效时，`vehicle_members` 调用抛错。若它与"不在 Tauri 里"
 * 共用同一个 catch，相位会落到 `skip`、组件返回 `null`，成员选择与整道门一起不显示。
 *
 * 这里钉住的约束在被合并回去后仍能编译、运行，只能靠读源码守住。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/features/auth/BoardingGate.tsx", import.meta.url), "utf8");

/** 去掉注释：断言的对象必须是会真的跑起来的代码，不是解释它的那段话。 */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const CODE = stripComments(SRC);

/** 取 `marker` 之后第一个 `} catch (…) {` 的整个块（按花括号配对），找不到返回 null。 */
function catchBlockAfter(code: string, marker: string): string | null {
  const at = code.indexOf(marker);
  if (at < 0) return null;
  const m = /\} catch \([^)]*\) \{/.exec(code.slice(at));
  if (!m) return null;
  let i = at + m.index + m[0].length;
  let depth = 1;
  const start = i;
  while (i < code.length && depth > 0) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") depth -= 1;
    i += 1;
  }
  return depth === 0 ? code.slice(start, i - 1) : null;
}

describe("[F-56-07][AC-56-7] 上车声明门的失败分支", () => {
  it("取名单失败有自己的相位，不与 skip 合流", () => {
    assert.match(CODE, /kind: "blocked"/, "blocked 相位没了？那失败又会落回 skip");
    /*
     * 断言 catch 块的结局，不断言文本相邻：catch 内可以插入 `resync_bound_vin` 重试，
     * 只要所有路径都以 blocked 收尾。做法是把 probe 里 `loadMembers(vin)` 的 catch 块
     * 整段切出，检查它只落到 blocked。
     */
    const block = catchBlockAfter(CODE, "await loadMembers(vin);");
    assert.ok(block, "probe 里 loadMembers(vin) 的 catch 块找不到了");
    const blocked = block.match(/setPhase\(\{ kind: "blocked"/g) ?? [];
    assert.ok(blocked.length >= 1, "loadMembers 的 catch 必须落到 blocked——落到 skip 就是整道门消失");
    assert.ok(!/kind: "skip"/.test(block), "取名单失败的分支里不许出现 skip——那正是 2026-08-31 走查里门消失的原因");
    // 重试路径（resync 后再 loadMembers）同样只能以 blocked 收尾
    if (block.includes("loadMembers(fresh)")) {
      assert.ok(blocked.length >= 2, "resync 后重试的那条路也得以 blocked 收尾，不能静默 return");
    }
  });

  it("只有 `device_role` 抛错才算不在 Tauri 里", () => {
    /*
     * 判据是探测拆成两段：第一段只包 device_role。
     * loadMembers 收回同一个 try 时本条失败。
     */
    const first = CODE.match(/try \{\s*role = await invoke<string>\("device_role"\);\s*\} catch \{/);
    assert.ok(first, "device_role 必须单独一个 try——它是唯一能判定『没有 Tauri』的调用");
    /*
     * 判据是两者之间已有一个 `} catch`，不用负向正则跨段匹配：
     * `[\s\S]` 会越过中间的 `} catch`，从第一个 try 匹配到第二个，结果恒为真。
     */
    const between = CODE.slice(
      CODE.indexOf('invoke<string>("device_role")'),
      CODE.indexOf("loadMembers(vin)"),
    );
    assert.match(
      between,
      /\} catch/,
      "device_role 与 loadMembers 又回到同一个 try 了——这正是本用例要防的合并",
    );
  });

  it("blocked 相位渲染出内容，不返回 null", () => {
    // 早退守卫里不得出现 blocked，否则 blocked 相位同样不渲染
    const guard = CODE.match(/if \(phase\.kind === [^)]*\) return null;/g) ?? [];
    for (const g of guard) {
      assert.ok(!g.includes("blocked"), `blocked 混进了返回 null 的守卫：${g}`);
    }
    assert.match(CODE, /连不上网关/, "要把原因摆在脸上");
    assert.match(CODE, /\{phase\.reason\}/, "**原始错误必须显示出来**，否则又回到『说不出为什么』");
  });

  it("留着进设置的出路——遮罩是全屏的，没出路就改不了网关地址", () => {
    assert.match(CODE, /先进入设置改地址/);
    assert.match(
      CODE,
      /onClick=\{\(\) => setPhase\(\{ kind: "skip" \}\)\}/,
      "这个按钮必须能真的把门放下，否则用户被永久挡在设置页外",
    );
  });

  it("[M54-10] 已声明 → 自动续用不重选；续用失败清声明回选择屏", () => {
    assert.match(CODE, /invoke<string>\("boarding_declared"\)/, "不读保存的声明就永远回到选择屏");
    assert.match(CODE, /saved\.declared/, "外层「声明过没有」必须参与判断");
    assert.match(CODE, /invoke\("boarding_reset"\)/, "续用失败必须清掉声明，否则每次启动都撞同一个 400");
  });

  it("重试不是刷新整页——刷新会把用户刚填的网关地址丢掉", () => {
    assert.match(CODE, /void probe\(\);/);
    assert.ok(!/window\.location\.reload/.test(CODE), "这一屏不许用整页刷新做重试");
  });
});
