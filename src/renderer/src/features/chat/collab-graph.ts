import type { SessionMeta } from "@shared/session";
import type { ChannelMessage } from "@shared/channel";
import type { ArtifactSummary } from "@shared/revert";
import type { SessionRunState } from "../notify/completion-notice.ts";

/**
 * 右栏「编排」面板的协作图（有向、允许成环；纯计算，可被 node --test 直接加载）。
 *
 * 用户 2026-11-24：「本质是有向有环图……要说明每个子智能体的职责、产出是什么、交接给谁……那条边是有方向的，
 * 而且是有产出文件格式的。」
 *
 * 导航模型定了之后（主智能体的 New Task 页开新 session），图的层次是：主智能体 → 它开出的 session → session 派出的子会话。
 * 这条线上**真实**的边都从真实记录取，取不到就说取不到，不编：
 * - 主智能体 → session：边上是开工那一句（会话记下的最早一条提问）；
 * - session → 主智能体：边上是这条 session 的产出（文件账里的文件数与扩展名）；在跑的画虚线「还没交回」；
 * - session → 子会话：通道账本里父侧的 task（任务说明）；
 * - 子会话 → session：子侧最后一条 done / failed 的第一行 + 子会话文件账的产出。
 * 每一对来回本身就是一个环。子智能体之间互相交接没有数据：不画，面板里写一句「等内核那条线接入后出现」；
 * 演示用的完整图（含活与活之间的边）只在点「看演示」时出现，并标明是演示。
 *
 * 「星际空间」（不属于任何工作区）没有主智能体：没有根节点，session 直接是第一层。
 *
 * 节点职责：有 DIY 档案取档案（这条线上还没有，profileOf 恒为 null），否则取任务标题并标来源。
 *
 * 布局（layoutCollab）是确定的：按深度优先一行一块往下排，新的在前；位置只由「第几块、第几层」与面板宽度定，
 * 状态变化、高亮切换都不动它——只有节点的增减才动。
 */

export type CollabRoleSource = "main" | "profile" | "title";

export interface CollabNode {
  id: string;
  kind: "main" | "session" | "child";
  /** 父节点 id（根为 null） */
  parent: string | null;
  depth: number;
  title: string;
  role: string;
  roleSource: CollabRoleSource;
  state: SessionRunState;
}

export type CollabEdgeKind = "task" | "report" | "peer";

export interface CollabEdge {
  id: string;
  from: string;
  to: string;
  kind: CollabEdgeKind;
  /** 边上的交接物：任务说明 / 结果的第一行；null = 没有记录 */
  text: string | null;
  /** 产出文件（report 与 peer 边）：null = 不适用 */
  files: ArtifactSummary | null;
  /** 还没交回（在跑 / 等你，report 边画虚线） */
  pending: boolean;
}

export interface CollabGraph {
  nodes: CollabNode[];
  edges: CollabEdge[];
  /** 没画出来的 session / 子会话数（在树状图里看） */
  hidden: number;
  demo: boolean;
}

/** 协作图一次最多画几条 session（新的在前；只挑有子会话、有状态或 3 天内动过的），每条最多几个子会话 */
export const COLLAB_SESSION_CAP = 10;
export const COLLAB_CHILD_CAP = 6;
export const COLLAB_IDLE_MS = 3 * 24 * 60 * 60 * 1000;

/** 一段话的第一行（去掉首尾空白）；空的为 null */
export function firstLine(text: string | undefined | null): string | null {
  if (text == null) return null;
  const line = text.trim().split(/\r?\n/)[0]?.trim() ?? "";
  return line === "" ? null : line;
}

const EMPTY: ArtifactSummary = { files: 0, exts: [] };

