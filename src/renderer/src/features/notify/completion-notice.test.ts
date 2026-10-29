import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  noticeTierOf,
  orderNoticeEntries,
  planNotice,
  sessionRunState,
  settledSessions,
  subtreeBusy,
  treeNotices,
  type PhaseSlot,
  type TreeNode,
  type RunSlot,
} from "./completion-notice.ts";

const slot = (phase: PhaseSlot["phase"], queued = 0): PhaseSlot => ({ phase, queued: Array(queued).fill(null) });
const map = (entries: Record<string, PhaseSlot>) => new Map(Object.entries(entries));
const run = (phase: RunSlot["phase"], approvals = 0): RunSlot => ({ phase, approvals });

describe("settledSessions", () => {
  it("turn → idle 且队列空算跑完", () => {
    deepStrictEqual(settledSessions(map({ a: slot("turn") }), map({ a: slot("idle") })), ["a"]);
  });

  it("压缩中 → idle 也算跑完（压缩是这一轮的尾巴）", () => {
    deepStrictEqual(settledSessions(map({ a: slot("compaction") }), map({ a: slot("idle") })), ["a"]);
  });

  it("idle 那拍队列里还有排队消息不算——下一条马上要投递", () => {
    deepStrictEqual(settledSessions(map({ a: slot("turn") }), map({ a: slot("idle", 1) })), []);
  });

  it("一直 idle、一直在跑、新建的槽都不算", () => {
    deepStrictEqual(
      settledSessions(
        map({ idle: slot("idle"), busy: slot("turn") }),
        map({ idle: slot("idle"), busy: slot("turn"), fresh: slot("idle") }),
      ),
      [],
    );
  });

  it("多条同拍落定全部报出", () => {
    deepStrictEqual(
      settledSessions(map({ a: slot("turn"), b: slot("turn") }), map({ a: slot("idle"), b: slot("idle") })),
      ["a", "b"],
    );
  });
});

describe("planNotice", () => {
  it("正看着且窗口在前台：什么都不做", () => {
    deepStrictEqual(planNotice({ watched: true, windowActive: true, soundOn: true }), { sound: false, unread: false });
  });

  it("正看着但窗口在后台：只响不标未读", () => {
    deepStrictEqual(planNotice({ watched: true, windowActive: false, soundOn: true }), { sound: true, unread: false });
  });

  it("没在看：响 + 未读", () => {
    deepStrictEqual(planNotice({ watched: false, windowActive: true, soundOn: true }), { sound: true, unread: true });
  });

  it("关了提示音：不响，但未读照标", () => {
    deepStrictEqual(planNotice({ watched: false, windowActive: false, soundOn: false }), { sound: false, unread: true });
    deepStrictEqual(planNotice({ watched: true, windowActive: false, soundOn: false }), { sound: false, unread: false });
  });
});

describe("sessionRunState（竖条与铃铛清单的单一真源）", () => {
  const idle: RunSlot = run("idle");

  it("自己或子会话在跑 → running（1/3 蓝）", () => {
    strictEqual(sessionRunState({ slot: run("turn"), children: [], unread: null }), "running");
    strictEqual(sessionRunState({ slot: run("compaction"), children: [], unread: null }), "running");
    strictEqual(sessionRunState({ slot: idle, children: [run("turn")], unread: null }), "running");
  });

  it("自己或子会话挂着审批 → waiting（2/3 橙），压过 running", () => {
    strictEqual(sessionRunState({ slot: run("turn", 1), children: [], unread: null }), "waiting");
    // 审批挂着时 phase 还是 turn：橙必须压过蓝，否则永远不亮
    strictEqual(sessionRunState({ slot: idle, children: [run("turn", 1)], unread: null }), "waiting");
    // 母会话自己空闲、孩子在等审批：亮在母会话那一行
    strictEqual(sessionRunState({ slot: idle, children: [run("idle", 1)], unread: null }), "waiting");
  });

  it("meta 带未读 → done（3/3 绿）；带 failed → failed（3/3 红）", () => {
    strictEqual(sessionRunState({ slot: idle, children: [], unread: { at: 1, failed: false } }), "done");
    strictEqual(sessionRunState({ slot: idle, children: [], unread: { at: 1, failed: true } }), "failed");
  });

  it("在读即不亮；没建过槽的（刚建 / 纯浏览）当 idle 空槽", () => {
    strictEqual(sessionRunState({ slot: undefined, children: [], unread: null }), null);
    strictEqual(sessionRunState({ slot: idle, children: [idle], unread: null }), null);
  });

  it("在跑压过未读：又开了一轮就不再是「跑完」", () => {
    strictEqual(
      sessionRunState({ slot: run("turn"), children: [], unread: { at: 1, failed: true } }),
      "running",
    );
  });
});

