import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import type { CompactedRecord } from "./session.ts";
import {
  parsePlan,
  parsePlanCall,
  parsePlanItemsLoose,
  PLAN_STATUSES,
  planAwaitingIn,
  planAwaitingOf,
} from "./plan.ts";

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
    assert.deepEqual(parsePlanCall({ items }), { items, why: null, confirm: [] });
  });

  test("why 去空白、折叠换行、超长截断；非字符串丢掉", () => {
    assert.equal(parsePlanCall({ items, why: "  跑测试\n发现按 UTC  " }).why, "跑测试 发现按 UTC");
    assert.equal(parsePlanCall({ items, why: 3 }).why, null);
    assert.equal(parsePlanCall({ items, why: "   " }).why, null);
    const long = parsePlanCall({ items, why: "x".repeat(500) }).why;
    assert.equal(long?.length, 200);
    assert.ok(long?.endsWith("…"));
  });

  test("旧记录入参里的 later（「以后再做」已删）读时忽略，不报错、不出现在结果里", () => {
    const call = parsePlanCall({ items, later: ["日期解析不一致", { text: "加 CI", why: "这次不动" }, 7] });
    assert.deepEqual(call, { items, why: null, confirm: [] });
  });

  test("confirm：最多 3 个问题，空白与重复丢掉；写坏了不拒整次调用", () => {
    assert.deepEqual(parsePlanCall({ items, confirm: ["a？", " ", "a？", "b？", "c？", "d？"] }).confirm, ["a？", "b？", "c？"]);
    assert.deepEqual(parsePlanCall({ items, confirm: { 0: "x" } }).confirm, []);
  });
});

describe("planAwaitingIn：停在计划确认上（主进程给手机推状态与 renderer 侧栏共用的判据）", () => {
  const tool = (o: Partial<ToolTranscriptItem> & Pick<ToolTranscriptItem, "toolCallId">): TranscriptItem =>
    ({ id: `item-${o.toolCallId}`, role: "tool", toolName: "read", input: {}, content: [], timestamp: 0, status: "complete", isError: false, ...o }) as TranscriptItem;
  const plan = (id: string, at: number, input: Record<string, unknown>, extra: Partial<ToolTranscriptItem> = {}) =>
    tool({ toolCallId: id, toolName: "update_plan", input: input as never, timestamp: at, ...extra });
  const steps = (...pairs: [string, "pending" | "in_progress" | "done"][]) => ({ items: pairs.map(([text, status]) => ({ text, status })) });
  const user = (id: string, at: number) =>
    ({ id, role: "user", content: [{ type: "text", text: "x" }], timestamp: at }) as unknown as TranscriptItem;
  const awaitingPlan = plan("p1", 10, steps(["甲", "in_progress"]), { details: { plan: [], awaiting: true } as never });

  test("最后一次 update_plan 要求确认、之后没有用户消息 = 是（中间隔着别的工具调用也算）", () => {
    assert.equal(planAwaitingIn([user("u1", 1), awaitingPlan, tool({ toolCallId: "r1", timestamp: 11 })]), true);
  });

  test("压缩界碑、回退界碑不是用户回应：隔着它们仍然停在确认上", () => {
    const compacted: CompactedRecord = { role: "compacted", id: "c1", summary: "…", tokensBefore: 1, timestamp: 12 };
    assert.equal(planAwaitingIn([user("u1", 1), awaitingPlan, compacted]), true);
  });

  test("用户已回应 / 之后有不要求确认的计划 / 没有计划 = 否", () => {
    assert.equal(planAwaitingIn([awaitingPlan, user("u2", 20)]), false);
    assert.equal(planAwaitingIn([awaitingPlan, plan("p2", 30, steps(["甲", "in_progress"]))]), false);
    assert.equal(planAwaitingIn([user("u1", 1)]), false);
    assert.equal(planAwaitingIn([]), false);
  });

  test("只认执行完的 update_plan：出错的、别的工具带了 awaiting 都不算", () => {
    assert.equal(planAwaitingIn([plan("p1", 10, steps(["甲", "pending"]), { status: "error", isError: true, details: { awaiting: true } as never })]), false);
    assert.equal(planAwaitingIn([tool({ toolCallId: "r1", details: { awaiting: true } as never })]), false);
  });

  test("planAwaitingOf 只认真值 true：缺席、字符串、对象都不算", () => {
    assert.equal(planAwaitingOf({ details: { awaiting: true } }), true);
    assert.equal(planAwaitingOf({ details: { awaiting: "true" } }), false);
    assert.equal(planAwaitingOf({ details: null }), false);
    assert.equal(planAwaitingOf({}), false);
  });
});
