/**
 * 会话列表一行里不许把同一个事实写两遍。
 *
 * 服务端只在一段对话有内容之后才给它起标题，所以「刚开没说话」「说了一句就退出」的会话
 * 都是无标题的。这时标题位回落成时间，下面那行不再写时间，否则上下两行一模一样。
 *
 * 定稿 `内部文档` 里的会话都有标题，比对设计图覆盖不到这一形态。
 *
 * 测的是组件真正调用的那个函数（`sessionRowText`），不在测试里另抄一份取值规则。
 * 本包没有 jsdom，能打到的最深一层就是它。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { sessionRowText, type SessionBrief } from "../src/dialog/SessionList";

/*
 * 期望值「今天 00:02」按东八区写，保留字面对照。`whenLabel` 用本机时区显示（车主看的是当地时间），
 * 所以由用例把运行环境对齐到期望值。`node --test` 每个文件一个子进程，这一行只影响本文件。
 */
process.env.TZ = "Asia/Shanghai";

const NOW = new Date("2026-09-11T00:30:00+08:00").getTime();

function brief(over: Partial<SessionBrief>): SessionBrief {
  return {
    sessionId: "s1",
    title: null,
    createdAt: "2026-09-11T00:02:00+08:00",
    updatedAt: "2026-09-11T00:02:00+08:00",
    closedAt: null,
    messageCount: 0,
    ...over,
  };
}

describe("会话列表：一行里不重复同一个事实", () => {
  it("无标题时只出现一次时间——第二行整个没有", () => {
    const row = sessionRowText(brief({}), NOW);
    assert.equal(row.title, "今天 00:02");
    assert.equal(row.when, undefined, "标题位已经回落成时间了，下面那行不能再写一遍");
  });

  it("有标题时照旧两行：标题在上，时间在下", () => {
    const row = sessionRowText(brief({ title: "明天去徐州玩三天" }), NOW);
    assert.equal(row.title, "明天去徐州玩三天");
    assert.equal(row.when, "今天 00:02");
  });

  it("空字符串标题按没有标题算——不留一行空白当标题", () => {
    const row = sessionRowText(brief({ title: "" }), NOW);
    assert.equal(row.title, "今天 00:02");
    assert.equal(row.when, undefined);
  });

  it("两行的内容永远不相等", () => {
    for (const title of [null, "", "保养该做了吗", "这车最近有点费电，正常吗"]) {
      const row = sessionRowText(brief({ title }), NOW);
      if (row.when !== undefined) {
        assert.notEqual(row.title, row.when, `标题「${title}」下面又写了一遍同样的字`);
      }
    }
  });
});
