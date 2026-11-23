import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ChannelMessage } from "@shared/channel";
import type { SessionMeta } from "@shared/session";
import type { SessionRunState } from "../notify/completion-notice.ts";
import { COLLAB_CHILD_CAP, COLLAB_SESSION_CAP, collabGraph, demoCollab, firstLine, layoutCollab } from "./collab-graph.ts";

const NOW = 1_800_000_000_000;
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
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}
const msg = (from: "parent" | "child", kind: ChannelMessage["kind"], text: string, at = NOW): ChannelMessage => ({
  id: `${from}-${kind}-${at}`,
  from,
  author: "model",
  kind,
  text,
  delivery: "steer",
  createdAt: at,
});
const root = { id: "ws", name: "orbita", role: "接你的话、派活、收结果" };

function graphOf(sessions: SessionMeta[], over: Partial<Parameters<typeof collabGraph>[0]> = {}) {
  return collabGraph({
    root,
    sessions: sessions.filter((m) => m.parentId === undefined),
    all: sessions,
    stateOf: () => null,
    now: NOW,
    channels: new Map(),
    artifacts: {},
    ...over,
  });
}

describe("协作图的数据：只画真实的边", () => {
  test("主智能体 → session（开工那一句）、session → 主智能体（产出文件）；session → 子会话（任务说明）、子会话 → session（结果 + 产出）", () => {
    const sessions = [meta("s", { recentQueries: ["第三句", "第二句", "修侧栏的行尾\n细节"] }), meta("k", { parentId: "s", title: "检索相关实现" })];
    const graph = graphOf(sessions, {
      channels: new Map([["k", [msg("parent", "task", "找出 X 的实现\n细节……"), msg("child", "progress", "在看"), msg("child", "done", "找到 3 处\n附表", NOW + 2)]]]),
      artifacts: { s: { files: 1, exts: [".ts"] }, k: { files: 2, exts: [".md", ".ts"] } },
    });
    assert.deepEqual(graph.nodes.map((n) => [n.id, n.kind, n.depth, n.parent]), [["ws", "main", 0, null], ["s", "session", 1, "ws"], ["k", "child", 2, "s"]]);
    const edge = (id: string) => graph.edges.find((e) => e.id === id);
    assert.deepEqual([edge("task:s")?.from, edge("task:s")?.to, edge("task:s")?.text], ["ws", "s", "修侧栏的行尾"], "开工那一句 = 记下的最早一条提问");
    assert.deepEqual(edge("report:s")?.files, { files: 1, exts: [".ts"] });
    assert.deepEqual([edge("task:k")?.from, edge("task:k")?.text], ["s", "找出 X 的实现"]);
    assert.deepEqual([edge("report:k")?.to, edge("report:k")?.text, edge("report:k")?.pending], ["s", "找到 3 处", false]);
    assert.equal(graph.nodes[2]?.role, "检索相关实现", "没有档案：职责取任务标题");
    assert.equal(graph.nodes[2]?.roleSource, "title");
    assert.equal(graph.edges.some((e) => e.kind === "peer"), false, "子智能体之间没有数据：不造边");
  });

  test("没有记录就说没有：读不到通道 → 任务说明 null；子会话在跑没交回 → pending；空闲没交回 → 不 pending；没有文件账 → 0 个", () => {
    const sessions = [meta("s"), meta("r", { parentId: "s" }), meta("i", { parentId: "s" })];
    const stateOf = (m: SessionMeta): SessionRunState => (m.id === "r" ? "running" : null);
    const graph = graphOf(sessions, { stateOf });
    const edge = (id: string) => graph.edges.find((e) => e.id === id);
    assert.equal(edge("task:r")?.text, null);
    assert.equal(edge("report:r")?.pending, true);
    assert.equal(edge("report:i")?.pending, false);
    assert.deepEqual(edge("report:i")?.files, { files: 0, exts: [] });
    assert.equal(edge("task:s")?.text, null, "没记下提问就没有开工那一句");
  });

  test("星际空间（没有工作区）：没有主智能体根节点，session 是第一层，只有 session ↔ 子会话的边", () => {
    const sessions = [meta("s", { workspaceId: null }), meta("k", { parentId: "s", workspaceId: null })];
    const graph = graphOf(sessions, { root: null });
    assert.equal(graph.nodes.some((n) => n.kind === "main"), false);
    assert.deepEqual(graph.nodes.map((n) => [n.id, n.depth]), [["s", 0], ["k", 1]]);
    assert.deepEqual(graph.edges.map((e) => e.id).sort(), ["report:k", "task:k"]);
  });

  test("满载：只挑有子会话 / 有状态 / 3 天内动过的 session，最多 COLLAB_SESSION_CAP 条，每条最多 COLLAB_CHILD_CAP 个子会话，其余计 hidden", () => {
    const sessions: SessionMeta[] = [];
    for (let i = 0; i < 30; i++) sessions.push(meta(`s${i}`, { createdAt: NOW - i * 1000 }));
    for (let i = 0; i < 9; i++) sessions.push(meta(`k${i}`, { parentId: "s0" }));
    const graph = graphOf(sessions);
    assert.equal(graph.nodes.filter((n) => n.kind === "session").length, COLLAB_SESSION_CAP);
    assert.equal(graph.nodes.filter((n) => n.kind === "child").length, COLLAB_CHILD_CAP);
    assert.equal(graph.hidden, 30 - COLLAB_SESSION_CAP + (9 - COLLAB_CHILD_CAP));
  });

  test("firstLine：取第一行、去空白；空的为 null", () => {
    assert.equal(firstLine("  a\nb"), "a");
    assert.equal(firstLine("\n"), null);
    assert.equal(firstLine(undefined), null);
  });
});

