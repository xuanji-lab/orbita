import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import {
  advanceClock,
  drawFrame,
  frameViewport,
  FRAME_EXTENT,
  FRAME_MS,
  CAMERA_ELEVATION_DEG,
  elevationFor,
  galaxyBox,
  galaxySpecOf,
  galaxyFixtureOf,
  GALAXY_MAX,
  GALAXY_MAX_FILL,
  layoutGalaxy,
  makeCamera,
  dustCapFor,
  foldedMarkAt,
  emptyHintAt,
  motionAllowed,
  orbitArcs,
  readablePlanetPx,
  DEBRIS_PX,
  DUST_PX,
  type DrawItem,
  type GalaxySpec,
  type MotionInputs,
} from "./galaxy.ts";
import { useT } from "../../locale.ts";
import { BodyFigure, StarBody } from "../galaxy-designer/StarFigure.tsx";
import { bodyArt, planetFaceDesign, starExtentRatio, type GalaxyDesign } from "../galaxy-designer/design.ts";
import { ORBIT_STEP } from "./galaxy-data.ts";
import { GalaxyCallouts } from "./GalaxyCallouts.tsx";
import type { PlanetItem } from "./galaxy.ts";

/**
 * 画布的真实尺寸（CSS px）：ResizeObserver 量 svg 自己的盒子。星系占首页输入框下方剩下的全部空间，
 * 窗口 / 侧栏 / 右栏一变，画布跟着变，viewBox 与像素一比一（不靠 preserveAspectRatio 拉伸）。
 * 还没量到（首帧）时不画天体，免得先按错误尺寸闪一下。
 */
function useBoxSize(target: RefObject<Element | null>): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
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
 * 时钟：只在 motionAllowed 时走表——每帧 requestAnimationFrame 取时间并重绘，帧与帧之间隔 FRAME_MS
 * （约 30 帧/秒）。
 * 停的条件——页面隐藏、窗口失焦、星系滚出 / 被藏出视口（IntersectionObserver）、
 * 系统要求减少动效——任何一个成立就 cancelAnimationFrame，卸载时一并清掉。
 * 现在跑不跑写在 svg 的 data-motion 上（running / paused），验收时可直接读。
 */
function useGalaxyClock(target: RefObject<SVGSVGElement | null>): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const el = target.current;
    if (el === null) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const inputs: MotionInputs = {
      hasFocus: document.hasFocus(),
      visibilityState: document.visibilityState,
      onScreen: true,
      reducedMotion: media.matches,
    };
    // 下一帧要么在等 rAF，要么在等两帧之间的 setTimeout：只排一个，停的时候两样都清。
    // 不每个 rAF 都接着排 rAF——120Hz 的屏上那是每秒 120 次唤醒，而画面只需 30 帧
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    let elapsed = 0;
    let last: number | null = null;
    const tick = (now: number) => {
      raf = 0;
      elapsed = advanceClock(elapsed, last, now);
      last = now;
      setSeconds(elapsed / 1000);
      timer = setTimeout(() => {
        timer = null;
        raf = requestAnimationFrame(tick);
      }, FRAME_MS);
    };
    const stop = () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      if (timer !== null) clearTimeout(timer);
      raf = 0;
      timer = null;
    };
    const sync = () => {
      const run = motionAllowed(inputs);
      if (run && !running) {
        last = null;
        raf = requestAnimationFrame(tick);
      } else if (!run && running) {
        stop();
      }
      running = run;
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
    sync();
    return () => {
      stop();
      running = false;
      observer.disconnect();
      document.removeEventListener("visibilitychange", onActivity);
      window.removeEventListener("focus", onActivity);
      window.removeEventListener("blur", onActivity);
      media.removeEventListener("change", onMotionPref);
    };
  }, [target]);
  return seconds;
}

/**
 * 首页 / 工作区页的星系：一颗主星、若干小得多的行星、一条会话星屑带。数据是真实的（galaxy-data.ts）。
 * 真 3D 坐标 + 透视投影 + 画家算法，画成 SVG——几何与排序都在 galaxy.ts（有测试），
 * 这里只画。颜色全部取墨色与发丝线 token（styles.css 的 .home-galaxy），不用 accent：
 * 它是这座星系的样子，不是要你点的东西。唯一的状态色是「等你」行星外的一圈细环（warning）。
 *
 * starDesign：这座星系的主星设计稿（星系设计面板）。给了就把主星画成面板里那颗（眼睛、星环、日冕），
 * 与侧栏头像同一个形象；不给是一颗素球。
 */
