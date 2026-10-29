import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { MemoryEntry, MemoryEntryView, MemorySessionView } from "../../../../shared/memory.ts";
import {
  filterMemoryEntries,
  groupMemoryEntries,
  memoryIsActive,
  memoryTurnCounts,
  rememberedTurns,
} from "./memory-view.ts";

const entry = (id: string, patch: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id,
  type: "fact",
  text: `条目 ${id}`,
  keywords: [],
  layer: "workspace",
  scopeId: "ws-1",
  sessionId: "s1",
  turns: [1],
  at: 1000,
  episodeId: "ep_1",
  source: "chat",
  ...patch,
});

const view = (e: MemoryEntry, patch: Partial<MemoryEntryView> = {}): MemoryEntryView => ({
  entry: e,
  token: "tok",
  sessionTitle: "某次会话",
  quote: null,
  evolution: [],
  ...patch,
});

const items = [
  view(entry("f1", { text: "用户关闭了会话记忆的旧 PR" })),
  view(entry("p1", { type: "preference", text: "UI 由父会话自己做", reason: "涉及UI的你得自己修" })),
  view(entry("i1", { type: "insight", text: "先看实测证据", reason: "三次交互", source: "manual" })),
  view(entry("p2", { type: "preference", text: "本地优先", keywords: ["embedding", "隐私"] }), { quote: "否则建议用便宜的 API" }),
];

describe("filterMemoryEntries", () => {
  test("类型与来源筛选；顺序不变", () => {
    assert.deepEqual(
      filterMemoryEntries(items, { type: "preference", source: "all", query: "" }).map((v) => v.entry.id),
      ["p1", "p2"],
    );
    assert.deepEqual(
      filterMemoryEntries(items, { type: "all", source: "manual", query: "" }).map((v) => v.entry.id),
      ["i1"],
    );
  });

  test("搜索命中正文、理由、原话、关键词；多个词都要命中，大小写不敏感", () => {
    const ids = (query: string) => filterMemoryEntries(items, { type: "all", source: "all", query }).map((v) => v.entry.id);
    assert.deepEqual(ids("自己修"), ["p1"]);
    assert.deepEqual(ids("api"), ["p2"]);
    assert.deepEqual(ids("EMBEDDING 隐私"), ["p2"]);
    assert.deepEqual(ids("embedding 不存在"), []);
    assert.equal(ids("   ").length, 4);
  });

  test("搜得到出处会话标题", () => {
    assert.equal(filterMemoryEntries(items, { type: "all", source: "all", query: "某次" }).length, 4);
  });
});

describe("groupMemoryEntries", () => {
  test("偏好、经验、事实的顺序；空类型不出组", () => {
    assert.deepEqual(
      groupMemoryEntries(items).map((g) => [g.type, g.items.map((v) => v.entry.id)]),
      [
        ["preference", ["p1", "p2"]],
        ["insight", ["i1"]],
        ["fact", ["f1"]],
      ],
    );
    assert.deepEqual(groupMemoryEntries([items[0]!]).map((g) => g.type), ["fact"]);
  });
});

describe("memoryIsActive", () => {
  test("缺席与 active 会被召回，muted 与 stale 不会", () => {
    assert.equal(memoryIsActive(entry("a")), true);
    assert.equal(memoryIsActive(entry("a", { status: "active" })), true);
    assert.equal(memoryIsActive(entry("a", { status: "muted" })), false);
    assert.equal(memoryIsActive(entry("a", { status: "stale" })), false);
  });
});

describe("按轮", () => {
  const session: MemorySessionView = {
    sessionId: "s1",
    token: "tok",
    organizing: false,
    pendingCount: 0,
    turns: [
      { turn: 1, at: 1, used: [{ id: "x", text: "x", score: 0.5 }], remembered: [] },
      { turn: 2, at: 2, used: [], remembered: [entry("f1")] },
      { turn: 3, at: 3, used: [{ id: "y", text: "y", score: 1, pinned: true }], remembered: [entry("p1"), entry("p2")] },
    ],
  };

  test("某轮的用到 / 记住条数；没有这轮的账返回 null", () => {
    assert.deepEqual(memoryTurnCounts(session, 3), { used: 1, remembered: 2 });
    assert.deepEqual(memoryTurnCounts(session, 1), { used: 1, remembered: 0 });
    assert.equal(memoryTurnCounts(session, 9), null);
    assert.equal(memoryTurnCounts(null, 1), null);
  });

  test("审查页签只列记住了东西的轮，新轮在上", () => {
    assert.deepEqual(rememberedTurns(session).map((row) => row.turn), [3, 2]);
    assert.deepEqual(rememberedTurns(null), []);
  });
});
