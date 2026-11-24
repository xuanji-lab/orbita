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
import { bodyArt, planetFaceDesign, starExtentRatio, type GalaxyDesign, type PlanetDesign } from "../galaxy-designer/design.ts";
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
import { reportElevation, useGalaxyTilt, useGalaxyTiltSetter, useGalaxyView, type GalaxySurface, type GalaxyViewSetter } from "./galaxy-tilt.ts";
import { anglesForSave, anglesLabel, dragAngles, isDragMove, keyAngles, raisedTo, VIEW_DEFAULT, type ViewAngles } from "./tilt-drag.ts";
import { beltSplit, liveProjection, zoomOf, type FrozenScene, type LiveProjection } from "./turntable.ts";

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
function applyProjection(root: HTMLElement, proj: LiveProjection, movers: readonly Mover[], tSec: number): void {
  const byId = new Map(movers.map((mover) => [mover.id, mover]));
  for (const node of root.querySelectorAll<HTMLElement>("[data-orbit]")) {
    const mover = byId.get(node.dataset.orbit ?? "");
    if (mover === undefined) continue;
    const frame = mover.kind === "rock" ? proj.rock : proj.planets.get(mover.id);
    if (frame === null || frame === undefined) continue;
    const m = orbitMatrix(frame);
    node.style.transform = cssMatrix(m);
    const inv = node.querySelector<HTMLElement>("[data-orbit-inv]");
    if (inv !== null) inv.style.transform = cssMatrix(inverseLinear(m));
  }
  // 远近分层每帧按新相机算：主星永远画在它挡住的天体前面
  const far = new Map<string, boolean>();
  for (const mover of movers) far.set(mover.id, moverFar({ ...mover, far: proj.far }, tSec));
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
}

