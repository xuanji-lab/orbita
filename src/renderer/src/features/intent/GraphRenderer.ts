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
 * - 缩放 / 平移（2026-10-14 用户：「图要能放大缩小，放得越大节点显示的信息越多」）：
 *   滚轮 / 触控板捏合围绕指针缩放、拖空白平移、双击空白复位，范围 0.6–4×；**只改视图
 *   变换**（基础映射 ⊕ 视图变换合成一个 Mapping），不碰布局坐标、不碰缓存、不触发模拟；
 *   每个视图各记一份。语义缩放：节点形状随倍率放大，文字不放大，按屏幕倍率分三档显示
 *   轮号 / 短标题 / 分数与联系 / 簇全名，只给可见区域内的节点上标签。
 */

import {
  ALPHA_DECAY,
  DEFAULT_COLOR_WEIGHT,
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
  type GraphColorWeight,
  type LayoutSeed,
  type LeafNode,
  type SimLink,
  type SimNode,
} from "./cluster-layout.ts";
import {
  IDENTITY_VIEW,
  baseMapping,
  clipText,
  composeMapping,
  labelTier,
  panBy,
  wheelFactor,
  zoomAround,
  type LabelTier,
  type Mapping,
  type ViewTransform,
} from "./graph-view.ts";

/** 三档百分比 → 用量格同款 color-mix（nebula 色带）。 */
export function nebulaFill(percent: number): string {
  return `color-mix(in srgb, var(--color-nebula) ${percent}%, transparent)`;
}

/** 数据 → 场景的构建闭包：渲染器决定布局空间尺寸与种子，调用方只管装配。 */
export type SceneBuilder = (W: number, H: number, seed: LayoutSeed | undefined) => ClusterScene | null;

export interface GraphStyle {
  /** 着色权重：0 = 时间，1 = 相关度 */
  colorWeight: GraphColorWeight;
  selKey: string | null;
  /** 悬停条目行时点亮对应节点（只点亮，不选中、不展开） */
  hoverKey: string | null;
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

/** 叶子短标题 / 一句联系的截断长度（语义缩放） */
const TITLE_CHARS = 12;
const DETAIL_CHARS = 24;
/** 标签只给可见区域内（外扩这么多 px）的节点 */
const LABEL_MARGIN = 24;

/** 一份坐标缓存：布局空间尺寸 + 各节点在该空间里的坐标。 */
interface CachedLayout {
  w: number;
  h: number;
  pos: Map<string, { x: number; y: number }>;
}

interface NodeHandle {
  root: SVGElement;
  /** 形状组：随倍率 scale(z)（命中圆、光晕、核） */
  shape: SVGElement;
  /** 文字组：不随倍率缩放，位置按屏幕倍率重算 */
  labels: SVGElement;
  core?: SVGElement;
  halo?: SVGElement;
  /** 文字组当前按哪一档构建（变档才重建文字） */
  tier: LabelTier | -1;
  /** 选中态要显轮号（和档位无关） */
  selected: boolean;
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
  /** 基础映射（布局空间 → 面板，等比居中）；绘制用的是它 ⊕ 视图变换 */
  private base: Mapping = { k: 1, ox: 0, oy: 0 };
  private mapping: Mapping = { k: 1, ox: 0, oy: 0 };
  /** 当前视图的缩放 / 平移；各视图各一份 */
  private viewTf: ViewTransform = IDENTITY_VIEW;
  private readonly viewTfs = new Map<string, ViewTransform>();
  /** 视图变换变了（倍率 / 平移）的回调：React 侧刷新按钮态 */
  private onViewChange: ((view: ViewTransform) => void) | null = null;
  private style: GraphStyle = { colorWeight: DEFAULT_COLOR_WEIGHT, selKey: null, hoverKey: null, activeRound: null, activeTurnId: null };
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
    // 平移 / 缩放挂在 svg 上：节点层的 pointerdown 已 stopPropagation，拖节点不会同时平移
    svg.addEventListener("pointerdown", this.onPanStart);
    svg.addEventListener("wheel", this.onWheel, { passive: false });
    svg.addEventListener("dblclick", this.onDoubleClick);
    window.addEventListener("blur", this.onInactive);
    window.addEventListener("focus", this.onActive);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  dispose(): void {
    this.disposed = true;
    this.stopLoop();
    this.endDrag(null);
    this.gNodes.removeEventListener("pointerdown", this.onPointerDown);
    this.svg.removeEventListener("pointerdown", this.onPanStart);
    this.svg.removeEventListener("wheel", this.onWheel);
    this.svg.removeEventListener("dblclick", this.onDoubleClick);
    this.endPan();
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
    this.viewTf = this.viewTfs.get(view) ?? IDENTITY_VIEW;
    this.base = baseMapping(scene, this.viewport);
    this.mapping = composeMapping(this.base, this.viewTf);
    this.onViewChange?.(this.viewTf);
    this.buildDom(scene);
    this.applyStyle();
    this.refreshLabels();
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
    this.refreshLabels();
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
    this.base = baseMapping(this.scene, this.viewport);
    this.mapping = composeMapping(this.base, this.viewTf);
    this.draw();
    this.refreshLabels();
  }

