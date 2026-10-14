/**
 * 右栏「意图」图的簇布局与配色 —— 纯计算，可被 `node --test` 直接加载。
 *
 * **会话累积图**（2026-10-14 00:11 用户裁决）：面板默认画整个会话的累积——每一问
 * 的 /edges 合并成一张图，同一 (qaId, 岗位) 出现在多问里就并成一个节点；新的一问
 * 只在旧图上**长出**新节点（布局用上一次的坐标做种子、小幅松弛，旧节点基本不动）。
 * 节点上标**最近使用它的轮号**（第几问；门卫跳过的问不计数），后面轮又用上就更新。
 *
 * 两种视图（原型 intent-clusters.html）：
 * - 按岗位（岗位成簇）：会话胞体居中，六个岗位各成一簇，簇内按来源会话分叉；
 *   同一条 QA 在两个岗位都入选，两片叶子之间拉桥——共享越多两簇越近。
 * - 按提问（提问网络）：会话里的每一问各是一个中心（最新一问最亮），中心的枝按
 *   来源会话成簇；被多个中心召回过的 QA 长在它们中间、两边各连一根（桥）。
 *
 * 力导向**确定性**（种子随机初始化 + 固定迭代数）：同一份数据（含同一份种子坐标）
 * 永远得到同一张图。颜色映射（轮次时间 / 相关度两档）也是纯函数。
 */

/** 一片叶子（一条被本会话用过的历史问答；按岗位视图里同一 QA 两岗 = 两片叶子）。 */
export interface ClusterLeaf {
  qaId: string;
  /** 按岗位视图：所属岗位；按提问视图：主岗（最高分岗） */
  slot: number;
  score: number;
  solid: boolean;
  verdict: "yes" | "no" | "skip" | null;
  edited: string | null;
  connection: string;
  asked: boolean;
  ts: number;
  sessionId: string;
  title: string;
  source: string;
  q: string;
  a: string;
  /** 最近使用它的是第几问（1 起）；累积合并时取最大。展示与着色用 */
  lastRound: number;
  /** 哪几问用过它（升序；高亮某一轮用） */
  rounds: readonly number[];
}

export type GraphColorMode = "time" | "score";

/** 叶子 / 枝的着色百分比（三档 30 / 62 / 100）——映射到
 *  `color-mix(in srgb, var(--color-nebula) X%, transparent)`（用量格同款 token）。 */
export type NebulaPercent = 30 | 62 | 100;

/** 着色归一的范围：轮次（time 模式）与分数（score 模式）各自的极差。 */
export interface LeafRange {
  rMin: number;
  rMax: number;
  sMin: number;
  sMax: number;
}

/**
 * 颜色 = 使用的轮次新旧（time：越近的问用过越满，越早越淡）或相关度强弱
 * （score）。两个维度都按当前数据内的极差归一，三档切分（<1/3 / <2/3 / 其余）。
 */
export function nebulaPercentOf(
  mode: GraphColorMode,
  leaf: Pick<ClusterLeaf, "lastRound" | "score">,
  range: LeafRange,
): NebulaPercent {
  const u =
    mode === "time"
      ? range.rMax === range.rMin
        ? 0.5
        : (leaf.lastRound - range.rMin) / (range.rMax - range.rMin)
      : range.sMax === range.sMin
        ? 0.5
        : (leaf.score - range.sMin) / (range.sMax - range.sMin);
  if (u < 1 / 3) return 30;
  if (u < 2 / 3) return 62;
  return 100;
}

/** 全部叶子的取值范围（着色归一用）。空表给退化区间。 */
export function leafRange(leaves: readonly ClusterLeaf[]): LeafRange {
  if (leaves.length === 0) return { rMin: 0, rMax: 1, sMin: 0, sMax: 1 };
  let rMin = Infinity;
  let rMax = -Infinity;
  let sMin = Infinity;
  let sMax = -Infinity;
  for (const leaf of leaves) {
    rMin = Math.min(rMin, leaf.lastRound);
    rMax = Math.max(rMax, leaf.lastRound);
    sMin = Math.min(sMin, leaf.score);
    sMax = Math.max(sMax, leaf.score);
  }
  return { rMin, rMax, sMin, sMax };
}

/* ---------------------------------------------------------------- 力导向骨架 */

interface SimPoint {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  rep: number;
  fixed?: boolean;
}

