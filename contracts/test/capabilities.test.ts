import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CAPABILITIES,
  capabilitiesFromPayload,
  parseCapabilitiesOff,
  unknownCapabilities,
} from "../src/constants";

describe("[ACR-056] 能力关闭清单的解析", () => {
  it("空值、空白 → 什么都不关（分离部署的缺省）", () => {
    for (const raw of [undefined, null, "", "  ", " , "]) {
      assert.equal(parseCapabilitiesOff(raw).size, 0, JSON.stringify(raw));
    }
  });

  it("逗号、全角逗号、空白都能分隔，重复项去重", () => {
    const off = parseCapabilitiesOff(" photo-diagnosis，ownership-qa  service-qa,photo-diagnosis ");
    assert.deepEqual([...off].sort(), ["ownership-qa", "photo-diagnosis", "service-qa"]);
  });

  it("不认识的项丢弃，并由 unknownCapabilities 报出来", () => {
    const raw = "photo-diagnosis,buying-qa,Photo-Diagnosis";
    assert.deepEqual([...parseCapabilitiesOff(raw)], ["photo-diagnosis"]);
    assert.deepEqual(unknownCapabilities(raw), ["buying-qa", "Photo-Diagnosis"]);
  });

  it("闭集：ACR-056 的三项在前，ACR-059 的四项在后", () => {
    assert.deepEqual(
      [...CAPABILITIES],
      ["photo-diagnosis", "ownership-qa", "service-qa", "buying-advice", "test-drive", "cabin-control", "voice"],
    );
  });

  it("[ACR-059] 单机版的整串关闭清单全部认得", () => {
    const raw = "photo-diagnosis,ownership-qa,service-qa,buying-advice,test-drive,cabin-control,voice";
    assert.equal(parseCapabilitiesOff(raw).size, 7);
    assert.deepEqual(unknownCapabilities(raw), []);
  });
});

describe("[ACR-057] 端上解析下发结果", () => {
  it("正常形状 → 关闭集合；不认识的项丢弃", () => {
    const off = capabilitiesFromPayload({ off: ["photo-diagnosis", "nope", 3], refreshMs: 30_000 });
    assert.deepEqual([...(off ?? [])], ["photo-diagnosis"]);
  });

  it("空清单是合法的「全开」，不是解析失败", () => {
    assert.equal(capabilitiesFromPayload({ off: [], refreshMs: 30_000 })?.size, 0);
  });

  it("形状不对 → undefined，调用方沿用上一次的值", () => {
    for (const bad of [undefined, null, "x", 1, {}, { off: "photo-diagnosis" }]) {
      assert.equal(capabilitiesFromPayload(bad), undefined, JSON.stringify(bad));
    }
  });
});
