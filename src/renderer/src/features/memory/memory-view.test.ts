import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { MemoryEntry, MemoryEntryView, MemorySessionView } from "../../../../shared/memory.ts";
import { MEMORY_MUTED_REVERTED } from "../../../../shared/memory.ts";
import {
  isRevertMuted,
  liveRemembered,
  manualDraftProblem,
  memoryUndoActions,
  pairMemoryTurns,
  filterMemoryEntries,
  groupMemoryEntries,
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


describe("pairMemoryTurns：对话气泡挂哪一轮的记忆", () => {
  const row = (turn: number, at: number) => ({ turn, at, used: [], remembered: [] });
  const session = (turns: ReturnType<typeof row>[]): MemorySessionView => ({
    sessionId: "s",
    token: null,
    turns,
  });
  const users = [
    { id: "u1", timestamp: 100_000 },
    { id: "u2", timestamp: 200_000 },
    { id: "u3", timestamp: 300_000 },
  ];

  test("按时间配：召回略早于消息也认", () => {
    const paired = pairMemoryTurns(users, session([row(1, 99_500), row(2, 199_800), row(3, 299_900)]));
    assert.equal(paired.get("u1")?.turn, 1);
    assert.equal(paired.get("u2")?.turn, 2);
    assert.equal(paired.get("u3")?.turn, 3);
  });

  test("renderer 只有最近几条消息（后台跑的轮 / 只加载了一页）：轮号大也配得上，不按计数错配", () => {
    // 实测回归：转录里只有第 7、8 轮两条消息，计数会把它们配成第 1、2 轮
    const live = [
      { id: "u7", timestamp: 1_000_000 },
      { id: "u8", timestamp: 1_010_000 },
    ];
    const view = session([row(1, 10_000), row(2, 20_000), row(7, 999_700), row(8, 1_009_900)]);
    const paired = pairMemoryTurns(live, view);
    assert.equal(paired.get("u7")?.turn, 7);
    assert.equal(paired.get("u8")?.turn, 8);
    assert.equal(paired.size, 2);
  });

  test("窗口之前的轮不挂到第一条气泡上", () => {
    const paired = pairMemoryTurns(users, session([row(5, 10_000), row(41, 98_000)]));
    assert.equal(paired.get("u1")?.turn, 41);
    assert.equal(paired.size, 1);
  });

  test("回退后：被撤回轮的账（时间在最后一条消息之后）不顶掉那条消息自己的轮", () => {
    // 实例 memrevert 实测：回到第 2 轮后只剩 u1，第 2 轮的账（几分钟后）也落在 u1 名下，
    // 旧规则留轮号大的，u1 下的「记住 3 条」被换成撤回轮的空行
    const live = [{ id: "u1", timestamp: 100_000 }];
    const paired = pairMemoryTurns(live, session([row(2, 410_000), row(1, 99_800)]));
    assert.equal(paired.get("u1")?.turn, 1);
  });

  test("没有视图或没有消息：空表", () => {
    assert.equal(pairMemoryTurns(users, null).size, 0);
    assert.equal(pairMemoryTurns([], session([row(1, 0)])).size, 0);
  });
});

describe("条目卡的撤销入口", () => {
  const base = {
    id: "mem_new",
    type: "preference" as const,
    text: "新说法",
    keywords: [],
    layer: "workspace" as const,
    scopeId: "ws",
    sessionId: "s",
    turns: [3],
    at: 3,
    episodeId: "",
    source: "agent" as const,
  };
  const chain = (oldStatus: "stale" | "active") => [
    { id: "mem_old", text: "旧说法", at: 1, status: oldStatus, source: "chat" as const },
    { id: "mem_new", text: "新说法", at: 3, source: "agent" as const },
  ];
  const view = (entry: Record<string, unknown>, evolution: ReturnType<typeof chain> | []) => ({
    entry: { ...base, ...entry },
    token: "t",
    sessionTitle: null,
    quote: null,
    evolution,
  });

  test("顶掉了旧说法、旧条已过时、这条还在用：给「恢复旧说法」", () => {
    assert.deepEqual(memoryUndoActions(view({ conflictWith: "mem_old" }, chain("stale"))), {
      restorePrevious: true,
      returnToWorkspace: false,
    });
  });

  test("已经恢复过（旧条 active、这条 muted）或没有 conflictWith：不给", () => {
    assert.equal(memoryUndoActions(view({ conflictWith: "mem_old", status: "muted" }, chain("active"))).restorePrevious, false);
    assert.equal(memoryUndoActions(view({ conflictWith: "mem_old" }, chain("active"))).restorePrevious, false);
    assert.equal(memoryUndoActions(view({}, [])).restorePrevious, false);
  });

  test("自动记到所有工作区且还在 user 层：给「只留在原工作区」；搬回去后不给", () => {
    assert.equal(memoryUndoActions(view({ layer: "user", promotedFrom: "abc" }, [])).returnToWorkspace, true);
    assert.equal(memoryUndoActions(view({ layer: "workspace" }, [])).returnToWorkspace, false);
    assert.equal(memoryUndoActions(view({ layer: "user" }, [])).returnToWorkspace, false);
  });
});

describe("手动添加校验", () => {
  test("事实可不写理由，偏好 / 经验必须写", () => {
    assert.equal(manualDraftProblem({ type: "fact", text: "x", reason: "" }), null);
    assert.equal(manualDraftProblem({ type: "preference", text: "x", reason: " " }), "reason");
    assert.equal(manualDraftProblem({ type: "insight", text: "  ", reason: "y" }), "text");
  });
});

describe("随对话回退停用", () => {
  test("isRevertMuted：只认 muted + 回退保留值；agent 停用 / 恢复使用后不算", () => {
    assert.equal(isRevertMuted(entry("a", { status: "muted", mutedReason: MEMORY_MUTED_REVERTED })), true);
    assert.equal(isRevertMuted(entry("b", { status: "muted", mutedReason: "agent 说不对" })), false);
    assert.equal(isRevertMuted(entry("c", { status: "active" })), false);
  });

  test("liveRemembered：对话行里去掉随回退停用的条目（重说的那一轮与被撤回的同轮号）；别的停用照常留着", () => {
    const row = {
      turn: 2,
      at: 1000,
      used: [],
      remembered: [
        view(entry("old", { status: "muted", mutedReason: MEMORY_MUTED_REVERTED })),
        view(entry("new")),
        view(entry("retired", { status: "muted", mutedReason: "agent 说不对" })),
      ],
    };
    assert.deepEqual(liveRemembered(row).remembered.map((item) => item.entry.id), ["new", "retired"]);
    const clean = { ...row, remembered: [view(entry("new"))] };
    assert.equal(liveRemembered(clean), clean);
  });
});
