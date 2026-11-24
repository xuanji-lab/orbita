import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  drawFrame,
  frameViewport,
  FRAME_EXTENT,
  CAPTURE_MS,
  DUST_CLICK_MAX,
  galaxyBox,
  GALAXY_MAX,
  GALAXY_MAX_FILL,
  LIVE_FRAME_MS,
  layoutGalaxy,
  makeCamera,
  beltFrame,
  capturedIds,
  dustLookOf,
  emptyHintAt,
  motionAllowed,
  orbitArcs,
  truncateLabel,
  AGENT_READABLE_MAX,
  PLANET_READABLE_MAX,
  ROCK_PX,
  type Belt,
  type Camera,
  type GalaxyLayout,
  type GalaxySpec,
  type MotionInputs,
  type OrbitArc,
  type PlanetItem,
  type RockItem,
  type Viewport,
} from "./galaxy.ts";
import {
  R0,
  captureOffsets,
  cssMatrix,
  dustDiskPoint,
  inverseLinear,
  moverFar,
  moversOf,
  msToNextSide,
  orbitMatrix,
  periodMs,
  spinKeyframes,
  type Mover,
} from "./galaxy-motion.ts";
import { useT } from "../../locale.ts";
import { BodyFigure, StarBody } from "../galaxy-designer/StarFigure.tsx";
import { bodyArt, planetFaceDesign, starExtentRatio, starOf, type GalaxyDesign, type PlanetDesign } from "../galaxy-designer/design.ts";
import { fitScreenSafe } from "./screen-safe.ts";
import {
  calloutBudget,
  calloutGeometry,
  calloutRank,
  lockFrame,
  lockFramePath,
  placeCallouts,
  recentFramePath,
  placeNameTags,
  type Box,
  type CalloutDir,
  type CalloutTarget,
} from "./callouts.ts";
import { useGalaxyActions, type GalaxyActions } from "./galaxy-actions.ts";
import { useProtoVariants } from "./proto-variants-store.ts";
import { useGalaxyTilt, useGalaxyTiltSetter, useGalaxyView, type GalaxySurface, type GalaxyViewSetter } from "./galaxy-tilt.ts";
import { anglesForSave, anglesLabel, dragAngles, isDragMove, keyAngles, VIEW_DEFAULT, type ViewAngles } from "./tilt-drag.ts";
import { boxesOverlap, planOverlay } from "./overlay-plan.ts";
import { beltSplit, liveProjection, type FrozenScene, type LiveProjection } from "./turntable.ts";
import { USER_VIEW_DEFAULT, zoomAt, type UserView } from "./galaxy.ts";
import { DENSITY, STAR_DENSITY, eccentricAnomaly, farWindow, orbitFrame, orbitPoint, project, starRadius, type OrbitFrame } from "./galaxy.ts";
import { FAR_MARGIN } from "./galaxy-motion.ts";
import { binaryGeometry, binaryPhase, binaryPositions, type BinaryGeometry } from "./binary.ts";
import { pitDepth, pitSoftening, type Well } from "./gravity.ts";
import { MassCard, ScanGrid, ScanToggle, useScanOn, type CardBody, type ScanFrame } from "./GalaxyScan.tsx";

/** 伴星在 movers 里的 id 前缀（后面接伴星工作区 id）：它不是这座星系的行星，名字 / 命中 / 远近另算 */
export const BINARY_ID = "binary:";

/**
 * 联星的一串轨道矩阵（正圆，主星在原点）：centered = 整座星系跟着本星绕质心走的那一串——中心归零，
 * 链末端对 children 只剩「本星相对质心的位移」，里面照旧按根节点坐标画
 */
function binaryFrame(a: number, camera: Camera, vp: Viewport, centered: boolean): OrbitFrame {
  const frame = orbitFrame(a, 0, 0, camera, vp, 0);
  return centered ? { ...frame, cx: 0, cy: 0 } : frame;
}

/** 碎石块的轮廓：七个顶点、半径按 id 抖一点（同一条会话永远同一块石头），不是圆点——它是会话，不是天体 */
export function rockPath(x: number, y: number, r: number, id: string): string {
  let hash = 2166136261;
  for (const ch of id) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  let d = "";
  for (let i = 0; i < 7; i++) {
    const jitter = 0.72 + (((hash >>> (i * 4)) & 15) / 15) * 0.36;
    const a = (i / 7) * Math.PI * 2;
    d += `${i === 0 ? "M" : "L"}${(x + Math.cos(a) * r * jitter).toFixed(1)} ${(y + Math.sin(a) * r * jitter).toFixed(1)}`;
  }
  return `${d}Z`;
}

/**
 * 画布的真实尺寸（CSS px）：ResizeObserver 量根节点自己的盒子。星系占首页输入框下方剩下的全部空间，
 * 窗口 / 侧栏 / 右栏一变，画布跟着变，坐标与像素一比一。还没量到（首帧）时不画天体，免得先按错误尺寸闪一下。
 */
function useBoxSize(target: RefObject<Element | null>): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = target.current;
    if (el === null) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (rect === undefined) return;
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setSize((prev) => (prev !== null && prev.width === width && prev.height === height ? prev : { width, height }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [target]);
  return size;
}

/**
 * 把一份投影直接写进 DOM（拖动中每帧一次、松手落位时一次）：不经 React，转动层的合成器动画照跑。
 * 写的东西：每串轨道 div 的轨道矩阵与逆矩阵、行星 / 碎石块在主星前 / 后哪一层、碎石带的矩阵与远近分界、
 * 主星的位置与大小（相对 React 画的那一份做变换）、轨道弧的远近两份 path。
 */
function applyProjection(root: HTMLElement, proj: LiveProjection, movers: readonly Mover[], tSec: number, bodyScale = 1): void {
  const byId = new Map(movers.map((mover) => [mover.id, mover]));
  for (const node of root.querySelectorAll<HTMLElement>("[data-orbit]")) {
    const mover = byId.get(node.dataset.orbit ?? "");
    // 联星的两串（GalaxyScan / binary.ts）：不在 proj.planets 里，按 data-binary-a（轨道半径）用新相机现算
    const binaryA = node.dataset.binaryA === undefined ? null : Number(node.dataset.binaryA);
    if (mover === undefined && binaryA === null) continue;
    const frame = binaryA !== null ? binaryFrame(binaryA, proj.camera, proj.viewport, node.dataset.binaryCentered === "true") : mover?.kind === "rock" ? proj.rock : proj.planets.get(mover?.id ?? "");
    if (frame === null || frame === undefined) continue;
    const m = orbitMatrix(frame);
    node.style.transform = cssMatrix(m);
    const inv = node.querySelector<HTMLElement>("[data-orbit-inv]");
    // 缩放中天体本身也跟着放大缩小（行星在 far / near 两层；名字、锁定框那一层不放大字）
    const grow = bodyScale !== 1 && node.dataset.layer !== "top" && node.dataset.binaryCentered !== "true" ? ` scale(${bodyScale.toFixed(4)})` : "";
    if (inv !== null) inv.style.transform = cssMatrix(inverseLinear(m)) + grow;
  }
  // 远近分层每帧按新相机算：主星永远画在它挡住的天体前面
  const far = new Map<string, boolean>();
  for (const mover of movers) far.set(mover.id, moverFar({ ...mover, far: mover.id.startsWith(BINARY_ID) ? farWindow(0, proj.camera.azimuth, FAR_MARGIN) : proj.far }, tSec));
  for (const node of root.querySelectorAll<HTMLElement>("[data-body]")) {
    const isFar = far.get(node.dataset.body ?? "");
    if (isFar === undefined) continue;
    node.style.visibility = (node.dataset.layer === "far") === isFar ? "" : "hidden";
  }
  if (proj.belt !== null) {
    for (const node of root.querySelectorAll<HTMLElement>("[data-belt-outer]")) applyBelt(node, cssMatrix(orbitMatrix(proj.belt.frame)), proj.belt.chiDeg, proj.belt.offset);
  }
  for (const node of root.querySelectorAll<SVGGElement>("[data-star-wrap]")) {
    const x0 = Number(node.dataset.x);
    const y0 = Number(node.dataset.y);
    const r0 = Number(node.dataset.r);
    node.style.transform = starTransform(proj.star, x0, y0, r0);
  }
  const arcs = new Map(proj.arcs.map((arc) => [arc.key, arc]));
  for (const node of root.querySelectorAll<SVGPathElement>("path[data-arc]")) {
    const arc = arcs.get(node.dataset.arc ?? "");
    const back = node.dataset.plane === "back";
    const d = arc === undefined ? "" : (arc.depth > proj.star.depth) === back ? arc.d : "";
    if (node.getAttribute("d") !== d) node.setAttribute("d", d);
  }
}

/** 主星相对 React 画的那一份（中心 x0, y0、半径 r0）挪到 (x, y)、缩到 r：SVG 用户坐标里的变换（transform-origin 0 0） */
function starTransform(star: { x: number; y: number; r: number }, x0: number, y0: number, r0: number): string {
  const k = r0 > 0 ? star.r / r0 : 1;
  if (Math.abs(star.x - x0) < 1e-3 && Math.abs(star.y - y0) < 1e-3 && Math.abs(k - 1) < 1e-6) return "";
  return `translate(${star.x.toFixed(2)}px, ${star.y.toFixed(2)}px) scale(${k.toFixed(5)}) translate(${(-x0).toFixed(2)}px, ${(-y0).toFixed(2)}px)`;
}

/** 碎石带半平面裁切框（转动层坐标、转过 χ 之后）：远侧 v < −offset，近侧 v > −offset */
function beltBox(side: "far" | "near", L: number, offset: number): { left: number; top: number; width: number; height: number } {
  return side === "far" ? { left: -L, top: -L, width: 2 * L, height: Math.max(0, L - offset) } : { left: -L, top: -offset, width: 2 * L, height: Math.max(0, L + offset) };
}

function applyBelt(outer: HTMLElement, matrix: string, chiDeg: number, offset: number): void {
  outer.style.transform = matrix;
  const rot = outer.querySelector<HTMLElement>("[data-belt-rot]");
  const half = outer.querySelector<HTMLElement>("[data-belt-half]");
  const back = outer.querySelector<HTMLElement>("[data-belt-back]");
  const unrot = outer.querySelector<HTMLElement>("[data-belt-unrot]");
  if (rot === null || half === null || back === null || unrot === null) return;
  rot.style.transform = `rotate(${chiDeg.toFixed(3)}deg)`;
  unrot.style.transform = `rotate(${(-chiDeg).toFixed(3)}deg)`;
  const box = beltBox(half.dataset.beltHalf === "far" ? "far" : "near", Number(half.dataset.l), offset);
  half.style.left = `${box.left}px`;
  half.style.top = `${box.top}px`;
  half.style.width = `${box.width}px`;
  half.style.height = `${box.height}px`;
  back.style.left = `${-box.left}px`;
  back.style.top = `${-box.top}px`;
}

