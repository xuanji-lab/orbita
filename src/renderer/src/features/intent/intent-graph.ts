/**
 * 右栏「意图」图的纯计算 —— /edges 数据 → 节点与连线，可被 `node --test` 直接加载。
 *
 * 图的形态（用户认可的原型 intent-graph-v4，交互脚本 graph-script.js）：
 * - 纵向时间轴：上早下晚，底部大节点 = 本问，全部汇入它；
 * - 横向六条岗位泳道：一条 QA 一个主节点（画在它最高分的岗位上），
 *   其它岗位上的入选画成小「突触点」、细线连回主节点；
 * - 同岗位按时间连线、最后一个连到本问；同会话跨岗用虚线串；
 *   links（QA 之间的历史理由边）单独一种样式；线粗细 / 亮度 = 相关度；
 * - 入选 = 实心；拿不准 = 空心；对 = 绿圈；不对 = 撤下（同岗链跳过它重连）；
 *   改字 = 标记。
 * - 超过约 40 条进密集模式：纵向按真实时间比例压进一屏，拿不准档画成淡尘点
 *   （不连线），入选档保留连线。**没有从 0 开始的相关度滑杆**（低于 pass 的
 *   根本不会到 Orbita）。
 */

import type { IntentEdge, IntentEdges, IntentLink } from "@shared/intent-edges";

/** 一个 QA 在图上的可见（未被撤下）入选项。 */
export interface GraphEntry {
  slot: number;
  score: number;
  band: "high" | "mid";
  /** high 或被用户表态提升（promoted / verdict yes / 改字） */
  solid: boolean;
  /** 拿不准且被守门员问到（与确认卡联动） */
  asked: boolean;
  /** 用户表态：yes/no/skip（null = 未问 / 未答） */
  verdict: "yes" | "no" | "skip" | null;
  /** 用户改过的说法 */
  edited: string | null;
  connection: string;
  statement: string | null;
  dupCount: number;
}

/** 一个 QA 的图节点：主节点 + 各岗突触点。 */
export interface GraphNode {
  qaId: string;
  ts: number;
  sessionId: string;
  title: string;
  source: string;
  q: string;
  a: string;
  /** 可见入选项（已滤掉 verdict=no），按岗位升序 */
  entries: GraphEntry[];
  /** 最高分所在的岗位（主节点画在那条泳道） */
  primary: number;
  /** 时间序下标（升序） */
  index: number;
}

/** 图上的一条连线。 */
export interface GraphConnection {
  kind: "slot" | "session" | "link";
  /** slot：岗位；link / session：null */
  slot: number | null;
  a: GraphNode;
  /** null = 连到本问（soma） */
  b: GraphNode | null;
  /** slot 链：两端分数均值；link：null（悬停给 connection） */
  score: number | null;
  /** link 的历史理由（悬停显示；用户改过字优先） */
  text: string | null;
  /** link 发生的时刻（当时的日期） */
  linkTs: number | null;
}

export interface IntentGraphData {
  nodes: GraphNode[];
  connections: GraphConnection[];
  /** 撤下（verdict=no）的条数（汇总行说一句） */
  withdrawn: number;
  /** 密集模式（> 40 条 QA） */
  dense: boolean;
  /** 被问到且未表态的条数（与确认卡联动） */
  pending: number;
}

/** 一条边是否算「实心」（入选进上下文 / 用户提升）。 */
function edgeSolid(edge: IntentEdge): boolean {
  if (edge.band === "high") return true;
  return edge.promoted || edge.verdict === "yes" || (edge.verdict !== null && edge.edited !== null);
}