export interface SomaNode extends SimPoint {
  kind: "soma";
  id: string;
  label: string;
  /** 旧中心（非最新一问）：整体退一档亮度 */
  past: boolean;
}

export interface HubNode extends SimPoint {
  kind: "hub";
  id: string;
  label: string;
  sub: boolean;
  group: string;
  count: number;
  past: boolean;
}

export interface LeafNode extends SimPoint {
  kind: "leaf";
  id: string;
  leaf: ClusterLeaf;
  /** 列表行的稳定 key（按岗位视图 = qaId#slot；按提问 = qaId） */
  rowKey: string;
  /** 被两个及以上簇 / 中心共享（描边强调） */
  shared: boolean;
  /** 着色百分比（paintScene 就地更新——只改样式，绝不碰坐标） */
  percent: NebulaPercent;
}

export type SimNode = SomaNode | HubNode | LeafNode;

export interface SimLink {
  a: SimNode;
  b: SimNode;
  len: number;
  k: number;
  w?: number;
  op?: number;
  dim?: boolean;
  bridge?: boolean;
}

export interface ClusterScene {
  nodes: SimNode[];
  links: SimLink[];
}

/** 种子随机（Lehmer / Park-Miller）：确定性布局的全部随机性都从这里出。 */
export function seededRandom(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

/** 单轮力学步进（排斥 + 弹簧 + 向心 + 边界钳制）。确定性：无随机。 */
export function tick(nodes: readonly SimNode[], links: readonly SimLink[], W: number, H: number, alpha: number, maxStep: number): void {
  {
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy + 0.01;
        if (d2 > 220 * 220) continue;
        const f = (a.rep * b.rep * 210) / d2;
        const d = Math.sqrt(d2);
        dx /= d;
        dy /= d;
        a.vx -= dx * f;
        a.vy -= dy * f;
        b.vx += dx * f;
        b.vy += dy * f;
      }
    }
    for (const l of links) {
      const a = l.a;
      const b = l.b;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const d = Math.hypot(dx, dy) + 0.01;
      const f = (d - l.len) * l.k;
      dx /= d;
      dy /= d;
      a.vx += dx * f;
      a.vy += dy * f;
      b.vx -= dx * f;
      b.vy -= dy * f;
    }
    for (const n of nodes) {
      if (n.fixed === true) {
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      n.vx += (W / 2 - n.x) * 0.0005;
      n.vy += (H / 2 - n.y) * 0.0005;
      n.x += Math.max(-maxStep, Math.min(maxStep, n.vx * alpha));
      n.y += Math.max(-maxStep, Math.min(maxStep, n.vy * alpha));
      n.vx *= 0.6;
      n.vy *= 0.6;
      n.x = Math.max(16, Math.min(W - 16, n.x));
      n.y = Math.max(16, Math.min(H - 40, n.y));
    }
  }
}

/**
 * 跑到**收敛**：alpha 从 1 起、每轮 ×0.985 衰减，alpha < 0.02 停（或撞 800 轮
 * 上限）。2026-10-14 真机教训：以前每次只跑一小段定长松弛，从上次的半路坐标
 * 接着跑，图永远停在没收敛的歪斜状态；resize / 切换只让它再挪一小步。
 * 收敛后坐标静止——只有数据（问 / 边）变化才重新布局。确定性：同数据同图。
 *
 * @param onTick 可选：每轮之后的回调（逐帧动画用它取坐标画中间态）。
 * @returns 实际跑的轮数。
 */
export function simulateToConvergence(
  nodes: readonly SimNode[],
  links: readonly SimLink[],
  W: number,
  H: number,
  options: { alpha?: number; maxIters?: number; onTick?: () => void } = {},
): number {
  const maxIters = options.maxIters ?? 800;
  let alpha = options.alpha ?? 1;
  let iter = 0;
  for (; iter < maxIters && alpha >= 0.02; iter += 1) {
    tick(nodes, links, W, H, alpha, 8);
    alpha *= 0.985;
    options.onTick?.();
  }
  return iter;
}

/** 再走一轮全体最多能挪多远（px）：收敛判定的度量。不改变节点状态。 */
export function maxDrift(
  nodes: readonly SimNode[],
  links: readonly SimLink[],
  W: number,
  H: number,
): number {
  const before = nodes.map((node) => ({ x: node.x, y: node.y }));
  tick(nodes, links, W, H, 0.02, 8);
  let worst = 0;
  nodes.forEach((node, i) => {
    const was = before[i]!;
    worst = Math.max(worst, Math.hypot(node.x - was.x, node.y - was.y));
    node.x = was.x;
    node.y = was.y;
  });
  return worst;
}