export function collabGraph(input: {
  /** 主智能体（工作区）；星际空间为 null（没有根节点） */
  root: { id: string; name: string; role: string } | null;
  /** 这个工作区的根会话 */
  sessions: readonly SessionMeta[];
  /** 全部会话（找子会话用） */
  all: readonly SessionMeta[];
  stateOf: (meta: SessionMeta) => SessionRunState;
  now: number;
  /** 子会话 id → 它与父会话之间的通道消息（时间正序）；没读到的不在表里 */
  channels: ReadonlyMap<string, readonly ChannelMessage[]>;
  /** 会话 id → 产物摘要；没读到的不在表里 */
  artifacts: Readonly<Record<string, ArtifactSummary>>;
  /** DIY 档案里的职责（这条线上还没有档案：恒返回 null） */
  profileOf?: (meta: SessionMeta) => string | null;
}): CollabGraph {
  const byNewest = (a: SessionMeta, b: SessionMeta): number => b.createdAt - a.createdAt || a.id.localeCompare(b.id);
  const childrenOf = new Map<string, SessionMeta[]>();
  for (const meta of input.all) {
    if (meta.parentId === undefined) continue;
    const list = childrenOf.get(meta.parentId);
    if (list === undefined) childrenOf.set(meta.parentId, [meta]);
    else list.push(meta);
  }
  const eligible = [...input.sessions]
    .filter((meta) => (childrenOf.get(meta.id)?.length ?? 0) > 0 || input.stateOf(meta) !== null || input.now - meta.updatedAt <= COLLAB_IDLE_MS)
    .sort(byNewest);
  const shown = eligible.slice(0, COLLAB_SESSION_CAP);
  let hidden = input.sessions.length - shown.length;
  const nodes: CollabNode[] = [];
  const edges: CollabEdge[] = [];
  const rootDepth = input.root === null ? 0 : 1;
  if (input.root !== null) {
    nodes.push({ id: input.root.id, kind: "main", parent: null, depth: 0, title: input.root.name, role: input.root.role, roleSource: "main", state: null });
  }
  const role = (meta: SessionMeta): { role: string; roleSource: CollabRoleSource } => {
    const profile = input.profileOf?.(meta) ?? null;
    return profile === null ? { role: meta.title.trim(), roleSource: "title" } : { role: profile, roleSource: "profile" };
  };
  for (const session of shown) {
    const state = input.stateOf(session);
    nodes.push({ id: session.id, kind: "session", parent: input.root?.id ?? null, depth: rootDepth, title: session.title.trim(), ...role(session), state });
    if (input.root !== null) {
      // 开工那一句：会话记下的最近 3 条提问（新 → 旧）里最早的那条；没有就没有
      const opening = session.recentQueries[session.recentQueries.length - 1];
      edges.push({ id: `task:${session.id}`, from: input.root.id, to: session.id, kind: "task", text: firstLine(opening), files: null, pending: false });
      edges.push({
        id: `report:${session.id}`,
        from: session.id,
        to: input.root.id,
        kind: "report",
        text: null,
        files: input.artifacts[session.id] ?? EMPTY,
        pending: state === "running" || state === "waiting",
      });
    }
    const kids = [...(childrenOf.get(session.id) ?? [])].sort(byNewest);
    hidden += Math.max(0, kids.length - COLLAB_CHILD_CAP);
    for (const kid of kids.slice(0, COLLAB_CHILD_CAP)) {
      const kidState = input.stateOf(kid);
      nodes.push({ id: kid.id, kind: "child", parent: session.id, depth: rootDepth + 1, title: kid.title.trim(), ...role(kid), state: kidState });
      const messages = input.channels.get(kid.id) ?? [];
      const task = messages.find((message) => message.from === "parent" && message.kind === "task");
      const report = [...messages].reverse().find((message) => message.from === "child" && (message.kind === "done" || message.kind === "failed"));
      edges.push({ id: `task:${kid.id}`, from: session.id, to: kid.id, kind: "task", text: firstLine(task?.text), files: null, pending: false });
      edges.push({
        id: `report:${kid.id}`,
        from: kid.id,
        to: session.id,
        kind: "report",
        text: firstLine(report?.text),
        files: input.artifacts[kid.id] ?? EMPTY,
        pending: report === undefined && (kidState === "running" || kidState === "waiting"),
      });
    }
  }
  return { nodes, edges, hidden, demo: false };
}

// ── 布局 ────────────────────────────────────────────────────────────────

/** 几何常量（px）：一块 = 派活线一行 + 卡 + 交回线一行；每深一层卡往右缩进 indent，右侧交回主干往左让 trunkStep */
export const COLLAB_GEOMETRY = {
  pad: 12,
  rootH: 60,
  labelH: 18,
  cardH: 44,
  inner: 4,
  blockGap: 10,
  indent: 22,
  trunkStep: 10,
  /** 演示里活与活之间的边走卡右侧这一条道 */
  peerLane: 84,
  /** 主干线与卡之间的空 */
  trunkGap: 12,
} as const;