/** 落位过渡的时长（ms，= 设计系统 --duration-fast）：松手后按新角度跑完屏幕安全布局，从拖动时的样子滑到合规的位置 */
const SETTLE_MS = 160;

/** 画面此刻对应的布局与角度（拖动按下时冻结这一份） */
interface SceneNow extends FrozenScene {
  elevation: number;
  azimuth: number;
  /** 这一份布局用的缩放与平移（scene.viewport 已经套过它） */
  view: UserView;
}

/**
 * 星系空白处拖动 = 转台（规则在 tilt-drag.ts，投影在 turntable.ts）：
 * - 按下不拦：位移 ≤ 4px 是点击，点天体照旧打开；超过才算拖、抓住指针，松手后吞掉那一下 click。
 * - 拖动中冻结布局、每帧（requestAnimationFrame 合并指针事件）只重新投影，直接写 DOM；不 setState、不跑屏幕安全布局。
 * - 松手按 1° 写设置（倾角与设置 › 外观的滑块同一个字段，方位角另一个字段）；设置回填后 React 按新角度跑一次屏幕安全布局，
 *   布局与视角无关，拖动最后一帧就是落位后的样子：不过渡；方向键 / 双击复位这种一下跳过去的才挂 gx-settling，SETTLE_MS 内滑过去
 *   （减少动效时不挂）。
 * - 键盘：焦点在星系根节点上时 ↑ ↓ 改俯角、← → 改方位，每次 5°；双击空白处回到默认 40° · 0°。
 */
interface TurntableOptions {
  root: RefObject<HTMLDivElement | null>;
  commit: GalaxyViewSetter | null;
  setting: ViewAngles;
  turntable: boolean;
  scene: MutableRefObject<SceneNow | null>;
  movers: MutableRefObject<readonly Mover[]>;
  clock: GalaxyClock;
  live: MutableRefObject<LiveProjection | null>;
  /** 拖动中让名字 / 锁定框的排布按新相机重算一次 */
  replan: () => void;
  badge: RefObject<HTMLSpanElement | null>;
  /** 这一刻的布局对象（scene 的 useMemo）：落位只在它换了之后做 */
  sceneId: object | null;
  /** 用户缩放与平移（本组件的）与改它的入口 */
  zoomView: UserView;
  setZoomView: (view: UserView) => void;
  /** 普通滚轮也缩放（编排页、右栏）；false = 只认双指捏合 / ⌘ / Ctrl + 滚轮（单智能体首页：普通滚轮留给页面滚动） */
  plainWheelZooms: boolean;
}

type TurntableGesture = { pointerId: number; x: number; y: number; start: ViewAngles; active: boolean; frozen: SceneNow | null };

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function useTurntable(options: TurntableOptions) {
  const opts = useRef(options);
  opts.current = options;
  const gesture = useRef<TurntableGesture | null>(null);
  const latest = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const view = useRef<ViewAngles | null>(null);
  const raf = useRef<number | null>(null);
  const swallowClick = useRef(false);
  const lastReplan = useRef(0);
  // 落位等的那一份布局：设置 / 缩放回填后 scene 换了才落位（期间别的重渲染不算）
  const settlePending = useRef<object | null | false>(false);
  const wheel = useRef<{ frozen: SceneNow; start: UserView; view: UserView; timer: number | null } | null>(null);
  const wheelRaf = useRef<number | null>(null);
  const lastStar = useRef<{ x: number; y: number; r: number } | null>(null);
  const timers = useRef<{ badge: number | null; settle: number | null }>({ badge: null, settle: null });

  const showBadge = (text: string, raised: string | null, hold: boolean): void => {
    const badge = opts.current.badge.current;
    if (badge === null) return;
    const value = badge.querySelector<HTMLElement>(".galaxy-tilt-value");
    const note = badge.querySelector<HTMLElement>(".galaxy-tilt-raised");
    if (value !== null) value.textContent = text;
    if (note !== null) {
      note.textContent = raised ?? "";
      note.hidden = raised === null;
    }
    badge.dataset.show = "true";
    if (timers.current.badge !== null) window.clearTimeout(timers.current.badge);
    timers.current.badge = hold ? null : window.setTimeout(() => delete badge.dataset.show, 1400);
  };

  const frame = (): void => {
    raf.current = null;
    const g = gesture.current;
    const root = opts.current.root.current;
    if (g === null || !g.active || g.frozen === null || root === null) return;
    const next = dragAngles(g.start, latest.current.dx, latest.current.dy, opts.current.turntable);
    view.current = next;
    const proj = liveProjection(g.frozen, next.tilt, next.azimuth);
    opts.current.live.current = proj;
    lastStar.current = proj.star;
    applyProjection(root, proj, opts.current.movers.current, opts.current.clock.now() / 1000);
    showBadge(anglesLabel(next, opts.current.zoomView.zoom), null, true);
    const now = performance.now();
    if (now - lastReplan.current > LIVE_FRAME_MS) {
      lastReplan.current = now;
      opts.current.replan();
    }
  };

  /** 落位：按 scene（新角度跑完屏幕安全布局的那一份）把拖动时直接写过的 DOM 全部写回合规的值，带短过渡 */
  // 布局与视角分离之后，拖动 / 滚轮松手时布局不变、拖动最后一帧就是落位后的样子：不过渡。只有方向键 / 双击复位这种一下跳过去的才过渡
  const settleAnimate = useRef(false);
  const settle = (scene: SceneNow, animateJump = settleAnimate.current): void => {
    const root = opts.current.root.current;
    opts.current.live.current = null;
    if (root === null) return;
    const animate = animateJump && !reducedMotion();
    const star = lastStar.current;
    if (animate && star !== null) {
      // 主星：React 已经按新布局画在新位置上，先挪回拖动时最后那一帧的样子，再滑过去
      for (const node of root.querySelectorAll<SVGGElement>("[data-star-wrap]")) {
        node.style.transition = "none";
        node.style.transform = starTransform(star, Number(node.dataset.x), Number(node.dataset.y), Number(node.dataset.r));
      }
      root.getBoundingClientRect();
      for (const node of root.querySelectorAll<SVGGElement>("[data-star-wrap]")) node.style.transition = "";
    }
    if (animate) root.classList.add("gx-settling");
    applyProjection(root, liveProjection(scene, scene.elevation, scene.azimuth), opts.current.movers.current, opts.current.clock.now() / 1000);
    lastStar.current = null;
    if (timers.current.settle !== null) window.clearTimeout(timers.current.settle);
    timers.current.settle = window.setTimeout(() => root.classList.remove("gx-settling"), SETTLE_MS + 40);
    opts.current.replan();
    const saved = anglesForSave({ tilt: opts.current.setting.tilt, azimuth: opts.current.setting.azimuth });
    showBadge(anglesLabel(saved, scene.view.zoom), null, false);
  };

  // 新的布局画好之后（设置回填 → React 按新角度跑完屏幕安全布局）落位
  const sceneNow = options.scene.current;
  const sceneId = options.sceneId;
  useLayoutEffect(() => {
    if (settlePending.current === false || sceneNow === null || sceneId === settlePending.current) return;
    settlePending.current = false;
    settle(sceneNow, settleAnimate.current);
  });

  // 滚轮 / 双指缩放：以指针为中心，无极、跟手；连续滚动时冻结布局只重新投影，停下 220ms 后存盘并重排落位
  const zoomFrame = (): void => {
    wheelRaf.current = null;
    const w = wheel.current;
    const root = opts.current.root.current;
    if (w === null || root === null) return;
    const vp = w.frozen.viewport;
    const ratio = w.view.zoom / w.start.zoom;
    const viewport = { ...vp, focal: vp.focal * ratio, cx: vp.cx - w.start.panX + w.view.panX, cy: vp.cy - w.start.panY + w.view.panY };
    const proj = liveProjection(w.frozen, w.frozen.elevation, w.frozen.azimuth, viewport);
    opts.current.live.current = proj;
    lastStar.current = proj.star;
    applyProjection(root, proj, opts.current.movers.current, opts.current.clock.now() / 1000, ratio);
    showBadge(anglesLabel({ tilt: w.frozen.elevation, azimuth: w.frozen.azimuth }, w.view.zoom), null, true);
    opts.current.replan();
  };
  const endWheel = (): void => {
    const w = wheel.current;
    const root = opts.current.root.current;
    wheel.current = null;
    if (wheelRaf.current !== null) {
      cancelAnimationFrame(wheelRaf.current);
      wheelRaf.current = null;
    }
    if (w === null || root === null) return;
    zoomFrame();
    const zoom = Math.round(w.view.zoom * 100) / 100;
    const next: UserView = { zoom, panX: w.view.panX, panY: w.view.panY };
    const scene = opts.current.scene.current;
    settleAnimate.current = false;
    if (next.zoom === w.start.zoom && next.panX === w.start.panX && next.panY === w.start.panY) {
      if (scene !== null) settle(scene, false);
      return;
    }
    settlePending.current = opts.current.sceneId;
    opts.current.setZoomView(next);
    if (zoom !== w.start.zoom) opts.current.commit?.({ zoom });
  };
  const enabled = options.commit !== null;
  useEffect(() => {
    const root = opts.current.root.current;
    if (!enabled || root === null) return;
    const onWheel = (event: WheelEvent): void => {
      const o = opts.current;
      const pinch = event.ctrlKey || event.metaKey;
      // 单智能体首页：普通滚轮交给页面（星系下面还有记录可滚），只认捏合 / ⌘ / Ctrl + 滚轮
      if (!o.plainWheelZooms && !pinch) return;
      const scene = o.scene.current;
      if (scene === null || gesture.current?.active === true) return;
      event.preventDefault();
      let w = wheel.current;
      if (w === null) {
        root.classList.remove("gx-settling");
        w = { frozen: scene, start: o.zoomView, view: o.zoomView, timer: null };
        wheel.current = w;
      }
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
      const factor = Math.exp(-event.deltaY * unit * (pinch ? 0.01 : 0.0015));
      const rect = root.getBoundingClientRect();
      const base = { cx: w.frozen.viewport.cx - w.start.panX, cy: w.frozen.viewport.cy - w.start.panY };
      w.view = zoomAt(w.view, base, event.clientX - rect.left, event.clientY - rect.top, w.view.zoom * factor);
      if (wheelRaf.current === null) wheelRaf.current = requestAnimationFrame(zoomFrame);
      if (w.timer !== null) window.clearTimeout(w.timer);
      w.timer = window.setTimeout(endWheel, 220);
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [enabled]);

  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      if (wheelRaf.current !== null) cancelAnimationFrame(wheelRaf.current);
      if (wheel.current?.timer != null) window.clearTimeout(wheel.current.timer);
      if (timers.current.badge !== null) window.clearTimeout(timers.current.badge);
      if (timers.current.settle !== null) window.clearTimeout(timers.current.settle);
    },
    [],
  );

  /** 写设置；角度没变（设置不会回填）就直接落位 */
  const commitView = (next: ViewAngles, root: HTMLElement, resetZoom = false, animate = true): void => {
    const commit = opts.current.commit;
    const saved = anglesForSave(next);
    const current = opts.current.setting;
    const zv = opts.current.zoomView;
    const zoomChanges = resetZoom && (zv.zoom !== 1 || zv.panX !== 0 || zv.panY !== 0);
    settleAnimate.current = animate;
    if (animate && !reducedMotion()) root.classList.add("gx-settling");
    // 方向键 / 双击没有拖动帧：主星从此刻画着的位置滑过去
    const scene = opts.current.scene.current;
    if (lastStar.current === null && scene !== null) lastStar.current = liveProjection(scene, scene.elevation, scene.azimuth).star;
    if (commit === null || (saved.tilt === current.tilt && saved.azimuth === current.azimuth && !zoomChanges)) {
      if (scene !== null) settle(scene, animate);
      return;
    }
    settlePending.current = opts.current.sceneId;
    if (zoomChanges) opts.current.setZoomView(USER_VIEW_DEFAULT);
    commit(resetZoom ? { ...saved, zoom: 1 } : saved);
  };

  const finish = (event: ReactPointerEvent<HTMLDivElement>, keep: boolean): void => {
    const g = gesture.current;
    if (g === null || g.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (!g.active) return;
    if (raf.current !== null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
    swallowClick.current = true;
    const root = event.currentTarget;
    delete root.dataset.tiltDragging;
    if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
    const final = view.current;
    view.current = null;
    if (keep && final !== null) commitView(final, root, false, false);
    else {
      const scene = opts.current.scene.current;
      if (scene !== null) settle(scene, false);
    }
  };

  /** 双击 / 方向键：从此刻画面的角度出发（画面若被自动抬高过，就从抬高后的俯角出发，不跳） */
  const currentView = (): ViewAngles => {
    const scene = opts.current.scene.current;
    return { tilt: scene?.elevation ?? opts.current.setting.tilt, azimuth: opts.current.setting.azimuth };
  };

  if (options.commit === null) return null;
  const interactive = (target: EventTarget | null): boolean =>
    target instanceof Element && target.closest(".galaxy-target, .galaxy-dot, .galaxy-callout[data-link], .galaxy-all") !== null;
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      swallowClick.current = false;
      if (event.button !== 0 || !event.isPrimary) return;
      gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: currentView(), active: false, frozen: null };
    },
    onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => {
      const g = gesture.current;
      if (g === null || g.pointerId !== event.pointerId) return;
      const dx = event.clientX - g.x;
      const dy = event.clientY - g.y;
      if (!g.active) {
        if (!isDragMove(dx, dy)) return;
        g.active = true;
        // 冻结按下这一刻的布局：拖动中只重新投影
        g.frozen = opts.current.scene.current;
        event.currentTarget.dataset.tiltDragging = "true";
        event.currentTarget.classList.remove("gx-settling");
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
      latest.current = { dx, dy };
      if (raf.current === null) raf.current = requestAnimationFrame(frame);
    },
    onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => {
      // 松手前把最后一个位置也投影上去（rAF 可能还没跑）
      if (gesture.current?.active === true && raf.current !== null) {
        cancelAnimationFrame(raf.current);
        frame();
      }
      finish(event, true);
    },
    onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => finish(event, false),
    // 指针被别处抢走（窗口失焦、系统手势）：按松手处理，不留一个卡在「拖动中」的星系
    onLostPointerCapture: (event: ReactPointerEvent<HTMLDivElement>) => finish(event, true),
    // 拖过之后的那一下 click 不给天体（捕获阶段拦下）
    onClickCapture: (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      event.stopPropagation();
      event.preventDefault();
    },
    // 双击空白处回到默认视角（Blender 视口的复位习惯）
    onDoubleClick: (event: ReactMouseEvent<HTMLDivElement>) => {
      if (interactive(event.target)) return;
      event.preventDefault();
      showBadge(anglesLabel(VIEW_DEFAULT, 1), null, false);
      commitView(VIEW_DEFAULT, event.currentTarget, true);
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      const next = keyAngles(currentView(), event.key, opts.current.turntable);
      if (next === null) return;
      event.preventDefault();
      showBadge(anglesLabel(next, opts.current.zoomView.zoom), null, false);
      commitView(next, event.currentTarget);
    },
  };
}

