import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import { BEFORE_PLAN, bucketAt, groupBySteps, OUTSIDE_PLAN, planAwaitingIn, planNoticeOf, planTimeline, stepActiveSince } from "./plan-timeline.ts";
import type { ProcessChapter } from "../chat/turn-process.ts";

const tool = (o: Partial<ToolTranscriptItem> & Pick<ToolTranscriptItem, "toolCallId">): TranscriptItem =>
  ({ id: `item-${o.toolCallId}`, role: "tool", toolName: "read", input: {}, content: [], timestamp: 0, status: "complete", isError: false, ...o }) as TranscriptItem;
const plan = (id: string, at: number, input: Record<string, unknown>, extra: Partial<ToolTranscriptItem> = {}) =>
  tool({ toolCallId: id, toolName: "update_plan", input: input as never, timestamp: at, ...extra });
const steps = (...pairs: [string, "pending" | "in_progress" | "done"][]) => ({ items: pairs.map(([text, status]) => ({ text, status })) });

describe("planTimeline", () => {
  test("没写过计划 = null", () => {
    assert.equal(planTimeline([]), null);
  });

  test("只打勾：版本递增、没有改动、步骤 id 不变", () => {
    const t = planTimeline([
      plan("p1", 10, steps(["看代码", "in_progress"], ["写函数", "pending"])),
      plan("p2", 20, steps(["看代码", "done"], ["写函数", "in_progress"])),
    ]);
    assert.ok(t !== null);
    assert.equal(t.versions.length, 2);
    assert.equal(t.edits, 0);
    assert.deepEqual(t.current.changes, []);
    assert.deepEqual(t.versions[0]?.items.map((i) => i.id), t.current.items.map((i) => i.id));
    assert.equal(t.current.items[0]?.note, null);
  });

  test("加了一步：带 why 的出处挂在新步上，之后打勾仍保留；原有步 id 不变", () => {
    const t = planTimeline([
      plan("p1", 10, steps(["看代码", "in_progress"], ["补测试", "pending"])),
      plan("p2", 20, { ...steps(["看代码", "done"], ["修时区比较", "in_progress"], ["补测试", "pending"]), why: "测试发现按 UTC 零点比" }),
      plan("p3", 30, steps(["看代码", "done"], ["修时区比较", "done"], ["补测试", "in_progress"])),
    ]);
    assert.ok(t !== null);
    assert.equal(t.edits, 1);
    assert.deepEqual(t.versions[1]?.changes, [{ kind: "added", text: "修时区比较" }]);
    const added = t.current.items[1];
    assert.deepEqual(added?.note, { kind: "added", why: "测试发现按 UTC 零点比", from: null, version: 2 });
    assert.equal(t.current.items[2]?.id, t.versions[0]?.items[1]?.id);
  });

  test("改说法：出处记原文；没写 why 照样有出处", () => {
    const t = planTimeline([
      plan("p1", 10, steps(["看 todo.js 和现有测试", "in_progress"])),
      plan("p2", 20, steps(["看 todo.js 和已有测试", "in_progress"])),
    ]);
    assert.ok(t !== null);
    assert.deepEqual(t.current.items[0]?.note, { kind: "reworded", why: null, from: "看 todo.js 和现有测试", version: 2 });
  });

  test("去掉一步：记在那一版里，带原位置", () => {
    const t = planTimeline([
      plan("p1", 10, steps(["看代码", "in_progress"], ["写函数", "pending"], ["写 README", "pending"])),
      plan("p2", 20, steps(["看代码", "in_progress"], ["写 README", "pending"])),
    ]);
    assert.ok(t !== null);
    assert.deepEqual(t.current.removed.map((r) => [r.text, r.afterNext]), [["写函数", 0]]);
    assert.ok(t.current.removed[0]?.id.startsWith("s"));
  });

  test("一张新计划：上一串进历史，版本从头数，没有改动", () => {
    const t = planTimeline([
      plan("p1", 10, steps(["给 CI 加缓存", "done"], ["改 workflow", "done"])),
      plan("p2", 20, steps(["调研向量库", "in_progress"], ["写对比表", "pending"])),
    ]);
    assert.ok(t !== null);
    assert.equal(t.versions.length, 1);
    assert.equal(t.current.n, 1);
    assert.deepEqual(t.current.changes, []);
  });

  test("被拒的不算；还在跑的过严格校验；later / confirm / awaiting 带出来", () => {
    const t = planTimeline([
      plan("p1", 10, steps(["读", "in_progress"])),
      plan("bad", 15, steps(["x", "in_progress"], ["y", "in_progress"]), { status: "running" }),
      plan("err", 16, steps(["z", "pending"]), { status: "error" }),
      plan("p2", 20, { ...steps(["读", "in_progress"]), later: ["日期解析不一致"], confirm: ["要兼容旧格式吗？"] }, { details: { plan: [], awaiting: true } as never }),
    ]);
    assert.ok(t !== null);
    assert.equal(t.versions.length, 2);
    assert.deepEqual(t.current.later, [{ text: "日期解析不一致" }]);
    assert.deepEqual(t.current.confirm, ["要兼容旧格式吗？"]);
    assert.equal(t.current.awaiting, true);
  });
});

