/**
 * 意图簇图的指令式渲染器 —— **拥有** svg 的全部子节点、模拟循环、拖拽与各视图的
 * 坐标缓存；React 只持有 svg ref 与三条 effect（数据 → setData、样式 → setStyle、
 * 尺寸 → resize）。
 *
 * 2026-10-14 诊断定下的所有权（之前三方都在模拟、都在存坐标，谁也不清理谁）：
 * - 渲染器**只创建一次**，生命周期绑 svg 元素；回调经 ref 取最新值（以前 effect
 *   依赖一个每次渲染都变的内联箭头，面板每渲染一次就换一个渲染器实例，旧实例的
 *   DOM 留在 svg 里 —— 这就是「冻住」「影分身」「hover 不亮」「拖不动」的共同根因）。
 * - `dispose()` 清空 svg；`setData` 整体替换场景，不残留。
 * - cluster-layout 只产生结构；**模拟只在这里跑**：首次 alpha=1 逐帧落定；新一轮
 *   到达（部分节点有种子）从 alpha=0.2 起小幅长出；切回视图（全部有种子）不加热，
 *   直接恢复上次收敛的坐标；颜色 / 选中 / 高亮只改样式。
 * - 模拟在**布局空间**（构建时的面板尺寸）里跑，绘制时等比映射到当前尺寸并居中——
 *   面板变宽变高只缩放，不压扁、不重排。
 * - 所有节点可拖（事件委托在节点层，透明命中圆 ≥10px，pointer capture）；拖动中
 *   复热，松手弹回再收敛；位移 <4px 算点击（叶子 → 滚到条目行）。
 * - 窗口失焦暂停 rAF（Electron 失焦不触发 visibilitychange，同时听 blur/focus）；
 *   `prefers-reduced-motion` 直接给收敛结果。
 */

import {
  ALPHA_DECAY,
  CONVERGED_ALPHA,
  GROW_ALPHA,
  leafRange,
  nebulaPercentOf,
  parentLinks,
  pathToRoot,
  sceneSeed,
  spineLeaves,
  simulateToConvergence,
  tick,
  unseededCount,
  type ClusterScene,
  type GraphColorMode,
  type LayoutSeed,
  type LeafNode,
  type SimLink,
  type SimNode,
} from "./cluster-layout.ts";

/** 三档百分比 → 用量格同款 color-mix（nebula 色带）。 */
export function nebulaFill(percent: number): string {
  return `color-mix(in srgb, var(--color-nebula) ${percent}%, transparent)`;
}

/** 数据 → 场景的构建闭包：渲染器决定布局空间尺寸与种子，调用方只管装配。 */
export type SceneBuilder = (W: number, H: number, seed: LayoutSeed | undefined) => ClusterScene | null;

export interface GraphStyle {
  colorMode: GraphColorMode;
  selKey: string | null;
  activeRound: number | null;
  activeTurnId: string | null;
}

/** 位移小于它算点击，不算拖拽 */
const CLICK_SLOP = 4;
/** 命中圆最小半径 */
const HIT_RADIUS = 10;
/** 没量到尺寸时的布局空间（面板首帧 0×0 时兜底；量到后 resize 会等比映射） */
const FALLBACK_SIZE = { w: 380, h: 340 };

const SVG_NS = "http://www.w3.org/2000/svg";

