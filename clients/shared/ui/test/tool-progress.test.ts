/**
 * 工具进展的端上聚合（FL-08 F-08-05）。
 *
 * 重点是并发：一轮出行规划里 weather 可调用五次、poi_search 三次，起止交错。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyToolProgress,
  currentProgress,
  EMPTY_PROGRESS,
  type ToolProgressEvent,
} from "../src/hooks/useToolProgress";

const ev = (
  id: string,
  name: string,
  displayName: string,
  status: ToolProgressEvent["status"],
): ToolProgressEvent => ({ toolCallId: id, toolName: name, displayName, status });

describe("工具进展聚合", () => {
  it("显示最新开始的那一条", () => {
    let s = applyToolProgress(EMPTY_PROGRESS, ev("1", "weather", "正在查天气", "started"));
    assert.equal(currentProgress(s), "正在查天气");
    s = applyToolProgress(s, ev("2", "poi_search", "正在找地点", "started"));
    assert.equal(currentProgress(s), "正在找地点");
  });

  it("一条结束不抹掉仍在跑的，否则进度看似卡住", () => {
    let s = applyToolProgress(EMPTY_PROGRESS, ev("1", "weather", "正在查天气", "started"));
    s = applyToolProgress(s, ev("2", "poi_search", "正在找地点", "started"));
    s = applyToolProgress(s, ev("2", "poi_search", "正在找地点", "succeeded"));
    assert.equal(currentProgress(s), "正在查天气", "回落到仍在跑的那条");
  });

  it("按 id 配对，不按工具名：同一轮同一个工具会被调多次", () => {
    // 按名字配对会让一次"完成"销掉同名的其他"进行中"，进度提前消失。
    let s = EMPTY_PROGRESS;
    for (const id of ["a", "b", "c"]) {
      s = applyToolProgress(s, ev(id, "weather", "正在查天气", "started"));
    }
    s = applyToolProgress(s, ev("a", "weather", "正在查天气", "succeeded"));
    assert.equal(s.length, 2);
    assert.equal(currentProgress(s), "正在查天气");
  });

  it("失败与成功同样结束这一条——车主不需要知道是哪种", () => {
    let s = applyToolProgress(EMPTY_PROGRESS, ev("1", "weather", "正在查天气", "started"));
    s = applyToolProgress(s, ev("1", "weather", "正在查天气", "failed"));
    assert.equal(currentProgress(s), null);
  });

  it("全部结束后回到 null，不给兜底文案", () => {
    let s = applyToolProgress(EMPTY_PROGRESS, ev("1", "weather", "正在查天气", "started"));
    s = applyToolProgress(s, ev("1", "weather", "正在查天气", "succeeded"));
    assert.equal(currentProgress(s), null);
    assert.equal(currentProgress(EMPTY_PROGRESS), null);
  });

  it("结束一个不存在的调用不产生副作用，且返回同一个数组", () => {
    // 对应轮次收口后迟到的回调。返回原数组让 React 少一次重渲染。
    const s = applyToolProgress(EMPTY_PROGRESS, ev("x", "weather", "正在查天气", "succeeded"));
    assert.equal(s, EMPTY_PROGRESS);
  });

  it("重复的 started 不叠加", () => {
    let s = applyToolProgress(EMPTY_PROGRESS, ev("1", "weather", "正在查天气", "started"));
    s = applyToolProgress(s, ev("1", "weather", "正在查天气", "started"));
    assert.equal(s.length, 1);
  });
});