describe("bucketAt：调用归哪一步", () => {
  const t = planTimeline([
    plan("p1", 100, steps(["甲", "in_progress"], ["乙", "pending"])),
    plan("p2", 200, steps(["甲", "done"], ["乙", "in_progress"])),
    plan("p3", 300, steps(["甲", "done"], ["乙", "done"])),
  ]);
  const [a, b] = [t?.versions[0]?.items[0]?.id, t?.versions[0]?.items[1]?.id];

  test("写计划之前 = 开工前；同一毫秒（同批）算新的那步", () => {
    assert.equal(bucketAt(t, 50), BEFORE_PLAN);
    assert.equal(bucketAt(t, 100), a);
    assert.equal(bucketAt(t, 199), a);
    assert.equal(bucketAt(t, 200), b);
  });

  test("全勾完还在调用 = 计划外；没有计划 = 开工前", () => {
    assert.equal(bucketAt(t, 400), OUTSIDE_PLAN);
    assert.equal(bucketAt(null, 400), BEFORE_PLAN);
  });
});

describe("groupBySteps", () => {
  const t = planTimeline([
    plan("p1", 100, steps(["甲", "in_progress"], ["乙", "pending"])),
    plan("p2", 200, steps(["甲", "done"], ["乙", "in_progress"])),
  ]);
  const call = (id: string, name: string, at: number, input: unknown = {}) => ({ kind: "toolCall" as const, key: id, messageId: "m", toolCallId: id, toolName: name, input, timestamp: at });
  const chapter = (key: string, calls: ReturnType<typeof call>[]): ProcessChapter => ({ key, title: key, source: "say", calls, steps: calls });

  test("调用数、写过的文件、失败各挂到当时在做的那步；update_plan 不算步；纯记账的章不挂", () => {
    const turn = {
      key: "u1",
      processKeys: ["proc:1"],
      live: false,
      chapters: [
        chapter("c1", [call("r1", "read", 110), call("e1", "edit", 150, { path: "a.ts" })]),
        chapter("c2", [call("p2", "update_plan", 200), call("e2", "edit", 205, { path: "b.ts" }), call("b1", "bash", 210)]),
        chapter("c3", [call("p9", "update_plan", 250)]),
      ],
    };
    const status = (id: string) => (id === "b1" ? "error" : "complete");
    const g = groupBySteps(t, [turn], status);
    const [a, b] = [t?.versions[0]?.items[0]?.id ?? "", t?.versions[0]?.items[1]?.id ?? ""];
    assert.equal(g.get(a)?.calls, 2);
    assert.deepEqual(g.get(a)?.files, ["a.ts"]);
    assert.equal(g.get(b)?.calls, 2);
    assert.equal(g.get(b)?.failed, 1);
    assert.deepEqual(g.get(a)?.chapters.map((c) => c.chapter.key), ["c1"]);
    assert.deepEqual(g.get(b)?.chapters.map((c) => c.chapter.key), ["c2"]);
  });
});

describe("planNoticeOf：每个过程块一条改动提示", () => {
  const t = planTimeline([
    plan("p1", 10, steps(["看代码", "in_progress"], ["补测试", "pending"])),
    plan("p2", 20, steps(["看代码", "done"], ["补测试", "in_progress"])),
    plan("p3", 30, { ...steps(["看代码", "done"], ["修时区", "in_progress"], ["补测试", "pending"]), why: "测试发现差一天" }),
  ]);

  test("只打勾的调用不出提示", () => {
    assert.equal(planNoticeOf(t, ["p1", "p2"]), null);
  });

  test("有结构改动的调用：改动 + 理由", () => {
    assert.deepEqual(planNoticeOf(t, ["p2", "p3"]), {
      changes: [{ kind: "added", text: "修时区" }],
      why: "测试发现差一天",
    });
  });

  test("没有计划 / 没有调用 = null", () => {
    assert.equal(planNoticeOf(null, ["p3"]), null);
    assert.equal(planNoticeOf(t, []), null);
  });
});

describe("stepActiveSince：在做那步的钟", () => {
  test("从这一次变成在做的那一版算起；中途让位再回来重新计；不在做 = null", () => {
    const t = planTimeline([
      plan("p1", 100, steps(["甲", "in_progress"], ["乙", "pending"])),
      plan("p2", 150, steps(["甲", "in_progress"], ["乙", "pending"])),
      plan("p3", 200, steps(["甲", "pending"], ["插", "in_progress"], ["乙", "pending"])),
      plan("p4", 300, steps(["甲", "in_progress"], ["插", "done"], ["乙", "pending"])),
    ]);
    assert.ok(t !== null);
    const [a, , ] = t.current.items;
    assert.equal(stepActiveSince(t, a?.id ?? ""), 300);
    assert.equal(stepActiveSince(t, t.current.items[2]?.id ?? ""), null);
    const first = planTimeline([
      plan("p1", 100, steps(["甲", "in_progress"])),
      plan("p2", 150, steps(["甲", "in_progress"])),
    ]);
    assert.equal(stepActiveSince(first as NonNullable<typeof first>, first?.current.items[0]?.id ?? ""), 100);
  });
});

describe("planAwaitingIn：停在计划确认上", () => {
  const user = (id: string, at: number) => ({ id, role: "user", content: [{ type: "text", text: "x" }], timestamp: at }) as unknown as TranscriptItem;
  const awaitingPlan = plan("p1", 10, steps(["甲", "in_progress"]), { details: { plan: [], awaiting: true } as never });
  test("最后一次 update_plan 要求确认、之后没有用户消息 = 是", () => {
    assert.equal(planAwaitingIn([user("u1", 1), awaitingPlan, tool({ toolCallId: "r1", timestamp: 11 })]), true);
  });
  test("用户已回应 / 之后有不要求确认的计划 / 没有计划 = 否", () => {
    assert.equal(planAwaitingIn([awaitingPlan, user("u2", 20)]), false);
    assert.equal(planAwaitingIn([awaitingPlan, plan("p2", 30, steps(["甲", "in_progress"]))]), false);
    assert.equal(planAwaitingIn([user("u1", 1)]), false);
  });
});
