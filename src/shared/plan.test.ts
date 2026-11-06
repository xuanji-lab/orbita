import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parsePlan, parsePlanCall, parsePlanItemsLoose, PLAN_STATUSES } from "./plan.ts";

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
    assert.throws(() => parsePlan({ items: [{ text: "a", status: "doing" }] }), /pending, in_progress, waiting or done/);
    assert.throws(
      () => parsePlan({ items: [{ text: "a", status: "in_progress" }, { text: "b", status: "in_progress" }] }),
      /Only one step/,
    );
    assert.throws(() => parsePlan({ items: Array.from({ length: 13 }, () => ({ text: "x", status: "pending" })) }), /at most 12/);
  });
});

describe("waiting 状态（卡在用户 / 外部身上的一步）", () => {
  test("waiting 是合法状态，可带 waitingFor；去空白、折叠换行、超长截断", () => {
    assert.ok(PLAN_STATUSES.includes("waiting"));
    assert.deepEqual(
      parsePlan({ items: [{ text: "装好", status: "waiting", waitingFor: "  等你\n改权限 " }, { text: "b", status: "in_progress" }] }),
      [
        { text: "装好", status: "waiting", waitingFor: "等你 改权限" },
        { text: "b", status: "in_progress" },
      ],
    );
    const long = parsePlan({ items: [{ text: "a", status: "waiting", waitingFor: "x".repeat(100) }] })[0]?.waitingFor;
    assert.equal(long?.length, 40);
    assert.ok(long?.endsWith("…"));
  });

  test("waitingFor 可缺；缺 / 空白 / 非字符串时不带这个字段", () => {
    assert.deepEqual(parsePlan({ items: [{ text: "a", status: "waiting" }] }), [{ text: "a", status: "waiting" }]);
    assert.deepEqual(parsePlan({ items: [{ text: "a", status: "waiting", waitingFor: "   " }] }), [{ text: "a", status: "waiting" }]);
    assert.deepEqual(parsePlan({ items: [{ text: "a", status: "waiting", waitingFor: 3 }] }), [{ text: "a", status: "waiting" }]);
  });

  test("waitingFor 只在 waiting 时保留：别的状态写了也丢掉，不拒", () => {
    assert.deepEqual(parsePlan({ items: [{ text: "a", status: "pending", waitingFor: "等你" }] }), [{ text: "a", status: "pending" }]);
  });

  test("waiting 不占 in_progress 名额：一条 waiting + 一条 in_progress 合法，多条 waiting 合法", () => {
    const items = [
      { text: "a", status: "waiting", waitingFor: "等你" },
      { text: "b", status: "waiting" },
      { text: "c", status: "in_progress" },
    ];
    assert.equal(parsePlan({ items }).length, 3);
    assert.throws(() => parsePlan({ items: [...items, { text: "d", status: "in_progress" }] }), /Only one step/);
  });

  test("旧数据（没有 waiting、没有 waitingFor）宽松读出来与以前逐字段相同", () => {
    const old = { items: [{ text: "读", status: "done" }, { text: "改", status: "in_progress" }, { text: "测", status: "pending" }] };
    assert.deepEqual(parsePlanItemsLoose(old), old.items);
  });

  test("宽松读：新状态与 waitingFor 都认；未知状态的坏条目仍跳过", () => {
    assert.deepEqual(
      parsePlanItemsLoose({ items: [{ text: "a", status: "waiting", waitingFor: "等你" }, { text: "b", status: "blocked" }] }),
      [{ text: "a", status: "waiting", waitingFor: "等你" }],
    );
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
