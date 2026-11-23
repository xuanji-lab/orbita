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
 * 这条线上**真实**的有向边只有两类，都从真实记录取，取不到就说取不到，不编：
 * - 主智能体 → 派出去的活：边上是任务说明（通道账本里父侧的 task 消息）；
 * - 活 → 主智能体：边上是结果（子侧最后一条 done / failed）与产出（这条会话文件账里的文件数与扩展名）。
 * 主 → 活 → 主 本身就是一个环。子智能体之间互相交接没有数据：不画，面板里写一句「等内核那条线接入后出现」；
 * 演示用的完整图（含活与活之间的边、多重环）只在用户点「看演示」时出现，并标明是演示。
 *
 * 节点职责：有 DIY 档案取档案（这条线上还没有，profileOf 恒为 null），否则取任务标题并标来源。
 *
 * 布局（layoutCollab）是确定的：主智能体在上，活按创建时间新的在前一行一块；位置只由「第几块」与面板宽度定，
 * 状态变化、高亮切换都不动它——只有活的增减才动。
 */

export type CollabRoleSource = "main" | "profile" | "title";

export interface CollabNode {
  id: string;
  kind: "main" | "job";
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
  /** 产出文件（只有 report 与 peer 边有）：null = 不适用 */
  files: ArtifactSummary | null;
  /** 还没交回（活在跑 / 等你，report 边画虚线） */
  pending: boolean;
}

export interface CollabGraph {
  nodes: CollabNode[];
  edges: CollabEdge[];
  /** 超出 COLLAB_CAP 没画的派出活数（在树状图里看） */
  hidden: number;
  demo: boolean;
}

/** 协作图一次最多画几件派出去的活（新的在前），其余在树状图里 */
export const COLLAB_CAP = 16;

/** 一段话的第一行（去掉首尾空白）；空的为 null */
export function firstLine(text: string | undefined | null): string | null {
  if (text == null) return null;
  const line = text.trim().split(/\r?\n/)[0]?.trim() ?? "";
  return line === "" ? null : line;
}

export function collabGraph(input: {
  main: SessionMeta;
  mainName: string;
  mainRole: string;
  /** 主对话的子会话（派出去的活） */
  jobs: readonly SessionMeta[];
  stateOf: (meta: SessionMeta) => SessionRunState;
  /** 子会话 id → 它与主对话之间的通道消息（时间正序）；没读到的不在表里 */
  channels: ReadonlyMap<string, readonly ChannelMessage[]>;
  /** 子会话 id → 产物摘要；没读到的不在表里 */
  artifacts: Readonly<Record<string, ArtifactSummary>>;
  /** DIY 档案里的职责（这条线上还没有档案：恒返回 null） */
  profileOf?: (meta: SessionMeta) => string | null;
}): CollabGraph {
  const sorted = [...input.jobs].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const shown = sorted.slice(0, COLLAB_CAP);
  const nodes: CollabNode[] = [
    { id: input.main.id, kind: "main", title: input.mainName, role: input.mainRole, roleSource: "main", state: input.stateOf(input.main) },
  ];
  const edges: CollabEdge[] = [];
  for (const job of shown) {
    const state = input.stateOf(job);
    const profile = input.profileOf?.(job) ?? null;
    nodes.push({
      id: job.id,
      kind: "job",
      title: job.title.trim(),
      role: profile ?? job.title.trim(),
      roleSource: profile === null ? "title" : "profile",
      state,
    });
    const messages = input.channels.get(job.id) ?? [];
    const task = messages.find((message) => message.from === "parent" && message.kind === "task");
    const report = [...messages].reverse().find((message) => message.from === "child" && (message.kind === "done" || message.kind === "failed"));
    edges.push({ id: `task:${job.id}`, from: input.main.id, to: job.id, kind: "task", text: firstLine(task?.text), files: null, pending: false });
    edges.push({
      id: `report:${job.id}`,
      from: job.id,
      to: input.main.id,
      kind: "report",
      text: firstLine(report?.text),
      files: input.artifacts[job.id] ?? { files: 0, exts: [] },
      pending: report === undefined && (state === "running" || state === "waiting"),
    });
  }
  return { nodes, edges, hidden: sorted.length - shown.length, demo: false };
}

