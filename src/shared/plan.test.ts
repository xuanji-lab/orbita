import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parsePlan, parsePlanCall } from "./plan.ts";

describe("parsePlan（工具与右栏面板共用的计划校验）", () => {
  test("整张清单解析：去空白、保留顺序", () => {
    assert.deepEqual(parsePlan({ items: [{ text: " 读代码 ", status: "done" }, { text: "改", status: "in_progress" }] }), [
      { text: "读代码", status: "done" },
      { text: "改", status: "in_progress" },
    ]);
  });

  test("坏入参抛错，文案能让模型改了重调", () => {
    assert.throws(() => parsePlan({}), /requires "items"/);
    assert.throws(() => parsePlan(null), /requires "items"/);
    assert.throws(() => parsePlan({ items: [{ text: "", status: "done" }] }), /Step 1 has no text/);
    assert.throws(() => parsePlan({ items: [{ text: "a", status: "doing" }] }), /pending, in_progress or done/);
    assert.throws(
      () => parsePlan({ items: [{ text: "a", status: "in_progress" }, { text: "b", status: "in_progress" }] }),
      /Only one step/,
    );
    assert.throws(() => parsePlan({ items: Array.from({ length: 13 }, () => ({ text: "x", status: "pending" })) }), /at most 12/);
  });
});

describe("parsePlanCall（v4：why / later / confirm 三个可选字段）", () => {
  const items = [{ text: "a", status: "in_progress" }];

  test("缺席 = 空：why null、later / confirm 空数组，items 校验不变", () => {
    assert.deepEqual(parsePlanCall({ items }), { items, why: null, later: [], confirm: [] });
  });

  test("why 去空白、折叠换行、超长截断；非字符串丢掉", () => {
    assert.equal(parsePlanCall({ items, why: "  跑测试\n发现按 UTC  " }).why, "跑测试 发现按 UTC");
    assert.equal(parsePlanCall({ items, why: 3 }).why, null);
    assert.equal(parsePlanCall({ items, why: "   " }).why, null);
    const long = parsePlanCall({ items, why: "x".repeat(500) }).why;
    assert.equal(long?.length, 200);
    assert.ok(long?.endsWith("…"));
  });

  test("later：字符串与对象都收，按文字去重，最多 5 条，坏条目跳过", () => {
    const later = parsePlanCall({
      items,
      later: ["日期解析不一致", { text: "日期解析不一致", why: "重复" }, { text: "加 CI", why: "这次不动" }, 7, { why: "没有文字" }, null],
    }).later;
    assert.deepEqual(later, [{ text: "日期解析不一致" }, { text: "加 CI", why: "这次不动" }]);
    const many = parsePlanCall({ items, later: Array.from({ length: 9 }, (_, i) => `事${i}`) }).later;
    assert.equal(many.length, 5);
    assert.deepEqual(parsePlanCall({ items, later: "不是数组" }).later, []);
  });

  test("confirm：最多 3 个问题，空白与重复丢掉；写坏了不拒整次调用", () => {
    assert.deepEqual(parsePlanCall({ items, confirm: ["a？", " ", "a？", "b？", "c？", "d？"] }).confirm, ["a？", "b？", "c？"]);
    assert.deepEqual(parsePlanCall({ items, confirm: { 0: "x" } }).confirm, []);
  });
});