  /* ------------------------------------------------ 对外：缩放 / 平移（只改视图变换） */

  /** React 侧订阅视图变换（按钮态）；立刻回一次当前值。 */
  subscribeView(listener: ((view: ViewTransform) => void) | null): void {
    this.onViewChange = listener;
    listener?.(this.viewTf);
  }

  /** 以画布中心为锚放大 / 缩小。 */
  zoomBy(factor: number): void {
    this.setViewTransform(zoomAround(this.viewTf, factor, this.viewport.w / 2, this.viewport.h / 2));
  }

  /** 适配：回到基础映射（全部节点都在画布内）。 */
  fit(): void {
    this.setViewTransform(IDENTITY_VIEW);
  }

  private setViewTransform(next: ViewTransform): void {
    if (this.disposed) return;
    this.viewTf = next;
    if (this.view !== "") this.viewTfs.set(this.view, next);
    this.mapping = composeMapping(this.base, next);
    this.onViewChange?.(next);
    if (this.scene === null) return;
    this.draw();
    this.refreshLabels();
  }

  private pointerInSvg(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.svg.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private onWheel = (event: WheelEvent): void => {
    if (this.scene === null) return;
    event.preventDefault();
    const at = this.pointerInSvg(event);
    this.setViewTransform(zoomAround(this.viewTf, wheelFactor(event.deltaY, event.ctrlKey), at.x, at.y));
  };

  private onDoubleClick = (event: MouseEvent): void => {
    if (this.nodeAt(event.target) !== null) return;
    this.fit();
  };

  private pan: { pointerId: number; last: { x: number; y: number } } | null = null;

  private onPanStart = (event: PointerEvent): void => {
    if (this.scene === null || this.pan !== null || this.drag !== null || event.button !== 0) return;
    if (this.nodeAt(event.target) !== null) return;
    event.preventDefault();
    this.pan = { pointerId: event.pointerId, last: { x: event.clientX, y: event.clientY } };
    this.svg.setPointerCapture(event.pointerId);
    this.svg.addEventListener("pointermove", this.onPanMove);
    this.svg.addEventListener("pointerup", this.onPanEnd);
    this.svg.addEventListener("pointercancel", this.onPanEnd);
    this.svg.classList.add("panning");
  };

  private onPanMove = (event: PointerEvent): void => {
    const pan = this.pan;
    if (pan === null || event.pointerId !== pan.pointerId) return;
    const dx = event.clientX - pan.last.x;
    const dy = event.clientY - pan.last.y;
    pan.last = { x: event.clientX, y: event.clientY };
    this.setViewTransform(panBy(this.viewTf, dx, dy));
  };

  private onPanEnd = (event: PointerEvent): void => {
    if (this.pan === null || event.pointerId !== this.pan.pointerId) return;
    this.endPan();
  };

  private endPan(): void {
    const pan = this.pan;
    if (pan === null) return;
    this.pan = null;
    this.svg.removeEventListener("pointermove", this.onPanMove);
    this.svg.removeEventListener("pointerup", this.onPanEnd);
    this.svg.removeEventListener("pointercancel", this.onPanEnd);
    this.svg.classList.remove("panning");
    if (this.svg.hasPointerCapture(pan.pointerId)) this.svg.releasePointerCapture(pan.pointerId);
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
    const m = baseMapping(cached, space);
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
      // 每个节点：root（只平移）→ shape（随倍率 scale）+ labels（不缩放，位置按屏幕倍率算）
      const shape = el("g", { class: "ishape" });
      const labels = el("g", { class: "ilabels" });
      if (node.kind === "hub") {
        const root = el("g", { class: `ihubg${node.sub ? " sub" : ""}`, "data-node": node.id });
        shape.append(hit, el("circle", { class: "ihub", r: node.r }));
        root.append(shape, labels);
        nodes.push(root);
        this.handles.set(node, { root, shape, labels, tier: -1, selected: false });
      } else if (node.kind === "leaf") {
        const root = el("g", { class: "ileaf", "data-node": node.id });
        const halo = el("circle", { class: "ileaf-halo", r: node.r + 4 });
        const core = el("circle", { class: "ileaf-core", r: node.r });
        shape.append(hit, halo, core);
        root.append(shape, labels);
        nodes.push(root);
        this.handles.set(node, { root, shape, labels, core, halo, tier: -1, selected: false });
      } else {
        const root = el("g", { class: `isoma${node.past ? " past" : ""}`, "data-node": node.id });
        shape.append(
          hit,
          el("circle", { class: "imembrane", r: node.r + 4 }),
          el("circle", { class: "isoma-core", r: node.r }),
        );
        root.append(shape, labels);
        nodes.push(root);
        this.handles.set(node, { root, shape, labels, tier: -1, selected: false });
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

  /**
   * 语义缩放：按屏幕倍率（合成映射的 k）定档，重建 / 定位每个节点的文字组，形状组
   * 按倍率 scale。只给可见区域内的节点上标签。文字不随倍率放大。
   */
  private refreshLabels(): void {
    const scene = this.scene;
    if (scene === null) return;
    const { k, ox, oy } = this.mapping;
    // 形状倍率：相对基础映射的放大倍数（基础映射本身已把布局空间贴合到面板）
    const z = this.base.k > 0 ? k / this.base.k : 1;
    const tier = labelTier(k, scene.dense);
    const scaleAttr = `scale(${z.toFixed(3)})`;
    for (const node of scene.nodes) {
      const handle = this.handles.get(node);
      if (handle === undefined) continue;
      handle.shape.setAttribute("transform", scaleAttr);
      const sx = ox + node.x * k;
      const sy = oy + node.y * k;
      const visible =
        sx >= -LABEL_MARGIN && sx <= this.viewport.w + LABEL_MARGIN && sy >= -LABEL_MARGIN && sy <= this.viewport.h + LABEL_MARGIN;
      if (!visible) {
        handle.labels.setAttribute("display", "none");
        continue;
      }
      handle.labels.removeAttribute("display");
      const rz = node.r * z;
      if (handle.tier !== tier) {
        handle.tier = tier;
        handle.labels.replaceChildren(...this.labelsFor(node, tier, handle.selected));
      }
      // 位置：围着放大后的形状摆（上方的簇名、右上的轮号、下方的标题 / 详情）
      for (const text of handle.labels.children) {
        const role = text.getAttribute("data-role");
        if (role === "hub") text.setAttribute("y", String(-rz - 5));
        else if (role === "soma") text.setAttribute("y", String(rz + 13));
        else if (role === "round") {
          text.setAttribute("x", String(rz + 3));
          text.setAttribute("y", String(-rz + 1));
        } else if (role === "title") text.setAttribute("y", String(rz + 11));
        else if (role === "detail") text.setAttribute("y", String(rz + 22));
      }
    }
  }

  /** 一个节点在某一档要显示哪些文字（内容；位置由 refreshLabels 定）。 */
  private labelsFor(node: SimNode, tier: LabelTier, selected: boolean): SVGElement[] {
    const out: SVGElement[] = [];
    if (node.kind === "hub") {
      const text = tier >= 2 ? node.fullLabel : node.label;
      if (text !== "") {
        const label = el("text", { class: "ihub-label", "text-anchor": "middle", "data-role": "hub" });
        label.textContent = text;
        out.push(label);
      }
    } else if (node.kind === "soma") {
      if (node.label !== "") {
        const label = el("text", { class: "isoma-label", "text-anchor": "middle", "data-role": "soma" });
        label.textContent = node.label;
        out.push(label);
      }
    } else {
      const dense = this.scene?.dense === true;
      // 轮号：选中的总是显；常规倍率下只给大节点（密集时不标）；放大后每片叶都标
      if (selected || tier >= 1 || (!dense && node.r >= 4.5)) {
        const round = el("text", { class: "ileaf-round", "data-role": "round" });
        round.textContent = String(node.leaf.lastRound);
        out.push(round);
      }
      if (tier >= 1) {
        const title = el("text", { class: "ileaf-title", "text-anchor": "middle", "data-role": "title" });
        title.textContent = clipText(node.leaf.title, TITLE_CHARS);
        out.push(title);
      }
      if (tier >= 2) {
        const detail = el("text", { class: "ileaf-detail", "text-anchor": "middle", "data-role": "detail" });
        detail.textContent = `${node.leaf.score.toFixed(2)} · ${clipText(node.leaf.edited ?? node.leaf.connection, DETAIL_CHARS)}`;
        out.push(detail);
      }
    }
    return out;
  }

  /** 上色 + 高亮：fill / stroke / class / 轮号文字。坐标绝不动。 */
  private applyStyle(): void {
    const scene = this.scene;
    if (scene === null) return;
    const { colorWeight, selKey, hoverKey, activeRound, activeTurnId } = this.style;
    const leaves = scene.nodes.filter((node): node is LeafNode => node.kind === "leaf");
    const range = leafRange(leaves.map((node) => node.leaf));
    const inRound = (rounds: readonly number[]): boolean => activeRound === null || rounds.includes(activeRound);
    for (const node of leaves) {
      const handle = this.handles.get(node);
      if (handle?.core === undefined) continue;
      const color = nebulaFill(nebulaPercentOf(colorWeight, node.leaf, range));
      const selected = selKey === node.rowKey;
      const cls = [
        "ileaf",
        node.leaf.solid ? "" : "mid",
        node.shared ? "shared" : "",
        inRound(node.leaf.rounds) ? "" : "dim",
        node.leaf.verdict === "yes" ? "yes" : "",
        selected ? "sel" : "",
        !selected && hoverKey === node.rowKey ? "hov" : "",
      ]
        .filter(Boolean)
        .join(" ");
      handle.root.setAttribute("class", cls);
      handle.core.setAttribute("fill", node.leaf.solid ? color : "var(--color-bg-panel)");
      // 选中 / 共享 / 确认过的描边走 CSS；内联 nebula 描边只给普通叶
      if (selected || node.shared || node.leaf.verdict === "yes") handle.core.removeAttribute("stroke");
      else handle.core.setAttribute("stroke", color);
      handle.halo?.setAttribute("fill", color);
      // 轮号 / 标题由语义缩放的文字组负责；选中态变了就让它在下一次 refreshLabels 重建
      if (handle.selected !== selected) {
        handle.selected = selected;
        handle.tier = -1;
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
    // 落定后按最终位置重算哪些节点在可见区域内（动画中只随节点平移，不逐帧算）
    this.refreshLabels();
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
