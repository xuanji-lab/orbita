import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { agentLineOf, agentStatusCount, agentStatusOf, headerStatusOf, orderAgentRows } from "./agent-status.ts";

const base = { waiting: 0, running: 0, lastTitle: null as string | null, waitingId: null as string | null };

describe("状态词表：侧栏行与页头胶囊共用同一个判定", () => {
  test("等你 > 在跑 > 空闲；件数只在等你 / 在跑时带", () => {
    assert.equal(agentStatusOf({ waiting: 2, running: 5 }), "waiting");
    assert.equal(agentStatusOf({ waiting: 0, running: 3 }), "running");
    assert.equal(agentStatusOf({ waiting: 0, running: 0 }), "idle");
    assert.equal(agentStatusCount({ waiting: 2, running: 5 }), 2);
    assert.equal(agentStatusCount({ waiting: 0, running: 3 }), 3);
    assert.equal(agentStatusCount({ waiting: 0, running: 0 }), null);
  });
  test("出错（最近一轮失败，如模型 401）排在在跑之后、空闲之前，带件数；侧栏行与页头一致", () => {
    assert.equal(agentStatusOf({ waiting: 0, running: 0, failed: 1 }), "failed");
    assert.equal(agentStatusOf({ waiting: 0, running: 2, failed: 1 }), "running");
    assert.equal(agentStatusOf({ waiting: 1, running: 0, failed: 1 }), "waiting");
    assert.equal(agentStatusCount({ waiting: 0, running: 0, failed: 2 }), 2);
    const summary = { ...base, failed: 1, lastTitle: "x" };
    assert.equal(agentLineOf(summary).status, "failed");
    assert.equal(agentLineOf(summary).recent, null, "出错时不补「最近」");
    assert.equal(headerStatusOf(summary).status, "failed");
  });
  test("同一份数据：侧栏行与页头胶囊的状态与件数一致", () => {
    for (const summary of [{ ...base, waiting: 1 }, { ...base, running: 4 }, base, { ...base, waiting: 2, running: 9, lastTitle: "x" }]) {
      const line = agentLineOf(summary);
      const header = headerStatusOf(summary);
      assert.equal(line.status, header.status);
      assert.equal(line.count, header.count);
    }
  });
});

describe("agentLineOf —— 第二行永远是状态", () => {
  test("在跑 / 等你时不挤进最近标题；只有空闲才补最近一件事", () => {
    assert.deepEqual(agentLineOf({ ...base, waiting: 1, running: 2, lastTitle: "x" }), { status: "waiting", count: 1, recent: null });
    assert.deepEqual(agentLineOf({ ...base, running: 3, lastTitle: "x" }), { status: "running", count: 3, recent: null });
    assert.deepEqual(agentLineOf({ ...base, lastTitle: "整理文献" }), { status: "idle", count: null, recent: "整理文献" });
    assert.deepEqual(agentLineOf(base), { status: "idle", count: null, recent: null });
  });
});

describe("headerStatusOf", () => {
  test("等你时带直达的会话 id，别的状态没有", () => {
    assert.deepEqual(headerStatusOf({ waiting: 1, running: 4, waitingId: "s1" }), { status: "waiting", count: 1, sessionId: "s1" });
    assert.deepEqual(headerStatusOf({ waiting: 0, running: 4, waitingId: null }), { status: "running", count: 4, sessionId: null });
    assert.deepEqual(headerStatusOf({ waiting: 0, running: 0, waitingId: null }), { status: "idle", count: null, sessionId: null });
  });
});

describe("orderAgentRows —— 主目录固定在前、等你置顶、其余按时间", () => {
  const key = (r: { pinned?: boolean; waiting?: number; at: number | null }) => ({ pinned: r.pinned === true, waiting: r.waiting ?? 0, lastActive: r.at });
  test("次序：固定 → 等你（新的在前）→ 其余按最近活动；没有会话的垫底；同分保持原次序", () => {
    const rows = [
      { id: "a", at: 10 },
      { id: "home", pinned: true, at: 1 },
      { id: "b", at: 50 },
      { id: "w1", waiting: 1, at: 5 },
      { id: "w2", waiting: 3, at: 9 },
      { id: "empty", at: null },
      { id: "c", at: 50 },
    ];
    assert.deepEqual(orderAgentRows(rows, key).map((r) => r.id), ["home", "w2", "w1", "b", "c", "a", "empty"]);
  });
  test("等你的事处理掉（waiting 归零）后落回时间位；不改入参", () => {
    const rows = [{ id: "x", at: 1, waiting: 1 }, { id: "y", at: 9 }];
    assert.deepEqual(orderAgentRows(rows, key).map((r) => r.id), ["x", "y"]);
    const handled = [{ id: "x", at: 1, waiting: 0 }, { id: "y", at: 9 }];
    assert.deepEqual(orderAgentRows(handled, key).map((r) => r.id), ["y", "x"]);
    assert.equal(rows[0]?.id, "x");
  });
});