/**
 * 星系的表：走了多少毫秒。不用一个「空跑的 Web Animation」当表——没有目标的动画在主线程上每帧都要服务一次，
 * 实测让主线程帧从 0 涨到每秒 100 帧（2026-11-24）。这里只在暂停 / 恢复时记账，读的时候现算。
 * 时间基准用 document.timeline（与转动层的动画同一条时间线）。
 */
export interface GalaxyClock {
  /** 已走的毫秒数 */
  now: () => number;
}

function timelineMs(): number {
  const time = document.timeline.currentTime;
  return typeof time === "number" ? time : performance.now();
}

/**
 * 公转（galaxy-motion.ts）：根节点里每个 [data-spin] 元素挂一个无限循环的 transform 动画，由合成器线程跑，React 不再每帧重绘。
 * 停的条件——页面隐藏、窗口失焦、星系滚出 / 被藏出视口（IntersectionObserver）、系统要求减少动效——任何一个成立，
 * 所有转动层一起 pause()，恢复时按表上的时间重设 currentTime 再 play()（相位不错开）。卸载时 cancel()。
 * 现在跑不跑写在根节点的 data-motion 上（running / paused），验收时可直接读。
 */
function useGalaxyMotion(target: RefObject<HTMLDivElement | null>, signature: string, powerSave = false): { running: boolean; clock: GalaxyClock } {
  const powerRef = useRef(powerSave);
  powerRef.current = powerSave;
  const resync = useRef<() => void>(() => undefined);
  const ledger = useRef<{ base: number; start: number | null }>({ base: 0, start: null });
  const clock = useMemo<GalaxyClock>(
    () => ({
      now: () => {
        const { base, start } = ledger.current;
        return start === null ? base : base + Math.max(0, timelineMs() - start);
      },
    }),
    [],
  );
  const spins = useRef<Animation[]>([]);
  const runningRef = useRef(false);
  const [running, setRunning] = useState(false);
  useLayoutEffect(() => {
    const el = target.current;
    if (el === null) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const inputs: MotionInputs = { hasFocus: document.hasFocus(), visibilityState: document.visibilityState, onScreen: true, reducedMotion: media.matches, powerSave: powerRef.current };
    const sync = () => {
      inputs.powerSave = powerRef.current;
      const run = motionAllowed(inputs);
      if (run !== runningRef.current) {
        const elapsed = clock.now();
        ledger.current = run ? { base: elapsed, start: timelineMs() } : { base: elapsed, start: null };
        runningRef.current = run;
        for (const anim of spins.current) {
          const period = Number(anim.effect?.getTiming().duration);
          if (Number.isFinite(period) && period > 0) anim.currentTime = elapsed % period;
          if (run) anim.play();
          else anim.pause();
        }
        setRunning(run);
      }
      el.dataset.motion = run ? "running" : "paused";
    };
    // 与 window-activity.ts 挂同三个事件；每次都现读 hasFocus / visibilityState，不靠事件猜
    const onActivity = () => {
      inputs.hasFocus = document.hasFocus();
      inputs.visibilityState = document.visibilityState;
      sync();
    };
    const onMotionPref = () => {
      inputs.reducedMotion = media.matches;
      sync();
    };
    const observer = new IntersectionObserver((entries) => {
      inputs.onScreen = entries.some((entry) => entry.isIntersecting);
      sync();
    });
    observer.observe(el);
    document.addEventListener("visibilitychange", onActivity);
    window.addEventListener("focus", onActivity);
    window.addEventListener("blur", onActivity);
    media.addEventListener("change", onMotionPref);
    el.dataset.motion = "paused";
    resync.current = sync;
    sync();
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onActivity);
      window.removeEventListener("focus", onActivity);
      window.removeEventListener("blur", onActivity);
      media.removeEventListener("change", onMotionPref);
      for (const anim of spins.current) anim.cancel();
      spins.current = [];
      ledger.current = { base: clock.now(), start: null };
      runningRef.current = false;
    };
  }, [target, clock]);
  // 几何一变（画布尺寸、轨道、会话数）就把转动层的动画重挂一遍：相位都从同一块表读，不跳
  useLayoutEffect(() => {
    const el = target.current;
    if (el === null) return;
    for (const anim of spins.current) anim.cancel();
    const now = clock.now();
    const list: Animation[] = [];
    for (const node of el.querySelectorAll<HTMLElement>("[data-spin]")) {
      const period = Number(node.dataset.period);
      if (!Number.isFinite(period) || period <= 0) continue;
      // 开普勒轨道：data-frames 是按平近点角等分的一串角度（galaxy-motion.spinKeyframes），offset 等分、段内线性；
      // 正圆轨道与碎石带只有起止两帧
      const frames = node.dataset.frames === undefined ? [Number(node.dataset.from), Number(node.dataset.to)] : node.dataset.frames.split(",").map(Number);
      const anim = node.animate(
        frames.map((deg) => ({ transform: `rotate(${deg}deg)` })),
        { duration: period, iterations: Infinity, easing: "linear" },
      );
      anim.currentTime = now % period;
      if (!runningRef.current) anim.pause();
      list.push(anim);
    }
    spins.current = list;
  }, [target, clock, signature]);
  // 离电省电档切换时重新判定（停转 / 恢复）
  useLayoutEffect(() => {
    resync.current();
  }, [powerSave]);
  return { running, clock };
}

/**
 * 行星 / 碎石块过了换层边界就从主星背后那一层挪到前面那一层（反之亦然）：每颗按到点时间排一个 setTimeout（一圈两次），
 * 不每帧问。两层各有一份同样的 DOM，只切 visibility（不影响正在跑的合成器动画）。
 */