export function HomeGalaxy(props: {
  spec: GalaxySpec;
  label: string;
  starDesign?: GalaxyDesign;
  fill?: boolean;
  emptyHint?: string;
  /**
   * 没有主星的「星际空间」（不属于任何工作区）：没有工作区就没有主智能体，也就没有主星与行星——
   * 只画缓慢漂移的碎石，每颗是一条会话（量大了也只是更浓，余数折成「+N」）。
   */
  starless?: boolean;
}) {
  const t = useT();
  const uid = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const seconds = useGalaxyClock(svgRef);
  const size = useBoxSize(svgRef);
  // 工作区页（fill）的碎石上限随画布面积缩放；单智能体首页的带子仍用原来的上限
  const dustCap = props.fill === true && size !== null ? dustCapFor(size.width, size.height) : undefined;
  const layout = useMemo(
    () => layoutGalaxy(dustCap === undefined ? props.spec : { ...props.spec, dustCap }),
    [props.spec, dustCap],
  );
  const scene = useMemo(() => {
    if (size === null || size.width < 2 || size.height < 2) return null;
    // 相机与视口只按统一画框 + 画布尺寸定：同一块画布上三档主星同大同位，不按星系自己的外缘缩放
    // 俯角按画框形状定（elevationFor）：同一块画布上三档仍同大同位——俯角只看画布，不看内容
    // 默认（全局首页那条带子）20° + 460 封顶，与原型一致；fill（工作区页）才按画框抬俯角、放宽封顶
    const box = galaxyBox(size.width, size.height, props.fill === true ? GALAXY_MAX_FILL : GALAXY_MAX);
    const camera = makeCamera(FRAME_EXTENT, props.fill === true ? elevationFor(box) : CAMERA_ELEVATION_DEG);
    const viewport = frameViewport(camera, size.width, size.height, box);
    return { camera, viewport, arcs: orbitArcs(layout, camera, viewport) };
  }, [layout, size, props.fill]);
  // 工作区页 / 右栏：行星至少画到表情可读的大小（两只眼看得见），但不压到隔壁轨道（readablePlanetPx）
  const minPlanetPx = scene === null || props.fill !== true ? 0 : readablePlanetPx(scene.camera, scene.viewport, ORBIT_STEP);
  const drawn =
    scene === null
      ? []
      : drawFrame(layout, scene.camera, scene.viewport, scene.arcs, seconds, minPlanetPx, props.starless === true ? DEBRIS_PX : DUST_PX);
  // 星际空间：不画主星、轨道与行星，只留碎石
  const items = props.starless === true ? drawn.filter((item) => item.kind === "dust") : drawn;
  // 工作区页（fill）：在做工的行星画锁定框，最要紧的几颗升起引线写任务名（GalaxyCallouts，与右栏星系图共用）
  const rankOf = useMemo(() => new Map(layout.planets.map((planet, index) => [planet.id, index])), [layout]);
  const planetItems = items.filter((item): item is PlanetItem => item.kind === "planet");
  const starItem = items.find((item) => item.kind === "star");
  const starExtent = props.starDesign === undefined ? 1 : starExtentRatio(props.starDesign);
  const folded = scene === null || props.fill !== true ? null : foldedMarkAt(layout, scene.camera, scene.viewport);
  const hint = scene === null || props.emptyHint === undefined ? null : emptyHintAt(layout, scene.camera, scene.viewport);
  const starGradient = `${uid}-star`;
  const render = (item: DrawItem) => {
    if (item.kind === "orbit") {
      return <path key={item.key} className={item.expected ? "galaxy-orbit galaxy-orbit-expected" : "galaxy-orbit"} d={item.d} />;
    }
    if (item.kind === "dust") {
      return <path key={item.key} className="galaxy-dust" d={item.d} style={{ opacity: item.alpha }} />;
    }
    if (item.kind === "star") {
      if (props.starDesign !== undefined) {
        return <StarBody key={item.key} design={props.starDesign} x={item.x} y={item.y} r={item.r} uid={`${uid}-sf`} />;
      }
      return <circle key={item.key} cx={item.x} cy={item.y} r={item.r} fill={`url(#${starGradient})`} />;
    }
    const lightId = `${uid}-${item.planetId}`;
    if (props.fill === true) {
      // 工作区页：每颗行星都是一个带两只竖胶囊眼的小天体（与设计面板同一个 BodyFigure），不再是素圆点
      return (
        <g
          key={item.key}
          className="gd-figure galaxy-planet-figure"
          data-planet={item.planetId}
          data-composition={item.composition}
          data-state={item.state ?? undefined}
          data-r={item.r.toFixed(1)}
          transform={`translate(${item.x} ${item.y})`}
        >
          <BodyFigure art={bodyArt(planetFaceDesign(item.composition), "planet", item.r)} uid={`${lightId}-f`} />
        </g>
      );
    }
    return (
      <g key={item.key}>
        {/* 等你的细环只留给单智能体首页的 fixture 星系；工作区页改由锁定框说（见 GalaxyCallouts） */}
        {item.state === "waiting" && <circle className="galaxy-planet-waiting" cx={item.x} cy={item.y} r={item.r + 3} />}
        <circle
          className="galaxy-planet"
          data-planet={item.planetId}
          data-composition={item.composition}
          data-state={item.state ?? undefined}
          cx={item.x}
          cy={item.y}
          r={item.r}
        />
        <circle cx={item.x} cy={item.y} r={item.r} fill={`url(#${lightId})`} />
      </g>
    );
  };
  return (
    <svg
      ref={svgRef}
      className="home-galaxy"
      viewBox={size === null ? undefined : `0 0 ${size.width} ${size.height}`}
      role="img"
      aria-label={props.label}
      data-planets={props.starless === true ? 0 : layout.planets.length}
      data-starless={props.starless === true || undefined}
      data-min-planet={minPlanetPx > 0 ? minPlanetPx.toFixed(1) : undefined}
      data-hidden={layout.hidden}
      data-sessions={layout.belt?.count ?? 0}
    >
      <defs>
        <radialGradient id={starGradient} cx="50%" cy="50%" r="50%" fx="38%" fy="34%">
          <stop offset="0%" className="galaxy-star-hi" />
          <stop offset="100%" className="galaxy-star-lo" />
        </radialGradient>
        {items.map((item) =>
          item.kind === "planet" ? (
            <radialGradient key={item.key} id={`${uid}-${item.planetId}`} cx="50%" cy="50%" r="50%" fx={item.fx} fy={item.fy}>
              <stop offset="0%" className="galaxy-light" stopOpacity={0.12 + 0.78 * item.lit} />
              <stop offset="100%" className="galaxy-light" stopOpacity={0} />
            </radialGradient>
          ) : null,
        )}
      </defs>
      {items.map(render)}
      {/* 锁定框、引线与悬停名字画在最上层；碎石折掉的会话数收成一个「+N」 */}
      {props.fill === true && scene !== null && props.starless !== true && (
        <GalaxyCallouts
          planets={planetItems}
          rankOf={rankOf}
          star={starItem === undefined ? null : { x: starItem.x, y: starItem.y, r: starItem.r * starExtent }}
          width={scene.viewport.width}
          height={scene.viewport.height}
          waitingWord={t.agents.status.waiting}
        />
      )}
      {hint !== null && props.emptyHint !== undefined && (
        <text className="galaxy-empty-hint" x={hint.x} y={hint.y} textAnchor="middle" dominantBaseline="central">
          {props.emptyHint}
        </text>
      )}
      {folded !== null && layout.belt !== null && (
        <text className="galaxy-folded" x={folded.x} y={folded.y} textAnchor="start" dominantBaseline="central">
          <title>{t.agents.foldedTip(layout.belt.folded)}</title>
          {t.agents.more(layout.belt.folded)}
        </text>
      )}
    </svg>
  );
}

/**
 * 单智能体首页的星系数据（原型）：`?galaxy=empty|typical|full` 切三档，不带参数时是 typical。
 * 单智能体侧原样保留写死的 fixture；编排侧的工作区页用真实数据（galaxy-data.ts）。
 * 页面地址在一次加载里不变，所以模块加载时算一次。
 */
export const PROTO_GALAXY_SPEC: GalaxySpec = galaxySpecOf(galaxyFixtureOf(window.location.search) ?? "typical");
