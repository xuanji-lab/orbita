import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import {
  drawFrame,
  frameViewport,
  FRAME_EXTENT,
  CAMERA_ELEVATION_DEG,
  CAPTURE_MS,
  DUST_CLICK_MAX,
  elevationFor,
  galaxyBox,
  galaxySpecOf,
  galaxyFixtureOf,
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
  spinFrames,
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
  placeNameTags,
  type Box,
  type CalloutDir,
  type CalloutTarget,
} from "./callouts.ts";
import { useGalaxyActions, type GalaxyActions } from "./galaxy-actions.ts";

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

/** 时钟动画的跨度：一个没有效果的 Web Animation，只当「星系走了多少毫秒」的表（与转动层同一条时间线，暂停一起停） */
const CLOCK_SPAN_MS = 1e12;

function clockMs(clock: Animation | null): number {
  const time = clock?.currentTime;
  return typeof time === "number" ? time : 0;
}

/**
 * 公转（galaxy-motion.ts）：根节点里每个 [data-spin] 元素挂一个无限循环的 transform 动画，由合成器线程跑，React 不再每帧重绘。
 * 停的条件——页面隐藏、窗口失焦、星系滚出 / 被藏出视口（IntersectionObserver）、系统要求减少动效——任何一个成立，
 * 时钟与所有转动层一起 pause()，恢复时一起 play()（同一帧起步，相位不错开）。卸载时 cancel()。
 * 现在跑不跑写在根节点的 data-motion 上（running / paused），验收时可直接读。
 */