/** 布局种子：上一次成型的坐标（按节点 id 对回）。「新东西长在旧图上」的机制。 */
export type LayoutSeed = ReadonlyMap<string, { x: number; y: number }>;

export interface BuildOptions {
  /** 上一张图的坐标：命中 id 的节点从原位出发（新节点热启动到带种子邻居的质心），
   *  然后跑**到收敛**——种子只决定出发点，不截断模拟（2026-10-14 真机教训：
   *  截断让图永远停在半路） */
  seed?: LayoutSeed;
}

/** 初始位置：先看种子，没有再随机（rng）。 */
function place(
  id: string,
  fallback: { x: number; y: number },
  seed: LayoutSeed | undefined,
  rng: () => number,
  spread: number,
): { x: number; y: number } {
  const found = seed?.get(id);
  if (found !== undefined) return { x: found.x, y: found.y };
  return { x: fallback.x + (rng() - 0.5) * spread, y: fallback.y + (rng() - 0.5) * spread };
}

/**
 * 种子模式的热启动：没有种子的新节点（新子簇 / 新叶）先摆到它**带种子的邻居**
 * 的质心，再进模拟——否则新子簇落在随机位置，弹簧会把挂到它名下的旧叶子拖出
 * 老远，「长出来」就变成了「重排」。
 */
function warmStartUnseeded(nodes: readonly SimNode[], links: readonly SimLink[], seed: LayoutSeed): void {
  const seeded = new Map<string, SimNode>();
  for (const node of nodes) {
    if (seed.get(node.id) !== undefined) seeded.set(node.id, node);
  }
  if (seeded.size === 0) return;
  for (const node of nodes) {
    if (seed.get(node.id) !== undefined) continue;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const link of links) {
      const other = link.a === node ? link.b : link.b === node ? link.a : undefined;
      if (other === undefined || !seeded.has(other.id)) continue;
      sx += other.x;
      sy += other.y;
      n += 1;
    }
    if (n === 0) continue;
    node.x = sx / n;
    node.y = sy / n;
  }
}

/** 把成型后的坐标收进种子表（下一次构建的起点）。 */
export function sceneSeed(scene: ClusterScene): Map<string, { x: number; y: number }> {
  const seed = new Map<string, { x: number; y: number }>();
  for (const node of scene.nodes) seed.set(node.id, { x: node.x, y: node.y });
  return seed;
}

function leafRadius(leaf: ClusterLeaf, dense: boolean): number {
  return dense ? 1 + 2.4 * (leaf.score - 0.5) / 0.5 : 2.2 + 4 * (leaf.score - 0.5) / 0.5;
}

/* ---------------------------------------------------------------- ① 按岗位成簇 */

export const SLOT_CLUSTER_NAMES: readonly string[] = [
  "同一件事",
  "同一目的",
  "同构机制",
  "取舍标准",
  "约束条件",
  "时序与修订",
];

/**
 * 按岗位成簇：会话胞体（固定居中）→ 六个岗位 hub →（岗位, 来源会话）子 hub
 * （该组 ≥2 条才分叉）→ 叶子（QA, 岗位）。同一 QA 两岗的叶子之间拉桥（弹簧，
 * 共享越多两簇越近）。叶子 / 枝按轮次或相关度着色；节点带最近使用的轮号。
 */
