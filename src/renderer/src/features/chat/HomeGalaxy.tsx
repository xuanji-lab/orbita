import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
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
  foldedCountOf,
  emptyHintAt,
  motionAllowed,
  orbitArcs,
  DEBRIS_PX,
  DUST_PX,
  AGENT_READABLE_MAX,
  PLANET_READABLE_MAX,
  type DrawItem,
  type GalaxySpec,
  type MotionInputs,
} from "./galaxy.ts";
import { useT } from "../../locale.ts";
import { BodyFigure, StarBody } from "../galaxy-designer/StarFigure.tsx";
import { bodyArt, planetFaceDesign, starExtentRatio, type GalaxyDesign, type PlanetDesign } from "../galaxy-designer/design.ts";
import { fitScreenSafe } from "./screen-safe.ts";
import { GalaxyCallouts } from "./GalaxyCallouts.tsx";
import { lockFrame, placeNameTags, textWidth } from "./callouts.ts";
import { useGalaxyActions } from "./galaxy-actions.ts";
import type { PlanetItem, RockItem } from "./galaxy.ts";

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
  /**
   * 子智能体行星（编排星系：行星 = 子智能体，id → 设计稿）。给了就按设计稿画（地表图 + 代码眼睛）并常显名字，
   * 行星可读半径放大一档（AGENT_READABLE_MAX）；会话不再是行星，在做事的会话是带锁定框的碎石块（spec.rocks）。
   */
  agents?: ReadonlyMap<string, PlanetDesign>;
  /**
   * 这座星系属于哪个工作区：给了且有 GalaxyActions（App 提供）时星系能点——碎石开会话、行星 / 主星开设计面板、
   * 角上「另有 N 条会话」开右栏树状图（2026-11-24 设计审查 R1）。
   */
  workspaceId?: string | null;
  /** 主星的名字（读屏与悬停提示「X（主星）：在设计面板里打开」）；缺省用主星设计稿的名字 */
  starName?: string;
}) {
  const t = useT();
  const actions = useGalaxyActions();
  const uid = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const seconds = useGalaxyClock(svgRef);
  const size = useBoxSize(svgRef);
  // 工作区页（fill）的碎石上限随画布面积缩放；单智能体首页的带子仍用原来的上限
  const dustCap = props.fill === true && size !== null ? dustCapFor(size.width, size.height) : undefined;
  const baseLayout = useMemo(
    () => layoutGalaxy(dustCap === undefined ? props.spec : { ...props.spec, dustCap }),
    [props.spec, dustCap],
  );
  const scene = useMemo(() => {
    if (size === null || size.width < 2 || size.height < 2) return null;
    // 相机与视口只按统一画框 + 画布尺寸定：同一块画布上三档主星同大同位，不按星系自己的外缘缩放
    // 默认（全局首页那条带子）20° + 460 封顶，与原型一致——单智能体首页这一支一个像素都不动
    if (props.fill !== true) {
      const box = galaxyBox(size.width, size.height, GALAXY_MAX);
      const camera = makeCamera(FRAME_EXTENT, CAMERA_ELEVATION_DEG);
      const viewport = frameViewport(camera, size.width, size.height, box);
      return { camera, viewport, layout: baseLayout, minPlanetPx: 0, arcs: orbitArcs(baseLayout, camera, viewport) };
    }
    // 工作区页 / 右栏：屏幕安全布局（screen-safe.ts）——在屏幕坐标里排轨道，任何相位上天体都不在画面上相撞：
    // 近侧行星让开主星，相邻两圈在短轴上留出间距，轨道放平；排不下就抬俯角，再不行少画最外一圈
    const box = galaxyBox(size.width, size.height, GALAXY_MAX_FILL);
    const readableMax = props.agents !== undefined && props.agents.size > 0 ? AGENT_READABLE_MAX : PLANET_READABLE_MAX;
    const safe = fitScreenSafe(dustCap === undefined ? props.spec : { ...props.spec, dustCap }, size.width, size.height, box, elevationFor(box), readableMax);
    return { camera: safe.camera, viewport: safe.viewport, layout: safe.layout, minPlanetPx: safe.minPlanetPx, arcs: orbitArcs(safe.layout, safe.camera, safe.viewport) };
  }, [baseLayout, size, props.fill, props.spec, dustCap, props.agents]);
  const layout = scene?.layout ?? baseLayout;
  const minPlanetPx = scene?.minPlanetPx ?? 0;
  // 工作区页 / 右栏：等你的行星不再强行画在主星前面——转到主星背后就让主星挡住（天体不得画在主星上面）
  const drawn =
    scene === null
      ? []
      : drawFrame(layout, scene.camera, scene.viewport, scene.arcs, seconds, minPlanetPx, props.starless === true ? DEBRIS_PX : DUST_PX, props.fill !== true);
  // 星际空间：不画主星、轨道与行星，只留碎石
  const items = props.starless === true ? drawn.filter((item) => item.kind === "dust") : drawn;
  // 工作区页（fill）：在做工的行星画锁定框，最要紧的几颗升起引线写任务名（GalaxyCallouts，与右栏星系图共用）
  const rankOf = useMemo(() => new Map(layout.planets.map((planet, index) => [planet.id, index])), [layout]);
  const planetItems = items.filter((item): item is PlanetItem => item.kind === "planet");
  const rockItems = items.filter((item): item is RockItem => item.kind === "rock");
  const starItem = items.find((item) => item.kind === "star");
  // 名字牌的字号跟设计系统走：挂上后量一次（同 GalaxyCallouts）
  const probeRef = useRef<SVGTextElement | null>(null);
  const [glyphPx, setGlyphPx] = useState(12);
  useLayoutEffect(() => {
    const el = probeRef.current;
    if (el === null) return;
    const px = Number.parseFloat(getComputedStyle(el).fontSize);
    if (Number.isFinite(px) && px > 0 && px !== glyphPx) setGlyphPx(px);
  });
  const starExtent = props.starDesign === undefined ? 1 : starExtentRatio(props.starDesign);
  // 被主星挡住的行星（在它背后、画面上与它重叠）：不画锁定框与引线，转出来再画——框画在主星上面也是「压在主星上」
  const visiblePlanets =
    starItem === undefined || starItem.kind !== "star"
      ? planetItems
      : planetItems.filter(
          (planet) => !(planet.depth > starItem.depth && Math.hypot(planet.x - starItem.x, planet.y - starItem.y) < starItem.r * starExtent + planet.r),
        );
  // 子智能体行星的名字常显；被主星挡住的不写（与锁定框同一个规矩）
  const agents = props.agents;
  const nameTags =
    agents === undefined || scene === null || props.fill !== true
      ? []
      : placeNameTags({
          planets: visiblePlanets.map((planet) => ({ id: planet.planetId, x: planet.x, y: planet.y, r: planet.r, name: agents.get(planet.planetId)?.name ?? "" })),
          // 碎石块按它的锁定框算：名字牌不能被框压住（ann-2 E：框压在「定盘星」身上，名字被吃掉）
          bodies: [
            ...planetItems.map((body) => ({ id: body.planetId, x: body.x, y: body.y, r: body.r })),
            ...rockItems.map((body) => ({ id: body.planetId, x: body.x, y: body.y, r: lockFrame(body.r).half })),
          ],
          star: starItem === undefined || starItem.kind !== "star" ? null : { x: starItem.x, y: starItem.y, r: starItem.r * starExtent },
          width: scene.viewport.width,
          height: scene.viewport.height,
          glyphPx,
        });
  // 锁定框与引线只认在做事的：子智能体行星（没有运行态）+ 在做事的碎石块
  const calloutBodies = agents === undefined ? visiblePlanets : [...visiblePlanets.map((planet) => ({ ...planet, label: null })), ...rockItems];
  // 能点的星系：只有编排的工作区星系（有 App 给的去处、有工作区 id、不是星际空间）
  const workspaceId = props.workspaceId ?? null;
  const live = props.fill === true && props.starless !== true && actions !== null && workspaceId !== null ? { actions, workspaceId } : null;
  // 角上那一行「另有 N 条会话」：星屑带折掉的 + 这一帧没画出来的碎石块（窄画布里整圈碎石块出画时归进这一行）
  const foldedCount = foldedCountOf(layout);
  const foldedLine = scene === null || props.fill !== true || props.starless === true || foldedCount <= 0 ? null : t.agents.more(foldedCount);
  const foldedBox =
    foldedLine === null || scene === null
      ? null
      : { x: 12, y: scene.viewport.height - 12, w: textWidth(foldedLine, glyphPx) };
  // 星际空间仍用星屑带旁边那个「+N」（它没有树状图可去）
  const folded = scene === null || props.fill !== true || props.starless !== true ? null : foldedMarkAt(layout, scene.camera, scene.viewport);
  const hint = scene === null || props.emptyHint === undefined ? null : emptyHintAt(layout, scene.camera, scene.viewport);
  const starGradient = `${uid}-star`;
  const render = (item: DrawItem) => {
    if (item.kind === "orbit") {
      return <path key={item.key} className={item.expected ? "galaxy-orbit galaxy-orbit-expected" : "galaxy-orbit"} d={item.d} />;
    }
    if (item.kind === "dust") {
      return <path key={item.key} className="galaxy-dust" d={item.d} style={{ opacity: item.alpha }} />;
    }
    if (item.kind === "rock") {
      return <path key={item.key} className="galaxy-rock" data-rock={item.planetId} data-state={item.state} d={rockPath(item.x, item.y, item.r, item.planetId)} />;
    }
    if (item.kind === "star") {
      if (props.starDesign !== undefined) {
        return <StarBody key={item.key} design={props.starDesign} x={item.x} y={item.y} r={item.r} uid={`${uid}-sf`} />;
      }
      return <circle key={item.key} cx={item.x} cy={item.y} r={item.r} fill={`url(#${starGradient})`} />;
    }
    const lightId = `${uid}-${item.planetId}`;
    if (props.fill === true) {
      // 工作区页：每颗行星都是一个带两只竖胶囊眼的小天体（与设计面板同一个 BodyFigure），不再是素圆点；
      // 子智能体行星按它的设计稿画（地表图 + 代码眼睛）
      const agent = props.agents?.get(item.planetId);
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
          <BodyFigure art={bodyArt(planetFaceDesign(item.composition, agent?.surface ?? null), "planet", item.r)} uid={`${lightId}-f`} />
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
      data-rocks={props.starless === true || layout.rockOrbit === null ? 0 : layout.rocks.length}
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
          planets={calloutBodies}
          reserved={[
            ...nameTags.map((tag) => tag.box),
            // 「+N」也占一块：引线标签不压它（满载右栏里两者曾叠在一起）
            ...(foldedBox === null ? [] : [{ x0: foldedBox.x - 4, y0: foldedBox.y - glyphPx - 4, x1: foldedBox.x + foldedBox.w + 4, y1: foldedBox.y + glyphPx }]),
          ]}
          rankOf={rankOf}
          star={starItem === undefined ? null : { x: starItem.x, y: starItem.y, r: starItem.r * starExtent }}
          width={scene.viewport.width}
          height={scene.viewport.height}
          waitingWord={t.agents.status.waiting}
          onActivate={live === null ? undefined : live.actions.openSession}
          activateLabel={t.agents.openRock}
        />
      )}
      {/* 主星与子智能体行星能点：一层透明命中圈叠在天体上（键盘可达，悬停 / 聚焦亮一圈细环）；被主星挡住的行星不给 */}
      {live !== null && (
        <g className="galaxy-targets">
          {starItem !== undefined && starItem.kind === "star" && (
            <GalaxyTarget
              kind="star"
              id="star"
              x={starItem.x}
              y={starItem.y}
              r={starItem.r}
              label={t.agents.openStar(props.starName ?? props.starDesign?.star?.name ?? props.label)}
              onActivate={() => live.actions.openStar(live.workspaceId)}
            />
          )}
          {agents !== undefined &&
            visiblePlanets.map((planet) => {
              const name = agents.get(planet.planetId)?.name ?? planet.planetId;
              return (
                <GalaxyTarget
                  key={`target-${planet.planetId}`}
                  kind="planet"
                  id={planet.planetId}
                  x={planet.x}
                  y={planet.y}
                  r={planet.r}
                  label={t.agents.openPlanet(name)}
                  onActivate={() => live.actions.openPlanet(live.workspaceId, planet.planetId)}
                />
              );
            })}
        </g>
      )}
      {props.fill === true && agents !== undefined && (
        <g className="galaxy-names" data-names={nameTags.length}>
          <text ref={probeRef} className="galaxy-name-text" x={-999} y={-999} aria-hidden="true">
            {""}
          </text>
          {nameTags.map((tag) => (
            <text key={`name-${tag.id}`} className="galaxy-name-text" data-planet={tag.id} x={tag.x} y={tag.y} textAnchor={tag.anchor} dominantBaseline="central">
              {agents.get(tag.id)?.name}
            </text>
          ))}
        </g>
      )}
      {hint !== null && props.emptyHint !== undefined && (
        <text className="galaxy-empty-hint" x={hint.x} y={hint.y} textAnchor="middle" dominantBaseline="central">
          {props.emptyHint}
        </text>
      )}
      {foldedLine !== null && foldedBox !== null && (
        // 一行看得懂的字，不是悬空的「+431」（设计审查 R9）；能点的星系里点了打开右栏树状图
        <g
          className="galaxy-more"
          data-count={foldedCount}
          {...(live === null
            ? {}
            : {
                role: "button",
                tabIndex: 0,
                "aria-label": t.agents.foldedTip(foldedCount),
                "data-link": "true",
                onClick: live.actions.openTree,
                onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  live.actions.openTree();
                },
              })}
        >
          <title>{t.agents.foldedTip(foldedCount)}</title>
          <rect className="galaxy-more-hit" x={foldedBox.x - 6} y={foldedBox.y - glyphPx} width={foldedBox.w + 12} height={glyphPx * 2} rx={4} />
          <text className="galaxy-folded" x={foldedBox.x} y={foldedBox.y} textAnchor="start" dominantBaseline="central">
            {foldedLine}
          </text>
        </g>
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

/**
 * 星系上一颗能点的天体（主星 / 子智能体行星）：透明命中圈 + 悬停 / 聚焦时的一圈细环。
 * role=button、tabIndex=0、Enter / 空格触发；key 按天体 id 稳定，天体每帧在动，焦点不丢。
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