// ── 布局 ────────────────────────────────────────────────────────────────

/** 几何常量（px）：一块 = 派活线一行 + 卡 + 交回线一行 */
export const COLLAB_GEOMETRY = {
  pad: 12,
  mainH: 64,
  gapAfterMain: 18,
  labelH: 18,
  cardH: 46,
  inner: 4,
  blockGap: 12,
  /** 演示里活与活之间的边走卡右侧这一条道 */
  peerLane: 44,
  /** 两条主干线与卡之间的空 */
  trunkGap: 14,
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
  main: CollabBox;
  /** 节点 id → 卡 */
  cards: Map<string, CollabBox>;
  /** 左主干（派活）与右主干（交回）的 x */
  trunkLeft: number;
  trunkRight: number;
  /** 边 id → 折线（SVG path）与标签位置 */
  edges: Map<string, { d: string; label: CollabBox; arrow: { x: number; y: number; dir: "down" | "left" | "right" | "up" } }>;
}

export function layoutCollab(graph: CollabGraph, width: number): CollabLayout {
  const g = COLLAB_GEOMETRY;
  const hasPeers = graph.edges.some((edge) => edge.kind === "peer");
  const trunkLeft = g.pad;
  const trunkRight = width - g.pad;
  const cardX = trunkLeft + g.trunkGap;
  const cardW = Math.max(120, trunkRight - g.trunkGap - (hasPeers ? g.peerLane : 0) - cardX);
  const main: CollabBox = { x: cardX, y: g.pad, w: trunkRight - g.trunkGap - cardX, h: g.mainH };
  const cards = new Map<string, CollabBox>();
  const blockH = g.labelH + g.inner + g.cardH + g.inner + g.labelH + g.blockGap;
  const top = main.y + main.h + g.gapAfterMain;
  const jobs = graph.nodes.filter((node) => node.kind === "job");
  jobs.forEach((node, index) => {
    cards.set(node.id, { x: cardX, y: top + index * blockH + g.labelH + g.inner, w: cardW, h: g.cardH });
  });
  cards.set(graph.nodes[0]?.id ?? "", main);
  const f = (n: number): string => n.toFixed(1);
  const edges: CollabLayout["edges"] = new Map();
  const mainBottom = main.y + main.h;
  const mainMidY = main.y + main.h / 2;
  for (const edge of graph.edges) {
    if (edge.kind === "task") {
      const card = cards.get(edge.to);
      if (card === undefined) continue;
      // 从主卡底下出发沿左主干下来，在这一块的「派活线」上拐进来，落到卡顶（箭头朝下）
      const lineY = card.y - g.inner;
      const enterX = card.x + 10;
      edges.set(edge.id, {
        d: `M${f(trunkLeft)} ${f(mainBottom - 8)}V${f(lineY)}H${f(enterX)}V${f(card.y)}`,
        label: { x: enterX + 8, y: lineY - g.labelH, w: card.x + card.w - (enterX + 8), h: g.labelH },
        arrow: { x: enterX, y: card.y, dir: "down" },
      });
    } else if (edge.kind === "report") {
      const card = cards.get(edge.from);
      if (card === undefined) continue;
      // 从卡底出发，在这一块的「交回线」上拐向右主干，沿右主干上去，回到主卡右侧（箭头朝左）
      const lineY = card.y + card.h + g.inner + g.labelH;
      const leaveX = card.x + 10;
      edges.set(edge.id, {
        d: `M${f(leaveX)} ${f(card.y + card.h)}V${f(lineY)}H${f(trunkRight)}V${f(mainMidY)}H${f(main.x + main.w)}`,
        label: { x: leaveX + 8, y: lineY - g.labelH, w: trunkRight - (leaveX + 8) - 8, h: g.labelH },
        arrow: { x: main.x + main.w, y: mainMidY, dir: "left" },
      });
    } else {
      const from = cards.get(edge.from);
      const to = cards.get(edge.to);
      if (from === undefined || to === undefined) continue;
      // 演示的活 → 活：卡右侧的道里画一段弧（往下的在里道、往上的在外道），标签贴在弧顶
      const x0 = from.x + from.w;
      const y0 = from.y + from.h * (to.y > from.y ? 0.7 : 0.3);
      const y1 = to.y + to.h * (to.y > from.y ? 0.3 : 0.7);
      const bulge = to.y > from.y ? g.peerLane * 0.45 : g.peerLane * 0.9;
      const midY = (y0 + y1) / 2;
      edges.set(edge.id, {
        d: `M${f(x0)} ${f(y0)}C${f(x0 + bulge)} ${f(y0)} ${f(x0 + bulge)} ${f(y1)} ${f(x0)} ${f(y1)}`,
        label: { x: x0 + 4, y: midY - g.labelH / 2, w: bulge + 4, h: g.labelH },
        arrow: { x: x0, y: y1, dir: "left" },
      });
    }
  }
  const height = jobs.length === 0 ? top : top + jobs.length * blockH;
  return { width, height, main, cards, trunkLeft, trunkRight, edges };
}