function useSides(target: RefObject<HTMLDivElement | null>, movers: readonly Mover[], clock: GalaxyClock, running: boolean, signature: string): void {
  useLayoutEffect(() => {
    const el = target.current;
    if (el === null) return;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const apply = (mover: Mover) => {
      const t = clock.now() / 1000;
      const far = moverFar(mover, t);
      for (const node of el.querySelectorAll<HTMLElement>(`[data-body="${CSS.escape(mover.id)}"]`)) {
        const show = (node.dataset.layer === "far") === far;
        node.style.visibility = show ? "" : "hidden";
      }
      if (running) timers.set(mover.id, setTimeout(() => apply(mover), msToNextSide(mover, t) + 20));
    };
    for (const mover of movers) apply(mover);
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [target, movers, clock, running, signature]);
}

/**
 * 新会话「被捕获」：第一次画之后再出现的会话 id（碎石带或碎石块里）在 CAPTURE_MS 内走一段从外缘吸进来的螺线。
 * 动效被停（减少动效、失焦、看不见）时不演，直接出现在自己的位置。
 */
function useCaptures(ids: readonly string[], enabled: boolean): ReadonlySet<string> {
  const known = useRef<Set<string> | null>(null);
  const [active, setActive] = useState<ReadonlySet<string>>(() => new Set());
  const key = ids.join("\n");
  useLayoutEffect(() => {
    const fresh = capturedIds(known.current, ids);
    const seen = known.current ?? new Set<string>();
    for (const id of ids) seen.add(id);
    known.current = seen;
    if (fresh.length === 0 || !enabled) return;
    setActive((prev) => new Set([...prev, ...fresh]));
    setTimeout(() => {
      setActive((prev) => {
        const next = new Set(prev);
        for (const id of fresh) next.delete(id);
        return next;
      });
    }, CAPTURE_MS + 120);
  }, [key, ids, enabled]);
  return active;
}

/** 给正在被捕获的元素挂一次性的位移动画（data-capture = 会话 id，data-cx / data-cy = 它在转动层里离最终位置的参照点） */
function useCaptureAnimations(target: RefObject<HTMLDivElement | null>, active: ReadonlySet<string>): void {
  const started = useRef(new Set<string>());
  useLayoutEffect(() => {
    const el = target.current;
    if (el === null) return;
    for (const id of active) {
      if (started.current.has(id)) continue;
      started.current.add(id);
      for (const node of el.querySelectorAll<HTMLElement>(`[data-capture="${CSS.escape(id)}"]`)) {
        const offsets = captureOffsets(Number(node.dataset.cx), Number(node.dataset.cy));
        node.animate(
          offsets.map((o) => ({ transform: `translate(${o.dx.toFixed(1)}px, ${o.dy.toFixed(1)}px)`, opacity: o.opacity })),
          { duration: CAPTURE_MS, easing: "linear", fill: "backwards" },
        );
      }
    }
    for (const id of started.current) if (!active.has(id)) started.current.delete(id);
  }, [target, active]);
}

/** 锁定框 / 引线 / 名字的排布（每 LIVE_FRAME_MS 重算一次，只在「朝哪边、谁有线、谁被主星挡住」变了时才重绘那一层） */
interface OverlayPlan {
  key: string;
  /** 被主星挡住的天体：不画名字、锁定框、命中圈 */
  hidden: ReadonlySet<string>;
  callouts: ReadonlyMap<string, { dir: CalloutDir; lift: number }>;
  /** 名字牌相对星体中心的位置 */
  names: ReadonlyMap<string, { dx: number; dy: number; anchor: "start" | "middle" | "end" }>;
  /** 此刻落进禁区（avoid，标题与输入框那一块）的天体：星体本身也不画（淡出），不只是不画名字 */
  masked: ReadonlySet<string>;
  /** 在跑 / 等你 / 最近、这一刻拉不出引线（或碎石块整圈没画）的：角落那一列（overlay-plan.ts） */
  spill: readonly CalloutTarget[];
}

const EMPTY_PLAN: OverlayPlan = { key: "", hidden: new Set(), callouts: new Map(), names: new Map(), masked: new Set(), spill: [] };

/** 角落那一列最多几行 */
const SPILL_ROWS = 4;

/** 禁区与主星外缘之间至少留的空（px） */
const SAFE_AVOID_GAP = 12;


function usePlan(compute: ((tSec: number) => OverlayPlan) | null, clock: GalaxyClock, running: boolean, signature: string): { plan: OverlayPlan; replan: () => void } {
  const [plan, setPlan] = useState<OverlayPlan>(EMPTY_PLAN);
  const computeRef = useRef(compute);
  computeRef.current = compute;
  const lastKey = useRef("");
  // 拖动中（相机在变、布局不变）按新相机重算一次：谁被主星挡住、名字写哪边
  const replan = useCallback(() => {
    const fn = computeRef.current;
    if (fn === null) return;
    const next = fn(clock.now() / 1000);
    if (next.key !== lastKey.current) {
      lastKey.current = next.key;
      setPlan(next);
    }
  }, [clock]);
  useLayoutEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      const fn = computeRef.current;
      if (fn === null) return;
      const next = fn(clock.now() / 1000);
      if (next.key !== lastKey.current) {
        lastKey.current = next.key;
        setPlan(next);
      }
      if (running) timer = setTimeout(tick, LIVE_FRAME_MS);
    };
    tick();
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [clock, running, signature]);
  return { plan: compute === null ? EMPTY_PLAN : plan, replan };
}

/**
 * 一串「跟着轨道走」的 div：轨道矩阵 · 转 −θ · 平移到 R0 ·（捕获位移）· 转 +θ · 轨道矩阵的逆 → 对 children 只是平移。
 * 两个转动层带 data-spin，由 useGalaxyMotion 挂合成器动画。
 */