export function buildSlotScene(
  leaves: readonly ClusterLeaf[],
  W: number,
  H: number,
  options: BuildOptions = {},
): ClusterScene {
  const dense = leaves.length > 40;
  const rng = seededRandom(3);
  const nodes: SimNode[] = [];
  const links: SimLink[] = [];
  const soma: SomaNode = {
    kind: "soma",
    id: "soma:session",
    x: W / 2,
    y: H / 2 - 10,
    vx: 0,
    vy: 0,
    r: dense ? 13 : 11,
    rep: 3,
    fixed: true,
    label: "",
    past: false,
  };
  nodes.push(soma);
  const hubs: HubNode[] = SLOT_CLUSTER_NAMES.map((name, i) => {
    const angle = (i / 6) * Math.PI * 2 - Math.PI / 2;
    const at = place(`hub:slot:${i + 1}`, { x: soma.x + Math.cos(angle) * 120, y: soma.y + Math.sin(angle) * 120 }, options.seed, rng, 10);
    const hub: HubNode = {
      kind: "hub",
      id: `hub:slot:${i + 1}`,
      x: at.x,
      y: at.y,
      vx: 0,
      vy: 0,
      r: 3.4,
      rep: 2.4,
      label: name,
      sub: false,
      group: `slot:${i + 1}`,
      count: 0,
      past: false,
    };
    nodes.push(hub);
    return hub;
  });
  const totals = SLOT_CLUSTER_NAMES.map(
    (_, i) => leaves.filter((leaf) => leaf.slot === i + 1).reduce((sum, leaf) => sum + leaf.score, 0),
  );
  hubs.forEach((hub, i) => {
    links.push({ a: soma, b: hub, len: 150, k: 0.04, w: 1 + totals[i]! * 0.5, op: 0.55 });
  });
  const leafOf = new Map<string, LeafNode[]>();
  SLOT_CLUSTER_NAMES.forEach((_, i) => {
    const slot = i + 1;
    const mine = leaves.filter((leaf) => leaf.slot === slot);
    const bySession = new Map<string, ClusterLeaf[]>();
    for (const leaf of mine) {
      const list = bySession.get(leaf.sessionId) ?? [];
      list.push(leaf);
      bySession.set(leaf.sessionId, list);
    }
    for (const [sessionId, list] of bySession) {
      let parent: HubNode = hubs[i]!;
      parent.count += list.length;
      if (list.length >= 2) {
        const id = `hub:slot:${slot}:${sessionId}`;
        const at = place(id, { x: hubs[i]!.x, y: hubs[i]!.y }, options.seed, rng, 40);
        const sub: HubNode = {
          kind: "hub",
          id,
          x: at.x,
          y: at.y,
          vx: 0,
          vy: 0,
          r: 1.8,
          rep: 1.2,
          // 密集模式只标 ≥3 条的簇（原型规则）
          label: list.length >= 3 ? (list[0]!.title ?? sessionId) : "",
          sub: true,
          group: `slot:${slot}`,
          count: list.length,
          past: false,
        };
        nodes.push(sub);
        links.push({ a: hubs[i]!, b: sub, len: 44, k: 0.07, w: 1.6, op: 0.5 });
        parent = sub;
      }
      for (const leaf of list) {
        const id = `leaf:${leaf.qaId}#${slot}`;
        const at = place(id, { x: parent.x, y: parent.y }, options.seed, rng, 30);
        const node: LeafNode = {
          kind: "leaf",
          id,
          rowKey: `${leaf.qaId}#${slot}`,
          leaf,
          x: at.x,
          y: at.y,
          vx: 0,
          vy: 0,
          r: leafRadius(leaf, dense),
          rep: 1,
          shared: false,
          percent: 62,
        };
        nodes.push(node);
        links.push({ a: parent, b: node, len: 24, k: 0.1, w: 0.9, op: 0.4 + 0.5 * leaf.score });
        const group = leafOf.get(leaf.qaId) ?? [];
        group.push(node);
        leafOf.set(leaf.qaId, group);
      }
    }
  });
  for (const group of leafOf.values()) {
    if (group.length < 2) continue;
    for (const node of group) node.shared = true;
    links.push({ a: group[0]!, b: group[1]!, len: 90, k: 0.01, bridge: true });
  }
  if (options.seed !== undefined) warmStartUnseeded(nodes, links, options.seed);
  simulateToConvergence(nodes, links, W, H);
  return { nodes, links };
}

/* ---------------------------------------------------------------- ③ 按提问成网络 */

/** 一个中心（会话里的一问；或被召回历史里 orbita 自召回的旧提问）。 */
export interface EgoCentre {
  key: string;
  /** 中心标签（「第 3 问 · 10-13 23:18」） */
  label: string;
  /** 最新一问 = false（最亮、居中固定）；其余中心 = true（旧中心退一档） */
  past: boolean;
  /** 该中心召回的叶子（每 QA 一片，slot = 主岗；含轮号信息） */
  leaves: readonly ClusterLeaf[];
}