// ── 演示 ────────────────────────────────────────────────────────────────

/**
 * 演示用的完整图（标明是演示）：五个活，活与活之间有交接，且有两个环——
 * 实现 ⇄ 测试（测试不过退回实现）、主 → 检索 → 实现 → 审查 → 主。边上写交接物与格式。
 */
export function demoCollab(mainId: string, mainName: string, mainRole: string, zh: boolean): CollabGraph {
  const w = (cn: string, en: string): string => (zh ? cn : en);
  const job = (id: string, title: string, state: SessionRunState): CollabNode => ({ id, kind: "job", title, role: title, roleSource: "profile", state });
  const nodes: CollabNode[] = [
    { id: mainId, kind: "main", title: mainName, role: mainRole, roleSource: "main", state: "running" },
    job("demo-search", w("检索：找现成实现与案例", "Search: prior art and examples"), null),
    job("demo-build", w("实现：按方案改组件", "Build: change the components"), "running"),
    job("demo-test", w("测试：跑全量并记失败", "Test: run the suite, log failures"), "running"),
    job("demo-review", w("审查：对照设计系统挑毛病", "Review against the design system"), null),
  ];
  const md = (files: number, exts: string[]): ArtifactSummary => ({ files, exts });
  const edges: CollabEdge[] = [
    { id: "t1", from: mainId, to: "demo-search", kind: "task", text: w("找 3–8 个关系图的真实实现", "Find 3–8 real graph implementations"), files: null, pending: false },
    { id: "r1", from: "demo-search", to: mainId, kind: "report", text: w("整理完 6 个案例", "Six cases collected"), files: md(1, [".md"]), pending: false },
    { id: "p1", from: "demo-search", to: "demo-build", kind: "peer", text: w("案例清单", "Case list"), files: md(1, [".md"]), pending: false },
    { id: "t2", from: mainId, to: "demo-build", kind: "task", text: w("按定稿改协作图组件", "Change the graph component to the spec"), files: null, pending: false },
    { id: "p2", from: "demo-build", to: "demo-test", kind: "peer", text: w("补丁", "Patch"), files: md(3, [".tsx", ".css"]), pending: false },
    { id: "p3", from: "demo-test", to: "demo-build", kind: "peer", text: w("2 条失败", "2 failures"), files: md(1, [".log"]), pending: false },
    { id: "t3", from: mainId, to: "demo-test", kind: "task", text: w("跑全量，失败退回实现", "Run all; send failures back"), files: null, pending: false },
    { id: "r3", from: "demo-test", to: mainId, kind: "report", text: null, files: md(0, []), pending: true },
    { id: "p4", from: "demo-build", to: "demo-review", kind: "peer", text: w("截图", "Screenshots"), files: md(6, [".png"]), pending: false },
    { id: "t4", from: mainId, to: "demo-review", kind: "task", text: w("只看截图与设计系统", "Screenshots and design system only"), files: null, pending: false },
    { id: "r4", from: "demo-review", to: mainId, kind: "report", text: w("13 条问题", "13 findings"), files: md(1, [".txt"]), pending: false },
  ];
  return { nodes, edges, hidden: 0, demo: true };
}