describe("协作图的布局：稳", () => {
  const sessions = [meta("a", { createdAt: NOW + 2 }), meta("b", { createdAt: NOW + 1 }), meta("a1", { parentId: "a" })];

  test("状态变了，节点与边的位置一个像素都不动", () => {
    const a = layoutCollab(graphOf(sessions), 360);
    const b = layoutCollab(graphOf(sessions, { stateOf: (m) => (m.id === "a" ? "waiting" : "running") }), 360);
    assert.deepEqual([...a.cards.entries()], [...b.cards.entries()]);
    assert.deepEqual([...a.edges.entries()], [...b.edges.entries()]);
  });

  test("加一条 session：原来的块整体下移、相对次序不变（新的在最上）", () => {
    const before = layoutCollab(graphOf(sessions), 360);
    const after = layoutCollab(graphOf([...sessions, meta("c", { createdAt: NOW + 3 })]), 360);
    const step = (after.cards.get("a")?.y ?? 0) - (before.cards.get("a")?.y ?? 0);
    assert.ok(step > 0);
    assert.equal((after.cards.get("b")?.y ?? 0) - (before.cards.get("b")?.y ?? 0), step);
    assert.ok((after.cards.get("c")?.y ?? 0) < (after.cards.get("a")?.y ?? 0));
  });

  test("层次：子会话比它的 session 缩进、右缘让出交回主干；派活箭头朝下落在卡顶，交回箭头朝左落在父卡右缘；标签不出面板", () => {
    const layout = layoutCollab(graphOf(sessions), 360);
    const a = layout.cards.get("a");
    const a1 = layout.cards.get("a1");
    assert.ok(a !== undefined && a1 !== undefined && a1.x > a.x && a1.x + a1.w < a.x + a.w);
    assert.equal(layout.edges.get("task:a1")?.arrow.dir, "down");
    assert.equal(layout.edges.get("task:a1")?.arrow.y, a1.y);
    assert.equal(layout.edges.get("report:a1")?.arrow.x, a.x + a.w);
    for (const edge of layout.edges.values()) assert.ok(edge.label.x + edge.label.w <= 360);
  });

  test("演示图：标明是演示，带环（实现 ⇄ 测试），有活与活的边时卡让出右侧的道", () => {
    const demo = demoCollab(root, true);
    assert.equal(demo.demo, true);
    const peers = demo.edges.filter((e) => e.kind === "peer");
    assert.ok(peers.some((e) => e.from === "demo-build" && e.to === "demo-test"));
    assert.ok(peers.some((e) => e.from === "demo-test" && e.to === "demo-build"), "允许成环");
    const card = layoutCollab(demo, 420).cards.get("demo-s");
    const plain = layoutCollab(graphOf(sessions), 420).cards.get("a");
    assert.ok(card !== undefined && plain !== undefined && card.w < plain.w);
    assert.equal(demoCollab(null, false).nodes.some((n) => n.kind === "main"), false);
  });
});
