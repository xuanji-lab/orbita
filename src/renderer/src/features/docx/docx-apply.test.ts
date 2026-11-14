/**
 * 文字定位（锚点失效后的降级）：`searchText` / `pickOccurrence`。
 *
 * 两条硬要求：**唯一命中才写**（出现两次宁可拒绝，绝不猜），以及引文的空白写法与原文不同
 * 形时（排版产生的 nbsp / 换行）仍能找到同一处——但要如实回报命中了几个。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickOccurrence, searchText } from "./docx-apply.ts";

describe("searchText", () => {
  it("逐字命中：每一处都给出起止偏移", () => {
    assert.deepEqual(searchText("abc abc", "abc"), [
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
  });

  it("没有命中就是空数组；空引文 / 全空白不返回零宽命中", () => {
    assert.deepEqual(searchText("abc", "zzz"), []);
    assert.deepEqual(searchText("abc", ""), []);
    assert.deepEqual(searchText("abc", "   "), []);
  });

  it("空白不同形（nbsp / 连续空格）：压平后仍能找到，偏移映射回原文", () => {
    const text = "结果\u00a0是   这样";
    const hits = searchText(text, "结果 是 这样");
    assert.deepEqual(hits, [{ start: 0, end: text.length }]);
  });

  it("逐字命中优先：原文里有同样空白时不会被压平后的匹配顶掉", () => {
    const hits = searchText("a  b", "a  b");
    assert.deepEqual(hits, [{ start: 0, end: 4 }]);
  });
});

describe("pickOccurrence", () => {
  it("只有一处才算定位成功", () => {
    assert.deepEqual(pickOccurrence([{ start: 2, end: 5 }]), { start: 2, end: 5 });
    assert.equal(pickOccurrence([]), null);
    assert.equal(
      pickOccurrence([
        { start: 0, end: 1 },
        { start: 3, end: 4 },
      ]),
      null,
    );
  });
});