/** /edges → 图数据。verdict=no 的入选不画（同岗链自然跳过它重连）。 */
export function buildIntentGraph(data: IntentEdges): IntentGraphData {
  const byQa = new Map<string, GraphNode>();
  let withdrawn = 0;
  let pending = 0;
  for (const edge of data.edges) {
    if (edge.verdict === "no") {
      withdrawn += 1;
      continue;
    }
    if (edge.band === "mid" && edge.asked && edge.verdict === null) pending += 1;
    let node = byQa.get(edge.qaId);
    if (node === undefined) {
      node = {
        qaId: edge.qaId,
        ts: edge.qa.ts,
        sessionId: edge.qa.sessionId,
        title: edge.qa.title,
        source: edge.qa.source,
        q: edge.qa.q,
        a: edge.qa.a,
        entries: [],
        primary: edge.slot,
        index: 0,
      };
      byQa.set(edge.qaId, node);
    }
    node.entries.push({
      slot: edge.slot,
      score: edge.score,
      band: edge.band,
      solid: edgeSolid(edge),
      asked: edge.asked,
      verdict: edge.verdict,
      edited: edge.edited,
      connection: edge.connection,
      statement: edge.statement,
      dupCount: edge.dupCount,
    });
  }
  const nodes = [...byQa.values()].sort((x, y) => x.ts - y.ts || (x.qaId < y.qaId ? -1 : 1));
  nodes.forEach((node, index) => {
    node.index = index;
    node.entries.sort((x, y) => x.slot - y.slot);
    // 主节点 = 最高分所在的岗位（平分取先出现的）
    let best = node.entries[0];
    for (const entry of node.entries) if (entry.score > (best?.score ?? -1)) best = entry;
    node.primary = best?.slot ?? 1;
  });

  const connections: GraphConnection[] = [];
  // 同岗时间链：该岗的可见节点按时间连；拿不准（非实心）在密集模式下不连线
  // （调用方在稀疏模式画、密集模式省略——这里统一生成，绘制层按 dense 取舍）
  for (let slot = 1; slot <= 6; slot += 1) {
    const chain = nodes.filter((node) => node.entries.some((entry) => entry.slot === slot));
    chain.forEach((node, at) => {
      const next = chain[at + 1] ?? null;
      const scoreOf = (n: GraphNode): number => n.entries.find((entry) => entry.slot === slot)?.score ?? 0;
      connections.push({
        kind: "slot",
        slot,
        a: node,
        b: next,
        score: next === null ? scoreOf(node) : (scoreOf(node) + scoreOf(next)) / 2,
        text: null,
        linkTs: null,
      });
    });
  }
  // 同会话跨岗虚线：串同会话的时间相邻节点；已被同岗实线连过的对不重复画
  const linked = new Set(
    connections
      .filter((conn) => conn.b !== null)
      .map((conn) => `${conn.a.qaId}>${conn.b?.qaId}`),
  );
  const bySession = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const list = bySession.get(node.sessionId) ?? [];
    list.push(node);
    bySession.set(node.sessionId, list);
  }
  for (const list of bySession.values()) {
    for (let at = 0; at + 1 < list.length; at += 1) {
      const a = list[at]!;
      const b = list[at + 1]!;
      if (linked.has(`${a.qaId}>${b.qaId}`)) continue;
      connections.push({ kind: "session", slot: null, a, b, score: null, text: null, linkTs: null });
    }
  }
  // links：QA 之间的历史理由边（两端都在图上才画）
  const known = new Set(nodes.map((node) => node.qaId));
  for (const link of data.links) {
    if (!known.has(link.fromQaId) || !known.has(link.toQaId)) continue;
    const a = byQa.get(link.fromQaId);
    const b = byQa.get(link.toQaId);
    if (a === undefined || b === undefined || a === b) continue;
    connections.push({
      kind: "link",
      slot: link.slot,
      a,
      b,
      score: null,
      text: link.edited ?? link.connection,
      linkTs: link.ts,
    });
  }

  return { nodes, connections, withdrawn, dense: nodes.length > 40, pending };
}

/* ---------------------------------------------------------------- 布局 */

export interface GraphLayout {
  dense: boolean;
  /** 左侧刻度列宽 */
  gutter: number;
  top: number;
  /** 稀疏模式的行高（密集模式按时间比例，不用它） */
  rowH: number;
  laneX: (slot: number) => number;
  /** 节点的纵坐标：稀疏按行序，密集按真实时间比例 */
  yOf: (node: GraphNode) => number;
  somaX: number;
  somaY: number;
  height: number;
  width: number;
}

export function layoutIntentGraph(width: number, nodes: readonly GraphNode[], dense: boolean): GraphLayout {
  const gutter = dense ? 46 : 74;
  const right = 14;
  const top = 34;
  const span = Math.max(1, width - gutter - right);
  const laneW = span / 6;
  const laneX = (slot: number): number => gutter + laneW * (slot - 0.5);
  const count = nodes.length;
  const rowH = dense ? Math.max(2.6, 1150 / Math.max(1, count)) : 50;
  const bodyTop = top + 22;
  const t0 = count > 0 ? nodes[0]!.ts : 0;
  const t1 = count > 0 ? nodes[count - 1]!.ts : 1;
  // 密集模式：真实时间比例压进一屏（同一时刻的多条自然叠在一起，是「尘」的形态）
  const timeSpan = bodyTop + (count - 1) * rowH - bodyTop;
  const yOf = (node: GraphNode): number =>
    dense && t1 > t0
      ? bodyTop + ((node.ts - t0) / (t1 - t0)) * timeSpan
      : bodyTop + node.index * rowH;
  const lastY = count > 0 ? yOf(nodes[count - 1]!) : bodyTop;
  const somaY = lastY + (dense ? 46 : 56);
  return {
    dense,
    gutter,
    top,
    rowH,
    laneX,
    yOf,
    somaX: gutter + span / 2,
    somaY,
    height: somaY + 44,
    width,
  };
}