function useGalaxyMotion(target: RefObject<HTMLDivElement | null>, signature: string): { running: boolean; clock: RefObject<Animation | null> } {
  const clock = useRef<Animation | null>(null);
  const spins = useRef<Animation[]>([]);
  const runningRef = useRef(false);
  const [running, setRunning] = useState(false);
  useLayoutEffect(() => {
    const el = target.current;
    if (el === null) return;
    const timer = new Animation(new KeyframeEffect(null, null, { duration: CLOCK_SPAN_MS }), document.timeline);
    timer.currentTime = 0;
    timer.pause();
    clock.current = timer;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const inputs: MotionInputs = { hasFocus: document.hasFocus(), visibilityState: document.visibilityState, onScreen: true, reducedMotion: media.matches };
    const sync = () => {
      const run = motionAllowed(inputs);
      if (run !== runningRef.current) {
        runningRef.current = run;
        for (const anim of [timer, ...spins.current]) {
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
      timer.cancel();
      clock.current = null;
      runningRef.current = false;
    };
  }, [target]);
  // 几何一变（画布尺寸、轨道、会话数）就把转动层的动画重挂一遍：相位都从同一个时钟读，不跳
  useLayoutEffect(() => {
    const el = target.current;
    if (el === null) return;
    for (const anim of spins.current) anim.cancel();
    const now = clockMs(clock.current);
    const list: Animation[] = [];
    for (const node of el.querySelectorAll<HTMLElement>("[data-spin]")) {
      const from = Number(node.dataset.from);
      const to = Number(node.dataset.to);
      const period = Number(node.dataset.period);
      if (!Number.isFinite(period) || period <= 0) continue;
      const anim = node.animate([{ transform: `rotate(${from}deg)` }, { transform: `rotate(${to}deg)` }], { duration: period, iterations: Infinity, easing: "linear" });
      anim.currentTime = now % period;
      if (!runningRef.current) anim.pause();
      list.push(anim);
    }
    spins.current = list;
  }, [target, signature]);
  return { running, clock };
}

/**
 * 行星 / 碎石块过了换层边界就从主星背后那一层挪到前面那一层（反之亦然）：每颗按到点时间排一个 setTimeout（一圈两次），
 * 不每帧问。两层各有一份同样的 DOM，只切 visibility（不影响正在跑的合成器动画）。
 */
function useSides(target: RefObject<HTMLDivElement | null>, movers: readonly Mover[], clock: RefObject<Animation | null>, running: boolean, signature: string): void {
  useLayoutEffect(() => {
    const el = target.current;
    if (el === null) return;
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const apply = (mover: Mover) => {
      const t = clockMs(clock.current) / 1000;
      const far = moverFar(mover, t);
      for (const node of el.querySelectorAll<HTMLElement>(`[data-body="${CSS.escape(mover.id)}"]`)) {
        const show = (node.dataset.layer === "far") === far;
        node.style.visibility = show ? "" : "hidden";
      }
      if (running && !mover.alwaysNear) timers.set(mover.id, setTimeout(() => apply(mover), msToNextSide(mover, t) + 20));
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
}

const EMPTY_PLAN: OverlayPlan = { key: "", hidden: new Set(), callouts: new Map(), names: new Map() };

function usePlan(compute: ((tSec: number) => OverlayPlan) | null, clock: RefObject<Animation | null>, running: boolean, signature: string): OverlayPlan {
  const [plan, setPlan] = useState<OverlayPlan>(EMPTY_PLAN);
  const computeRef = useRef(compute);
  computeRef.current = compute;
  const lastKey = useRef("");
  useLayoutEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      const fn = computeRef.current;
      if (fn === null) return;
      const next = fn(clockMs(clock.current) / 1000);
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
  return compute === null ? EMPTY_PLAN : plan;
}

/**
 * 一串「跟着轨道走」的 div：轨道矩阵 · 转 −θ · 平移到 R0 ·（捕获位移）· 转 +θ · 轨道矩阵的逆 → 对 children 只是平移。
 * 两个转动层带 data-spin，由 useGalaxyMotion 挂合成器动画。
 */
function OrbitChain(props: { mover: Mover; layer: "far" | "near" | "top"; children: ReactNode; className?: string }) {
  const { mover } = props;
  const m = orbitMatrix(mover.frame);
  const period = periodMs(mover.omega);
  const out = spinFrames(mover.phase, -1);
  const back = spinFrames(mover.phase, 1);
  return (
    <div className={props.className === undefined ? "gx-node" : `gx-node ${props.className}`} style={{ transform: cssMatrix(m) }} data-body={props.layer === "top" ? undefined : mover.id} data-layer={props.layer}>
      <div className="gx-node" data-spin="" data-from={out.from} data-to={out.to} data-period={period}>
        <div className="gx-node" style={{ transform: `translateX(${R0}px)` }}>
          <div className="gx-node" data-capture={mover.id} data-cx={R0} data-cy={0}>
            <div className="gx-node" data-spin="" data-from={back.from} data-to={back.to} data-period={period}>
              <div className="gx-node" style={{ transform: cssMatrix(inverseLinear(m)) }}>
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

/** 碎石带的一半（远半圈在主星之下那层、近半圈在之上那层）：轨道矩阵 · 半平面裁切 · 转 α · 一张静止的碎石 SVG */
function BeltHalf(props: {
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
  const half: CSSProperties = props.side === "far" ? { left: -L, top: -L, width: 2 * L, height: L } : { left: -L, top: 0, width: 2 * L, height: L };
  const back: CSSProperties = props.side === "far" ? { left: L, top: L } : { left: L, top: 0 };
  return (
    <div className="gx-node" style={{ transform: cssMatrix(m) }}>
      <div className="gx-half" style={half}>
        <div className="gx-node" style={back}>
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
  );
}

/**
 * 首页 / 工作区页的星系：一颗主星、若干小得多的行星、一条会话碎石带。数据是真实的（galaxy-data.ts）。
 * 几何在 galaxy.ts（有测试），公转交给合成器（galaxy-motion.ts）：这里只搭一次静止的 DOM。
 * 颜色全部取墨色与发丝线 token（styles.css 的 .home-galaxy），不用 accent：它是这座星系的样子，不是要你点的东西。
 *
 * 画家顺序拆成几层（从下到上）：远半圈轨道弧 → 远半圈的碎石与天体 → 主星 → 近半圈轨道弧 → 近半圈的碎石与天体 →
 * 锁定框 / 引线 / 名字 / 命中圈。天体过了左右两点在两层之间换（useSides）。
 *
 * 编排星系（fill）：每条根会话都是碎石带里的一颗碎石，带子随会话数长大（beltGrowthOf）；新会话从外缘被吸进来（useCaptures）。
 */
export function HomeGalaxy(props: {
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
}) {
  const t = useT();
  const actions = useGalaxyActions();
  const uid = useId().replace(/:/g, "");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const size = useBoxSize(rootRef);
  const fill = props.fill === true;
  const starless = props.starless === true;
  // 工作区页：每条会话都是一颗碎石（不封顶）；单智能体首页的原型带子仍封顶 DUST_CAP
  const spec = useMemo(() => (fill ? { ...props.spec, dustCap: Number.POSITIVE_INFINITY } : props.spec), [props.spec, fill]);
  const baseLayout = useMemo(() => layoutGalaxy(spec), [spec]);
  const scene = useMemo(() => {
    if (size === null || size.width < 2 || size.height < 2) return null;
    // 默认（全局首页那条带子）20° + 460 封顶，与原型一致
    if (!fill) {
      const box = galaxyBox(size.width, size.height, GALAXY_MAX);
      const camera = makeCamera(FRAME_EXTENT, CAMERA_ELEVATION_DEG);
      const viewport = frameViewport(camera, size.width, size.height, box);
      return { camera, viewport, layout: baseLayout, minPlanetPx: 0 };
    }
    // 工作区页 / 右栏：屏幕安全布局（screen-safe.ts）——在屏幕坐标里排轨道，任何相位上天体都不在画面上相撞
    const box = galaxyBox(size.width, size.height, GALAXY_MAX_FILL);
    const readableMax = props.agents !== undefined && props.agents.size > 0 ? AGENT_READABLE_MAX : PLANET_READABLE_MAX;
    const safe = fitScreenSafe(spec, size.width, size.height, box, elevationFor(box), readableMax);
    return { camera: safe.camera, viewport: safe.viewport, layout: safe.layout, minPlanetPx: safe.minPlanetPx };
  }, [baseLayout, size, fill, spec, props.agents]);
  const layout: GalaxyLayout = scene === null ? baseLayout : starless ? { ...scene.layout, planets: [] } : scene.layout;
  const arcs: OrbitArc[] = useMemo(() => (scene === null || starless ? [] : orbitArcs(layout, scene.camera, scene.viewport)), [scene, layout, starless]);
  // 一张 t = 0 的快照：主星的位置与半径、碎石块的大小（碎石 < 行星的规矩在 drawFrame 里）
  const snapshot = useMemo(() => (scene === null ? [] : drawFrame({ ...layout, belt: null }, scene.camera, scene.viewport, [], 0, scene.minPlanetPx, !fill)), [scene, layout, fill]);
  const starItem = snapshot.find((item) => item.kind === "star");
  const rockPx = snapshot.find((item): item is RockItem => item.kind === "rock")?.r ?? ROCK_PX;
  const movers = useMemo(() => (scene === null ? [] : moversOf(layout, scene.camera, scene.viewport, scene.minPlanetPx, !fill, rockPx)), [scene, layout, fill, rockPx]);
  const look = layout.belt === null ? null : dustLookOf(layout.belt.count, starless);
  const ids = useMemo(() => [...layout.rocks.map((rock) => rock.id), ...(layout.belt?.particles.map((particle) => particle.id) ?? [])], [layout]);
  const signature = useMemo(
    () =>
      JSON.stringify([
        size,
        movers.map((m) => [m.id, m.phase, m.omega, m.frame.cx, m.frame.cy, m.frame.m1x, m.frame.m2y]),
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
  const live: { actions: GalaxyActions; workspaceId: string } | null = fill && !starless && actions !== null && workspaceId !== null ? { actions, workspaceId } : null;
  const rankOf = useMemo(() => new Map(layout.planets.map((planet, index) => [planet.id, index])), [layout]);
  const previousCallouts = useRef(new Map<string, { dir: CalloutDir; lift: number }>());
  // 排布：此刻每颗天体在哪（drawFrame 不带碎石带），谁被主星挡住、谁有引线、名字写哪边
  const compute = useCallback(
    (tSec: number): OverlayPlan => {
      if (scene === null) return EMPTY_PLAN;
      const items = drawFrame({ ...layout, belt: null }, scene.camera, scene.viewport, [], tSec, scene.minPlanetPx, !fill);
      const star = items.find((item) => item.kind === "star");
      const starDisc = star === undefined ? null : { x: star.x, y: star.y, r: star.r * starExtent };
      const planets = items.filter((item): item is PlanetItem => item.kind === "planet");
      const rocks = items.filter((item): item is RockItem => item.kind === "rock");
      const hidden = new Set<string>();
      for (const body of [...planets, ...rocks]) {
        const reach = body.kind === "rock" ? lockFrame(body.r).half : body.r;
        if (starDisc !== null && star !== undefined && body.depth > star.depth && Math.hypot(body.x - starDisc.x, body.y - starDisc.y) < starDisc.r + reach) hidden.add(body.planetId);
      }
      const visiblePlanets = planets.filter((planet) => !hidden.has(planet.planetId));
      const visibleRocks = rocks.filter((rock) => !hidden.has(rock.planetId));
      const names = new Map<string, { dx: number; dy: number; anchor: "start" | "middle" | "end" }>();
      const tags =
        agents === undefined || !fill
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
        const planet = planets.find((p) => p.planetId === tag.id);
        if (planet !== undefined) names.set(tag.id, { dx: Math.round((tag.x - planet.x) * 10) / 10, dy: Math.round((tag.y - planet.y) * 10) / 10, anchor: tag.anchor });
      }
      const callouts = new Map<string, { dir: CalloutDir; lift: number }>();
      if (fill && !starless) {
        const bodies = agents === undefined ? visiblePlanets : [...visiblePlanets.map((planet) => ({ ...planet, label: null })), ...visibleRocks];
        const targets: CalloutTarget[] = [];
        for (const body of bodies) {
          if (body.state !== "waiting" && body.state !== "running") continue;
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
          reserved: tags.map((tag) => tag.box),
        });
        for (const item of placed) callouts.set(item.id, { dir: item.dir, lift: item.lift });
        previousCallouts.current = new Map(callouts);
      }
      const key = JSON.stringify([[...hidden].sort(), [...callouts].map(([id, c]) => `${id}:${c.dir}${c.lift}`), [...names].map(([id, n]) => `${id}:${n.anchor}`), glyphPx]);
      return { key, hidden, callouts, names };
    },
    [scene, layout, fill, starless, starExtent, agents, glyphPx, rankOf, t],
  );
  const plan = usePlan(scene === null ? null : compute, motion.clock, motion.running, signature);
  const hint = scene === null || props.emptyHint === undefined ? null : emptyHintAt(layout, scene.camera, scene.viewport);
  const starGradient = `${uid}-star`;
  const starDepth = starItem?.depth ?? 0;
  const backArcs = arcs.filter((arc) => arc.depth > starDepth);
  const frontArcs = arcs.filter((arc) => arc.depth <= starDepth);
  const planetById = new Map(layout.planets.map((planet) => [planet.id, planet]));
  const rockById = new Map(layout.rocks.map((rock) => [rock.id, rock]));
  const clickableDust = live !== null && layout.belt !== null && layout.belt.particles.length <= DUST_CLICK_MAX;
  const orbitPath = (arc: OrbitArc) => <path key={arc.key} className={arc.expected ? "galaxy-orbit galaxy-orbit-expected" : "galaxy-orbit"} d={arc.d} />;
  const body = (mover: Mover, layer: "far" | "near") => {
    if (mover.kind === "rock") {
      const rock = rockById.get(mover.id);
      return (
        <OrbitChain key={`${layer}-${mover.id}`} mover={mover} layer={layer}>
          <Local box={square(mover.r + 2)}>
            <path className="galaxy-rock" data-rock={mover.id} data-state={rock?.state} d={rockPath(0, 0, mover.r, mover.id)} />
          </Local>
        </OrbitChain>
      );
    }
    const planet = planetById.get(mover.id);
    if (planet === undefined) return null;
    const copyUid = `${uid}-${layer}-${mover.id}`;
    if (fill) {
      // 工作区页：每颗行星都是一个带两只竖胶囊眼的小天体（与设计面板同一个 BodyFigure）；子智能体行星按它的设计稿画
      const agent = agents?.get(mover.id);
      return (
        <OrbitChain key={`${layer}-${mover.id}`} mover={mover} layer={layer}>
          <Local box={square(mover.r * 1.6 + 2)}>
            <g className="gd-figure galaxy-planet-figure" data-planet={mover.id} data-composition={planet.composition} data-state={planet.state ?? undefined} data-r={mover.r.toFixed(1)}>
              <BodyFigure art={bodyArt(planetFaceDesign(planet.composition, agent?.surface ?? null), "planet", mover.r)} uid={`${copyUid}-f`} />
            </g>
          </Local>
        </OrbitChain>
      );
    }
    return (
      <OrbitChain key={`${layer}-${mover.id}`} mover={mover} layer={layer}>
        <Local box={square(mover.r + 4)}>
          <defs>
            <radialGradient id={`${copyUid}-l`} cx="50%" cy="50%" r="50%" fx="38%" fy="34%">
              <stop offset="0%" className="galaxy-light" stopOpacity={0.5} />
              <stop offset="100%" className="galaxy-light" stopOpacity={0} />
            </radialGradient>
          </defs>
          {/* 等你的细环只留给单智能体首页的 fixture 星系；工作区页改由锁定框说 */}
          {planet.state === "waiting" && <circle className="galaxy-planet-waiting" r={mover.r + 3} />}
          <circle className="galaxy-planet" data-planet={mover.id} data-composition={planet.composition} data-state={planet.state ?? undefined} r={mover.r} />
          <circle r={mover.r} fill={`url(#${copyUid}-l)`} />
        </Local>
      </OrbitChain>
    );
  };
  // 最上层：跟着天体走的名字、锁定框、引线与命中圈（相对星体中心画，排布见 plan）
  const overlay = (mover: Mover) => {
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
      return (
        <OrbitChain key={`top-${mover.id}`} mover={mover} layer="top">
          <Local box={box}>
            {tag !== undefined && name !== undefined && (
              <text className="galaxy-name-text" data-planet={mover.id} x={tag.dx} y={tag.dy} textAnchor={tag.anchor} dominantBaseline="central">
                {name}
              </text>
            )}
            {target && live !== null && (
              <GalaxyTarget kind="planet" id={mover.id} x={0} y={0} r={mover.r} label={label} onActivate={() => live.actions.openPlanet(live.workspaceId, mover.id)} />
            )}
          </Local>
        </OrbitChain>
      );
    }
    const rock = rockById.get(mover.id);
    if (rock === undefined || rock.label === "") return null;
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
    return (
      <OrbitChain key={`top-${mover.id}`} mover={mover} layer="top">
        <Local box={box} className="galaxy-callouts">
          {geo !== null && <path className="galaxy-lock" data-state={rock.state} data-planet={mover.id} d={lockFramePath(0, 0, mover.r)} />}
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
        </Local>
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
      className="home-galaxy"
      role={live === null ? "img" : "group"}
      aria-label={props.label}
      data-planets={starless ? 0 : layout.planets.length}
      data-rocks={starless || layout.rockOrbit === null ? 0 : layout.rocks.length}
      data-starless={starless || undefined}
      data-min-planet={scene !== null && scene.minPlanetPx > 0 ? scene.minPlanetPx.toFixed(1) : undefined}
      data-hidden={layout.hidden}
      data-sessions={total}
      data-dust={layout.belt?.particles.length ?? 0}
      data-belt={layout.belt === null ? undefined : `${layout.belt.inner.toFixed(1)}-${layout.belt.outer.toFixed(1)}`}
    >
      {scene !== null && (
        <>
          {plane(backArcs.map(orbitPath))}
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
                {props.starDesign !== undefined ? (
                  <StarBody design={props.starDesign} x={starItem.x} y={starItem.y} r={starItem.r} uid={`${uid}-sf`} />
                ) : (
                  <circle cx={starItem.x} cy={starItem.y} r={starItem.r} fill={`url(#${starGradient})`} />
                )}
              </>,
            )}
          {plane(frontArcs.map(orbitPath))}
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
                <g className="galaxy-targets">
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
          {fill && !starless && <div className="gx-layer gx-top">{movers.map(overlay)}</div>}
        </>
      )}
      {/*
        「全部 N 条会话」：不占画面的入口（2026-11-24 起每条会话都画成碎石，不再有「另有 N 条」那行字）。
        平时视觉隐藏，键盘 Tab 到它时才在左下角出现；读屏念它。碎石几百颗时单颗不可点，键盘要回旧会话就从这里去右栏树状图。
      */}
      {live !== null && total > 0 && (
        <button type="button" className="galaxy-all" onClick={live.actions.openTree}>
          {t.agents.allSessions(total)}
        </button>
      )}
    </div>
  );
}

/**
 * 单智能体首页的星系数据（原型）：`?galaxy=empty|typical|full` 切三档，不带参数时是 typical。
 * 单智能体侧原样保留写死的 fixture；编排侧的工作区页用真实数据（galaxy-data.ts）。
 * 页面地址在一次加载里不变，所以模块加载时算一次。
 */
export const PROTO_GALAXY_SPEC: GalaxySpec = galaxySpecOf(galaxyFixtureOf(window.location.search) ?? "typical");

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
