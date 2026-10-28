import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentEvent } from "@shared/agent-ipc";
import { applyAgentEvent, createSessionStates, type SessionStates } from "../chat/session-states.ts";
import {
  NOTICE_KEEP_MAX,
  NOTICE_VISIBLE_MAX,
  completionNoticeItems,
  completionNoticeRows,
  dropWatchedNotices,
  mergeNoticeEntries,
  noticeTierOf,
  orderNoticeEntries,
  planNotice,
  sessionRunState,
  settledSessions,
  snapshotSettled,
  visibleNoticeRows,
  type NoticeSnapshot,
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
  const row = (id: string, failed: boolean, settledAt: number) => ({ id, title: id, failed, settledAt });

  it("空输入：空数组（不弹卡）", () => {
    deepStrictEqual(completionNoticeItems([]), []);
  });

  it("单条：原样返回（单条卡外观不变）", () => {
    const one = row("a", false, 10);
    deepStrictEqual(completionNoticeItems([one]), [one]);
    deepStrictEqual(completionNoticeItems([row("b", true, 3)]).map((item) => item.id), ["b"]);
  });

  it("多条无失败：按 settledAt 降序（刚完成的在上）", () => {
    const items = completionNoticeItems([row("old", false, 1), row("new", false, 30), row("mid", false, 20)]);
    deepStrictEqual(items.map((item) => item.id), ["new", "mid", "old"]);
  });

  it("失败优先：失败整体在前，同类里仍按 settledAt 降序", () => {
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

describe("mergeNoticeEntries（卡开着时后来落定的会话并进来）", () => {
  const snap = (id: string, failed: boolean, settledAt: number): NoticeSnapshot => ({ id, failed, settledAt });

  it("空卡：新批原样成为卡的内容", () => {
    const batch = [snap("a", false, 1), snap("b", true, 2)];
    deepStrictEqual(mergeNoticeEntries([], batch), batch);
  });

  it("已有再并：保留原顺序、新的接在后面", () => {
    const merged = mergeNoticeEntries([snap("a", false, 1)], [snap("b", false, 2), snap("c", true, 3)]);
    deepStrictEqual(merged.map((entry) => entry.id), ["a", "b", "c"]);
  });

  it("同一条会话再次落定：新快照换掉旧的，不重复列", () => {
    const merged = mergeNoticeEntries([snap("a", true, 1), snap("b", false, 2)], [snap("a", false, 9)]);
    deepStrictEqual(merged, [snap("b", false, 2), snap("a", false, 9)]);
  });

  it("没有新快照：原数组引用不变（不白重渲染）", () => {
    const current = [snap("a", false, 1)];
    strictEqual(mergeNoticeEntries(current, []), current);
  });

  it("状态有上限：卡一直开着连续落定也不超过 keepMax，挤掉的是最早成功的", () => {
    let entries: readonly NoticeSnapshot[] = [snap("f-early", true, 0)];
    for (let i = 1; i <= NOTICE_KEEP_MAX + 30; i += 1) entries = mergeNoticeEntries(entries, [snap(`ok-${i}`, false, i)]);
    strictEqual(entries.length, NOTICE_KEEP_MAX);
    const ids = new Set(entries.map((entry) => entry.id));
    strictEqual(ids.has("f-early"), true, "失败行排在前面，最早落定也不被挤掉");
    strictEqual(ids.has("ok-1"), false, "最早成功的先被挤掉");
    strictEqual(ids.has(`ok-${NOTICE_KEEP_MAX + 30}`), true, "最新落定的一定在");
  });

  it("keepMax 可传：小上限下同样按行序截断", () => {
    const merged = mergeNoticeEntries([snap("a", false, 1), snap("b", false, 2)], [snap("c", false, 3)], 2);
    deepStrictEqual(merged.map((entry) => entry.id), ["c", "b"]);
  });
});

describe("dropWatchedNotices（看着的那条从卡上退下）", () => {
  const entries: readonly NoticeSnapshot[] = [
    { id: "a", failed: false, settledAt: 1 },
    { id: "b", failed: true, settledAt: 2 },
  ];

  it("看着其中一条：只退那一条，其余留着", () => {
    deepStrictEqual(dropWatchedNotices(entries, ["a"]).map((entry) => entry.id), ["b"]);
  });

  it("看着的不在卡上：原数组引用不变", () => {
    strictEqual(dropWatchedNotices(entries, ["z"]), entries);
  });
});

describe("visibleNoticeRows（卡上可见行数上限）", () => {
  const rows = (count: number) => Array.from({ length: count }, (_, i) => `r${i}`);

  it("不超上限：全画，没有「还有 N 条」", () => {
    deepStrictEqual(visibleNoticeRows(rows(NOTICE_VISIBLE_MAX)), { shown: rows(NOTICE_VISIBLE_MAX), more: 0 });
    deepStrictEqual(visibleNoticeRows([]), { shown: [], more: 0 });
  });

  it("超上限：画前 max 行，其余记成 more", () => {
    const { shown, more } = visibleNoticeRows(rows(NOTICE_VISIBLE_MAX + 7));
    deepStrictEqual(shown, rows(NOTICE_VISIBLE_MAX));
    strictEqual(more, 7);
  });

  it("上限可传", () => {
    deepStrictEqual(visibleNoticeRows(rows(4), 2), { shown: ["r0", "r1"], more: 2 });
  });
});

/**
 * 回归：卡开着时，失败的那条会话又开了一轮——失败标记与排序都不能变。
 * 驱动的是真的会话状态归约器（applyAgentEvent），不是手造的槽：先证明新一轮确实把
 * 槽里的 turnError 清掉了（前提断言），再证明卡的行仍是落定那一刻的样子。
 */
describe("完成卡的失败标记是落定时快照", () => {
  const phase = (sessionId: string, value: "turn" | "idle"): AgentEvent => ({ type: "phase", sessionId, phase: value });
  const apply = (states: SessionStates, events: readonly AgentEvent[]): SessionStates =>
    events.reduce(applyAgentEvent, states);
  const turnErrorOf = (states: SessionStates) => (id: string) => states.get(id)?.turnError ?? null;
  const metas = [
    { id: "bad", title: "跑挂的那条" },
    { id: "good", title: "跑完的那条" },
  ];

  it("同一会话再开一轮：卡上仍标失败、仍排第一", () => {
    // 两条会话都在跑
    let states = apply(createSessionStates(), [phase("bad", "turn"), phase("good", "turn")]);
    // bad 先以回合失败落定
    let prev = states;
    states = apply(states, [{ type: "failed", sessionId: "bad", message: "重试耗尽", turn: true }, phase("bad", "idle")]);
    let card = mergeNoticeEntries([], snapshotSettled(settledSessions(prev, states), turnErrorOf(states), 100));
    // good 晚一点成功落定，并进同一张卡
    prev = states;
    states = apply(states, [phase("good", "idle")]);
    card = mergeNoticeEntries(card, snapshotSettled(settledSessions(prev, states), turnErrorOf(states), 200));
    const before = completionNoticeRows(card, metas);
    deepStrictEqual(before.map((row) => [row.id, row.failed]), [["bad", true], ["good", false]]);

    // 卡还开着，bad 又开了一轮：槽的失败标注被清掉（前提——不清的话这条测试测不到东西）
    prev = states;
    states = apply(states, [phase("bad", "turn")]);
    strictEqual(states.get("bad")?.turnError, null, "前提：新一轮开跑清掉了槽的 turnError");
    deepStrictEqual(settledSessions(prev, states), [], "新一轮开跑不是落定，卡片状态不动");

    const after = completionNoticeRows(card, metas);
    deepStrictEqual(after, before, "失败标记与行序都停在落定那一刻");
  });

  it("那一轮再落定（成功）：换成新快照，失败标记这才退掉", () => {
    let states = apply(createSessionStates(), [phase("bad", "turn")]);
    let prev = states;
    states = apply(states, [{ type: "failed", sessionId: "bad", message: "x", turn: true }, phase("bad", "idle")]);
    let card = mergeNoticeEntries([], snapshotSettled(settledSessions(prev, states), turnErrorOf(states), 100));
    states = apply(states, [phase("bad", "turn")]);
    prev = states;
    states = apply(states, [phase("bad", "idle")]);
    card = mergeNoticeEntries(card, snapshotSettled(settledSessions(prev, states), turnErrorOf(states), 300));
    deepStrictEqual(completionNoticeRows(card, metas), [{ id: "bad", title: "跑挂的那条", failed: false, settledAt: 300 }]);
  });

  it("会话被删掉：那一行跳过，全删光就是空（不弹卡）", () => {
    const card: NoticeSnapshot[] = [{ id: "gone", failed: true, settledAt: 1 }];
    deepStrictEqual(completionNoticeRows(card, metas), []);
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