/**
 * 星系空白处拖动 = 转台（规则在 tilt-drag.ts，投影在 turntable.ts）：
 * - 按下不拦：位移 ≤ 4px 是点击，点天体照旧打开；超过才算拖、抓住指针，松手后吞掉那一下 click。
 * - 拖动中冻结布局、每帧（requestAnimationFrame 合并指针事件）只重新投影，直接写 DOM；不 setState、不跑屏幕安全布局。
 * - 松手按 1° 写设置（倾角与设置 › 外观的滑块同一个字段，方位角另一个字段）；设置回填后 React 按新角度跑一次屏幕安全布局，
 *   根节点挂 gx-settling 让轨道矩阵在 SETTLE_MS 内滑过去（减少动效时不挂，直接落位）。
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
  raisedText: (deg: number) => string;
}

type TurntableGesture = { pointerId: number; x: number; y: number; start: ViewAngles; active: boolean; frozen: SceneNow | null; zoom: number };

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
  const settlePending = useRef(false);
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
    const proj = liveProjection(g.frozen, next.tilt, next.azimuth, g.zoom);
    opts.current.live.current = proj;
    lastStar.current = proj.star;
    applyProjection(root, proj, opts.current.movers.current, opts.current.clock.now() / 1000);
    showBadge(anglesLabel(next), null, true);
    const now = performance.now();
    if (now - lastReplan.current > LIVE_FRAME_MS) {
      lastReplan.current = now;
      opts.current.replan();
    }
  };

  /** 落位：按 scene（新角度跑完屏幕安全布局的那一份）把拖动时直接写过的 DOM 全部写回合规的值，带短过渡 */
  const settle = (scene: SceneNow): void => {
    const root = opts.current.root.current;
    opts.current.live.current = null;
    if (root === null) return;
    const animate = !reducedMotion();
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
    applyProjection(root, liveProjection(scene, scene.elevation, scene.azimuth, zoomOf(scene)), opts.current.movers.current, opts.current.clock.now() / 1000);
    lastStar.current = null;
    if (timers.current.settle !== null) window.clearTimeout(timers.current.settle);
    timers.current.settle = window.setTimeout(() => root.classList.remove("gx-settling"), SETTLE_MS + 40);
    opts.current.replan();
    const saved = anglesForSave({ tilt: opts.current.setting.tilt, azimuth: opts.current.setting.azimuth });
    const raised = raisedTo(saved.tilt, scene.elevation);
    showBadge(anglesLabel(saved), raised === null ? null : opts.current.raisedText(raised), false);
  };

  // 新的布局画好之后（设置回填 → React 按新角度跑完屏幕安全布局）落位
  const sceneNow = options.scene.current;
  useLayoutEffect(() => {
    if (!settlePending.current || sceneNow === null) return;
    settlePending.current = false;
    settle(sceneNow);
  });

  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      if (timers.current.badge !== null) window.clearTimeout(timers.current.badge);
      if (timers.current.settle !== null) window.clearTimeout(timers.current.settle);
    },
    [],
  );

  /** 写设置；角度没变（设置不会回填）就直接落位 */
  const commitView = (next: ViewAngles, root: HTMLElement): void => {
    const commit = opts.current.commit;
    const saved = anglesForSave(next);
    const current = opts.current.setting;
    if (!reducedMotion()) root.classList.add("gx-settling");
    // 方向键 / 双击没有拖动帧：主星从此刻画着的位置滑过去
    const scene = opts.current.scene.current;
    if (lastStar.current === null && scene !== null) lastStar.current = liveProjection(scene, scene.elevation, scene.azimuth, zoomOf(scene)).star;
    if (commit === null || (saved.tilt === current.tilt && saved.azimuth === current.azimuth)) {
      if (scene !== null) settle(scene);
      return;
    }
    settlePending.current = true;
    commit(saved);
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
    if (keep && final !== null) commitView(final, root);
    else {
      const scene = opts.current.scene.current;
      if (scene !== null) settle(scene);
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
      gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: currentView(), active: false, frozen: null, zoom: 1 };
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
        g.zoom = g.frozen === null ? 1 : zoomOf(g.frozen);
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
      showBadge(anglesLabel(VIEW_DEFAULT), null, false);
      commitView(VIEW_DEFAULT, event.currentTarget);
    },
    onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      const next = keyAngles(currentView(), event.key, opts.current.turntable);
      if (next === null) return;
      event.preventDefault();
      showBadge(anglesLabel(next), null, false);
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
function useGalaxyMotion(target: RefObject<HTMLDivElement | null>, signature: string): { running: boolean; clock: GalaxyClock } {
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
    const inputs: MotionInputs = { hasFocus: document.hasFocus(), visibilityState: document.visibilityState, onScreen: true, reducedMotion: media.matches };
    const sync = () => {
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
}

const EMPTY_PLAN: OverlayPlan = { key: "", hidden: new Set(), callouts: new Map(), names: new Map(), masked: new Set() };

/** 禁区与主星外缘之间至少留的空（px） */
const SAFE_AVOID_GAP = 12;

function boxesOverlap(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

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
function OrbitChain(props: { mover: Mover; layer: "far" | "near" | "top"; children: ReactNode; className?: string }) {
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
      data-body={props.layer === "top" ? undefined : mover.id}
      data-layer={props.layer}
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
  side: "far" | "near";
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
  const box = beltBox(props.side, L, split.offset);
  const half: CSSProperties = box;
  const back: CSSProperties = { left: -box.left, top: -box.top };
  return (
    <div className="gx-node" data-belt-outer="" style={{ transform: cssMatrix(m) }}>
      <div className="gx-node" data-belt-rot="" style={{ transform: `rotate(${split.chiDeg.toFixed(3)}deg)` }}>
      <div className="gx-half" data-belt-half={props.side} data-l={L} style={half}>
        <div className="gx-node" data-belt-back="" style={back}>
          <div className="gx-node" data-belt-unrot="" style={{ transform: `rotate(${(-split.chiDeg).toFixed(3)}deg)` }}>
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
  const surface = props.surface === undefined ? (props.fill === true ? "page" : "home") : props.surface;
  // 设置页的小预览（surface = null）不接拖动：那里有滑块
  const setView = useGalaxyTiltSetter();
  const spec = useMemo(() => ({ ...props.spec, eccentricity: orbitE }), [props.spec, orbitE]);
  const baseLayout = useMemo(() => layoutGalaxy(spec), [spec]);
  const scene = useMemo(() => {
    if (size === null || size.width < 2 || size.height < 2) return null;
    // 工作区页 / 右栏：屏幕安全布局（screen-safe.ts）——在屏幕坐标里排轨道，任何相位上天体都不在画面上相撞
    // fill：编排 New Task 页（星系占输入框上方整块，高度封顶放宽）；不是 fill：单智能体首页输入框下面那条带子
    const box = galaxyBox(size.width, size.height, props.fill === true ? GALAXY_MAX_FILL : GALAXY_MAX);
    const readableMax = props.agents !== undefined && props.agents.size > 0 ? AGENT_READABLE_MAX : PLANET_READABLE_MAX;
    const safe = fitScreenSafe(spec, size.width, size.height, box, tilt, readableMax, azimuth);
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
  }, [size, spec, props.agents, props.fill, tilt, azimuth, props.avoid, props.starDesign]);
  const actualElevation = scene?.elevation ?? null;
  useLayoutEffect(() => {
    if (surface === null) return;
    // 卸载时不清：设置页打开时编排页的星系已经卸了，那一句说的是「上次画这块画布时」
    reportElevation(surface, tilt, actualElevation);
  }, [surface, tilt, actualElevation]);
  const layout: GalaxyLayout = scene === null ? baseLayout : starless ? { ...scene.layout, planets: [] } : scene.layout;
  const arcs: OrbitArc[] = useMemo(() => (scene === null || starless ? [] : orbitArcs(layout, scene.camera, scene.viewport)), [scene, layout, starless]);
  // 一张 t = 0 的快照：主星的位置与半径、碎石块的大小（碎石 < 行星的规矩在 drawFrame 里）
  const snapshot = useMemo(() => (scene === null ? [] : drawFrame({ ...layout, belt: null }, scene.camera, scene.viewport, [], 0, scene.minPlanetPx)), [scene, layout]);
  const starItem = snapshot.find((item) => item.kind === "star");
  const rockPx = snapshot.find((item): item is RockItem => item.kind === "rock")?.r ?? ROCK_PX;
  const movers = useMemo(() => (scene === null ? [] : moversOf(layout, scene.camera, scene.viewport, scene.minPlanetPx, rockPx)), [scene, layout, rockPx]);
  const look = layout.belt === null ? null : dustLookOf(layout.belt.count, starless);
  const ids = useMemo(() => [...layout.rocks.map((rock) => rock.id), ...(layout.belt?.particles.map((particle) => particle.id) ?? [])], [layout]);
  const signature = useMemo(
    () =>
      JSON.stringify([
        size,
        movers.map((m) => [m.id, m.phase, m.ecc, m.omega, m.frame.cx, m.frame.cy, m.frame.m1x, m.frame.m2y]),
        layout.belt === null ? null : [layout.belt.inner, layout.belt.outer, layout.belt.particles.length],
        ids.length,
      ]),
    [size, movers, layout.belt, ids.length],
  );
  const motion = useGalaxyMotion(rootRef, signature);
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
      const star = items.find((item) => item.kind === "star");
      const starDisc = star === undefined ? null : { x: star.x, y: star.y, r: star.r * starExtent };
      const planets = items.filter((item): item is PlanetItem => item.kind === "planet");
      const rocks = items.filter((item): item is RockItem => item.kind === "rock");
      const hidden = new Set<string>();
      const masked = new Set<string>();
      const avoid = props.avoid ?? null;
      for (const body of [...planets, ...rocks]) {
        const reach = body.kind === "rock" ? lockFrame(body.r).half : body.r;
        if (starDisc !== null && star !== undefined && body.depth > star.depth && Math.hypot(body.x - starDisc.x, body.y - starDisc.y) < starDisc.r + reach) hidden.add(body.planetId);
        // 走进禁区（标题与输入框那一块）：整颗淡出，名字、框、命中圈都不画
        if (avoid !== null && boxesOverlap(avoid, { x0: body.x - reach, y0: body.y - reach, x1: body.x + reach, y1: body.y + reach })) {
          masked.add(body.planetId);
          hidden.add(body.planetId);
        }
      }
      const visiblePlanets = planets.filter((planet) => !hidden.has(planet.planetId));
      const visibleRocks = rocks.filter((rock) => !hidden.has(rock.planetId));
      const names = new Map<string, { dx: number; dy: number; anchor: "start" | "middle" | "end" }>();
      const tags =
        agents === undefined
          ? []
          : placeNameTags({
              planets: visiblePlanets.map((planet) => ({ id: planet.planetId, x: planet.x, y: planet.y, r: planet.r, name: agents.get(planet.planetId)?.name ?? "" })),
              bodies: [...planets.map((body) => ({ id: body.planetId, x: body.x, y: body.y, r: body.r })), ...rocks.map((body) => ({ id: body.planetId, x: body.x, y: body.y, r: lockFrame(body.r).half }))],
              star: starDisc,
              width: scene.viewport.width,
              height: scene.viewport.height,
              glyphPx,
            });
      for (const tag of tags) {
        if (avoid !== null && boxesOverlap(avoid, tag.box)) continue;
        const planet = planets.find((p) => p.planetId === tag.id);
        if (planet !== undefined) names.set(tag.id, { dx: Math.round((tag.x - planet.x) * 10) / 10, dy: Math.round((tag.y - planet.y) * 10) / 10, anchor: tag.anchor });
      }
      const callouts = new Map<string, { dir: CalloutDir; lift: number }>();
      if (!starless) {
        const bodies = agents === undefined ? visiblePlanets : [...visiblePlanets.map((planet) => ({ ...planet, label: null })), ...visibleRocks];
        const targets: CalloutTarget[] = [];
        for (const body of bodies) {
          // recent（最近但没在做事的会话，只有碎石块有）也拉引线写名字，排在在做事的后面、样式轻一档
          if (body.state !== "waiting" && body.state !== "running" && body.state !== "recent") continue;
          if (body.label === null || body.label === "") continue;
          const title = truncateLabel(body.label);
          targets.push({ id: body.planetId, x: body.x, y: body.y, r: body.r, state: body.state, text: body.state === "waiting" ? `${t.agents.status.waiting} · ${title}` : title, rank: calloutRank(body.state, rankOf.get(body.planetId) ?? 0) });
        }
        const placed = placeCallouts({
          targets,
          bodies: bodies.map((body) => ({ id: body.planetId, x: body.x, y: body.y, r: body.r })),
          star: starDisc,
          width: scene.viewport.width,
          height: scene.viewport.height,
          glyphPx,
          budget: calloutBudget(scene.viewport.width),
          previous: previousCallouts.current,
          reserved: avoid === null ? tags.map((tag) => tag.box) : [...tags.map((tag) => tag.box), avoid],
        });
        for (const item of placed) callouts.set(item.id, { dir: item.dir, lift: item.lift });
        previousCallouts.current = new Map(callouts);
      }
      const key = JSON.stringify([[...hidden].sort(), [...masked].sort(), [...callouts].map(([id, c]) => `${id}:${c.dir}${c.lift}`), [...names].map(([id, n]) => `${id}:${n.anchor}`), glyphPx]);
      return { key, hidden, callouts, names, masked };
    },
    [scene, layout, starless, starExtent, agents, glyphPx, rankOf, t, props.avoid],
  );
  const { plan, replan } = usePlan(scene === null ? null : compute, motion.clock, motion.running, signature);
  // 转台：拖动按下时冻结的那一份（布局 + 角度），与给 applyProjection 的 movers
  const sceneRef = useRef<SceneNow | null>(null);
  sceneRef.current =
    scene === null ? null : { camera: scene.camera, viewport: scene.viewport, layout, width: scene.size.width, height: scene.size.height, box: scene.box, elevation: scene.elevation, azimuth };
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
    replan,
    badge: badgeRef,
    raisedText: t.agents.tiltRaised,
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
    const planet = planetById.get(mover.id);
    if (planet === undefined) return null;
    const copyUid = `${uid}-${layer}-${mover.id}`;
    // 每颗行星都是一个带两只竖胶囊眼的小天体（与设计面板同一个 BodyFigure）；子智能体行星按它的设计稿画
    const agent = agents?.get(mover.id);
    return (
      <OrbitChain key={`${layer}-${mover.id}`} mover={mover} layer={layer}>
        <Local box={square(mover.r * 1.6 + 2)}>
          <g className="gd-figure galaxy-planet-figure" data-masked={plan.masked.has(mover.id) || undefined} data-planet={mover.id} data-composition={planet.composition} data-state={planet.state ?? undefined} data-r={mover.r.toFixed(1)}>
            <BodyFigure art={bodyArt(planetFaceDesign(planet.composition, agent?.surface ?? null, agent?.eyeStyle), "planet", mover.r)} uid={`${copyUid}-f`} />
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
      const label = t.agents.openPlanet(name ?? mover.id);
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
              <GalaxyTarget kind="planet" id={mover.id} x={0} y={0} r={mover.r} label={label} onActivate={() => live.actions.openPlanet(live.workspaceId, mover.id)} />
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
      <OrbitChain key={`top-${mover.id}`} mover={mover} layer="top">
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
  const beltHalf = (side: "far" | "near") =>
    scene === null || layout.belt === null || look === null ? null : (
      <BeltHalf
        side={side}
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
      {scene !== null && (
        <>
          {plane(arcPaths("back"))}
          <div className="gx-layer">
            {beltHalf("far")}
            {movers.map((mover) => body(mover, "far"))}
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
                    <StarBody design={props.starDesign} x={starItem.x} y={starItem.y} r={starItem.r} uid={`${uid}-sf`} />
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
                    label={t.agents.openStar(props.starName ?? props.starDesign?.star?.name ?? props.label)}
                    onActivate={() => live.actions.openStar(live.workspaceId)}
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
        </>
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
      {live !== null && total > 0 && (
        <button type="button" className="galaxy-all" onClick={live.actions.openTree}>
          {t.agents.allSessions(total)}
        </button>
      )}
    </div>
  );
});


/**
 * 星系上一颗能点的天体（主星 / 子智能体行星）：透明命中圈 + 悬停 / 聚焦时的一圈细环。
 * role=button、tabIndex=0、Enter / 空格触发；key 按天体 id 稳定，天体在动，焦点不丢。
 */
function GalaxyTarget(props: { kind: "star" | "planet"; id: string; x: number; y: number; r: number; label: string; onActivate: () => void }) {
  return (
    <g
      className="galaxy-target"
      data-target={props.kind}
      data-planet={props.kind === "planet" ? props.id : undefined}
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
