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
 *   来源会话成簇；被多个中心召回过的 QA 长在它们中间、两边各连一根（实线）。
 *
 * **所有权（2026-10-14 诊断后定死）**：本模块只产生**结构**——节点、连线、初始
 * 坐标（有种子用种子）；**不跑模拟**。模拟循环、拖拽、坐标缓存全在 GraphRenderer；
 * `tick` / `simulateToConvergence` 是给渲染器与测试用的纯力学步。以前 build 内部跑
 * 到收敛、渲染器再从 alpha=1 跑一遍，已收敛的图被整体再加热（最大位移 46px）——
 * 这就是「新一轮到达旧节点乱跳」的根因。
 *
 * **尺度相对化**：所有长度按 R = min(W, H) 的比例给，不用像素常量——原型是 470×600
 * 的画布，面板只有 ~320–460 宽；像素常量原样搬过来，六个岗位 hub 全部顶在钳制墙上。
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

/**
 * 着色权重：0 = 全按时间（最近用过的轮次），1 = 全按相关度，中间按比例相加。
 * 用户 2026-10-14：「时间和相关度给一个滑块……50% 就是既考虑时间又考虑相关度，
 * 两套数字按百分比相加」。缺省 0.5。
 */
export type GraphColorWeight = number;
export const DEFAULT_COLOR_WEIGHT: GraphColorWeight = 0.5;

/** 叶子的着色浓度（20–100，连续）——映射到
 *  `color-mix(in srgb, var(--color-nebula) X%, transparent)`（用量格同款 token）。 */
export type NebulaPercent = number;

/** 着色归一的范围：轮次（time 模式）与分数（score 模式）各自的极差。 */
export interface LeafRange {
  rMin: number;
  rMax: number;
  sMin: number;
  sMax: number;
}

/**
 * 颜色 = 时间（使用的轮次，越近越满）与相关度（分数，越高越满）按权重相加：
 * u = (1 − w)·时间分 + w·相关度分，两个分量都按当前数据内的极差归一到 [0, 1]；
 * 浓度连续映射到 20–100%（不再切三档：混合后的值要能看出深浅的细差）。
 */
export function nebulaPercentOf(
  weight: GraphColorWeight,
  leaf: Pick<ClusterLeaf, "lastRound" | "score">,
  range: LeafRange,
): NebulaPercent {
  const w = Math.min(1, Math.max(0, weight));
  const uTime = range.rMax === range.rMin ? 0.5 : (leaf.lastRound - range.rMin) / (range.rMax - range.rMin);
  const uScore = range.sMax === range.sMin ? 0.5 : (leaf.score - range.sMin) / (range.sMax - range.sMin);
  const u = (1 - w) * uTime + w * uScore;
  return Math.round(20 + 80 * u);
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
  /** 被拖拽中：坐标由指针给，力学不动它 */
  fixed?: boolean;
  /** 钉住的目标点（本问胞体）：强弹簧拉向它——可拖，松手弹回 */
  pin?: { x: number; y: number };
  /** 向心力倍数（中心节点 10×：没有连接的中心也要被拉进画面） */
  grav?: number;
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
  /** 常规倍率下显示的标签（小簇为空，免得密集时互相压住） */
  label: string;
  /** 完整标签（来源会话名）：语义缩放放大后每个簇心都显；单条归成的枝没有名字 */
  fullLabel: string;
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
  /** 按岗位视图：同一 QA 跨岗的虚线桥（强调色） */
  bridge?: boolean;
  /** 按提问视图：共享叶到各中心的实线（强调色、细淡）——不是虚线 */
  ego?: boolean;
}

export interface ClusterScene {
  nodes: SimNode[];
  links: SimLink[];
  /** 布局空间（构建时的面板尺寸）：模拟在这个空间里跑，渲染器等比映射到屏幕 */
  w: number;
  h: number;
  /** 密集样式（>40 片叶）：叶更小、线更细 */
  dense: boolean;
}

