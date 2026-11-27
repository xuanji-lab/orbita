import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { scrollEdges } from "./scroll-inset.ts";

const box = (over: Partial<Parameters<typeof scrollEdges>[0]>) => ({ offsetWidth: 300, clientWidth: 300, scrollHeight: 400, clientHeight: 400, scrollTop: 0, ...over });

describe("scrollEdges —— 滚动条占宽与底部渐隐", () => {
  test("没有溢出：没有滚动条宽、不渐隐", () => {
    assert.deepEqual(scrollEdges(box({})), { gap: 0, fade: false });
  });
  test("溢出：gap = 滚动条宽；没滚到底渐隐，滚到底（4px 以内）不渐隐", () => {
    assert.deepEqual(scrollEdges(box({ clientWidth: 289, scrollHeight: 700, clientHeight: 400 })), { gap: 11, fade: true });
    assert.equal(scrollEdges(box({ clientWidth: 289, scrollHeight: 700, clientHeight: 400, scrollTop: 297 })).fade, false);
    assert.equal(scrollEdges(box({ clientWidth: 289, scrollHeight: 700, clientHeight: 400, scrollTop: 150 })).fade, true);
  });
  test("1px 的取整误差不算溢出", () => {
    assert.equal(scrollEdges(box({ scrollHeight: 401 })).fade, false);
  });
});