describe("铃铛清单分档与排序", () => {
  it("档位映射：done / failed 都是未读档，null 不进清单", () => {
    strictEqual(noticeTierOf("waiting"), "waiting");
    strictEqual(noticeTierOf("done"), "unread");
    strictEqual(noticeTierOf("failed"), "unread");
    strictEqual(noticeTierOf("running"), "running");
    strictEqual(noticeTierOf(null), null);
  });

  it("等你 > 未读 > 在跑，同档新的在前；不改原数组", () => {
    const rows = [
      { id: "old-running", tier: "running" as const, at: 1 },
      { id: "fresh-unread", tier: "unread" as const, at: 90 },
      { id: "waiting", tier: "waiting" as const, at: 5 },
      { id: "stale-unread", tier: "unread" as const, at: 20 },
      { id: "fresh-running", tier: "running" as const, at: 80 },
    ];
    deepStrictEqual(
      orderNoticeEntries(rows).map((row) => row.id),
      ["waiting", "fresh-unread", "stale-unread", "fresh-running", "old-running"],
    );
    strictEqual(rows[0]?.id, "old-running");
  });
});
// 落实C 的形状：根 C 下 5 个子会话，其中一个还有孙会话
const tree: TreeNode[] = [
  { id: "C" },
  { id: "B" },
  { id: "c1", parentId: "C" },
  { id: "c2", parentId: "C" },
  { id: "g1", parentId: "c2" },
];
const noFailure = (): boolean => false;

describe("subtreeBusy", () => {
  it("子会话在跑 / 孙会话在跑 / 子会话队里有待投递：都算没停", () => {
    strictEqual(subtreeBusy("C", tree, map({ C: slot("idle"), c1: slot("turn") })), true);
    strictEqual(subtreeBusy("C", tree, map({ C: slot("idle"), c2: slot("idle"), g1: slot("compaction") })), true);
    strictEqual(subtreeBusy("C", tree, map({ C: slot("idle"), c1: slot("idle", 1) })), true);
  });

  it("全停 / 没建过槽的后代当停着；别的根的子会话不算", () => {
    strictEqual(subtreeBusy("C", tree, map({ C: slot("idle"), c1: slot("idle"), g1: slot("idle") })), false);
    strictEqual(subtreeBusy("B", tree, map({ B: slot("idle"), c1: slot("turn") })), false);
  });

  it("parentId 成环不死循环", () => {
    const loop: TreeNode[] = [{ id: "x", parentId: "y" }, { id: "y", parentId: "x" }];
    strictEqual(subtreeBusy("x", loop, map({ x: slot("idle"), y: slot("idle") })), false);
  });
});

describe("treeNotices", () => {
  it("子树全停：落定当拍就提醒", () => {
    const result = treeNotices({ settled: ["C"], held: new Set(), states: map({ C: slot("idle"), c1: slot("idle") }), sessions: tree, failed: noFailure });
    deepStrictEqual(result.notify, ["C"]);
    deepStrictEqual([...result.held], []);
  });

  it("子会话还在跑：压着，不提醒（2026-10-29 一直响的那一声）", () => {
    const result = treeNotices({ settled: ["C"], held: new Set(), states: map({ C: slot("idle"), c1: slot("turn") }), sessions: tree, failed: noFailure });
    deepStrictEqual(result.notify, []);
    deepStrictEqual([...result.held], ["C"]);
  });

  it("压着的在子树停下那拍兑现一次，之后不再重报", () => {
    const states = map({ C: slot("idle"), c1: slot("idle"), c2: slot("idle") });
    const first = treeNotices({ settled: [], held: new Set(["C"]), states, sessions: tree, failed: noFailure });
    deepStrictEqual(first.notify, ["C"]);
    const second = treeNotices({ settled: [], held: first.held, states, sessions: tree, failed: noFailure });
    deepStrictEqual(second.notify, []);
  });

  it("压着的又开跑了：放掉，等它下次落定重判", () => {
    const result = treeNotices({ settled: [], held: new Set(["C"]), states: map({ C: slot("turn"), c1: slot("turn") }), sessions: tree, failed: noFailure });
    deepStrictEqual(result.notify, []);
    deepStrictEqual([...result.held], []);
  });

  it("压着的队里来了子会话交付（马上要投递）：不提醒、放掉", () => {
    const result = treeNotices({ settled: [], held: new Set(["C"]), states: map({ C: slot("idle", 1), c1: slot("idle") }), sessions: tree, failed: noFailure });
    deepStrictEqual(result.notify, []);
    deepStrictEqual([...result.held], []);
  });

  it("回合失败不压：子会话还在跑也当场提醒", () => {
    const result = treeNotices({ settled: ["C"], held: new Set(), states: map({ C: slot("idle"), c1: slot("turn") }), sessions: tree, failed: (id) => id === "C" });
    deepStrictEqual(result.notify, ["C"]);
  });

  it("会话删了（槽没了）：从压着里去掉", () => {
    const result = treeNotices({ settled: [], held: new Set(["gone"]), states: map({}), sessions: tree, failed: noFailure });
    deepStrictEqual(result.notify, []);
    deepStrictEqual([...result.held], []);
  });

  it("同拍：刚落定的在前，兑现的在后，不重复", () => {
    const result = treeNotices({ settled: ["B", "C"], held: new Set(["C"]), states: map({ B: slot("idle"), C: slot("idle") }), sessions: tree, failed: noFailure });
    deepStrictEqual(result.notify, ["B", "C"]);
  });
});