/** 种子随机（Lehmer / Park-Miller）：确定性布局的全部随机性都从这里出。 */
export function seededRandom(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

/** 物理常量的尺度基准：原型画布的短边。 */
const UNIT = 340;

/** 软边界的边距：节点进入边距带就被推回（标签要留得下） */
export function boundaryMargin(W: number, H: number): number {
  return Math.max(20, Math.min(W, H) * 0.07);
}

/**
 * 单轮力学步进（排斥 + 弹簧 + 向心 + 钉点弹簧 + 软边界）。确定性：无随机。
 * 排斥常量与截断距离按 min(W,H)/340 缩放，布局在小面板里不会因为力程不变而爆开。
 * 边界是**软**的（进入边距带给回拉力），只在画布外沿做硬钳制——硬钳制在墙上
 * 会把一堆节点压到同一个角点（2026-10-14 真机的「角落孤点」）。
 */
export function tick(nodes: readonly SimNode[], links: readonly SimLink[], W: number, H: number, alpha: number, maxStep: number): void {
  const s = Math.min(W, H) / UNIT;
  const cutoff2 = 220 * s * (220 * s);
  const repK = 210 * s * s;
  const margin = boundaryMargin(W, H);
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      const d2 = dx * dx + dy * dy + 0.01;
      if (d2 > cutoff2) continue;
      const f = (a.rep * b.rep * repK) / d2;
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
    const g = 0.0005 * (n.grav ?? 1);
    n.vx += (W / 2 - n.x) * g;
    n.vy += (H / 2 - n.y) * g;
    if (n.pin !== undefined) {
      n.vx += (n.pin.x - n.x) * 0.15;
      n.vy += (n.pin.y - n.y) * 0.15;
    }
    if (n.x < margin) n.vx += (margin - n.x) * 0.12;
    else if (n.x > W - margin) n.vx -= (n.x - (W - margin)) * 0.12;
    if (n.y < margin) n.vy += (margin - n.y) * 0.12;
    else if (n.y > H - margin) n.vy -= (n.y - (H - margin)) * 0.12;
    n.x += Math.max(-maxStep, Math.min(maxStep, n.vx * alpha));
    n.y += Math.max(-maxStep, Math.min(maxStep, n.vy * alpha));
    n.vx *= 0.6;
    n.vy *= 0.6;
    n.x = Math.max(6, Math.min(W - 6, n.x));
    n.y = Math.max(6, Math.min(H - 6, n.y));
  }
}

/** 收敛阈值与衰减：alpha 从起点每轮 ×0.985，低于 0.02 视为静止。 */
export const CONVERGED_ALPHA = 0.02;
export const ALPHA_DECAY = 0.985;
/** 有种子时（新一轮长出 / 拖拽松手）的起始热度：够新节点落定，旧节点只小幅让位 */
export const GROW_ALPHA = 0.2;

/**
 * 同步跑到**收敛**（reduced-motion、测试用；渲染器逐帧动画走自己的循环）。
 * alpha 从起点起每轮 ×0.985，< 0.02 停（或撞 800 轮上限）。
 * @returns 实际跑的轮数。
 */
export function simulateToConvergence(
  scene: ClusterScene,
  options: { alpha?: number; maxIters?: number } = {},
): number {
  const maxIters = options.maxIters ?? 800;
  let alpha = options.alpha ?? 1;
  let iter = 0;
  for (; iter < maxIters && alpha >= CONVERGED_ALPHA; iter += 1) {
    tick(scene.nodes, scene.links, scene.w, scene.h, alpha, 8);
    alpha *= ALPHA_DECAY;
  }
  return iter;
}

/** 布局种子：上一次成型的坐标（按节点 id 对回）。「新东西长在旧图上」的机制。 */
export type LayoutSeed = ReadonlyMap<string, { x: number; y: number }>;