function el(tag: string, attrs: Record<string, string | number>): SVGElement {
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

/** 布局空间 → 屏幕的等比映射（短边贴合、居中）。 */
interface Mapping {
  k: number;
  ox: number;
  oy: number;
}

function mappingOf(space: { w: number; h: number }, view: { w: number; h: number }): Mapping {
  const k = Math.min(view.w / space.w, view.h / space.h);
  return { k, ox: (view.w - space.w * k) / 2, oy: (view.h - space.h * k) / 2 };
}

/** 一份坐标缓存：布局空间尺寸 + 各节点在该空间里的坐标。 */
interface CachedLayout {
  w: number;
  h: number;
  pos: Map<string, { x: number; y: number }>;
}

interface NodeHandle {
  root: SVGElement;
  core?: SVGElement;
  halo?: SVGElement;
  round?: SVGElement;
}

export class GraphRenderer {
  private readonly svg: SVGSVGElement;
  private readonly gLinks: SVGGElement;
  private readonly gBridges: SVGGElement;
  private readonly gNodes: SVGGElement;
  private readonly onSelectLeaf: (rowKey: string) => void;
  /** 节点 id → DOM 句柄（位置更新只动 transform，不重建结构） */
  private readonly handles = new Map<SimNode, NodeHandle>();
  private readonly linkEls: { path: SVGPathElement; link: SimLink; a: SimNode; b: SimNode; leafEnd: LeafNode | null; styled: boolean }[] = [];
  /** 各视图上次收敛 / 离开时的坐标 */
  private readonly cache = new Map<string, CachedLayout>();
  private scene: ClusterScene | null = null;
  private view = "";
  private viewport = { w: 0, h: 0 };
  private mapping: Mapping = { k: 1, ox: 0, oy: 0 };
  private style: GraphStyle = { colorMode: "time", selKey: null, activeRound: null, activeTurnId: null };
  /** 尺寸还没量到时先存着的数据（量到后立刻构建） */
  private pending: { view: string; build: SceneBuilder } | null = null;
  private frame = 0;
  private running = false;
  private alpha = 0;
  private disposed = false;

  constructor(svg: SVGSVGElement, onSelectLeaf: (rowKey: string) => void) {
    this.svg = svg;
    this.onSelectLeaf = onSelectLeaf;
    this.gLinks = el("g", { class: "ig-links" }) as SVGGElement;
    this.gBridges = el("g", { class: "ig-bridges" }) as SVGGElement;
    this.gNodes = el("g", { class: "ig-nodes" }) as SVGGElement;
    // 接管全部子节点：上一个实例若没清干净，这里一并清掉
    svg.replaceChildren(this.gLinks, this.gBridges, this.gNodes);
    this.gNodes.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("blur", this.onInactive);
    window.addEventListener("focus", this.onActive);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  dispose(): void {
    this.disposed = true;
    this.stopLoop();
    this.endDrag(null);
    this.gNodes.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("blur", this.onInactive);
    window.removeEventListener("focus", this.onActive);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.svg.replaceChildren();
    this.handles.clear();
    this.linkEls.length = 0;
    this.scene = null;
  }

  /* ------------------------------------------------ 对外：数据 / 样式 / 尺寸 */

  /**
   * 数据或视图变了：把当前场景的实时坐标存进它所属视图的缓存，然后用新视图的
   * 缓存做种子构建新场景并**整体替换** DOM。加热程度由「有多少节点没种子」决定。
   * build 为 null = 清空。
   */
  setData(view: string, build: SceneBuilder | null): void {
    if (this.disposed) return;
    // 同一视图在落定动画中途被重建（例如只有轮号变了、节点 id 一个没变）：
    // 种子是半路坐标，必须把动画接着跑完，否则图就冻在半路
    const carry = this.running && this.view === view ? Math.max(this.alpha, GROW_ALPHA) : 0;
    this.rememberCurrent();
    this.stopLoop();
    this.endDrag(null);
    if (build === null) {
      this.pending = null;
      this.clearScene();
      return;
    }
    if (this.viewport.w <= 0 || this.viewport.h <= 0) {
      // 还没量到尺寸：先画在兜底空间里，resize 到来时等比映射，不会跳
      this.viewport = { ...FALLBACK_SIZE };
    }
    const space = { w: this.viewport.w, h: this.viewport.h };
    const seed = this.seedFor(view, space);
    const scene = build(space.w, space.h, seed);
    this.pending = null;
    if (scene === null) {
      this.clearScene();
      return;
    }
    this.view = view;
    this.scene = scene;
    this.mapping = mappingOf(scene, this.viewport);
    this.buildDom(scene);
    this.applyStyle();
    const fresh = unseededCount(scene, seed);
    if (fresh === 0 && carry === 0) {
      // 切回视图：全部节点都有上次收敛的坐标，不加热
      this.draw();
      return;
    }
    this.start(fresh === scene.nodes.length ? 1 : Math.max(carry, GROW_ALPHA));
  }

  /** 颜色模式 / 选中 / 高亮轮：只改样式，坐标绝不动。 */
  setStyle(style: GraphStyle): void {
    this.style = style;
    this.applyStyle();
  }

  /** 面板尺寸变了：换映射重画（布局空间不变，等比缩放并居中）。 */
  resize(w: number, h: number): void {
    if (this.disposed || w <= 0 || h <= 0) return;
    if (this.viewport.w === w && this.viewport.h === h) return;
    this.viewport = { w, h };
    if (this.pending !== null) {
      const { view, build } = this.pending;
      this.setData(view, build);
      return;
    }
    if (this.scene === null) return;
    this.mapping = mappingOf(this.scene, this.viewport);
    this.draw();
  }

  /* ------------------------------------------------ 缓存 */

  private rememberCurrent(): void {
    if (this.scene === null || this.view === "") return;
    this.cache.set(this.view, { w: this.scene.w, h: this.scene.h, pos: sceneSeed(this.scene) });
  }

  /** 该视图的缓存坐标映射到新的布局空间（等比 + 居中），作为种子。 */
  private seedFor(view: string, space: { w: number; h: number }): LayoutSeed | undefined {
    const cached = this.cache.get(view);
    if (cached === undefined) return undefined;
    if (cached.w === space.w && cached.h === space.h) return cached.pos;
    const m = mappingOf(cached, space);
    const out = new Map<string, { x: number; y: number }>();
    for (const [id, at] of cached.pos) out.set(id, { x: m.ox + at.x * m.k, y: m.oy + at.y * m.k });
    return out;
  }

  /* ------------------------------------------------ DOM */

  private clearScene(): void {
    this.scene = null;
    this.view = "";
    this.handles.clear();
    this.linkEls.length = 0;
    this.gLinks.replaceChildren();
    this.gBridges.replaceChildren();
    this.gNodes.replaceChildren();
  }

  private buildDom(scene: ClusterScene): void {
    this.handles.clear();
    this.linkEls.length = 0;
    const links: SVGElement[] = [];
    const bridges: SVGElement[] = [];
    const nodes: SVGElement[] = [];
    for (const link of scene.links) {
      const isBridge = link.bridge === true || link.ego === true;
      const path = el("path", {
        class: link.bridge === true ? "ibridge" : link.ego === true ? `ibridge ego${link.dim === true ? " dim" : ""}` : "ibr",
        fill: "none",
        // 跨岗桥的粗细与透明度走 CSS（.ibridge 雾态 / .ibridge.lit 追溯态），这里不写内联
        // 岗位粗枝的粗细 = 该岗累积相关度，但封顶 1.8px：再粗就和主干（2.2px 墨色）混了
        ...(isBridge ? {} : { "stroke-width": Math.min(link.w ?? 1, 1.8), "stroke-opacity": link.op ?? 0.5 }),
      }) as SVGPathElement;
      (isBridge ? bridges : links).push(path);
      const leafEnd = link.b.kind === "leaf" ? link.b : null;
      this.linkEls.push({ path, link, a: link.a, b: link.b, leafEnd, styled: !isBridge });
    }
    for (const node of scene.nodes) {
      const hit = el("circle", { class: "ihit", r: Math.max(node.r + 6, HIT_RADIUS) });
      if (node.kind === "hub") {
        const root = el("g", { class: `ihubg${node.sub ? " sub" : ""}`, "data-node": node.id });
        root.append(hit, el("circle", { class: "ihub", r: node.r }));
        if (node.label !== "") {
          const label = el("text", { class: "ihub-label", "text-anchor": "middle", y: -node.r - 5 });
          label.textContent = node.label;
          root.append(label);
        }
        nodes.push(root);
        this.handles.set(node, { root });
      } else if (node.kind === "leaf") {
        const root = el("g", { class: "ileaf", "data-node": node.id });
        const halo = el("circle", { class: "ileaf-halo", r: node.r + 4 });
        const core = el("circle", { class: "ileaf-core", r: node.r });
        root.append(hit, halo, core);
        nodes.push(root);
        this.handles.set(node, { root, core, halo });
      } else {
        const root = el("g", { class: `isoma${node.past ? " past" : ""}`, "data-node": node.id });
        root.append(
          hit,
          el("circle", { class: "imembrane", r: node.r + 4 }),
          el("circle", { class: "isoma-core", r: node.r }),
        );
        if (node.label !== "") {
          const label = el("text", { class: "isoma-label", "text-anchor": "middle", y: node.r + 13 });
          label.textContent = node.label;
          root.append(label);
        }
        nodes.push(root);
        this.handles.set(node, { root });
      }
    }
    this.gLinks.replaceChildren(...links);
    this.gBridges.replaceChildren(...bridges);
    this.gNodes.replaceChildren(...nodes);
  }

  /** 把所有坐标写进 DOM（布局空间 → 屏幕；结构与上色不动）。 */
  private draw(): void {
    const scene = this.scene;
    if (scene === null) return;
    const { k, ox, oy } = this.mapping;
    for (const node of scene.nodes) {
      const handle = this.handles.get(node);
      handle?.root.setAttribute("transform", `translate(${(ox + node.x * k).toFixed(1)},${(oy + node.y * k).toFixed(1)})`);
    }
    for (const link of this.linkEls) {
      link.path.setAttribute(
        "d",
        curveD({ x: ox + link.a.x * k, y: oy + link.a.y * k }, { x: ox + link.b.x * k, y: oy + link.b.y * k }),
      );
    }
  }

  /** 上色 + 高亮：fill / stroke / class / 轮号文字。坐标绝不动。 */
  private applyStyle(): void {
    const scene = this.scene;
    if (scene === null) return;
    const { colorMode, selKey, activeRound, activeTurnId } = this.style;
    const leaves = scene.nodes.filter((node): node is LeafNode => node.kind === "leaf");
    const range = leafRange(leaves.map((node) => node.leaf));
    const inRound = (rounds: readonly number[]): boolean => activeRound === null || rounds.includes(activeRound);
    for (const node of leaves) {
      const handle = this.handles.get(node);
      if (handle?.core === undefined) continue;
      const color = nebulaFill(nebulaPercentOf(colorMode, node.leaf, range));
      const selected = selKey === node.rowKey;
      const cls = [
        "ileaf",
        node.leaf.solid ? "" : "mid",
        node.shared ? "shared" : "",
        inRound(node.leaf.rounds) ? "" : "dim",
        node.leaf.verdict === "yes" ? "yes" : "",
        selected ? "sel" : "",
      ]
        .filter(Boolean)
        .join(" ");
      handle.root.setAttribute("class", cls);
      handle.core.setAttribute("fill", node.leaf.solid ? color : "var(--color-bg-panel)");
      // 选中 / 共享 / 确认过的描边走 CSS；内联 nebula 描边只给普通叶
      if (selected || node.shared || node.leaf.verdict === "yes") handle.core.removeAttribute("stroke");
      else handle.core.setAttribute("stroke", color);
      handle.halo?.setAttribute("fill", color);
      // 轮号：大节点常显（密集时不标），选中的总是显
      const showRound = selected || (!scene.dense && node.r >= 4.5);
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
    for (const node of scene.nodes) {
      if (node.kind !== "soma") continue;
      const handle = this.handles.get(node);
      if (handle === undefined) continue;
      const lit = activeTurnId !== null && node.id === `soma:centre:${activeTurnId}`;
      const dim = activeTurnId !== null && !lit;
      handle.root.setAttribute("class", `isoma${node.past ? " past" : ""}${dim ? " dim" : ""}${lit ? " lit" : ""}`);
    }
    // 跨岗桥平时是「雾」，选中一片叶时它连出去的桥亮起来——同一事件存在几个岗位里，
    // 点一下就能顺着桥追到它在别的岗位的那片叶（2026-10-14 用户：桥没错，要像雾，但要可追溯）
    for (const link of this.linkEls) {
      if (link.styled || !link.path.classList.contains("ibridge") || link.path.classList.contains("ego")) continue;
      const touches = (node: SimNode): boolean => node.kind === "leaf" && (node as LeafNode).rowKey === selKey;
      link.path.setAttribute("class", selKey !== null && (touches(link.a) || touches(link.b)) ? "ibridge lit" : "ibridge");
    }
    for (const link of this.linkEls) {
      if (!link.styled) continue;
      const leaf = link.leafEnd;
      if (leaf === null) continue;
      // 枝一律中性墨色：颜色只给节点（用户：「节点本身用 color gradient」）——枝也上 nebula 色时，
      // 蓝枝、灰粗枝、黑主干三种线混在一起分不清（2026-10-14 真机）。拿不准的叶连同它的枝退淡，
      // 主干自然浮出来。
      link.path.removeAttribute("stroke");
      link.path.setAttribute("class", `ibr${inRound(leaf.leaf.rounds) ? "" : " dim"}${leaf.leaf.solid ? "" : " mid"}`);
    }
    // 主干：相关度最高的几片叶走回本问的那一路边常亮（不管隔几跳）；选中的叶亮出它的那一路
    // （trace，强调色）。class 在上面各自设完之后再叠加，坐标不动。
    const parent = parentLinks(scene);
    const spine = new Set<SimLink>();
    const spineNodes = new Set<SimNode>();
    for (const leaf of spineLeaves(scene, parent)) {
      spineNodes.add(leaf);
      for (const link of pathToRoot(leaf, parent)) spine.add(link);
    }
    const trace = new Set<SimLink>();
    const picked = leaves.find((node) => node.rowKey === selKey);
    if (picked !== undefined) for (const link of pathToRoot(picked, parent)) trace.add(link);
    for (const item of this.linkEls) {
      item.path.classList.toggle("spine", spine.has(item.link));
      item.path.classList.toggle("trace", trace.has(item.link));
    }
    for (const node of leaves) this.handles.get(node)?.root.classList.toggle("spine", spineNodes.has(node));
  }

  /* ------------------------------------------------ 模拟循环 */

  private reducedMotion(): boolean {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  private inactive(): boolean {
    return document.hidden || !document.hasFocus();
  }

  /** 从 alpha 起跑到收敛：逐帧动画；reduced-motion / 窗口不在前台时同步算完直接画
   *  （后台不跑 rAF，但也不能让图停在随机初始位置等焦点回来）。 */
  private start(alpha: number): void {
    const scene = this.scene;
    if (scene === null) return;
    this.alpha = alpha;
    if (this.reducedMotion() || this.inactive()) {
      simulateToConvergence(scene, { alpha });
      this.settle();
      return;
    }
    this.running = true;
    this.loop();
  }

  private loop = (): void => {
    this.frame = 0;
    const scene = this.scene;
    if (!this.running || scene === null) return;
    // 每帧若干轮：落定动画半秒上下走完
    for (let i = 0; i < 8 && this.alpha >= CONVERGED_ALPHA; i += 1) {
      tick(scene.nodes, scene.links, scene.w, scene.h, this.alpha, 8);
      this.alpha *= ALPHA_DECAY;
    }
    this.draw();
    if (this.alpha < CONVERGED_ALPHA) {
      this.settle();
      return;
    }
    this.frame = window.requestAnimationFrame(this.loop);
  };

  /** 收敛：静止，并把坐标写回该视图的缓存。 */
  private settle(): void {
    this.running = false;
    this.alpha = 0;
    this.draw();
    this.rememberCurrent();
  }

  private stopLoop(): void {
    if (this.frame !== 0) window.cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.running = false;
  }

  private onInactive = (): void => {
    if (this.frame !== 0) window.cancelAnimationFrame(this.frame);
    this.frame = 0;
  };

  private onActive = (): void => {
    if (this.running && this.frame === 0 && !this.inactive()) this.loop();
  };

  private onVisibility = (): void => {
    if (document.hidden) this.onInactive();
    else this.onActive();
  };

  /* ------------------------------------------------ 拖拽：事件委托在节点层 */

  private drag: { node: SimNode; pointerId: number; start: { x: number; y: number }; moved: number } | null = null;

  private nodeAt(target: EventTarget | null): SimNode | null {
    if (!(target instanceof Element)) return null;
    const root = target.closest("[data-node]");
    if (root === null) return null;
    const id = root.getAttribute("data-node");
    for (const node of this.handles.keys()) if (node.id === id) return node;
    return null;
  }

  /** 屏幕坐标 → 布局空间坐标 */
  private toSpace(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.svg.getBoundingClientRect();
    const { k, ox, oy } = this.mapping;
    return { x: (clientX - rect.left - ox) / k, y: (clientY - rect.top - oy) / k };
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (this.scene === null || this.drag !== null || event.button !== 0) return;
    const node = this.nodeAt(event.target);
    if (node === null) return;
    event.preventDefault();
    event.stopPropagation();
    this.stopLoop();
    this.drag = { node, pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, moved: 0 };
    node.fixed = true;
    node.vx = 0;
    node.vy = 0;
    this.svg.setPointerCapture(event.pointerId);
    this.svg.addEventListener("pointermove", this.onPointerMove);
    this.svg.addEventListener("pointerup", this.onPointerUp);
    this.svg.addEventListener("pointercancel", this.onPointerUp);
    this.svg.addEventListener("lostpointercapture", this.onPointerUp);
    this.svg.classList.add("dragging");
  };

  private onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    const scene = this.scene;
    if (drag === null || scene === null || event.pointerId !== drag.pointerId) return;
    drag.moved = Math.max(drag.moved, Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y));
    if (drag.moved < CLICK_SLOP) return;
    const at = this.toSpace(event.clientX, event.clientY);
    drag.node.x = Math.max(6, Math.min(scene.w - 6, at.x));
    drag.node.y = Math.max(6, Math.min(scene.h - 6, at.y));
    // 拖动中就地复热到较低热度：周围跟着让位，但不全场乱飞
    for (let i = 0; i < 2; i += 1) tick(scene.nodes, scene.links, scene.w, scene.h, 0.25, 8);
    this.draw();
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.drag === null || event.pointerId !== this.drag.pointerId) return;
    this.endDrag(event);
  };

  /** 松手（或被迫结束）：解除固定；点击 → 选叶；拖过 → 复热弹回再收敛。 */
  private endDrag(event: PointerEvent | null): void {
    const drag = this.drag;
    if (drag === null) return;
    this.drag = null;
    this.svg.removeEventListener("pointermove", this.onPointerMove);
    this.svg.removeEventListener("pointerup", this.onPointerUp);
    this.svg.removeEventListener("pointercancel", this.onPointerUp);
    this.svg.removeEventListener("lostpointercapture", this.onPointerUp);
    this.svg.classList.remove("dragging");
    if (this.svg.hasPointerCapture(drag.pointerId)) this.svg.releasePointerCapture(drag.pointerId);
    drag.node.fixed = false;
    if (event === null || this.scene === null) return;
    if (drag.moved < CLICK_SLOP) {
      if (drag.node.kind === "leaf") this.onSelectLeaf(drag.node.rowKey);
      return;
    }
    this.start(GROW_ALPHA);
  }
}
