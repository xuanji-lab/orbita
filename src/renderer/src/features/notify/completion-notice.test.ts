import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  completionNoticeItems,
  mergeNoticeIds,
  noticeTierOf,
  orderNoticeEntries,
  planNotice,
  sessionRunState,
  settledSessions,
  type PhaseSlot,
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

describe("completionNoticeItems（聚合卡的行序）", () => {
  const row = (id: string, failed: boolean, updatedAt: number) => ({ id, title: id, failed, updatedAt });

  it("空输入：空数组（不弹卡）", () => {
    deepStrictEqual(completionNoticeItems([]), []);
  });

  it("单条：原样返回（单条卡外观不变）", () => {
    const one = row("a", false, 10);
    deepStrictEqual(completionNoticeItems([one]), [one]);
    deepStrictEqual(completionNoticeItems([row("b", true, 3)]).map((item) => item.id), ["b"]);
  });

  it("多条无失败：按 updatedAt 降序（刚完成的在上）", () => {
    const items = completionNoticeItems([row("old", false, 1), row("new", false, 30), row("mid", false, 20)]);
    deepStrictEqual(items.map((item) => item.id), ["new", "mid", "old"]);
  });

  it("失败优先：失败整体在前，同类里仍按 updatedAt 降序", () => {
    const items = completionNoticeItems([
      row("ok-new", false, 90),
      row("f-old", true, 5),
      row("ok-old", false, 10),
      row("f-new", true, 40),
    ]);
    deepStrictEqual(items.map((item) => item.id), ["f-new", "f-old", "ok-new", "ok-old"]);
  });

  it("不改原数组", () => {
    const input = [row("a", false, 1), row("b", true, 2)];
    completionNoticeItems(input);
    deepStrictEqual(input.map((item) => item.id), ["a", "b"]);
  });
});

describe("mergeNoticeIds（卡开着时后来落定的会话并进来）", () => {
  it("空卡：新批原样成为卡的内容", () => {
    deepStrictEqual(mergeNoticeIds([], ["a", "b"]), ["a", "b"]);
  });

  it("已有再并：保留原顺序、新 id 接在后面、重复的不加", () => {
    deepStrictEqual(mergeNoticeIds(["a"], ["b", "a", "c"]), ["a", "b", "c"]);
  });

  it("没有新增：原数组引用不变（不白重渲染）", () => {
    const current = ["a", "b"];
    strictEqual(mergeNoticeIds(current, ["b", "a"]), current);
    strictEqual(mergeNoticeIds(current, []), current);
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