/**
 * 按提问成网络：每个中心一个 soma（最新一问固定居中），(中心, 来源会话) 成簇；
 * 被多个中心召回的 QA 一片叶子长在它们中间、每边一根桥。叶子的展示数据取**最近
 * 使用它的那一问**（合并语义），轮号 / rounds 跨中心汇总。
 */
export function buildEgoScene(
  centres: readonly EgoCentre[],
  W: number,
  H: number,
  options: BuildOptions = {},
): ClusterScene {
  const dense = centres.reduce((sum, centre) => sum + centre.leaves.length, 0) > 40;
  const rng = seededRandom(5);
  const nodes: SimNode[] = [];
  const links: SimLink[] = [];
  const angles = [-2.3, -0.6, 1.6, 2.6, 0.5, -1.4];
  const centreNodes: SomaNode[] = centres.map((centre, i) => {
    const past = centre.past;
    const id = `soma:centre:${centre.key}`;
    const at = place(
      id,
      past
        ? { x: W / 2 + Math.cos(angles[(i - 1) % 6] ?? 0) * 200, y: H / 2 + Math.sin(angles[(i - 1) % 6] ?? 0) * 200 }
        : { x: W / 2, y: H / 2 - 10 },
      options.seed,
      rng,
      8,
    );
    const node: SomaNode = {
      kind: "soma",
      id,
      x: at.x,
      y: at.y,
      vx: 0,
      vy: 0,
      r: past ? 7 : 11,
      rep: 4,
      fixed: !past,
      label: centre.label,
      past,
    };
    nodes.push(node);
    return node;
  });
  // 展示叶子（合并）：qaId → 最近一问的数据 + 汇总的 rounds
  const merged = new Map<string, ClusterLeaf>();
  const who = new Map<string, number[]>();
  centres.forEach((centre, gi) => {
    for (const leaf of centre.leaves) {
      const list = who.get(leaf.qaId) ?? [];
      list.push(gi);
      who.set(leaf.qaId, list);
      const found = merged.get(leaf.qaId);
      if (found === undefined || leaf.lastRound > found.lastRound) merged.set(leaf.qaId, leaf);
    }
  });
  for (const [qaId, gs] of who) {
    const leaf = merged.get(qaId)!;
    const rounds = [...new Set(centres.filter((_, gi) => gs.includes(gi)).flatMap((c) => c.leaves.find((l) => l.qaId === qaId)?.rounds ?? [leaf.lastRound]))];
    const shared = gs.length > 1;
    const hs = gs.map((gi) => hubFor(gi, leaf.sessionId));
    const node: LeafNode = {
      kind: "leaf",
      id: `leaf:${qaId}`,
      rowKey: qaId,
      leaf: { ...leaf, lastRound: Math.max(...rounds, leaf.lastRound), rounds },
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      r: leafRadius(leaf, dense),
      rep: 1,
      shared,
      percent: 62,
    };
    const at = place(node.id, { x: hs[0]!.x, y: hs[0]!.y }, options.seed, rng, 20);
    node.x = at.x;
    node.y = at.y;
    nodes.push(node);
    hs.forEach((hub, at2) => {
      const centre = centres[gs[at2]!]!;
      if (shared) {
        links.push({ a: hub, b: node, len: 60, k: 0.04, bridge: true });
      } else {
        links.push({
          a: hub,
          b: node,
          len: 22,
          k: 0.1,
          w: 0.9,
          op: centre.past ? 0.3 : 0.4 + 0.5 * leaf.score,
          dim: centre.past,
        });
      }
    });
  }
  if (options.seed !== undefined) warmStartUnseeded(nodes, links, options.seed);
  simulateToConvergence(nodes, links, W, H);
  return { nodes, links };

  function hubFor(gi: number, sessionId: string): HubNode {
    const id = `hub:centre:${centres[gi]!.key}:${sessionId}`;
    const centre = centres[gi]!;
    const angle = rng() * Math.PI * 2;
    const at = place(id, { x: centreNodes[gi]!.x + Math.cos(angle) * 60, y: centreNodes[gi]!.y + Math.sin(angle) * 60 }, options.seed, rng, 10);
    let hub = nodes.find((n) => n.id === id);
    if (hub === undefined || hub.kind !== "hub") {
      hub = {
        kind: "hub",
        id,
        x: at.x,
        y: at.y,
        vx: 0,
        vy: 0,
        r: centre.past ? 1.6 : 2.6,
        rep: 1.6,
        label: "",
        sub: true,
        group: id,
        count: 0,
        past: centre.past,
      };
      nodes.push(hub);
      links.push({
        a: centreNodes[gi]!,
        b: hub,
        len: centre.past ? 50 : 80,
        k: 0.05,
        w: centre.past ? 1.1 : 2,
        op: centre.past ? 0.35 : 0.6,
        dim: centre.past,
      });
    }
    hub.count += 1;
    return hub;
  }
}

