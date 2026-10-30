import test from "node:test";
import assert from "node:assert/strict";
import type { MemoryHistoryScope, MemoryHistoryStatus } from "../../../../shared/memory.ts";
import {
  defaultHistorySelection,
  historyActive,
  historyPercent,
  historyTotals,
  mergeHistoryScopes,
} from "./history-view.ts";

const scope = (scopeId: string, stats: MemoryHistoryScope["stats"], sessions = 2): MemoryHistoryScope => ({
  scopeId,
  token: `tok-${scopeId}`,
  kind: "workspace",
  name: scopeId,
  sessions,
  stats,
});

const status = (patch: Partial<MemoryHistoryStatus>): MemoryHistoryStatus => ({
  state: "idle",
  scopeIds: [],
  totalTurns: 0,
  doneTurns: 0,
  episodes: 0,
  written: { fact: 0, preference: 0, insight: 0 },
  calls: 0,
  failed: 0,
  startedAt: null,
  updatedAt: null,
  ...patch,
});

test("默认勾选正在看的范围；对不上（全部 / 所有工作区层）不勾", () => {
  const scopes = [scope("ws-1", null), scope("ws-2", null)];
  assert.deepEqual(defaultHistorySelection(scopes, "tok-ws-2"), ["ws-2"]);
  assert.deepEqual(defaultHistorySelection(scopes, "all"), []);
});

test("合计：只算勾选的；有没统计完的标 counting；已处理与待处理分开", () => {
  const scopes = [scope("a", { turns: 10, processed: 4, calls: 20 }), scope("b", null, 3), scope("c", { turns: 1, processed: 0, calls: 3 })];
  assert.deepEqual(historyTotals(scopes, new Set(["a", "b"])), { sessions: 5, turns: 10, processed: 4, calls: 20, counting: true });
  assert.deepEqual(historyTotals(scopes, new Set(["a", "c"])), { sessions: 4, turns: 11, processed: 4, calls: 23, counting: false });
});

test("进度与任务在不在", () => {
  assert.equal(historyPercent(status({ totalTurns: 0 })), 0);
  assert.equal(historyPercent(status({ state: "done", totalTurns: 0 })), 100);
  assert.equal(historyPercent(status({ totalTurns: 3, doneTurns: 1 })), 33);
  assert.equal(historyActive(status({ state: "paused" })), true);
  assert.equal(historyActive(status({ state: "failed" })), true);
  assert.equal(historyActive(status({ state: "done" })), false);
  assert.equal(historyActive(null), false);
});

test("合并预估：新一轮没点名的作用域保留上次的数", () => {
  const merged = mergeHistoryScopes([scope("a", { turns: 1, processed: 0, calls: 3 })], [scope("a", null), scope("b", { turns: 2, processed: 1, calls: 5 })]);
  assert.deepEqual(merged.map((row) => row.stats?.turns ?? null), [1, 2]);
});
