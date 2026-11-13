/**
 * 「整个任务」取数编排的纯状态机测试：分页累积与去重、页数上限、空页异常、
 * 回退失效指纹、与尾窗视图的合并去重、store 的订阅与引用稳定。
 */
import { deepStrictEqual, equal, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionRecord, TranscriptRecord } from "../../../../shared/session.ts";
import {
  advanceHistory,
  failHistory,
  historyStale,
  mergeHistory,
  startHistory,
  TASK_HISTORY_IDLE,
  TASK_HISTORY_PAGE_LIMIT,
  TaskHistoryStore,
} from "./task-inventory.ts";

function userRecord(id: string, timestamp: number): SessionRecord {
  return { id, role: "user", content: [{ type: "text", text: "问" }], timestamp } as SessionRecord;
}

function toolRecord(id: string, timestamp: number): SessionRecord {
  return {
    id,
    role: "tool",
    toolCallId: `tc-${id}`,
    toolName: "read",
    input: { path: "/ws/a.ts" },
    content: [{ type: "text", text: "内容" }],
    timestamp,
    status: "complete",
    isError: false,
  } as SessionRecord;
}

describe("startHistory / advanceHistory —— 分页累积", () => {
  it("开拉记指纹进入 loading；每页整页前插、条数累加", () => {
    let state = startHistory({ firstId: "w1", reverts: 0 });
    strictEqual(state.status, "loading");
    deepStrictEqual(state.anchor, { firstId: "w1", reverts: 0 });

    // 第一页（紧挨尾窗之前，页内时间正序），第二页更早——整页前插保持正序
    state = advanceHistory(state, { records: [userRecord("p1a", 11), toolRecord("p1b", 12)], hasMore: true });
    strictEqual(state.status, "loading");
    strictEqual(state.fetched, 2);
    deepStrictEqual(state.records.map((r) => r.id), ["p1a", "p1b"]);

    state = advanceHistory(state, { records: [userRecord("p0", 5)], hasMore: false });
    strictEqual(state.status, "ready");
    strictEqual(state.fetched, 3);
    deepStrictEqual(state.records.map((r) => r.id), ["p0", "p1a", "p1b"]);
    equal(state.capped, false);
  });

  it("同一条记录在两页都出现（与聊天面分页重叠）按 id 去重、不重复计数", () => {
    let state = startHistory({ firstId: "w1", reverts: 1 });
    state = advanceHistory(state, { records: [userRecord("a", 1)], hasMore: true });
    state = advanceHistory(state, { records: [userRecord("a", 1), userRecord("b", 0)], hasMore: false });
    deepStrictEqual(state.records.map((r) => r.id), ["b", "a"]);
    strictEqual(state.fetched, 2);
  });

  it("撞页数上限：停住并标 capped（整个任务不完整但已到手的部分可用）", () => {
    let state = startHistory({ firstId: "w1", reverts: 0 });
    for (let i = 0; i < TASK_HISTORY_PAGE_LIMIT; i += 1) {
      state = advanceHistory(state, { records: [userRecord(`p${i}`, i)], hasMore: true });
    }
    strictEqual(state.status, "ready");
    equal(state.capped, true);
    strictEqual(state.pages, TASK_HISTORY_PAGE_LIMIT);
    strictEqual(state.records.length, TASK_HISTORY_PAGE_LIMIT);
  });

  it("空页却声称还有更多（主进程对不上盘的防御信号）：判错停住，不空转", () => {
    let state = startHistory({ firstId: "w1", reverts: 0 });
    state = advanceHistory(state, { records: [], hasMore: true });
    strictEqual(state.status, "error");
    ok(state.error !== null);
    deepStrictEqual(state.records, []);
  });

  it("失败保留已到手的记录，标错", () => {
    let state = startHistory({ firstId: "w1", reverts: 0 });
    state = advanceHistory(state, { records: [userRecord("a", 1)], hasMore: true });
    state = failHistory(state, "IPC 挂了");
    strictEqual(state.status, "error");
    strictEqual(state.error, "IPC 挂了");
    deepStrictEqual(state.records.map((r) => r.id), ["a"]);
  });
});

describe("historyStale —— 回退指纹", () => {
  it("回退计数变了才失效；firstId 前移（聊天面自己翻页）不算失效", () => {
    const state = startHistory({ firstId: "w1", reverts: 0 });
    equal(historyStale(state, { firstId: "w0", reverts: 0 }), false);
    equal(historyStale(state, { firstId: "w1", reverts: 1 }), true);
  });

  it("idle 常量态永不失效（没有缓存就没有失效）", () => {
    equal(historyStale(TASK_HISTORY_IDLE, { firstId: null, reverts: 9 }), false);
  });
});

describe("mergeHistory —— 更早记录 + 尾窗视图", () => {
  it("更早的在前、尾窗在后，按 id 去重（聊天面翻页装进尾窗的那批不重复）", () => {
    const older: SessionRecord[] = [userRecord("old2", 1), toolRecord("old1", 2)];
    const current: TranscriptRecord[] = [toolRecord("old1", 2), userRecord("tail1", 10)];
    const merged = mergeHistory(older, current);
    deepStrictEqual(merged.map((r) => r.id), ["old2", "old1", "tail1"]);
  });

  it("空侧直接复制另一侧（引用不共享）", () => {
    const current: TranscriptRecord[] = [userRecord("a", 1)];
    deepStrictEqual(mergeHistory([], current).map((r) => r.id), ["a"]);
    deepStrictEqual(mergeHistory([userRecord("a", 1)], []).map((r) => r.id), ["a"]);
  });
});

describe("TaskHistoryStore —— 订阅与引用稳定", () => {
  it("缺席的会话拿到 IDLE 常量（同一引用）；写入后通知订阅者", () => {
    const store = new TaskHistoryStore();
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });

    strictEqual(store.snapshot("s1"), TASK_HISTORY_IDLE);
    strictEqual(store.snapshot("s1"), TASK_HISTORY_IDLE); // 引用稳定

    const state = startHistory({ firstId: "w1", reverts: 0 });
    store.set("s1", state);
    strictEqual(notified, 1);
    strictEqual(store.snapshot("s1"), state);

    // 相同引用的写入不通知
    store.set("s1", state);
    strictEqual(notified, 1);

    unsubscribe();
    store.drop("s1");
    strictEqual(notified, 1); // 退订后不再通知
    strictEqual(store.snapshot("s1"), TASK_HISTORY_IDLE);
  });
});
