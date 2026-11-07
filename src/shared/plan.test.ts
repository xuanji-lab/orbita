import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parsePlan } from "./plan.ts";

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
