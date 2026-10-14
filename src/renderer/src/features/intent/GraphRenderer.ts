/**
 * 意图簇图的指令式渲染器 —— 不经过 React 状态驱动逐帧更新。
 *
 * 2026-10-14 真机的两处教训落在这一层：
 * 1. **布局要跑到收敛**（cluster-layout 的 simulateToConvergence，alpha 衰减到阈值），
 *    初次加载 / 新增一轮数据用逐帧动画让节点「落定」，落定后静止——动效只解释
 *    「东西去哪了」，不常驻（设计系统规定）。
 * 2. **模拟的每一帧不驱动 React 重渲染**：React 只在数据（问 / 边）变化时重建
 *    SVG 结构；落定动画、拖拽复热、上色、高亮全部由本类直接改 DOM 属性。
 *
 * 另：窗口失焦暂停（设计系统规定）；prefers-reduced-motion 直接给收敛后的结果；
 * 节点可拖（Obsidian 关系图的手感）：拖动时复热，松手后弹回落定。
 */

import {
  leafRange,
  maxDrift,
  nebulaPercentOf,
  simulateToConvergence,
  tick,
  type ClusterScene,
  type GraphColorMode,
  type LeafNode,
  type SimNode,
} from "./cluster-layout.ts";

const CONVERGED_ALPHA = 0.02;
const ALPHA_DECAY = 0.985;