export interface CollabBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CollabLayout {
  width: number;
  height: number;
  /** 节点 id → 卡 */
  cards: Map<string, CollabBox>;
  /** 边 id → 折线（SVG path）、标签位置与箭头 */
  edges: Map<string, { d: string; label: CollabBox; arrow: { x: number; y: number; dir: "down" | "left" } }>;
}

export function layoutCollab(graph: CollabGraph, width: number): CollabLayout {
  const g = COLLAB_GEOMETRY;
  const hasPeers = graph.edges.some((edge) => edge.kind === "peer");
  const lane = hasPeers ? g.peerLane : 0;
  /** 某一层卡的右缘：越深越往左让，给上一层的交回主干留道 */
  const rightOf = (depth: number): number => width - g.pad - g.trunkGap - depth * g.trunkStep - lane;
  const leftOf = (depth: number): number => g.pad + g.trunkGap + depth * g.indent;
  const cards = new Map<string, CollabBox>();
  let y = g.pad;
  for (const node of graph.nodes) {
    if (node.kind === "main") {
      cards.set(node.id, { x: leftOf(0), y, w: width - g.pad - leftOf(0), h: g.rootH });
      y += g.rootH + g.blockGap + g.inner;
      continue;
    }
    const hasParent = node.parent !== null;
    const top = y + (hasParent ? g.labelH + g.inner : 0);
    const x = leftOf(node.depth);
    cards.set(node.id, { x, y: top, w: Math.max(96, rightOf(node.depth) - x), h: g.cardH });
    y = top + g.cardH + (hasParent ? g.inner + g.labelH : 0) + g.blockGap;
  }
  const f = (n: number): string => n.toFixed(1);
  const edges: CollabLayout["edges"] = new Map();
  for (const edge of graph.edges) {
    const from = cards.get(edge.from);
    const to = cards.get(edge.to);
    if (from === undefined || to === undefined) continue;
    if (edge.kind === "task") {
      // 从父卡左下沿主干下来，在这一块的「派活线」上拐进来，落到子卡顶（箭头朝下）
      const trunkX = from.x + 8;
      const lineY = to.y - g.inner;
      const enterX = to.x + 10;
      edges.set(edge.id, {
        d: `M${f(trunkX)} ${f(from.y + from.h)}V${f(lineY)}H${f(enterX)}V${f(to.y)}`,
        label: { x: enterX + 8, y: lineY - g.labelH, w: Math.max(0, to.x + to.w - enterX - 8), h: g.labelH },
        arrow: { x: enterX, y: to.y, dir: "down" },
      });
    } else if (edge.kind === "report") {
      // 从子卡底出发，在这一块的「交回线」上拐向右侧主干，沿主干上去，回到父卡右缘（箭头朝左）
      const lineY = from.y + from.h + g.inner + g.labelH;
      const leaveX = from.x + 10;
      const trunkX = Math.min(to.x + to.w + g.trunkGap / 2 + 2, width - g.pad);
      const midY = to.y + to.h / 2;
      edges.set(edge.id, {
        d: `M${f(leaveX)} ${f(from.y + from.h)}V${f(lineY)}H${f(trunkX)}V${f(midY)}H${f(to.x + to.w)}`,
        label: { x: leaveX + 8, y: lineY - g.labelH, w: Math.max(0, trunkX - leaveX - 16), h: g.labelH },
        arrow: { x: to.x + to.w, y: midY, dir: "left" },
      });
    } else {
      // 演示的活 → 活：卡右侧的道里画一段弧，标签贴在弧顶
      const x0 = from.x + from.w;
      const x1 = to.x + to.w;
      const down = to.y > from.y;
      const y0 = from.y + from.h * (down ? 0.7 : 0.3);
      const y1 = to.y + to.h * (down ? 0.3 : 0.7);
      const bulge = Math.max(x0, x1) + (down ? lane * 0.4 : lane * 0.85);
      edges.set(edge.id, {
        d: `M${f(x0)} ${f(y0)}C${f(bulge)} ${f(y0)} ${f(bulge)} ${f(y1)} ${f(x1)} ${f(y1)}`,
        // 标签压在道里（带纸面底，线从它后面穿过）：道宽就是标签宽
        label: { x: Math.max(x0, x1) + 4, y: (y0 + y1) / 2 - g.labelH / 2, w: lane - 8, h: g.labelH },
        arrow: { x: x1, y: y1, dir: "left" },
      });
    }
  }
  return { width, height: y + g.pad, cards, edges };
}