function OrbitChain(props: {
  mover: Mover;
  layer: "far" | "near" | "top";
  children: ReactNode;
  className?: string;
  /** 联星的串（binary.ts）：轨道半径（拖动中 applyProjection 按它现算矩阵）；centered = 整座星系跟着本星绕质心走的那一串 */
  binary?: { a: number; centered: boolean };
}) {
  const { mover } = props;
  const m = orbitMatrix(mover.frame);
  const period = periodMs(mover.omega);
  const out = spinKeyframes(mover.phase, mover.ecc, -1).map((deg) => Number(deg.toFixed(4))).join(",");
  const back = spinKeyframes(mover.phase, mover.ecc, 1).map((deg) => Number(deg.toFixed(4))).join(",");
  return (
    <div
      className={props.className === undefined ? "gx-node" : `gx-node ${props.className}`}
      style={{ transform: cssMatrix(m) }}
      data-orbit={mover.id}
      data-body={props.layer === "top" || props.binary?.centered === true ? undefined : mover.id}
      data-layer={props.layer}
      data-binary-a={props.binary?.a}
      data-binary-centered={props.binary?.centered === true ? "true" : undefined}
    >
      <div className="gx-node" data-spin="" data-frames={out} data-period={period}>
        <div className="gx-node" style={{ transform: `translateX(${R0}px)` }}>
          <div className="gx-node" data-capture={mover.id} data-cx={R0} data-cy={0}>
            <div className="gx-node" data-spin="" data-frames={back} data-period={period}>
              <div className="gx-node" data-orbit-inv="" style={{ transform: cssMatrix(inverseLinear(m)) }}>
                {props.children}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 以 (0,0) 为中心的一小张 SVG（星体、名字、锁定框都按相对坐标画）；box 是内容的外接框 */
function Local(props: { box: Box; children: ReactNode; className?: string }) {
  const x0 = Math.floor(props.box.x0);
  const y0 = Math.floor(props.box.y0);
  const w = Math.ceil(props.box.x1) - x0;
  const h = Math.ceil(props.box.y1) - y0;
  const style: CSSProperties = { left: x0, top: y0 };
  return (
    <svg className={props.className === undefined ? "gx-local" : `gx-local ${props.className}`} style={style} width={w} height={h} viewBox={`${x0} ${y0} ${w} ${h}`}>
      {props.children}
    </svg>
  );
}

function square(r: number): Box {
  return { x0: -r, y0: -r, x1: r, y1: r };
}

function union(a: Box, b: Box): Box {
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

/**
 * 碎石带的一半（远半圈在主星之下那层、近半圈在之上那层）：轨道矩阵 · 转 χ · 半平面裁切 · 转 −χ · 转 α · 一张静止的碎石 SVG。
 * χ 与裁切线的偏移由方位角定（turntable.beltSplit；方位角 0 时 χ = 0、偏移 0，与原来一样）；拖动中 applyBelt 直接改这几层。
 * memo：拖动中名字排布重算会让星系重渲染，几百颗碎石这一大块不跟着重算。
 */
const BeltHalf = memo(function BeltHalf(props: {
  /** whole = 整条不裁、画在主星背后那一层（碎石密度低于「全部」时，省电） */
  side: "far" | "near" | "whole";
  belt: Belt;
  camera: Camera;
  viewport: Viewport;
  look: { px: number; alpha: number };
  capturing: ReadonlySet<string>;
  clickable: boolean;
  onOpen: ((id: string) => void) | null;
  openLabel: (title: string) => string;
}) {
  const frame = beltFrame(props.belt, props.camera, props.viewport);
  const m = orbitMatrix(frame);
  // 转动层里 1px 在屏幕上横向约 sx 像素：碎石按屏幕上的直径画（纵向被轨道矩阵压扁，像平躺在盘面上）
  const sx = Math.max(Math.hypot(m.a, m.b), 1e-3);
  const rho = props.look.px / sx;
  const hit = 6 / sx;
  const mid = (props.belt.inner + props.belt.outer) / 2;
  const L = Math.ceil((R0 * props.belt.outer) / mid + hit + 8);
  const points = props.belt.particles.map((particle) => ({ particle, ...dustDiskPoint(props.belt, particle.r, particle.theta0) }));
  const still = points.filter((point) => !props.capturing.has(point.particle.id));
  const moving = points.filter((point) => props.capturing.has(point.particle.id));
  const period = periodMs(props.belt.omega);
  const dot = (x: number, y: number) => `M${(x - rho).toFixed(1)} ${y.toFixed(1)}a${rho.toFixed(2)} ${rho.toFixed(2)} 0 1 0 ${(rho * 2).toFixed(2)} 0a${rho.toFixed(2)} ${rho.toFixed(2)} 0 1 0 ${(-rho * 2).toFixed(2)} 0`;
  const split = beltSplit(props.belt.ecc, props.camera.azimuth);
  const box = beltBox(props.side === "near" ? "near" : "far", L, split.offset);
  const half: CSSProperties = box;
  const back: CSSProperties = { left: -box.left, top: -box.top };
  // 碎石转动层（一张静止 SVG，整层由合成器转）
  const spinLayer = (
          <div className="gx-node" data-spin="" data-from={0} data-to={-360} data-period={period}>
            <svg className="gx-local" style={{ left: -L, top: -L }} width={2 * L} height={2 * L} viewBox={`${-L} ${-L} ${2 * L} ${2 * L}`}>
              {props.clickable && props.onOpen !== null ? (
                still.map(({ particle, x, y }) => {
                  const label = props.openLabel(particle.title ?? "");
                  return (
                    <g key={particle.id} className="galaxy-dot" data-session={particle.id} onClick={() => props.onOpen?.(particle.id)} style={{ opacity: props.look.alpha }}>
                      <title>{label}</title>
                      <circle className="galaxy-dot-hit" cx={x} cy={y} r={hit} />
                      <circle className="galaxy-dust" cx={x} cy={y} r={rho} />
                    </g>
                  );
                })
              ) : (
                <path className="galaxy-dust" d={still.map(({ x, y }) => dot(x, y)).join("")} style={{ opacity: props.look.alpha }} />
              )}
            </svg>
            {moving.map(({ particle, x, y }) => (
              <div key={particle.id} className="gx-node" style={{ left: x, top: y }}>
                <div className="gx-node" data-capture={particle.id} data-cx={x} data-cy={y}>
                  <svg className="gx-local" style={{ left: -rho - 1, top: -rho - 1 }} width={rho * 2 + 2} height={rho * 2 + 2} viewBox={`${-rho - 1} ${-rho - 1} ${rho * 2 + 2} ${rho * 2 + 2}`}>
                    <circle className="galaxy-dust" r={rho} style={{ opacity: props.look.alpha }} />
                  </svg>
                </div>
              </div>
            ))}
          </div>
  );
  // 整条（碎石密度低于「全部」时）：不裁半平面、整条画在主星背后那一层——实测 GPU 花在两半的半平面裁切上（裁切让合成器每帧另开离屏面），
  // 不在颗数，也不在这一层转（orbita 435 条：裁成两半 GPU 26–28%，整条不裁 15.4–15.6%，不画碎石带 16.5–16.8%）。
  // 代价：近侧那一段碎石从主星前面经过时被主星挡住（只在低俯角、主星大时看得出）
  if (props.side === "whole") {
    return (
      <div className="gx-node" data-belt-outer="" data-belt-whole="" style={{ transform: cssMatrix(m) }}>
        {spinLayer}
      </div>
    );
  }
  return (
    <div className="gx-node" data-belt-outer="" style={{ transform: cssMatrix(m) }}>
      <div className="gx-node" data-belt-rot="" style={{ transform: `rotate(${split.chiDeg.toFixed(3)}deg)` }}>
      <div className="gx-half" data-belt-half={props.side} data-l={L} style={half}>
        <div className="gx-node" data-belt-back="" style={back}>
          <div className="gx-node" data-belt-unrot="" style={{ transform: `rotate(${(-split.chiDeg).toFixed(3)}deg)` }}>
          {spinLayer}
          </div>
        </div>
      </div>
      </div>
    </div>
  );
});

/**
 * 首页 / 工作区页的星系：一颗主星、若干小得多的行星、一条会话碎石带。数据是真实的（galaxy-data.ts）。
 * 几何在 galaxy.ts（有测试），公转交给合成器（galaxy-motion.ts）：这里只搭一次静止的 DOM。
 * 颜色全部取墨色与发丝线 token（styles.css 的 .home-galaxy），不用 accent：它是这座星系的样子，不是要你点的东西。
 *
 * 画家顺序拆成几层（从下到上）：远半圈轨道弧 → 远半圈的碎石与天体 → 主星 → 近半圈轨道弧 → 近半圈的碎石与天体 →
 * 锁定框 / 引线 / 名字 / 命中圈。天体过了左右两点在两层之间换（useSides）。
 *
 * 单智能体首页与编排页同一套（2026-11-24 用户要两边 consistent）：每条根会话都是碎石带里的一颗碎石，带子随会话数长大
 * （beltGrowthOf）；新会话从外缘被吸进来（useCaptures）。fill 只决定画框的高度封顶（编排 New Task 页占满输入框上方）。
 */
type HomeGalaxyProps = {
  spec: GalaxySpec;
  label: string;
  starDesign?: GalaxyDesign;
  fill?: boolean;
  emptyHint?: string;
  /**
   * 没有主星的「星际空间」（不属于任何工作区）：没有工作区就没有主智能体，也就没有主星与行星——
   * 只画缓慢转动的碎石，每颗是一条会话。
   */
  starless?: boolean;
  /**
   * 子智能体行星（编排星系：行星 = 子智能体，id → 设计稿）。给了就按设计稿画（地表图 + 代码眼睛）并常显名字，
   * 行星可读半径放大一档（AGENT_READABLE_MAX）；会话不再是行星，在做事的会话是带锁定框的碎石块（spec.rocks）。
   */
  agents?: ReadonlyMap<string, PlanetDesign>;
  /**
   * 这座星系属于哪个工作区：给了且有 GalaxyActions（App 提供）时星系能点——碎石开会话、行星 / 主星开设计面板、
   * 「全部 N 条会话」（读屏 / 键盘入口）开右栏树状图。
   */
  workspaceId?: string | null;
  /** 主星的名字（读屏与悬停提示「X（主星）：在设计面板里打开」）；缺省用主星设计稿的名字 */
  starName?: string;
  /**
   * 这是哪块画布（俯角被自动抬高时，设置页说明是哪一块）：home = 单智能体首页，page = 编排 New Task 页，panel = 右栏星系图；
   * 缺省按 fill 推（fill → page，否则 home）。设置页的小预览传 null：不上报
   */
  surface?: GalaxySurface | null;
  /**
   * 禁区（相对星系根节点的像素矩形）：单智能体首页「星系铺满作背景」候选里，标题、slogan 与输入框那一块。
   * 给了：主星压不进去（画框整体下移到主星让开）；天体走进去时淡出、名字与引线不写进去。缺席 = 没有禁区
   */
  avoid?: Box | null;
  /**
   * 联星（Workspace.binaryWith，binary.ts）：伴星的工作区 id、名字、主星设计稿。给了就画两颗主星绕共同质心转：
   * 这座星系（行星、碎石带）跟着本星走，伴星只画星体与名字。缺席 / null = 没有伴星
   */
  binary?: { workspaceId: string; name: string; design: GalaxyDesign } | null;
};

/**
 * 外层只做一件事：把 spec 按内容稳住。ChatView 每来一个运行态事件都会重算一份新的 spec 对象（内容多半没变）；
 * 按内容比较之后，星系那一大棵 DOM（几百颗碎石、几串转动层）只在真变了的时候重渲染。
 */
export function HomeGalaxy(props: HomeGalaxyProps) {
  const key = JSON.stringify(props.spec);
  const cache = useRef<{ key: string; spec: GalaxySpec } | null>(null);
  if (cache.current === null || cache.current.key !== key) cache.current = { key, spec: props.spec };
  return <GalaxyScene {...props} spec={cache.current.spec} />;
}

const GalaxyScene = memo(function GalaxyScene(props: HomeGalaxyProps) {
  const t = useT();
  const actions = useGalaxyActions();
  const uid = useId().replace(/:/g, "");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const size = useBoxSize(rootRef);
  const starless = props.starless === true;
  // 轨道是开普勒椭圆（偏心率候选见 proto-variants），俯角是设置里的星系倾角（单智能体首页与编排页同一套）
  const orbitE = Number(useProtoVariants().orbitE);
  const tilt = useGalaxyTilt();
  const galaxyView = useGalaxyView();
  const azimuth = galaxyView.azimuth;
  // 缩放：设置里存的倍数 + 本组件的平移（以指针为中心缩放带出来的，不存盘）。本组件改了先在这里生效，再写设置；
  // 别处改了设置（另一块星系、双击复位）就跟过来
  const [zoomView, setZoomView] = useState<UserView>(() => ({ zoom: galaxyView.zoom, panX: 0, panY: 0 }));
  useEffect(() => {
    setZoomView((current) => (current.zoom === galaxyView.zoom ? current : galaxyView.zoom === 1 ? USER_VIEW_DEFAULT : { ...current, zoom: galaxyView.zoom }));
  }, [galaxyView.zoom]);
  const surface = props.surface === undefined ? (props.fill === true ? "page" : "home") : props.surface;
  // 设置页的小预览（surface = null）不接拖动：那里有滑块
  const setView = useGalaxyTiltSetter();
  // 碎石密度（设置 › 外观）：只删减碎石带里的普通会话，在跑 / 等你 / 最近的碎石块不受影响
  const spec = useMemo(() => ({ ...props.spec, eccentricity: orbitE, dustKeep: galaxyView.dustKeep }), [props.spec, orbitE, galaxyView.dustKeep]);
  const baseLayout = useMemo(() => layoutGalaxy(spec), [spec]);
  // 联星：间距、质心、画面要缩多少（binary.ts）。只在有工作区、有主星时成立
  const binary = starless || props.workspaceId == null ? null : (props.binary ?? null);
  const companionStar = binary === null ? null : starOf(binary.design);
  const companionDensity = companionStar?.density ?? STAR_DENSITY;
  const companionR = companionStar === null ? 0 : starRadius(companionStar.mass, companionDensity);
  const geo: BinaryGeometry | null = useMemo(
    () => (companionStar === null ? null : binaryGeometry(spec.starMass, companionStar.mass, baseLayout.extent, companionR)),
    [companionStar, spec.starMass, baseLayout.extent, companionR],
  );
  const binaryPhase0 = binary === null || props.workspaceId == null ? 0 : binaryPhase(props.workspaceId, binary.workspaceId);
  // 联星时画面整体缩一档，把伴星装进来（用户缩放乘在上面）
  const sceneView = useMemo<UserView>(() => (geo === null || geo.zoom === 1 ? zoomView : { ...zoomView, zoom: zoomView.zoom * geo.zoom }), [geo, zoomView]);
  const scene = useMemo(() => {
    if (size === null || size.width < 2 || size.height < 2) return null;
    // 工作区页 / 右栏：屏幕安全布局（screen-safe.ts）——在屏幕坐标里排轨道，任何相位上天体都不在画面上相撞
    // fill：编排 New Task 页（星系占输入框上方整块，高度封顶放宽）；不是 fill：单智能体首页输入框下面那条带子
    const box = galaxyBox(size.width, size.height, props.fill === true ? GALAXY_MAX_FILL : GALAXY_MAX);
    const readableMax = props.agents !== undefined && props.agents.size > 0 ? AGENT_READABLE_MAX : PLANET_READABLE_MAX;
    const safe = fitScreenSafe(spec, size.width, size.height, box, tilt, readableMax, azimuth, sceneView);
    let viewport = safe.viewport;
    const avoid = props.avoid ?? null;
    if (avoid !== null) {
      // 禁区：主星（连星环 / 日冕外缘）不得压进去——画框整体往下挪到主星让开为止（下沿被裁，它是背景）
      const star = drawFrame({ ...safe.layout, belt: null }, safe.camera, viewport, [], 0, safe.minPlanetPx).find((item) => item.kind === "star");
      const reach = star === undefined ? 0 : star.r * (props.starDesign === undefined ? 1 : starExtentRatio(props.starDesign));
      const delta = star === undefined ? 0 : Math.max(0, avoid.y1 + reach + SAFE_AVOID_GAP - star.y);
      if (delta > 0) viewport = { ...viewport, cy: viewport.cy + delta };
    }
    return { camera: safe.camera, viewport, layout: safe.layout, minPlanetPx: safe.minPlanetPx, elevation: safe.elevationDeg, box, size };
  }, [size, spec, props.agents, props.fill, tilt, azimuth, props.avoid, props.starDesign, sceneView]);
  const layout: GalaxyLayout = scene === null ? baseLayout : starless ? { ...scene.layout, planets: [] } : scene.layout;
  const arcs: OrbitArc[] = useMemo(() => (scene === null || starless ? [] : orbitArcs(layout, scene.camera, scene.viewport)), [scene, layout, starless]);
  // 一张 t = 0 的快照：主星的位置与半径、碎石块的大小（碎石 < 行星的规矩在 drawFrame 里）
  const snapshot = useMemo(() => (scene === null ? [] : drawFrame({ ...layout, belt: null }, scene.camera, scene.viewport, [], 0, scene.minPlanetPx)), [scene, layout]);
  const starItem = snapshot.find((item) => item.kind === "star");
  const rockPx = snapshot.find((item): item is RockItem => item.kind === "rock")?.r ?? ROCK_PX;
  const baseMovers = useMemo(() => (scene === null ? [] : moversOf(layout, scene.camera, scene.viewport, scene.minPlanetPx, rockPx)), [scene, layout, rockPx]);
  // 联星的两串：伴星（绕本星，间距 sep，跟行星一样分远近两层画）、本星（整座星系绕质心，半径 r1）
  const pxPerUnit = scene === null ? 1 : scene.viewport.focal / project({ x: 0, y: 0, z: 0 }, scene.camera).depth;
  const companionId = binary === null ? null : `${BINARY_ID}${binary.workspaceId}`;
  const companionMover = useMemo<Mover | null>(() => {
    if (scene === null || geo === null || companionId === null) return null;
    const far = farWindow(0, scene.camera.azimuth, FAR_MARGIN);
    return { id: companionId, kind: "planet", frame: binaryFrame(geo.sep, scene.camera, scene.viewport, false), phase: binaryPhase0, ecc: 0, omega: geo.omega, r: Math.max(companionR * pxPerUnit, 6), waiting: false, far };
  }, [scene, geo, companionId, binaryPhase0, companionR, pxPerUnit]);
  const selfMover = useMemo<Mover | null>(() => {
    if (scene === null || geo === null) return null;
    return { id: `${BINARY_ID}self`, kind: "planet", frame: binaryFrame(geo.r1, scene.camera, scene.viewport, true), phase: binaryPhase0 + Math.PI, ecc: 0, omega: geo.omega, r: 0, waiting: false, far: farWindow(0, scene.camera.azimuth, FAR_MARGIN) };
  }, [scene, geo, binaryPhase0]);
  const movers = useMemo(() => (companionMover === null ? baseMovers : [...baseMovers, companionMover]), [baseMovers, companionMover]);
  const look = layout.belt === null ? null : dustLookOf(layout.belt.count, starless);
  const ids = useMemo(() => [...layout.rocks.map((rock) => rock.id), ...(layout.belt?.particles.map((particle) => particle.id) ?? [])], [layout]);
  const signature = useMemo(
    () =>
      JSON.stringify([
        size,
        movers.map((m) => [m.id, m.phase, m.ecc, m.omega, m.frame.cx, m.frame.cy, m.frame.m1x, m.frame.m2y]),
        selfMover === null ? null : [selfMover.frame.m1x, selfMover.frame.m2y, selfMover.omega],
        layout.belt === null ? null : [layout.belt.inner, layout.belt.outer, layout.belt.particles.length],
        ids.length,
      ]),
    [size, movers, layout.belt, ids.length, selfMover],
  );
  const motion = useGalaxyMotion(rootRef, signature, galaxyView.powerSave);
  useSides(rootRef, movers, motion.clock, motion.running, signature);
  const capturing = useCaptures(ids, motion.running);
  useCaptureAnimations(rootRef, capturing);
  // 名字牌 / 锁定框的字号跟设计系统走：挂上后量一次
  const probeRef = useRef<SVGTextElement | null>(null);
  const [glyphPx, setGlyphPx] = useState(12);
  useLayoutEffect(() => {
    const el = probeRef.current;
    if (el === null) return;
    const px = Number.parseFloat(getComputedStyle(el).fontSize);
    if (Number.isFinite(px) && px > 0 && px !== glyphPx) setGlyphPx(px);
  });
  const starExtent = props.starDesign === undefined ? 1 : starExtentRatio(props.starDesign);
  const agents = props.agents;
  const workspaceId = props.workspaceId ?? null;
  // 能点的星系：只有编排的工作区星系（有 App 给的去处、有工作区 id、不是星际空间）
  const live: { actions: GalaxyActions; workspaceId: string } | null = !starless && actions !== null && workspaceId !== null ? { actions, workspaceId } : null;
  const rankOf = useMemo(() => new Map(layout.planets.map((planet, index) => [planet.id, index])), [layout]);
  const previousCallouts = useRef(new Map<string, { dir: CalloutDir; lift: number }>());
  // 排布：此刻每颗天体在哪（drawFrame 不带碎石带），谁被主星挡住、谁有引线、名字写哪边
  // 拖动中的那一份投影（turntable）：排布按它的相机算；不拖时为 null
  const liveRef = useRef<LiveProjection | null>(null);
  const compute = useCallback(
    (tSec: number): OverlayPlan => {
      if (scene === null) return EMPTY_PLAN;
      const camera = liveRef.current?.camera ?? scene.camera;
      const viewport = liveRef.current?.viewport ?? scene.viewport;
      const items = drawFrame({ ...layout, belt: null }, camera, viewport, [], tSec, scene.minPlanetPx);
      const { hidden, masked, names, callouts, spill } = planOverlay({
        items,
        layout,
        starExtent,
        agentNames: agents === undefined ? null : new Map([...agents].map(([id, design]) => [id, design.name])),
        starless,
        avoid: props.avoid ?? null,
        width: scene.viewport.width,
        height: scene.viewport.height,
        glyphPx,
        waitingWord: t.agents.status.waiting,
        rankOf,
        previous: previousCallouts.current,
      });
      previousCallouts.current = new Map(callouts);
      const key = JSON.stringify([[...hidden].sort(), [...masked].sort(), [...callouts].map(([id, c]) => `${id}:${c.dir}${c.lift}`), [...names].map(([id, n]) => `${id}:${n.anchor}`), spill.map((s) => s.id), glyphPx]);
      return { key, hidden, callouts, names, masked, spill };
    },
    [scene, layout, starless, starExtent, agents, glyphPx, rankOf, t, props.avoid],
  );
  const { plan, replan } = usePlan(scene === null ? null : compute, motion.clock, motion.running, signature);
  // 引力扫描的网格跟着转台 / 缩放重画：拖动中 replan 每 LIVE_FRAME_MS 一次，顺带叫它
  const scanOn = useScanOn();
  const scanRedraw = useRef<(() => void) | null>(null);
  const replanAll = useCallback(() => {
    replan();
    scanRedraw.current?.();
  }, [replan]);
  // 质量卡：点了哪颗（"star" / 行星 id / 伴星 id）
  const [selected, setSelected] = useState<string | null>(null);
  // 同一颗再点一下收起；点别的换成那一颗
  const toggleSelected = useCallback((id: string) => setSelected((current) => (current === id ? null : id)), []);
  const planetSpecById = useMemo(() => new Map(spec.planets.map((planet) => [planet.id, planet])), [spec.planets]);
  const starMassUi = spec.starMass;
  const starDensity = spec.starDensity ?? STAR_DENSITY;
  // 网格上每个天体此刻在哪、压多深（坑深只随质量，坑宽随画出来的大小）
  const scanFrameAt = useCallback(
    (tSec: number): ScanFrame | null => {
      if (scene === null || starless) return null;
      const camera = liveRef.current?.camera ?? scene.camera;
      const viewport = liveRef.current?.viewport ?? scene.viewport;
      const ppu = viewport.focal / project({ x: 0, y: 0, z: 0 }, camera).depth;
      const pos = geo === null ? null : binaryPositions(geo, binaryPhase0, tSec);
      const o = pos?.self ?? { x: 0, y: 0 };
      const wells: Well[] = [{ id: "star", x: o.x, y: o.y, depth: pitDepth(starMassUi), soft: pitSoftening(layout.starRadius) }];
      const moverById = new Map(baseMovers.map((mover) => [mover.id, mover]));
      for (const planet of layout.planets) {
        const E = eccentricAnomaly(planet.phase + planet.omega * tSec, layout.ecc);
        const p = orbitPoint(planet.orbitRadius, planet.inclination, planet.node, E, layout.ecc);
        const mover = moverById.get(planet.id);
        const drawn = mover === undefined ? planet.radius : mover.r / ppu;
        wells.push({ id: planet.id, x: o.x + p.x, y: o.y + p.y, depth: pitDepth(planetSpecById.get(planet.id)?.mass ?? 0), soft: pitSoftening(drawn) });
      }
      if (pos !== null && companionStar !== null && companionId !== null) {
        wells.push({ id: companionId, x: pos.companion.x, y: pos.companion.y, depth: pitDepth(companionStar.mass), soft: pitSoftening(companionR) });
      }
      const q = project({ x: o.x, y: o.y, z: 0 }, camera);
      return { camera, viewport, wells, origin: { x: 0, y: 0 }, star: { x: viewport.cx + viewport.focal * q.sx, y: viewport.cy + viewport.focal * q.sy } };
    },
    [scene, starless, geo, binaryPhase0, starMassUi, layout, baseMovers, planetSpecById, companionStar, companionId, companionR],
  );
  // 转台：拖动按下时冻结的那一份（布局 + 角度），与给 applyProjection 的 movers
  const sceneRef = useRef<SceneNow | null>(null);
  sceneRef.current =
    scene === null
      ? null
      : { camera: scene.camera, viewport: scene.viewport, layout, width: scene.size.width, height: scene.size.height, box: scene.box, elevation: scene.elevation, azimuth, view: zoomView };
  const moversRef = useRef<readonly Mover[]>(movers);
  moversRef.current = movers;
  const badgeRef = useRef<HTMLSpanElement | null>(null);
  const handlers = useTurntable({
    root: rootRef,
    commit: surface === null ? null : setView,
    setting: { tilt, azimuth },
    turntable: galaxyView.turntable,
    scene: sceneRef,
    movers: moversRef,
    clock: motion.clock,
    live: liveRef,
    replan: replanAll,
    badge: badgeRef,
    sceneId: scene,
    zoomView,
    setZoomView,
    plainWheelZooms: surface !== "home",
  });
  const hint = scene === null || props.emptyHint === undefined ? null : emptyHintAt(layout, scene.camera, scene.viewport);
  const starGradient = `${uid}-star`;
  const starDepth = starItem?.depth ?? 0;
  // 每段弧在远、近两张平面里各有一条 path（只有一条有 d）：转台拖动时 applyProjection 直接把 d 挪到另一边
  const arcPaths = (plane: "back" | "front") =>
    arcs.map((arc) => (
      <path
        key={arc.key}
        className={arc.expected ? "galaxy-orbit galaxy-orbit-expected" : "galaxy-orbit"}
        data-arc={arc.key}
        data-plane={plane}
        d={(arc.depth > starDepth) === (plane === "back") ? arc.d : ""}
      />
    ));
  const planetById = new Map(layout.planets.map((planet) => [planet.id, planet]));
  const rockById = new Map(layout.rocks.map((rock) => [rock.id, rock]));
  const clickableDust = live !== null && layout.belt !== null && layout.belt.particles.length <= DUST_CLICK_MAX;
  const body = (mover: Mover, layer: "far" | "near") => {
    // 碎石块只画在最上层（overlay）
    if (mover.kind === "rock") return null;
    if (mover.id === companionId && binary !== null && geo !== null) {
      // 伴星：另一座星系的主星，按它自己的设计稿画（行星与碎石不画，见 binary.ts）
      return (
        <OrbitChain key={`${layer}-${mover.id}`} mover={mover} layer={layer} binary={{ a: geo.sep, centered: false }}>
          <Local box={square(mover.r * starExtentRatio(binary.design) + 2)}>
            <g className="galaxy-companion" data-companion={binary.workspaceId} data-r={mover.r.toFixed(1)}>
              <StarBody design={binary.design} x={0} y={0} r={mover.r} uid={`${uid}-${layer}-companion`} gazeKey={`star:${binary.workspaceId}`} />
            </g>
          </Local>
        </OrbitChain>
      );
    }
    const planet = planetById.get(mover.id);
    if (planet === undefined) return null;
    const copyUid = `${uid}-${layer}-${mover.id}`;
    // 每颗行星都是一个带两只竖胶囊眼的小天体（与设计面板同一个 BodyFigure）；子智能体行星按它的设计稿画
    const agent = agents?.get(mover.id);
    return (
      <OrbitChain key={`${layer}-${mover.id}`} mover={mover} layer={layer}>
        <Local box={square(mover.r * 1.6 + 2)}>
          <g className="gd-figure galaxy-planet-figure" data-masked={plan.masked.has(mover.id) || undefined} data-planet={mover.id} data-composition={planet.composition} data-state={planet.state ?? undefined} data-r={mover.r.toFixed(1)}>
            <BodyFigure art={bodyArt(planetFaceDesign(planet.composition, agent?.surface ?? null, agent?.eyeStyle), "planet", mover.r)} uid={`${copyUid}-f`} gazeKey={`planet:${mover.id}`} />
          </g>
        </Local>
      </OrbitChain>
    );
  };
  // 最上层：跟着天体走的碎石块、名字、锁定框、引线与命中圈（相对星体中心画，排布见 plan）。
  // 每颗天体的那一串 div 永远挂着（转动层的动画挂在 DOM 上，卸了再挂就丢了相位），排布变了只换里面的内容。
  // 碎石块只在这一层画一份：它在最外圈，不会被别的轨道线划过；转到主星背后、和主星重叠时整块藏起来（plan.hidden）。
  const overlayContent = (mover: Mover): { box: Box; content: ReactNode } | null => {
    if (plan.hidden.has(mover.id)) return null;
    if (mover.id === companionId && binary !== null) {
      // 伴星：名字写在星体下方，单击出质量卡
      const w = binary.name.length * glyphPx + 8;
      const box = union(square(mover.r + 6), { x0: -w, y0: 0, x1: w, y1: mover.r + glyphPx * 2 + 4 });
      return {
        box,
        content: (
          <>
            <text className="galaxy-companion-name" x={0} y={mover.r + glyphPx + 2} textAnchor="middle" dominantBaseline="central">
              {binary.name}
            </text>
            {live !== null && (
              <GalaxyTarget kind="companion" id={mover.id} x={0} y={0} r={mover.r} label={t.gravity.cardLabel(binary.name)} selected={selected === mover.id} onActivate={() => toggleSelected(mover.id)} />
            )}
          </>
        ),
      };
    }
    if (mover.kind === "planet") {
      const name = agents?.get(mover.id)?.name;
      const tag = plan.names.get(mover.id);
      const target = live !== null && agents !== undefined;
      if ((tag === undefined || name === undefined) && !target) return null;
      let box = square(mover.r + 6);
      if (tag !== undefined && name !== undefined) {
        const w = name.length * glyphPx + 8;
        box = union(box, { x0: tag.dx - w, y0: tag.dy - glyphPx, x1: tag.dx + w, y1: tag.dy + glyphPx });
      }
      const label = t.gravity.cardLabel(name ?? mover.id);
      return {
        box,
        content: (
          <>
            {tag !== undefined && name !== undefined && (
              <text className="galaxy-name-text" data-planet={mover.id} x={tag.dx} y={tag.dy} textAnchor={tag.anchor} dominantBaseline="central">
                {name}
              </text>
            )}
            {target && live !== null && (
              <GalaxyTarget kind="planet" id={mover.id} x={0} y={0} r={mover.r} label={label} selected={selected === mover.id} onActivate={() => toggleSelected(mover.id)} />
            )}
          </>
        ),
      };
    }
    const rock = rockById.get(mover.id);
    if (rock === undefined) return null;
    const shape = <path className="galaxy-rock" data-rock={mover.id} data-state={rock.state} d={rockPath(0, 0, mover.r, mover.id)} />;
    if (rock.label === "") return { box: square(mover.r + 2), content: shape };
    const callout = plan.callouts.get(mover.id);
    const title = truncateLabel(rock.label);
    const text = rock.state === "waiting" ? `${t.agents.status.waiting} · ${title}` : title;
    const geo = callout === undefined ? null : calloutGeometry({ id: mover.id, x: 0, y: 0, r: mover.r, state: rock.state, text, rank: 0 }, callout.dir, callout.lift, glyphPx);
    const frameHalf = lockFrame(mover.r).half;
    let box = square(Math.max(frameHalf + 2, mover.r + 8));
    if (geo !== null) box = union(box, { x0: geo.box.x0 - 4, y0: geo.box.y0 - 4, x1: geo.box.x1 + 4, y1: geo.box.y1 + 4 });
    // 悬停名字（没有引线的那块）：写在右边
    if (geo === null) box = union(box, { x0: 0, y0: -glyphPx, x1: mover.r + 7 + rock.label.length * glyphPx, y1: glyphPx });
    const open = live === null ? undefined : () => live.actions.openSession(mover.id);
    const label = t.agents.openRock(rock.label);
    return {
      box,
      content: (
        <>
          {shape}
          {geo !== null && <path className="galaxy-lock" data-state={rock.state} data-planet={mover.id} d={rock.state === "recent" ? recentFramePath(0, 0, mover.r) : lockFramePath(0, 0, mover.r)} />}
          {geo !== null && (
            // 引线上的字也能点（鼠标）：与它那块碎石同一个去处；键盘焦点只落在碎石上，不重复一个 tab 位
            <g className="galaxy-callout" data-planet={mover.id} data-state={rock.state} data-dir={geo.dir} data-link={open === undefined ? undefined : "true"} onClick={open}>
              <path className="galaxy-callout-line" d={`M${geo.start.x.toFixed(1)} ${geo.start.y.toFixed(1)}L${geo.elbow.x.toFixed(1)} ${geo.elbow.y.toFixed(1)}L${geo.end.x.toFixed(1)} ${geo.end.y.toFixed(1)}`} />
              <text className="galaxy-callout-text" x={geo.textX} y={geo.textY} textAnchor={geo.anchor}>
                {text}
              </text>
            </g>
          )}
          {open !== undefined ? (
            // 能点的碎石：一个键盘可达的按钮（role=button + tabIndex），key 按 id 稳定——它在动，焦点不丢
            <g
              className="galaxy-tag galaxy-target"
              data-target="rock"
              data-planet={mover.id}
              role="button"
              tabIndex={0}
              aria-label={label}
              onClick={open}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                open();
              }}
            >
              <title>{label}</title>
              <circle className="galaxy-hit" r={Math.max(mover.r + 7, 12)} />
              <circle className="galaxy-target-ring" r={mover.r + 4} />
              {geo === null && (
                <text className="galaxy-tag-text" x={mover.r + 7} y={0} textAnchor="start" dominantBaseline="central">
                  {title}
                </text>
              )}
            </g>
          ) : (
            geo === null && (
              <g className="galaxy-tag">
                <circle className="galaxy-hit" r={mover.r + 7} />
                <text className="galaxy-tag-text" x={mover.r + 7} y={0} textAnchor="start" dominantBaseline="central">
                  {title}
                </text>
              </g>
            )
          )}
        </>
      ),
    };
  };
  const overlay = (mover: Mover) => {
    const inner = overlayContent(mover);
    return (
      <OrbitChain key={`top-${mover.id}`} mover={mover} layer="top" {...(mover.id === companionId && geo !== null ? { binary: { a: geo.sep, centered: false } } : {})}>
        {inner !== null && <Local box={inner.box}>{inner.content}</Local>}
      </OrbitChain>
    );
  };
  const width = scene?.viewport.width ?? 0;
  const height = scene?.viewport.height ?? 0;
  const plane = (children: ReactNode, className = "gx-plane") => (
    <svg className={className} width={width} height={height} viewBox={`0 0 ${Math.max(width, 1)} ${Math.max(height, 1)}`}>
      {children}
    </svg>
  );
  // 碎石密度「全部」照旧裁成远近两半（近侧碎石盖在主星前面）；低于「全部」整条画在主星背后（省电，见 BeltHalf）
  const wholeBelt = galaxyView.dustKeep < 1;
  const beltHalf = (side: "far" | "near") =>
    scene === null || layout.belt === null || look === null || (wholeBelt && side === "near") ? null : (
      <BeltHalf
        side={wholeBelt ? "whole" : side}
        belt={layout.belt}
        camera={scene.camera}
        viewport={scene.viewport}
        look={look}
        capturing={capturing}
        clickable={clickableDust}
        onOpen={live === null ? null : live.actions.openSession}
        openLabel={t.agents.openRock}
      />
    );
  const total = layout.belt?.count ?? 0;
  // 联星：整座星系（这一层以内的一切）跟着本星绕质心走
  const wrapBinary = (children: ReactNode): ReactNode =>
    selfMover === null || geo === null ? (
      children
    ) : (
      <OrbitChain mover={selfMover} layer="top" binary={{ a: geo.r1, centered: true }}>
        {children}
      </OrbitChain>
    );
  // 质量卡：选中的那颗此刻的数
  const card: CardBody | null = (() => {
    if (selected === null || starless) return null;
    if (selected === "star") {
      return { id: "star", kind: "star", name: props.starName ?? props.starDesign?.star?.name ?? props.label, massUi: starMassUi, density: starDensity, looksBigger: false };
    }
    if (selected === companionId && binary !== null && companionStar !== null) {
      return { id: selected, kind: "companion", name: binary.name, massUi: companionStar.mass, density: companionDensity, looksBigger: false };
    }
    const planet = planetSpecById.get(selected);
    const mover = baseMovers.find((m) => m.id === selected);
    if (planet === undefined || mover === undefined) return null;
    const density = planet.density !== undefined && planet.density > 0 ? planet.density : DENSITY[planet.composition];
    return { id: planet.id, kind: "planet", name: agents?.get(planet.id)?.name ?? planet.id, massUi: planet.mass, density, looksBigger: starItem !== undefined && mover.r > starItem.r };
  })();
  return (
    <div
      ref={rootRef}
      className="home-galaxy gx-root"
      role={live === null && handlers === null ? "img" : "group"}
      aria-label={props.label}
      aria-description={handlers === null ? undefined : galaxyView.turntable ? t.agents.tiltHint : t.agents.tiltHintVertical}
      tabIndex={handlers === null ? undefined : 0}
      data-tilt-drag={handlers === null ? undefined : "true"}
      data-tilt={tilt}
      data-azimuth={azimuth}
      {...(handlers ?? {})}
      data-planets={starless ? 0 : layout.planets.length}
      data-scan={scanOn && !starless ? "on" : undefined}
      data-binary={binary?.workspaceId}
      data-selected={selected ?? undefined}
      data-rocks={starless || layout.rockOrbit === null ? 0 : layout.rocks.length}
      data-starless={starless || undefined}
      data-elevation={scene === null ? undefined : scene.elevation.toFixed(1)}
      data-ecc={layout.ecc}
      data-min-planet={scene !== null && scene.minPlanetPx > 0 ? scene.minPlanetPx.toFixed(1) : undefined}
      data-hidden={layout.hidden}
      data-sessions={total}
      data-dust={layout.belt?.particles.length ?? 0}
      data-belt={layout.belt === null ? undefined : `${layout.belt.inner.toFixed(1)}-${layout.belt.outer.toFixed(1)}`}
    >
      {scene !== null && scanOn && !starless && (
        <ScanGrid width={width} height={height} running={motion.running} clock={motion.clock} frameAt={scanFrameAt} redraw={scanRedraw} />
      )}
      {scene !== null && geo !== null && starItem !== undefined && plane(binaryRings(geo, scene.camera, scene.viewport, starItem))}
      {scene !== null &&
        wrapBinary(
        <>
          {plane(arcPaths("back"))}
          <div className="gx-layer">
            {beltHalf("far")}
            {/* 远半圈按远近叠：外圈离镜头更远，先画（倒序）；近半圈外圈更近，后画（正序）。主星前后由两层分开 */}
            {[...movers].reverse().map((mover) => body(mover, "far"))}
          </div>
          {starItem !== undefined &&
            !starless &&
            plane(
              <>
                <defs>
                  <radialGradient id={starGradient} cx="50%" cy="50%" r="50%" fx="38%" fy="34%">
                    <stop offset="0%" className="galaxy-star-hi" />
                    <stop offset="100%" className="galaxy-star-lo" />
                  </radialGradient>
                </defs>
                <g className="gx-star-wrap" data-star-wrap="" data-x={starItem.x} data-y={starItem.y} data-r={starItem.r}>
                  {props.starDesign !== undefined ? (
                    <StarBody design={props.starDesign} x={starItem.x} y={starItem.y} r={starItem.r} uid={`${uid}-sf`} gazeKey={`star:${workspaceId ?? uid}`} />
                  ) : (
                    <circle cx={starItem.x} cy={starItem.y} r={starItem.r} fill={`url(#${starGradient})`} />
                  )}
                </g>
              </>,
            )}
          {plane(arcPaths("front"))}
          <div className="gx-layer">
            {beltHalf("near")}
            {movers.map((mover) => body(mover, "near"))}
          </div>
          {plane(
            <>
              <text ref={probeRef} className="galaxy-name-text" x={-999} y={-999} aria-hidden="true">
                {""}
              </text>
              {/* 主星能点：一层透明命中圈叠在天体上（键盘可达，悬停 / 聚焦亮一圈细环） */}
              {live !== null && starItem !== undefined && (
                <g className="galaxy-targets gx-star-wrap" data-star-wrap="" data-x={starItem.x} data-y={starItem.y} data-r={starItem.r}>
                  <GalaxyTarget
                    kind="star"
                    id="star"
                    x={starItem.x}
                    y={starItem.y}
                    r={starItem.r}
                    label={t.gravity.cardLabel(props.starName ?? props.starDesign?.star?.name ?? props.label)}
                    selected={selected === "star"}
                    onActivate={() => toggleSelected("star")}
                  />
                </g>
              )}
              {hint !== null && props.emptyHint !== undefined && (
                <text className="galaxy-empty-hint" x={hint.x} y={hint.y} textAnchor="middle" dominantBaseline="central">
                  {props.emptyHint}
                </text>
              )}
            </>,
            "gx-plane gx-top",
          )}
          {!starless && <div className="gx-layer gx-top">{movers.map(overlay)}</div>}
        </>,
        )}
      {scene !== null && handlers !== null && !starless && <ScanToggle />}
      {card !== null && (
        <MassCard
          body={card}
          starMassUi={starMassUi}
          onClose={() => setSelected(null)}
          onDesign={
            live === null
              ? null
              : card.kind === "star"
                ? () => live.actions.openStar(live.workspaceId)
                : card.kind === "planet"
                  ? () => live.actions.openPlanet(live.workspaceId, card.id)
                  : binary === null
                    ? null
                    : () => live.actions.openStar(binary.workspaceId)
          }
        />
      )}
      {/*
        「全部 N 条会话」：不占画面的入口（2026-11-24 起每条会话都画成碎石，不再有「另有 N 条」那行字）。
        平时视觉隐藏，键盘 Tab 到它时才在左下角出现；读屏念它。碎石几百颗时单颗不可点，键盘要回旧会话就从这里去右栏树状图。
      */}
      {/* 拖动中 / 刚按过方向键：角落写「俯角 · 方位角」；松手后屏幕安全布局把这块画布抬高了就在旁边写一句。文字由 useTurntable 直接写 */}
      {handlers !== null && (
        <span ref={badgeRef} className="galaxy-tilt-badge" role="status">
          <span className="galaxy-tilt-value" />
          <span className="galaxy-tilt-raised" hidden />
        </span>
      )}
      {/*
        角落那一列：在跑 / 等你 / 最近、但这一刻在画面上拉不出引线的会话（碎石块那一圈被收掉、或引线放不下），
        不因为视角消失（overlay-plan.ts）。最多四行，多的写「另 N 条」去树状图
      */}
      {plan.spill.length > 0 && (
        <ul className="galaxy-spill" aria-label={t.agents.spillLabel}>
          {plan.spill.slice(0, SPILL_ROWS).map((target) => (
            <li key={target.id} data-state={target.state}>
              {live !== null ? (
                <button type="button" className="galaxy-spill-row" onClick={() => live.actions.openSession(target.id)} title={t.agents.openRock(target.text)}>
                  {target.text}
                </button>
              ) : (
                <span className="galaxy-spill-row">{target.text}</span>
              )}
            </li>
          ))}
          {plan.spill.length > SPILL_ROWS && (
            <li data-state="more">
              {live !== null ? (
                <button type="button" className="galaxy-spill-row" onClick={live.actions.openTree}>
                  {t.agents.spillMore(plan.spill.length - SPILL_ROWS)}
                </button>
              ) : (
                <span className="galaxy-spill-row">{t.agents.spillMore(plan.spill.length - SPILL_ROWS)}</span>
              )}
            </li>
          )}
        </ul>
      )}
      {live !== null && total > 0 && (
        <button type="button" className="galaxy-all" onClick={live.actions.openTree}>
          {t.agents.allSessions(total)}
        </button>
      )}
    </div>
  );
});


/**
 * 联星的两圈（两颗主星各自绕质心走的路，虚线）与质心记号（一个小十字）：画在这座星系之下、不跟着本星走。
 * 质心就是画面上主星原来的钉点（屏幕安全布局的转轴）
 */
function binaryRings(geo: BinaryGeometry, camera: Camera, vp: Viewport, star: { x: number; y: number }): ReactNode {
  const ring = (a: number): string => {
    const frame = orbitFrame(a, 0, 0, camera, vp, 0);
    let d = "";
    for (let i = 0; i <= 72; i++) {
      const theta = (i / 72) * Math.PI * 2;
      d += `${i === 0 ? "M" : "L"}${(frame.cx + frame.m1x * Math.cos(theta) + frame.m2x * Math.sin(theta)).toFixed(1)} ${(frame.cy + frame.m1y * Math.cos(theta) + frame.m2y * Math.sin(theta)).toFixed(1)}`;
    }
    return d;
  };
  const k = 4;
  return (
    <>
      <path className="galaxy-binary-orbit" data-binary-ring="self" d={ring(geo.r1)} />
      <path className="galaxy-binary-orbit" data-binary-ring="companion" d={ring(geo.r2)} />
      <path className="galaxy-barycenter" d={`M${star.x - k} ${star.y}H${star.x + k}M${star.x} ${star.y - k}V${star.y + k}`} />
    </>
  );
}

/**
 * 星系上一颗能点的天体（主星 / 子智能体行星）：透明命中圈 + 悬停 / 聚焦时的一圈细环。
 * role=button、tabIndex=0、Enter / 空格触发；key 按天体 id 稳定，天体在动，焦点不丢。
 */
function GalaxyTarget(props: { kind: "star" | "planet" | "companion"; id: string; x: number; y: number; r: number; label: string; onActivate: () => void; selected?: boolean }) {
  return (
    <g
      className="galaxy-target"
      data-target={props.kind}
      data-planet={props.kind === "star" ? undefined : props.id}
      data-selected={props.selected === true ? "" : undefined}
      aria-pressed={props.selected === true}
      role="button"
      tabIndex={0}
      aria-label={props.label}
      onClick={props.onActivate}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        props.onActivate();
      }}
    >
      <title>{props.label}</title>
      <circle className="galaxy-hit" cx={props.x} cy={props.y} r={props.r + (props.kind === "star" ? 2 : 5)} />
      <circle className="galaxy-target-ring" cx={props.x} cy={props.y} r={props.r + (props.kind === "star" ? 4 : 3)} />
    </g>
  );
}
