/**
 * 检索回包该不该上屏 —— 评审 F1 的竞态回归网。
 *
 * 真实事故：输入 A 点查找 → 没回来就改成 B → A 的回包把列表填成 A 的结果，输入框
 * 显示 B，回车把 **A** 写进 .bib 并插进正文。判定必须在回包那一刻做，且同时看
 * 「请求序号」与「查询快照」——只清已显示的结果挡不住在飞的请求。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isStaleResponse, normalizeQuery } from "./cite-search.ts";

describe("isStaleResponse", () => {
  test("输入没变、序号也没变：回包算数", () => {
    assert.equal(isStaleResponse("Attention is all you need", "Attention is all you need", 3, 3), false);
  });

  test("输入改了（哪怕没再查）：作废", () => {
    assert.equal(isStaleResponse("Shiri 2026", "Attention is all you need", 3, 3), true);
  });

  test("有新请求发出（序号变了）：旧回包作废", () => {
    assert.equal(isStaleResponse("Attention", "Attention", 3, 4), true);
  });

  test("首尾空白 / 连续空白 / 大小写不算「改了查询」", () => {
    assert.equal(isStaleResponse("  attention   is all ", "Attention is all", 1, 1), false);
  });

  test("空输入（用户清空了）：任何回包都作废", () => {
    assert.equal(isStaleResponse("", "Attention", 1, 1), true);
  });
});

describe("normalizeQuery", () => {
  test("折叠空白并小写", () => {
    assert.equal(normalizeQuery("  A\tB  "), "a b");
  });
});
