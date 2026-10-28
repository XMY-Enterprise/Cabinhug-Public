/**
 * [F-09-07] 附件句柄按会话归属，发消息时不能换会话。
 *
 * 句柄与上传时的会话绑定；消息若发到另一段会话，网关回 `attachment_not_owned`（400）。
 * `ensureUsableSession` 的退休判定若读闭包里那一拍的 `lastInteractionAt`，会在上传刚换新会话后
 * 仍看到旧值而再建一段会话。两道约束：判定读 ref，带附件时把会话钉在上传的那一段。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

import { createAttachmentSessions } from "../src/data/attachmentSessions";
import { explainAttachmentFailure } from "../src/data/attachmentFailure";

const APP = readFileSync(new URL("../src/app/index.tsx", import.meta.url), "utf8");

describe("[F-09-07][AC-09-1] 句柄 → 会话的账本", () => {
  it("上传进哪段会话，就钉在哪段", () => {
    const s = createAttachmentSessions();
    s.remember("h1", "sess-a");
    assert.equal(s.sessionFor(["h1"]), "sess-a");
  });

  it("一组句柄不在同一段会话时不钉：让网关拒，不悄悄丢掉另一半", () => {
    const s = createAttachmentSessions();
    s.remember("h1", "sess-a");
    s.remember("h2", "sess-b");
    assert.equal(s.sessionFor(["h1", "h2"]), undefined);
  });

  it("不认识的句柄、空数组、undefined 都不钉", () => {
    const s = createAttachmentSessions();
    s.remember("h1", "sess-a");
    assert.equal(s.sessionFor(["h1", "unknown"]), undefined);
    assert.equal(s.sessionFor([]), undefined);
    assert.equal(s.sessionFor(undefined), undefined);
  });

  it("超出上限先淘汰最老的；重记同一个句柄挪到队尾", () => {
    const s = createAttachmentSessions(2);
    s.remember("h1", "sess-a");
    s.remember("h2", "sess-a");
    s.remember("h1", "sess-b"); // 重记 → h1 变成最新
    s.remember("h3", "sess-c"); // 淘汰的应该是 h2
    assert.equal(s.sessionFor(["h1"]), "sess-b");
    assert.equal(s.sessionFor(["h3"]), "sess-c");
    assert.equal(s.sessionFor(["h2"]), undefined);
  });
});

describe("[F-09-07][AC-09-1] 退休判定不读那一拍的 state", () => {
  it("canRetire 的 lastInteractionAt 来自 ref；ensureUsableSession 的 deps 里没有它", () => {
    const ensure = APP.slice(APP.indexOf("const ensureUsableSession"), APP.indexOf("const endCurrentSession"));
    assert.ok(ensure.includes("lastInteractionAt: lastInteractionRef.current"), "退休判定必须读 ref");
    const deps = ensure.slice(ensure.lastIndexOf("}, ["));
    assert.ok(!/\blastInteractionAt\b/.test(deps), "deps 里再出现 lastInteractionAt 就说明又捕回了 state");
  });

  it("setLastInteractionAt 同时写 ref 与 state", () => {
    assert.ok(/setLastInteractionAt = useCallback\([\s\S]*?lastInteractionRef\.current = ts;[\s\S]*?setLastInteractionAtState\(ts\)/.test(APP));
  });

  it("刚上传附件的那段会话必须原样返回，不进退休判定", () => {
    assert.ok(/if \(opts\?\.keep && opts\.keep === sid\) return sid;/.test(APP));
  });
});

describe("[F-09-07][AC-09-1] 发消息时把会话钉在上传的那一段", () => {
  it("upload 成功即记账，sendText 用这组句柄取 keep", () => {
    assert.ok(APP.includes("attachmentSessions.remember(r.handle, sessionId)"), "上传成功要记一笔");
    assert.ok(
      APP.includes("ensureUsableSession({ keep: attachmentSessions.sessionFor(attachments) })"),
      "发消息要带上 keep，否则退休判定仍可能换掉会话",
    );
  });
});

describe("[F-20-15] 失败提示说人话", () => {
  it("认得出的错误码换成下一步动作，不把 JSON 展示给车主", () => {
    const text = explainAttachmentFailure('rejected: status=400 body={"error":"attachment_not_owned","handle":"U1gN"}');
    assert.equal(text, "这张照片和当前对话对不上了，重拍一张就好");
    assert.ok(!text.includes("status=400"));
  });

  it("认不出的原样保留，供排查", () => {
    assert.equal(explainAttachmentFailure("network timeout"), "network timeout");
  });
});
