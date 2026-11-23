import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import {
  advanceClock,
  drawFrame,
  frameViewport,
  FRAME_EXTENT,
  FRAME_MS,
  galaxyFixtureOf,
  galaxySpecOf,
  layoutGalaxy,
  makeCamera,
  motionAllowed,
  orbitArcs,
  type DrawItem,
  type GalaxySpec,
  type MotionInputs,
} from "./galaxy.ts";

/** 画布的逻辑尺寸：宽 = 内容列量度（900），高按「输入框下一条安静的带子」取 */
const VIEW_W = 900;
const VIEW_H = 240;

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
 * 首页输入框下的星系（原型）：一颗主星、若干小得多的行星、一条会话星屑带。
 * 真 3D 坐标 + 透视投影 + 画家算法，画成 SVG——几何与排序都在 galaxy.ts（有测试），
 * 这里只画。颜色全部取墨色与发丝线 token（styles.css 的 .home-galaxy），不用 accent：
 * 它是这座星系的样子，不是要你点的东西。
 */
export function HomeGalaxy(props: { spec: GalaxySpec; label: string }) {
  const uid = useId().replace(/:/g, "");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const seconds = useGalaxyClock(svgRef);
  const scene = useMemo(() => {
    const layout = layoutGalaxy(props.spec);
    // 相机与视口只按统一画框定：三档的主星同大同位（不按这座星系自己的外缘缩放）
    const camera = makeCamera(FRAME_EXTENT);
    const viewport = frameViewport(camera, VIEW_W, VIEW_H);
    return { layout, camera, viewport, arcs: orbitArcs(layout, camera, viewport) };
  }, [props.spec]);
  const items = drawFrame(scene.layout, scene.camera, scene.viewport, scene.arcs, seconds);
  const starGradient = `${uid}-star`;
  const render = (item: DrawItem) => {
    if (item.kind === "orbit") {
      return <path key={item.key} className={item.expected ? "galaxy-orbit galaxy-orbit-expected" : "galaxy-orbit"} d={item.d} />;
    }
    if (item.kind === "dust") {
      return <path key={item.key} className="galaxy-dust" d={item.d} style={{ opacity: item.alpha }} />;
    }
    if (item.kind === "star") {
      return <circle key={item.key} cx={item.x} cy={item.y} r={item.r} fill={`url(#${starGradient})`} />;
    }
    const lightId = `${uid}-${item.planetId}`;
    return (
      <g key={item.key}>
        <circle
          className="galaxy-planet"
          data-planet={item.planetId}
          data-composition={item.composition}
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
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={props.label}
      data-planets={scene.layout.planets.length}
      data-hidden={scene.layout.hidden}
      data-sessions={scene.layout.belt?.count ?? 0}
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

/**
 * 原型用的星系数据：`?galaxy=empty|typical|full` 切三档，不带参数时是 typical。
 * 页面地址在一次加载里不变，所以模块加载时算一次。真实的行星 / 会话映射还没做（等编排落地）。
 */
export const PROTO_GALAXY_SPEC: GalaxySpec = galaxySpecOf(galaxyFixtureOf(window.location.search) ?? "typical");