/** 三档百分比 → 用量格同款 color-mix（nebula 色带）。 */
export function nebulaFill(percent: number): string {
  return `color-mix(in srgb, var(--color-nebula) ${percent}%, transparent)`;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementEventMap>(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function curveD(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const k = 0.12;
  return `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${(mx - dy * k).toFixed(1)},${(my + dx * k).toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
}

export class GraphRenderer {
  private colorMode: GraphColorMode = "time";
  private readonly svg: SVGSVGElement;
  private readonly gLinks: SVGGElement;
  private readonly gBridges: SVGGElement;
  private readonly gNodes: SVGGElement;
  /** 每个节点的 DOM 句柄（位置更新只动这些属性，不重建结构） */
  private readonly handles = new Map<SimNode, { root: SVGElement; core?: SVGElement; round?: SVGElement }>();
  private readonly linkEls: { path: SVGPathElement; a: SimNode; b: SimNode; bridge: boolean }[] = [];
  private scene: ClusterScene | null = null;
  private frame = 0;
  private running = false;
  private alpha = 0;

  constructor(
    svg: SVGSVGElement,
    /** 点（非拖）一片叶子：滚到条目行并选中 */
    private readonly onSelectLeaf: (rowKey: string) => void = () => undefined,
  ) {
    this.svg = svg;
    this.gLinks = el("g", {}) as SVGGElement;
    this.gBridges = el("g", {}) as SVGGElement;
    this.gNodes = el("g", {}) as SVGGElement;
    svg.append(this.gLinks, this.gBridges, this.gNodes);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  dispose(): void {
    this.stop();
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  private onVisibility = (): void => {
    if (document.hidden) {
      this.stop();
    } else if (this.running) {
      this.loop();
    }
  };

  /** 数据变了：重建结构，然后（可选动画）跑到收敛。 */
  setScene(scene: ClusterScene, W: number, H: number, options: { animate: boolean }): void {
    this.stop();
    this.scene = scene;
    this.handles.clear();
    this.linkEls.length = 0;
    this.gLinks.replaceChildren();
    this.gBridges.replaceChildren();
    this.gNodes.replaceChildren();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // 结构
    for (const link of scene.links) {
      const path = el("path", {
        class: link.bridge === true ? "ibridge" : "ibr",
        fill: "none",
        ...(link.bridge === true ? {} : { "stroke-width": link.w ?? 1, "stroke-opacity": link.op ?? 0.5 }),
      }) as SVGPathElement;
      (link.bridge === true ? this.gBridges : this.gLinks).append(path);
      this.linkEls.push({ path, a: link.a, b: link.b, bridge: link.bridge === true });
    }
    for (const node of scene.nodes) {
      if (node.kind === "hub") {
        const root = el("g", {});
        root.append(el("circle", { class: "ihub", r: node.r }));
        if (node.label !== "") {
          const label = el("text", { class: "ihub-label", "text-anchor": "middle" });
          label.textContent = node.label;
          label.setAttribute("y", String(-node.r - 5));
          root.append(label);
        }
        this.gNodes.append(root);
        this.handles.set(node, { root });
      } else if (node.kind === "leaf") {
        const root = el("g", { class: "ileaf" });
        const halo = el("circle", { class: "ileaf-halo", r: node.r + 4 });
        const core = el("circle", { class: "ileaf-core", r: Math.max(node.r, 1) });
        root.append(halo, core);
        this.handles.set(node, { root, core });
        root.addEventListener("pointerdown", (event) => this.beginDrag(event, node));
      } else {
        const root = el("g", { class: `isoma${node.past ? " past" : ""}` });
        root.append(
          el("circle", { class: "imembrane", r: node.r + 6 }),
          el("circle", { class: "isoma-core", r: node.r }),
        );
        if (node.label !== "") {
          const label = el("text", { class: "isoma-label", "text-anchor": "middle" });
          label.textContent = node.label;
          label.setAttribute("y", String(node.r + 15));
          root.append(label);
        }
        this.gNodes.append(root);
        this.handles.set(node, { root });
      }
    }
    this.draw();
    // 力学：动画落定（或 reduced-motion / 后台时同步收敛）
    if (options.animate && !reduced && !document.hidden) {
      this.alpha = 1;
      this.running = true;
      this.loop();
    } else {
      simulateToConvergence(scene.nodes, scene.links, W, H);
      this.draw();
    }
  }

  /** 收敛态的坐标仍在（拖分隔条 / 微调窗口）：整体缩放，不重排。 */
  rescale(fromW: number, fromH: number, toW: number, toH: number): void {
    if (this.scene === null || fromW <= 0 || fromH <= 0) return;
    const kx = toW / fromW;
    const ky = toH / fromH;
    for (const node of this.scene.nodes) {
      node.x *= kx;
      node.y *= ky;
    }
    this.draw();
  }

  /** 上色（时间 / 相关度）：只改 fill / stroke 与轮号文字，坐标绝不动。 */
  paint(colorMode: GraphColorMode): void {
    this.colorMode = colorMode;
    const scene = this.scene;
    if (scene === null) return;
    const leaves = scene.nodes.filter((node): node is LeafNode => node.kind === "leaf");
    const range = leafRange(leaves.map((node) => node.leaf));
    for (const node of leaves) {
      const handle = this.handles.get(node);
      if (handle?.core === undefined) continue;
      const color = nebulaFill(nebulaPercentOf(colorMode, node.leaf, range));
      const selected = handle.root.classList.contains("sel");
      handle.core.setAttribute("fill", node.leaf.solid ? color : "var(--color-bg-panel)");
      handle.core.setAttribute("stroke", selected ? "" : color);
      if (selected) handle.core.removeAttribute("stroke");
      const halo = handle.root.firstChild as SVGElement | null;
      halo?.setAttribute("fill", color);
      // 轮号：大节点常显，小节点选中才显
      const showRound = selected || node.r >= 3.2;
      if (showRound && handle.round === undefined) {
        const text = el("text", { class: "ileaf-round", x: node.r + 3, y: -node.r + 1 });
        text.textContent = String(node.leaf.lastRound);
        handle.root.append(text);
        handle.round = text;
      } else if (!showRound && handle.round !== undefined) {
        handle.round.remove();
        handle.round = undefined;
      } else if (handle.round !== undefined) {
        handle.round.textContent = String(node.leaf.lastRound);
      }
    }
    for (const link of this.linkEls) {
      if (link.bridge || link.b.kind !== "leaf") continue;
      link.path.setAttribute("stroke", nebulaFill(nebulaPercentOf(colorMode, link.b.leaf, range)));
    }
  }

  /** 高亮：选中行 / 某一轮。只动 class，不动坐标。 */
  setHighlight(selKey: string | null, activeRound: number | null, activeTurnId: string | null): void {
    const scene = this.scene;
    if (scene === null) return;
    const inRound = (rounds: readonly number[]): boolean =>
      activeRound === null || rounds.includes(activeRound);
    for (const node of scene.nodes) {
      const handle = this.handles.get(node);
      if (handle === undefined) continue;
      if (node.kind === "leaf") {
        const cls = [
          "ileaf",
          node.leaf.solid ? "" : "mid",
          node.shared ? "shared" : "",
          inRound(node.leaf.rounds) ? "" : "dim",
          node.leaf.verdict === "yes" ? "yes" : "",
          selKey === node.rowKey ? "sel" : "",
        ]
          .filter(Boolean)
          .join(" ");
        handle.root.setAttribute("class", cls);
      }
    }
    // 选中态的强调描边走 CSS、内联 nebula 色会让它失效：class 变了之后按当前
    // 模式重上一次色（坐标仍不动）
    this.paint(this.colorMode);
    for (const node of scene.nodes) {
      if (node.kind === "soma") {
        const handle = this.handles.get(node);
        if (handle === undefined) continue;
        const lit = activeTurnId !== null && node.id === `soma:centre:${activeTurnId}`;
        const dim = activeTurnId !== null && !lit;
        handle.root.setAttribute("class", `isoma${node.past ? " past" : ""}${dim ? " dim" : ""}${lit ? " lit" : ""}`);
      }
    }
    for (const link of this.linkEls) {
      if (link.bridge) continue;
      const dimByRound = link.b.kind === "leaf" && !inRound(link.b.leaf.rounds);
      link.path.setAttribute("class", `ibr${dimByRound ? " dim" : ""}`);
    }
  }

  /** 当前是否已经静止（拖拽复热判断用）。 */
  get settled(): boolean {
    return this.scene !== null && !this.running && maxDrift(this.scene.nodes, this.scene.links, 1, 1) < 0.5;
  }

  private loop = (): void => {
    if (!this.running || this.scene === null) return;
    const scene = this.scene;
    const rect = this.svg.getBoundingClientRect();
    const W = Math.max(1, rect.width);
    const H = Math.max(1, rect.height);
    // 每帧若干轮：落定动画一秒上下走完
    for (let i = 0; i < 8 && this.alpha >= CONVERGED_ALPHA; i += 1) {
      tick(scene.nodes, scene.links, W, H, this.alpha, 8);
      this.alpha *= ALPHA_DECAY;
    }
    this.draw();
    if (this.alpha < CONVERGED_ALPHA) {
      this.running = false;
      return;
    }
    this.frame = window.requestAnimationFrame(this.loop);
  };

  private stop(): void {
    if (this.frame !== 0) window.cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.running = false;
  };

  /** 把所有坐标写进 DOM（结构与上色不动）。 */
  private draw(): void {
    const scene = this.scene;
    if (scene === null) return;
    for (const node of scene.nodes) {
      const handle = this.handles.get(node);
      handle?.root.setAttribute("transform", `translate(${node.x.toFixed(1)},${node.y.toFixed(1)})`);
    }
    for (const link of this.linkEls) {
      link.path.setAttribute("d", curveD(link.a, link.b));
    }
  }

  /* ------------------------------------------------ 拖拽：复热，松手弹回落定 */

  private dragging: { node: SimNode; wasFixed: boolean; moved: number } | null = null;

  private beginDrag(event: PointerEvent, node: SimNode): void {
    if (this.scene === null) return;
    event.preventDefault();
    event.stopPropagation();
    this.stop();
    this.dragging = { node, wasFixed: node.fixed === true, moved: 0 };
    node.fixed = true;
    const start = { x: event.clientX, y: event.clientY };
    this.svg.setPointerCapture(event.pointerId);
    const move = (ev: PointerEvent): void => {
      if (this.dragging === null) return;
      this.dragging.moved = Math.max(this.dragging.moved, Math.hypot(ev.clientX - start.x, ev.clientY - start.y));
      const rect = this.svg.getBoundingClientRect();
      this.dragging.node.x = Math.max(6, Math.min(rect.width - 6, ev.clientX - rect.left));
      this.dragging.node.y = Math.max(6, Math.min(rect.height - 6, ev.clientY - rect.top));
      // 拖动中就地复热到较低热度：周围跟着让位，但不全场乱飞
      const scene = this.scene;
      if (scene !== null) {
        for (let i = 0; i < 2; i += 1) tick(scene.nodes, scene.links, rect.width, rect.height, 0.25, 8);
      }
      this.draw();
    };
    const up = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const dragged = this.dragging;
      if (dragged !== null) {
        dragged.node.fixed = dragged.wasFixed;
        this.dragging = null;
        // 几乎没动 = 点选（滚到条目行），不算拖拽
        if (dragged.moved < 3 && dragged.node.kind === "leaf") {
          this.onSelectLeaf(dragged.node.rowKey);
          return;
        }
      }
      // 松手：复热回落定（弹回一点，然后静止）
      if (this.scene !== null && !window.matchMedia("(prefers-reduced-motion: reduce)").matches && !document.hidden) {
        this.alpha = 0.3;
        this.running = true;
        this.loop();
      } else if (this.scene !== null) {
        const rect = this.svg.getBoundingClientRect();
        simulateToConvergence(this.scene.nodes, this.scene.links, Math.max(1, rect.width), Math.max(1, rect.height));
        this.draw();
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  }
}
