import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { appendWithdrawn } from "./withdraw-draft.ts";

describe("appendWithdrawn —— 撤回的文字接回草稿", () => {
  test("草稿为空：直接就是撤回的那条", () => {
    assert.equal(appendWithdrawn("", "排队的那条"), "排队的那条");
  });

  test("草稿只有空白：也当空处理，不在开头留空行", () => {
    assert.equal(appendWithdrawn("  \n\n ", "排队的那条"), "排队的那条");
  });

  test("草稿有内容：换行接在后面", () => {
    assert.equal(appendWithdrawn("我在写的", "排队的那条"), "我在写的\n排队的那条");
  });

  test("草稿以换行结尾：先削尾再接，不多出空行", () => {
    assert.equal(appendWithdrawn("我在写的\n\n", "排队的那条"), "我在写的\n排队的那条");
  });

  test("连点两条撤回：依次堆叠", () => {
    const once = appendWithdrawn("我在写的", "第一条");
    assert.equal(appendWithdrawn(once, "第二条"), "我在写的\n第一条\n第二条");
  });

  test("撤回空文字：草稿原样不动（compact 项没有「用户的话」可拿回）", () => {
    assert.equal(appendWithdrawn("我在写的", ""), "我在写的");
    assert.equal(appendWithdrawn("", ""), "");
  });

  test("撤回的文字自带换行：原样保留，不压平", () => {
    assert.equal(appendWithdrawn("我在写的", "第一行\n第二行"), "我在写的\n第一行\n第二行");
  });
});
