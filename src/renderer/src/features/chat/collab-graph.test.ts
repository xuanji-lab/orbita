import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ChannelMessage } from "@shared/channel";
import type { SessionMeta } from "@shared/session";
import type { SessionRunState } from "../notify/completion-notice.ts";
import { COLLAB_CAP, collabGraph, demoCollab, firstLine, layoutCollab } from "./collab-graph.ts";

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

const main = meta("main");
const base = { main, mainName: "orbita", mainRole: "接你的话、派活、收结果" };

describe("协作图的数据：只画真实的边", () => {
  test("每件派出的活两条有向边：主 → 活（任务说明第一行）、活 → 主（最后一条 done / failed 的第一行 + 产出文件）", () => {
    const job = meta("job", { parentId: "main", title: "检索相关实现" });
    const graph = collabGraph({
      ...base,
      jobs: [job],
      stateOf: () => null,
      channels: new Map([["job", [msg("parent", "task", "找出 X 的实现\n细节……"), msg("child", "progress", "在看"), msg("child", "done", "找到 3 处\n附表", NOW + 2)]]]),
      artifacts: { job: { files: 2, exts: [".md", ".ts"] } },
    });
    assert.deepEqual(graph.nodes.map((n) => [n.id, n.kind, n.roleSource]), [["main", "main", "main"], ["job", "job", "title"]]);
    assert.equal(graph.nodes[1]?.role, "检索相关实现", "没有档案：职责取任务标题，并标来源");
    const task = graph.edges.find((e) => e.kind === "task");
    const report = graph.edges.find((e) => e.kind === "report");
    assert.deepEqual([task?.from, task?.to, task?.text], ["main", "job", "找出 X 的实现"]);
    assert.deepEqual([report?.from, report?.to, report?.text, report?.pending], ["job", "main", "找到 3 处", false]);
    assert.deepEqual(report?.files, { files: 2, exts: [".md", ".ts"] });
    assert.equal(graph.edges.some((e) => e.kind === "peer"), false, "活与活之间没有数据：不造边");
    assert.equal(graph.demo, false);
  });

  test("没有记录就说没有：没读到通道 → 任务说明为 null；在跑没交回 → pending；空闲没交回 → 不 pending、结果 null；没有文件账 → 0 个", () => {
    const running = meta("r", { parentId: "main" });
    const idle = meta("i", { parentId: "main" });
    const stateOf = (m: SessionMeta): SessionRunState => (m.id === "r" ? "running" : null);
    const graph = collabGraph({ ...base, jobs: [running, idle], stateOf, channels: new Map(), artifacts: {} });
    const report = (id: string) => graph.edges.find((e) => e.kind === "report" && e.from === id);
    assert.equal(graph.edges.find((e) => e.kind === "task" && e.to === "r")?.text, null);
    assert.equal(report("r")?.pending, true);
    assert.equal(report("i")?.pending, false);
    assert.equal(report("i")?.text, null);
    assert.deepEqual(report("i")?.files, { files: 0, exts: [] });
  });

  test("档案有职责时取档案并标来源；失败的交回也是交回", () => {
    const job = meta("j", { parentId: "main", title: "标题" });
    const graph = collabGraph({
      ...base,
      jobs: [job],
      stateOf: () => "failed",
      channels: new Map([["j", [msg("child", "failed", "做不下去：缺权限")]]]),
      artifacts: {},
      profileOf: () => "负责测试",
    });
    assert.deepEqual([graph.nodes[1]?.role, graph.nodes[1]?.roleSource], ["负责测试", "profile"]);
    assert.equal(graph.edges.find((e) => e.kind === "report")?.text, "做不下去：缺权限");
  });

  test("满载：42 件活只画最新的 COLLAB_CAP 件，其余计 hidden；新的在前", () => {
    const jobs = Array.from({ length: 42 }, (_, i) => meta(`j${i}`, { parentId: "main", createdAt: NOW + i }));
    const graph = collabGraph({ ...base, jobs, stateOf: () => null, channels: new Map(), artifacts: {} });
    assert.equal(graph.nodes.length, 1 + COLLAB_CAP);
    assert.equal(graph.hidden, 42 - COLLAB_CAP);
    assert.equal(graph.nodes[1]?.id, "j41");
  });

  test("firstLine：取第一行、去空白；空的为 null", () => {
    assert.equal(firstLine("  a\nb"), "a");
    assert.equal(firstLine("\n"), null);
    assert.equal(firstLine(undefined), null);
  });
});

describe("协作图的布局：稳", () => {
  const jobs = [meta("a", { parentId: "main", createdAt: NOW + 2 }), meta("b", { parentId: "main", createdAt: NOW + 1 })];
  const build = (stateOf: (m: SessionMeta) => SessionRunState) => collabGraph({ ...base, jobs, stateOf, channels: new Map(), artifacts: {} });

  test("状态变了，节点位置一个像素都不动", () => {
    const a = layoutCollab(build(() => null), 360);
    const b = layoutCollab(build((m) => (m.id === "a" ? "waiting" : "running")), 360);
    assert.deepEqual([...a.cards.entries()], [...b.cards.entries()]);
    assert.deepEqual([...a.edges.entries()], [...b.edges.entries()]);
  });

  test("加一件活：原来的块整体下移一块、相对次序不变（新的在最上）", () => {
    const before = layoutCollab(build(() => null), 360);
    const more = collabGraph({ ...base, jobs: [...jobs, meta("c", { parentId: "main", createdAt: NOW + 3 })], stateOf: () => null, channels: new Map(), artifacts: {} });
    const after = layoutCollab(more, 360);
    const step = (after.cards.get("a")?.y ?? 0) - (before.cards.get("a")?.y ?? 0);
    assert.ok(step > 0);
    assert.equal((after.cards.get("b")?.y ?? 0) - (before.cards.get("b")?.y ?? 0), step);
    assert.ok((after.cards.get("c")?.y ?? 0) < (after.cards.get("a")?.y ?? 0));
    assert.ok(after.height > before.height);
  });

  test("边的方向：派活的箭头朝下落在活的卡顶；交回的箭头朝左落在主卡右缘", () => {
    const layout = layoutCollab(build(() => null), 360);
    const task = layout.edges.get("task:a");
    const report = layout.edges.get("report:a");
    assert.equal(task?.arrow.dir, "down");
    assert.equal(task?.arrow.y, layout.cards.get("a")?.y);
    assert.equal(report?.arrow.dir, "left");
    assert.equal(report?.arrow.x, layout.main.x + layout.main.w);
    // 标签不出面板
    for (const edge of layout.edges.values()) assert.ok(edge.label.x + edge.label.w <= 360);
  });

  test("演示图：标明是演示，带环（实现 ⇄ 测试），活与活之间的边走卡右侧的道", () => {
    const demo = demoCollab("main", "orbita", "role", true);
    assert.equal(demo.demo, true);
    const peers = demo.edges.filter((e) => e.kind === "peer");
    assert.ok(peers.some((e) => e.from === "demo-build" && e.to === "demo-test"));
    assert.ok(peers.some((e) => e.from === "demo-test" && e.to === "demo-build"), "允许成环");
    const layout = layoutCollab(demo, 420);
    const card = layout.cards.get("demo-build");
    const plain = layoutCollab(build(() => null), 420).cards.get("a");
    assert.ok(card !== undefined && plain !== undefined && card.w < plain.w, "有活与活的边时卡让出右侧的道");
  });
});