// ── 演示 ────────────────────────────────────────────────────────────────

/**
 * 演示用的完整图（标明是演示）：一条 session 派出四个活，活与活之间有交接，且有环——
 * 实现 ⇄ 测试（测试不过退回实现）、检索 → 实现 → 审查 → session。边上写交接物与格式。
 */
export function demoCollab(root: { id: string; name: string; role: string } | null, zh: boolean): CollabGraph {
  const w = (cn: string, en: string): string => (zh ? cn : en);
  const rootDepth = root === null ? 0 : 1;
  const nodes: CollabNode[] = [];
  if (root !== null) nodes.push({ id: root.id, kind: "main", parent: null, depth: 0, title: root.name, role: root.role, roleSource: "main", state: null });
  nodes.push({ id: "demo-s", kind: "session", parent: root?.id ?? null, depth: rootDepth, title: w("重做编排面板", "Rebuild the orchestration panel"), role: w("重做编排面板", "Rebuild the orchestration panel"), roleSource: "title", state: "running" });
  const kid = (id: string, title: string, state: SessionRunState): CollabNode => ({ id, kind: "child", parent: "demo-s", depth: rootDepth + 1, title, role: title, roleSource: "profile", state });
  nodes.push(
    kid("demo-search", w("检索：找现成实现与案例", "Search: prior art"), null),
    kid("demo-build", w("实现：按方案改组件", "Build: change components"), "running"),
    kid("demo-test", w("测试：跑全量并记失败", "Test: run the suite"), "running"),
    kid("demo-review", w("审查：对照设计系统", "Review against the design system"), null),
  );
  const md = (files: number, exts: string[]): ArtifactSummary => ({ files, exts });
  const edges: CollabEdge[] = [];
  if (root !== null) {
    edges.push({ id: "t0", from: root.id, to: "demo-s", kind: "task", text: w("把编排面板改成三种视图", "Three views for the panel"), files: null, pending: false });
    edges.push({ id: "r0", from: "demo-s", to: root.id, kind: "report", text: null, files: md(0, []), pending: true });
  }
  edges.push(
    { id: "t1", from: "demo-s", to: "demo-search", kind: "task", text: w("找 3–8 个关系图的真实实现", "Find 3–8 graph implementations"), files: null, pending: false },
    { id: "r1", from: "demo-search", to: "demo-s", kind: "report", text: w("整理完 6 个案例", "Six cases collected"), files: md(1, [".md"]), pending: false },
    { id: "t2", from: "demo-s", to: "demo-build", kind: "task", text: w("按定稿改协作图组件", "Change the graph component"), files: null, pending: false },
    { id: "r2", from: "demo-build", to: "demo-s", kind: "report", text: null, files: md(0, []), pending: true },
    { id: "t3", from: "demo-s", to: "demo-test", kind: "task", text: w("跑全量，失败退回实现", "Run all; send failures back"), files: null, pending: false },
    { id: "r3", from: "demo-test", to: "demo-s", kind: "report", text: null, files: md(0, []), pending: true },
    { id: "t4", from: "demo-s", to: "demo-review", kind: "task", text: w("只看截图与设计系统", "Screenshots and design system only"), files: null, pending: false },
    { id: "r4", from: "demo-review", to: "demo-s", kind: "report", text: w("13 条问题", "13 findings"), files: md(1, [".txt"]), pending: false },
    { id: "p1", from: "demo-search", to: "demo-build", kind: "peer", text: w("案例清单", "Case list"), files: md(1, [".md"]), pending: false },
    { id: "p2", from: "demo-build", to: "demo-test", kind: "peer", text: w("补丁", "Patch"), files: md(3, [".tsx", ".css"]), pending: false },
    { id: "p3", from: "demo-test", to: "demo-build", kind: "peer", text: w("2 条失败", "2 failures"), files: md(1, [".log"]), pending: false },
    { id: "p4", from: "demo-build", to: "demo-review", kind: "peer", text: w("截图", "Screenshots"), files: md(6, [".png"]), pending: false },
  );
  return { nodes, edges, hidden: 0, demo: true };
}
