import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { CAMERA_ELEVATION_DEG, FRAME_EXTENT, GALAXY_MAX, frameViewport, galaxyBox, layoutGalaxy, makeCamera, motionAllowed, type GalaxySpec, type MotionInputs } from "./galaxy.ts";
import { FRAME_MS, advanceClock, classicOrbitArcs, drawClassicFrame, type ClassicItem } from "./galaxy-classic.ts";
import { StarBody } from "../galaxy-designer/StarFigure.tsx";
import type { GalaxyDesign } from "../galaxy-designer/design.ts";

/**
 * 画布的真实尺寸（CSS px）：ResizeObserver 量 svg 自己的盒子，viewBox 与像素一比一。
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
 * 时钟：只在 motionAllowed 时走表——每帧 requestAnimationFrame 取时间并重绘，帧与帧之间隔 FRAME_MS（约 30 帧/秒）。
 * 停的条件——页面隐藏、窗口失焦、星系滚出 / 被藏出视口（IntersectionObserver）、系统要求减少动效——任何一个成立就停，
 * 卸载时一并清掉。现在跑不跑写在 svg 的 data-motion 上（running / paused）。
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
    // 下一帧要么在等 rAF，要么在等两帧之间的 setTimeout：只排一个，停的时候两样都清
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
 * 单智能体首页的星系（原型 fixture 那条带子）：d12f2e2a 的画法原样保留——用户定「单智能体原样保留」（2026-11-24 主会话打回：
 * 一度跟编排页一起换成了合成器，碎石被盘面压成横短线、受光面固定）。真 3D 坐标 + 透视投影 + 画家算法，每帧整张重算（galaxy-classic.ts）。
 * 颜色全部取墨色与发丝线 token（styles.css 的 .home-galaxy）。starDesign 给了就把主星画成面板里那颗。
 */
export function ClassicGalaxy(props: { spec: GalaxySpec; label: string; starDesign?: GalaxyDesign }) {
  const uid = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const seconds = useGalaxyClock(svgRef);
  const size = useBoxSize(svgRef);
  const layout = useMemo(() => layoutGalaxy(props.spec), [props.spec]);
  const scene = useMemo(() => {
    if (size === null || size.width < 2 || size.height < 2) return null;
    // 相机与视口只按统一画框 + 画布尺寸定：20° + 460 封顶，同一块画布上三档主星同大同位
    const box = galaxyBox(size.width, size.height, GALAXY_MAX);
    const camera = makeCamera(FRAME_EXTENT, CAMERA_ELEVATION_DEG);
    const viewport = frameViewport(camera, size.width, size.height, box);
    return { camera, viewport, arcs: classicOrbitArcs(layout, camera, viewport) };
  }, [layout, size]);
  const items: ClassicItem[] = scene === null ? [] : drawClassicFrame(layout, scene.camera, scene.viewport, scene.arcs, seconds);
  const starGradient = `${uid}-star`;
  const render = (item: ClassicItem) => {
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
    return (
      <g key={item.key}>
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
      data-planets={layout.planets.length}
      data-rocks={layout.rockOrbit === null ? 0 : layout.rocks.length}
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
    </svg>
  );
}
