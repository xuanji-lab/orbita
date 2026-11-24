import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionMeta } from "@shared/session";
import type { SessionRunState } from "../notify/completion-notice.ts";
import { mainSessionOf, orchestraTree, sessionHeadTitle, TREE_IDLE_MS } from "./orchestra-data.ts";

const NOW = new Date(2026, 10, 24, 15, 0, 0).getTime();
const HOUR = 3_600_000;

function meta(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: id,
    titleSource: "user",
    cwd: "/w",
    workspaceId: "ws",
    providerId: "p",
    modelId: "m",
    mode: "skip",
    thinkingLevel: "medium",
    piSessionFile: null,
    pinned: false,
    archived: false,
    recentQueries: [],
    stats: null,
    createdAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
    ...over,
  };
}
const none = (): SessionRunState => null;

describe("编排面板的树：列出这个工作区的全部 session", () => {
  test("下一层 = 这个工作区的每一条会话；子会话挂在父会话下面（孙会话也挂着）；别的工作区不混进来", () => {
    const sessions = [
      meta("a", { createdAt: NOW - 3 * HOUR }),
      meta("b", { createdAt: NOW - 2 * HOUR }),
      meta("a1", { parentId: "a" }),
      meta("a1x", { parentId: "a1" }),
      meta("elsewhere", { workspaceId: "other" }),
    ];
    const tree = orchestraTree({ sessions, workspaceId: "ws", stateOf: none, now: NOW });
    assert.deepEqual(tree.recent.map((n) => n.meta.id), ["b", "a"], "新的在前");
    assert.deepEqual(tree.recent[1]?.children.map((n) => n.meta.id), ["a1"]);
    assert.deepEqual(tree.recent[1]?.children[0]?.children.map((n) => n.meta.id), ["a1x"]);
    assert.equal(tree.total, 2);
  });

  test("状态变化不让行换位置：次序只按创建时间", () => {
    const sessions = [meta("a", { createdAt: NOW - 2 * HOUR }), meta("b", { createdAt: NOW - HOUR })];
    const idle = orchestraTree({ sessions, workspaceId: "ws", stateOf: none, now: NOW });
    const busy = orchestraTree({ sessions, workspaceId: "ws", stateOf: (m) => (m.id === "a" ? "waiting" : null), now: NOW });
    assert.deepEqual(idle.recent.map((n) => n.meta.id), busy.recent.map((n) => n.meta.id));
  });

  test("自己退场但不藏：没状态又 3 天没碰的进「更早」；在跑 / 等你 / 子会话在跑的留在「最近」", () => {
    const old = NOW - TREE_IDLE_MS - HOUR;
    const sessions = [
      meta("stale", { updatedAt: old, createdAt: old }),
      meta("stale-running", { updatedAt: old, createdAt: old - 1 }),
      meta("stale-parent", { updatedAt: old, createdAt: old - 2 }),
      meta("kid", { parentId: "stale-parent" }),
    ];
    const stateOf = (m: SessionMeta): SessionRunState => (m.id === "stale-running" || m.id === "kid" ? "running" : null);
    const tree = orchestraTree({ sessions, workspaceId: "ws", stateOf, now: NOW });
    assert.deepEqual(tree.recent.map((n) => n.meta.id), ["stale-running", "stale-parent"]);
    assert.equal(tree.recent[1]?.activeBelow, true, "子会话在跑的默认展开");
    assert.deepEqual(tree.older.map((n) => n.meta.id), ["stale"]);
    assert.equal(tree.total, 3);
  });

  test("满载：400 条会话一条不少（最近 + 更早 = 全部），一条会话的 40 个子会话全挂着", () => {
    const sessions: SessionMeta[] = [];
    for (let i = 0; i < 400; i++) sessions.push(meta(`s${i}`, { createdAt: NOW - i * HOUR, updatedAt: NOW - i * HOUR }));
    for (let i = 0; i < 40; i++) sessions.push(meta(`k${i}`, { parentId: "s0" }));
    const tree = orchestraTree({ sessions, workspaceId: "ws", stateOf: none, now: NOW });
    assert.equal(tree.recent.length + tree.older.length, 400);
    assert.equal(tree.total, 400);
    assert.equal(tree.recent[0]?.children.length, 40);
  });

  test("归档的、自动化开出来没转正的不列；主目录只列不属于任何工作区的", () => {
    const sessions = [meta("arch", { archived: true }), meta("auto", { automationId: "x" }), meta("promoted", { automationId: "x", promoted: true }), meta("home", { workspaceId: null })];
    assert.deepEqual(orchestraTree({ sessions, workspaceId: "ws", stateOf: none, now: NOW }).recent.map((n) => n.meta.id), ["promoted"]);
    assert.deepEqual(orchestraTree({ sessions, workspaceId: null, stateOf: none, now: NOW }).recent.map((n) => n.meta.id), ["home"]);
  });

  test("页头次级标题：用会话标题，空标题给兜底词，不露会话 id", () => {
    assert.equal(sessionHeadTitle(meta("x", { title: "  修侧栏 " }), "新任务"), "修侧栏");
    assert.equal(sessionHeadTitle(meta("x", { title: "" }), "新任务"), "新任务");
    assert.equal(sessionHeadTitle(null, "新任务"), "新任务");
  });
});

describe("主智能体的常驻对话：树里置顶，指针失效当作没有", () => {
  test("mainId 那条单独拎出来（不在最近 / 更早里），它的子会话照样挂着；总数仍算它", () => {
    const sessions = [meta("a"), meta("main", { updatedAt: NOW - 30 * 24 * HOUR }), meta("m1", { parentId: "main" })];
    const tree = orchestraTree({ sessions, workspaceId: "ws", stateOf: none, now: NOW, mainId: "main" });
    assert.equal(tree.main?.meta.id, "main");
    assert.deepEqual(tree.main?.children.map((c) => c.meta.id), ["m1"]);
    assert.deepEqual([...tree.recent, ...tree.older].map((n) => n.meta.id), ["a"]);
    assert.equal(tree.total, 2);
  });
  test("mainSessionOf：在、没归档、是根会话、还在这个工作区才算；星际空间没有", () => {
    const pointers = { ws: "main" };
    assert.equal(mainSessionOf([meta("main")], "ws", pointers)?.id, "main");
    assert.equal(mainSessionOf([], "ws", pointers), null);
    assert.equal(mainSessionOf([meta("main", { archived: true })], "ws", pointers), null);
    assert.equal(mainSessionOf([meta("main", { workspaceId: "other" })], "ws", pointers), null);
    assert.equal(mainSessionOf([meta("main", { parentId: "x" })], "ws", pointers), null);
    assert.equal(mainSessionOf([meta("main")], "ws", undefined), null);
    assert.equal(mainSessionOf([meta("main", { workspaceId: null })], null, { "": "main" }), null);
  });
});