export interface BuildOptions {
  /** 上一张图的坐标：命中 id 的节点从原位出发（新节点热启动到带种子邻居的质心）。
   *  种子只决定出发点；要不要加热、加热到几分由渲染器按「有多少节点没种子」决定 */
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

/** 把成型后的坐标收进种子表（渲染器的各视图坐标缓存）。 */
export function sceneSeed(scene: ClusterScene): Map<string, { x: number; y: number }> {
  const seed = new Map<string, { x: number; y: number }>();
  for (const node of scene.nodes) seed.set(node.id, { x: node.x, y: node.y });
  return seed;
}

/** 种子里有多少节点对不上（新节点数）：渲染器据此决定加热程度。 */
export function unseededCount(scene: ClusterScene, seed: LayoutSeed | undefined): number {
  if (seed === undefined) return scene.nodes.length;
  let n = 0;
  for (const node of scene.nodes) if (!seed.has(node.id)) n += 1;
  return n;
}

/** 叶子半径：密集 2.5–5px、常规 3–6.5px（分数越高越大）。2px 的叶在真机上看不见也点不中。 */
export function leafRadius(score: number, dense: boolean): number {
  const u = Math.max(0, Math.min(1, (score - 0.5) / 0.5));
  return dense ? 2.5 + 2.5 * u : 3 + 3.5 * u;
}

/** 叶枝长度：高分近、低分远（等长辐条 = 海胆）。 */
function leafLen(score: number, R: number): number {
  const u = Math.max(0, Math.min(1, (score - 0.5) / 0.5));
  return R * (0.085 - 0.04 * u);
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
 * 按岗位成簇：会话胞体（钉在中心）→ 六个岗位 hub → 子簇 → 叶子（QA, 岗位）。
 * 子簇规则：同一岗位下，≥2 条的来源会话各自一个子簇（≥3 条标会话名）；只有一条
 * 的来源按首次召回它的那一问归成一根不标名的枝——真实数据里一个岗位 25 片叶来自
 * 22 个会话，照「每会话一簇」画就是 22 根辐条（2026-10-14 真机的海胆）。
 * 同一 QA 两岗的叶子之间拉桥（弹簧，共享越多两簇越近）。
 */
export function buildSlotScene(
  leaves: readonly ClusterLeaf[],
  W: number,
  H: number,
  options: BuildOptions = {},
): ClusterScene {
  const R = Math.min(W, H);
  const dense = leaves.length > 40;
  const rng = seededRandom(3);
  const nodes: SimNode[] = [];
  const links: SimLink[] = [];
  // 胞体也走种子：钉点弹簧与不对称的排斥平衡在离中心几 px 处，不用种子就会
  // 在切回视图时跳回正中（真机 12.8px）
  const somaAt = place("soma:session", { x: W / 2, y: H / 2 }, options.seed, rng, 0);
  const soma: SomaNode = {
    kind: "soma",
    id: "soma:session",
    x: somaAt.x,
    y: somaAt.y,
    vx: 0,
    vy: 0,
    // 本问胞体：墨色本身就够醒目，不用做大（用户 2026-10-14）
    r: 7,
    rep: 3,
    pin: { x: W / 2, y: H / 2 },
    label: "",
    past: false,
  };
  nodes.push(soma);
  const hubs: HubNode[] = SLOT_CLUSTER_NAMES.map((name, i) => {
    const angle = (i / 6) * Math.PI * 2 - Math.PI / 2;
    const at = place(
      `hub:slot:${i + 1}`,
      { x: soma.x + Math.cos(angle) * R * 0.27, y: soma.y + Math.sin(angle) * R * 0.27 },
      options.seed,
      rng,
      10,
    );
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
      fullLabel: name,
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
    links.push({ a: soma, b: hub, len: R * 0.27, k: 0.04, w: 1 + totals[i]! * 0.4, op: 0.5 });
  });
  const leafOf = new Map<string, LeafNode[]>();
  const addSub = (slot: number, id: string, label: string, fullLabel: string, count: number): HubNode => {
    const hub = hubs[slot - 1]!;
    const at = place(id, { x: hub.x, y: hub.y }, options.seed, rng, R * 0.12);
    const sub: HubNode = {
      kind: "hub",
      id,
      x: at.x,
      y: at.y,
      vx: 0,
      vy: 0,
      r: 1.8,
      rep: 1.2,
      label,
      fullLabel,
      sub: true,
      group: `slot:${slot}`,
      count,
      past: false,
    };
    nodes.push(sub);
    links.push({ a: hub, b: sub, len: R * 0.11, k: 0.06, w: 1.4, op: 0.45 });
    return sub;
  };
  const addLeaf = (parent: HubNode, leaf: ClusterLeaf, slot: number): void => {
    const id = `leaf:${leaf.qaId}#${slot}`;
    const at = place(id, { x: parent.x, y: parent.y }, options.seed, rng, R * 0.08);
    const node: LeafNode = {
      kind: "leaf",
      id,
      rowKey: `${leaf.qaId}#${slot}`,
      leaf,
      x: at.x,
      y: at.y,
      vx: 0,
      vy: 0,
      r: leafRadius(leaf.score, dense),
      rep: dense ? 0.8 : 1,
      shared: false,
    };
    nodes.push(node);
    links.push({ a: parent, b: node, len: leafLen(leaf.score, R), k: 0.05, w: dense ? 0.8 : 1, op: 0.4 + 0.5 * leaf.score });
    const group = leafOf.get(leaf.qaId) ?? [];
    group.push(node);
    leafOf.set(leaf.qaId, group);
  };
  SLOT_CLUSTER_NAMES.forEach((_, i) => {
    const slot = i + 1;
    const mine = leaves.filter((leaf) => leaf.slot === slot);
    hubs[i]!.count = mine.length;
    const bySession = new Map<string, ClusterLeaf[]>();
    for (const leaf of mine) {
      const list = bySession.get(leaf.sessionId) ?? [];
      list.push(leaf);
      bySession.set(leaf.sessionId, list);
    }
    const singles: ClusterLeaf[] = [];
    for (const [sessionId, list] of bySession) {
      if (list.length < 2) {
        singles.push(list[0]!);
        continue;
      }
      // 密集模式只标 ≥3 条的簇（原型规则）；常规 ≥2 条就标
      const label = list.length >= (dense ? 3 : 2) ? list[0]!.title : "";
      const sub = addSub(slot, `hub:slot:${slot}:${sessionId}`, label, list[0]!.title, list.length);
      for (const leaf of list) addLeaf(sub, leaf, slot);
    }
    if (singles.length === 1) {
      addLeaf(hubs[i]!, singles[0]!, slot);
    } else {
      // 单条来源的叶子按**首次召回它的那一问**归枝：一片叶的首轮永不变，新一轮只会
      // 添一根新枝，旧枝的成员不变——按时间顺序每 5 片切一段的话，新叶插进来会让
      // 后面所有段重新分组，旧叶跟着挪（真机实测旧节点平均位移 14px → 3px）
      const byFirstRound = new Map<number, ClusterLeaf[]>();
      for (const leaf of singles) {
        const first = leaf.rounds[0] ?? leaf.lastRound;
        const list = byFirstRound.get(first) ?? [];
        list.push(leaf);
        byFirstRound.set(first, list);
      }
      for (const [first, chunk] of [...byFirstRound.entries()].sort((a, b) => a[0] - b[0])) {
        chunk.sort((a, b) => a.ts - b.ts || (a.qaId < b.qaId ? -1 : 1));
        const sub = addSub(slot, `hub:slot:${slot}:twig:${first}`, "", "", chunk.length);
        for (const leaf of chunk) addLeaf(sub, leaf, slot);
      }
    }
  });
  for (const group of leafOf.values()) {
    if (group.length < 2) continue;
    for (const node of group) node.shared = true;
    for (let i = 1; i < group.length; i += 1) {
      links.push({ a: group[0]!, b: group[i]!, len: R * 0.26, k: 0.01, bridge: true });
    }
  }
  if (options.seed !== undefined) warmStartUnseeded(nodes, links, options.seed);
  return { nodes, links, w: W, h: H, dense };
}

/* ---------------------------------------------------------------- ② 按提问成网络 */

/** 一个中心（会话里的一问；或被召回历史里 orbita 自召回的旧提问）。 */
export interface EgoCentre {
  key: string;
  /** 中心标签（「第 3 问」） */
  label: string;
  /** 最新一问 = false（最亮、钉在中心）；其余中心 = true（旧中心退一档） */
  past: boolean;
  /** 该中心召回的叶子（每 QA 一片，slot = 主岗；含轮号信息） */
  leaves: readonly ClusterLeaf[];
}

/** 中心数上限（规格 C）。 */
export const MAX_CENTRES = 6;

/**
 * 按提问成网络：每个中心一个 soma（最新一问钉在中心，旧中心带 10× 向心力——
 * 没有连接的中心也被拉进画面），(中心, 来源会话) 成簇；被多个中心召回的 QA 一片
 * 叶子长在它们中间、每边一根**实线**（原型 `.bridge.ego` 无虚线——虚线只给按岗位
 * 视图的跨岗桥）。叶子的展示数据取**最近使用它的那一问**（合并语义）。
 */
export function buildEgoScene(
  centres: readonly EgoCentre[],
  W: number,
  H: number,
  options: BuildOptions = {},
): ClusterScene {
  const R = Math.min(W, H);
  const dense = centres.reduce((sum, centre) => sum + centre.leaves.length, 0) > 40;
  const rng = seededRandom(5);
  const nodes: SimNode[] = [];
  const links: SimLink[] = [];
  const pastCount = centres.filter((centre) => centre.past).length;
  let pastIndex = 0;
  const centreNodes: SomaNode[] = centres.map((centre) => {
    const past = centre.past;
    const id = `soma:centre:${centre.key}`;
    let fallback = { x: W / 2, y: H / 2 };
    if (past) {
      const angle = (pastIndex / Math.max(1, pastCount)) * Math.PI * 2 - Math.PI / 2;
      pastIndex += 1;
      fallback = { x: W / 2 + Math.cos(angle) * R * 0.22, y: H / 2 + Math.sin(angle) * R * 0.22 };
    }
    const at = place(id, fallback, options.seed, rng, 8);
    const node: SomaNode = {
      kind: "soma",
      id,
      x: at.x,
      y: at.y,
      vx: 0,
      vy: 0,
      r: past ? 5 : 7,
      rep: past ? 3 : 4,
      grav: 24,
      pin: past ? undefined : { x: W / 2, y: H / 2 },
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
  const hubs = new Map<string, HubNode>();
  const hubFor = (gi: number, sessionId: string, title: string): HubNode => {
    const centre = centres[gi]!;
    const id = `hub:centre:${centre.key}:${sessionId}`;
    const found = hubs.get(id);
    if (found !== undefined) {
      found.count += 1;
      return found;
    }
    const origin = centreNodes[gi]!;
    const angle = rng() * Math.PI * 2;
    const at = place(
      id,
      { x: origin.x + Math.cos(angle) * R * 0.14, y: origin.y + Math.sin(angle) * R * 0.14 },
      options.seed,
      rng,
      10,
    );
    const hub: HubNode = {
      kind: "hub",
      id,
      x: at.x,
      y: at.y,
      vx: 0,
      vy: 0,
      r: centre.past ? 1.6 : 2.6,
      rep: 1.6,
      label: "",
      fullLabel: title,
      sub: true,
      group: id,
      count: 1,
      past: centre.past,
    };
    hubs.set(id, hub);
    nodes.push(hub);
    links.push({
      a: origin,
      b: hub,
      len: centre.past ? R * 0.11 : R * 0.18,
      k: 0.05,
      w: centre.past ? 1.1 : 1.8,
      op: centre.past ? 0.35 : 0.6,
      dim: centre.past,
    });
    // 最新一问的簇标来源会话名（≥3 条才标，见下方 count 校正）
    hub.label = title;
    return hub;
  };
  for (const [qaId, gs] of who) {
    const leaf = merged.get(qaId)!;
    const rounds = [
      ...new Set(
        gs.flatMap((gi) => centres[gi]!.leaves.find((item) => item.qaId === qaId)?.rounds ?? [leaf.lastRound]),
      ),
    ].sort((a, b) => a - b);
    const shared = gs.length > 1;
    const hs = gs.map((gi) => hubFor(gi, leaf.sessionId, leaf.title));
    const node: LeafNode = {
      kind: "leaf",
      id: `leaf:${qaId}`,
      rowKey: qaId,
      leaf: { ...leaf, lastRound: Math.max(...rounds, leaf.lastRound), rounds },
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      r: leafRadius(leaf.score, dense),
      rep: dense ? 0.8 : 1,
      shared,
    };
    const centroid = {
      x: hs.reduce((sum, hub) => sum + hub.x, 0) / hs.length,
      y: hs.reduce((sum, hub) => sum + hub.y, 0) / hs.length,
    };
    const at = place(node.id, centroid, options.seed, rng, R * 0.06);
    node.x = at.x;
    node.y = at.y;
    nodes.push(node);
    hs.forEach((hub, at2) => {
      const centre = centres[gs[at2]!]!;
      if (shared) {
        links.push({ a: hub, b: node, len: R * 0.16, k: 0.04, ego: true, dim: centre.past });
      } else {
        links.push({
          a: hub,
          b: node,
          len: leafLen(leaf.score, R),
          k: 0.06,
          w: dense ? 0.8 : 1,
          op: centre.past ? 0.3 : 0.4 + 0.5 * leaf.score,
          dim: centre.past,
        });
      }
    });
  }
  // 簇名：只给最新一问、≥3 条的簇（旧中心的簇不标，密了看不清）
  for (const hub of hubs.values()) {
    if (hub.past || hub.count < 3) hub.label = "";
  }
  if (options.seed !== undefined) warmStartUnseeded(nodes, links, options.seed);
  return { nodes, links, w: W, h: H, dense };
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

/**
 * 本会话的问 → 按提问视图的中心（≤ MAX_CENTRES）：最新的几问各一个中心；超出
 * 上限的更早几问并成一个「更早」中心（它们的叶子仍带各自的轮号）。
 * 不出中心的轮不会让叶子失联——每片叶至少挂在「更早」中心上。
 */
export function centresOfTurns(
  turns: readonly TurnLeaves[],
  latestRound: number,
  labelOf: (round: number) => string,
  earlierLabel: (fromRound: number, toRound: number) => string,
): EgoCentre[] {
  const live = turns.filter((turn) => turn.leaves.length > 0 || turn.round === latestRound);
  if (live.length <= MAX_CENTRES) {
    return live.map((turn) => ({
      key: turn.turnId,
      label: labelOf(turn.round),
      past: turn.round !== latestRound,
      leaves: turn.leaves,
    }));
  }
  const keep = live.slice(live.length - (MAX_CENTRES - 1));
  const earlier = live.slice(0, live.length - (MAX_CENTRES - 1));
  const mergedLeaves = mergeTurnLeaves(earlier, (leaf) => leaf.qaId);
  return [
    {
      key: `earlier:${earlier[0]!.turnId}`,
      label: earlierLabel(earlier[0]!.round, earlier[earlier.length - 1]!.round),
      past: true,
      leaves: mergedLeaves,
    },
    ...keep.map((turn) => ({
      key: turn.turnId,
      label: labelOf(turn.round),
      past: turn.round !== latestRound,
      leaves: turn.leaves,
    })),
  ];
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
    // 先查预算再收：max=0（本会话的问已占满中心）时一个都不给
    if (out.length >= max) break;
    const parsed = parseOrbitaQaId(leaf.qaId);
    if (parsed === null) continue;
    const key = `${parsed.sessionId}:${parsed.turnId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }
  return out;
}

/** `orbita:<sessionId>:<turnId>` → 两段；不是这个形状给 null。 */
export function parseOrbitaQaId(qaId: string): { sessionId: string; turnId: string } | null {
  if (!qaId.startsWith("orbita:")) return null;
  const rest = qaId.slice("orbita:".length);
  const at = rest.indexOf(":");
  if (at <= 0 || at >= rest.length - 1) return null;
  return { sessionId: rest.slice(0, at), turnId: rest.slice(at + 1) };
}

/* ---------------------------------------------------------------- 主干（spine）

  用户 2026-10-14：「spine 应该是最相关的那几条——不管隔了几跳，它们连到本问的那一路边
  都要亮起来」。图是一棵以本问胞体为根的树（再加跨岗桥 / 共享实线）；主干 = 相关度
  最高的几片叶各自沿树走回本问的那条路径上的全部边。选中的叶同样亮出它的那一路。 */

/** 主干取相关度最高的几片叶。 */
export const SPINE_LEAVES = 3;

/**
 * 每个节点走回本问的父边：从**本问胞体**（钉住的那个、非旧中心）出发沿非桥边做 BFS；
 * 按提问视图里只连到旧中心的叶，再从各旧中心补一轮（它们和本问之间没有直接的边，
 * 那一路就止于它所属的旧中心）。返回 子节点 → 通向父节点的那条边。
 */
export function parentLinks(scene: ClusterScene): Map<SimNode, SimLink> {
  const adj = new Map<SimNode, SimLink[]>();
  for (const link of scene.links) {
    if (link.bridge === true) continue;
    for (const end of [link.a, link.b]) {
      const list = adj.get(end) ?? [];
      list.push(link);
      adj.set(end, list);
    }
  }
  const somas = scene.nodes.filter((node): node is SomaNode => node.kind === "soma");
  const roots = [...somas.filter((soma) => !soma.past), ...somas.filter((soma) => soma.past)];
  const parent = new Map<SimNode, SimLink>();
  const seen = new Set<SimNode>();
  for (const root of roots) {
    if (seen.has(root)) continue;
    seen.add(root);
    const queue: SimNode[] = [root];
    for (let head = 0; head < queue.length; head += 1) {
      const node = queue[head]!;
      for (const link of adj.get(node) ?? []) {
        const next = link.a === node ? link.b : link.a;
        if (seen.has(next) || next.kind === "soma") continue;
        seen.add(next);
        parent.set(next, link);
        queue.push(next);
      }
    }
  }
  return parent;
}

/** 一片叶走回本问的全部边（叶 → 子簇 → 岗位 / 中心 → 胞体）。 */
export function pathToRoot(leaf: SimNode, parent: ReadonlyMap<SimNode, SimLink>): SimLink[] {
  const out: SimLink[] = [];
  let node: SimNode = leaf;
  for (let guard = 0; guard < 64; guard += 1) {
    const link = parent.get(node);
    if (link === undefined) break;
    out.push(link);
    node = link.a === node ? link.b : link.a;
  }
  return out;
}

/** 一条路径是否走到**本问**胞体（非旧中心）。 */
export function reachesCurrent(path: readonly SimLink[]): boolean {
  const last = path[path.length - 1];
  if (last === undefined) return false;
  return [last.a, last.b].some((node) => node.kind === "soma" && !node.past);
}

/**
 * 主干叶：**连得到本问**的叶里相关度最高的几片（同分取最近一轮用过的；被否认的不进）。
 * 按提问视图里只属于旧问的叶走不到本问——它们再相关也不是本问的主干。
 */
export function spineLeaves(
  scene: ClusterScene,
  parent: ReadonlyMap<SimNode, SimLink>,
  count = SPINE_LEAVES,
): LeafNode[] {
  return scene.nodes
    .filter(
      (node): node is LeafNode =>
        node.kind === "leaf" && node.leaf.verdict !== "no" && reachesCurrent(pathToRoot(node, parent)),
    )
    .sort((a, b) => b.leaf.score - a.leaf.score || b.leaf.lastRound - a.leaf.lastRound || (a.id < b.id ? -1 : 1))
    .slice(0, count);
}