/* ---------------------------------------------------------------- 合并：多问 → 一张累积图 */

export interface TurnLeaves {
  turnId: string;
  /** 第几问（1 起；调用方已按「跑过召回」的问计数） */
  round: number;
  /** 这一问的 /edges → 叶子（按岗位视图逐 (QA, 岗)；按提问视图逐 QA 主岗） */
  leaves: readonly ClusterLeaf[];
}

/**
 * 把每一问的叶子合并成累积集合：合并键 keyOf（按岗位 = qaId#slot；按提问 = qaId）。
 * 展示字段取**最近使用它的那一问**；lastRound 取最大；rounds 汇总升序去重。
 */
export function mergeTurnLeaves(
  turns: readonly TurnLeaves[],
  keyOf: (leaf: ClusterLeaf) => string,
): ClusterLeaf[] {
  const byKey = new Map<string, ClusterLeaf>();
  for (const turn of turns) {
    for (const leaf of turn.leaves) {
      const key = keyOf(leaf);
      const found = byKey.get(key);
      if (found === undefined) {
        byKey.set(key, { ...leaf, lastRound: turn.round, rounds: [turn.round] });
        continue;
      }
      const rounds = [...new Set([...found.rounds, turn.round])].sort((a, b) => a - b);
      const latest = turn.round >= found.lastRound ? leaf : found;
      byKey.set(key, {
        ...latest,
        lastRound: Math.max(found.lastRound, turn.round),
        rounds,
      });
    }
  }
  return [...byKey.values()].sort((a, b) => a.ts - b.ts || (a.qaId < b.qaId ? -1 : 1));
}

/* ---------------------------------------------------------------- 上色 / 缩放（只改样式与几何映射，不重排） */

/**
 * 把着色档位写到叶子上（就地）。**只碰 percent，绝不碰坐标**——切「时间 / 相关度」
 * 或换高亮轮永远不该引发重新布局（2026-10-14 用户裁决）。
 */
export function paintScene(scene: ClusterScene, colorMode: GraphColorMode): void {
  const leaves = scene.nodes.filter((node): node is LeafNode => node.kind === "leaf");
  const range = leafRange(leaves.map((node) => node.leaf));
  for (const node of leaves) {
    node.percent = nebulaPercentOf(colorMode, node.leaf, range);
  }
}

/**
 * 面板尺寸变了：已收敛的坐标按新宽高等比缩放（soma 的居中固定点也跟着走）。
 * 不重新模拟——拖分隔条 / 微调窗口时图保持形状，只是整体伸缩（大跨度宽度变化
 * 由调用方判断后整体重建）。
 */
export function rescaleScene(scene: ClusterScene, fromW: number, fromH: number, toW: number, toH: number): void {
  if (fromW <= 0 || fromH <= 0) return;
  const kx = toW / fromW;
  const ky = toH / fromH;
  for (const node of scene.nodes) {
    node.x *= kx;
    node.y *= ky;
  }
}

/* ---------------------------------------------------------------- 提问网络的中心候选 */

/**
 * 从入选里找出「当年自己也做过召回」的 orbita 提问（qaId 形如
 * `orbita:<sessionId>:<turnId>`），作为提问网络的旧中心候选。至多 max 个。
 */
export function orbitaCentreCandidates(
  leaves: readonly ClusterLeaf[],
  max: number,
): { sessionId: string; turnId: string }[] {
  const seen = new Set<string>();
  const out: { sessionId: string; turnId: string }[] = [];
  for (const leaf of leaves) {
    if (!leaf.qaId.startsWith("orbita:")) continue;
    const rest = leaf.qaId.slice("orbita:".length);
    const at = rest.indexOf(":");
    if (at <= 0 || at >= rest.length - 1) continue;
    const sessionId = rest.slice(0, at);
    const turnId = rest.slice(at + 1);
    const key = `${sessionId}:${turnId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ sessionId, turnId });
    if (out.length >= max) break;
  }
  return out;
}
