import { useEffect, useId, useState, type ReactNode } from "react";
import { BodyFigure, StarFigure } from "../features/galaxy-designer/StarFigure.tsx";
import { bodyArt, displayRadius, planetFaceDesign, radiusOf, withStar, type GalaxyDesign, type PlanetDesign } from "../features/galaxy-designer/design.ts";
import { orderedSubAgents, type ActivityVariant, type RowActivity, type SubAgentFixture } from "./sidebar-activity.ts";
import { useT } from "../locale.ts";
import "./agent-activity.css";

/**
 * 侧栏智能体行的「谁在干活」三个候选（原型；sidebar-activity.ts 讲数据口径）。只在头像外面包一层、往行里插几个小件，
 * 不改头像组件本身（StarFigure / BodyFigure 原样调用）。
 *
 * 三个方案只在「放在哪」和「主智能体自己怎么动」上不同，共用同一套小件：
 * - 子智能体 = 它那颗行星的小头像（名字与形象来自星系设计稿，「在干活」目前是演示数据）；等你的那颗描一圈 warning；
 *   一律在主头像**右侧**、不压主头像的脸（眼睛要放大到约直径 30%），有几个画几个、不折成「+N」（2026-11-24 用户）；
 * - 会话在跑 = 一根闪烁的插入符（不画头像：会话是碎石，没有脸）；
 * - 持续动效只有两种、都交给合成器：opacity（呼吸 / 插入符）与 transform（月亮绕行、眼睛）；
 *   带 .anim-continuous，窗口失焦 / 隐藏时由 styles.css 统一暂停，减少动效时不演。
 * - 主智能体在等你时，它自己的动效一律不演（等你要比任何「在干活」都醒目）。
 */

/** 一颗子智能体的小头像：只画行星本体与眼睛（星环、云、卫星在十几个像素上只会糊） */
export function PlanetFace(props: { design: GalaxyDesign; planet: PlanetDesign; size: number; label: string }) {
  const uid = useId().replace(/:/g, "");
  const star = withStar(props.design);
  const base = props.planet;
  const planet: PlanetDesign = { ...base, elements: { ...base.elements, ring: false, clouds: false, moons: false, corona: false, eyes: true } };
  const design: GalaxyDesign = { ...star, planet };
  const r = displayRadius(radiusOf(design, "planet"));
  const art = bodyArt(design, "planet", r);
  const half = r * 1.02;
  return (
    <svg className="gd-figure aa-face-svg" width={props.size} height={props.size} viewBox={`${-half} ${-half} ${half * 2} ${half * 2}`} role="img" aria-label={props.label}>
      <BodyFigure art={art} uid={uid} />
    </svg>
  );
}

/** 设计稿里第 index 颗行星；稿里没有这么多颗（演示数据要满载时）就按序号取一张只有眼睛的素脸，不编名字 */
const SPARE_COMPOSITIONS = ["rock", "ice", "gas"] as const;

function planetAt(design: GalaxyDesign, index: number): { planet: PlanetDesign; designed: boolean } {
  const list = design.planets ?? (design.planet === null ? [] : [design.planet]);
  const found = list[index];
  if (found !== undefined) return { planet: found, designed: true };
  return { planet: planetFaceDesign(SPARE_COMPOSITIONS[index % SPARE_COMPOSITIONS.length] ?? "rock").planet, designed: false };
}

/** 一串子智能体小头像（等你的在前），有几个画几个 */
export function SubAgentFaces(props: { design: GalaxyDesign; agents: readonly SubAgentFixture[]; size: number; place: "lead" | "inline" | "trailing" }) {
  const t = useT();
  const agents = orderedSubAgents(props.agents);
  if (agents.length === 0) return null;
  return (
    <span className="aa-faces" data-place={props.place}>
      {agents.map((agent, index) => {
        const { planet, designed } = planetAt(props.design, agent.planet);
        const name = (designed ? planet.name.trim() : "") || t.agents.subAgentUnnamed;
        const label = agent.state === "waiting" ? t.agents.subAgentWaiting(name) : t.agents.subAgentWorking(name);
        return (
          <span key={`${agent.planet}:${index}`} className="aa-face" data-state={agent.state} title={label} style={{ width: props.size, height: props.size }}>
            <PlanetFace design={props.design} planet={planet} size={props.size} label={label} />
          </span>
        );
      })}
    </span>
  );
}

/** 会话在跑：一根插入符（像有人在那儿打字），不带数字——件数在第二行的「在跑 · N」里 */
export function SessionCaret(props: { count: number }) {
  const t = useT();
  if (props.count <= 0) return null;
  return <span className="aa-caret anim-continuous" role="img" aria-label={t.agents.sessionsRunning(props.count)} title={t.agents.sessionsRunning(props.count)} />;
}

/**
 * 头像外包的一层：按方案叠「主智能体在干活」的动静（A 日冕呼吸、B 眼睛活过来、C 一颗小月亮绕行）。
 * 头像上不再叠子智能体（会挡住主星的脸），子智能体都在右边的文字行里。
 * figure = 原来那张头像（StarFigure / DustFigure），B 在主智能体干活时换成「去掉眼睛的同一张图 + 会动的眼睛层」。
 */
export function ActivityAvatar(props: {
  variant: ActivityVariant;
  activity: RowActivity;
  design: GalaxyDesign;
  size: number;
  label: string;
  figure: ReactNode;
}) {
  const { variant, activity } = props;
  const working = activity.main === "working";
  return (
    <span className="agent-avatar aa-avatar" data-variant={variant} data-main={activity.main}>
      {variant === "a" && working && <span className="aa-corona anim-continuous" aria-hidden />}
      {variant === "c" && working && (
        <span className="aa-orbit" aria-hidden>
          <span className="aa-moon-track anim-continuous">
            <span className="aa-moon" />
          </span>
        </span>
      )}
      {variant === "b" && working ? <LivelyStar design={props.design} size={props.size} label={props.label} /> : props.figure}
    </span>
  );
}

/**
 * B：主智能体在干活 = 眼睛活过来（慢慢左右看、偶尔眨一下）。为了让眼睛单独动又只用合成器，
 * 底下画「关掉眼睛的同一张头像」，上面叠一层只有眼睛的 svg：外层 span 管左右看（translateX），svg 管眨眼（scaleY）。
 */
function LivelyStar(props: { design: GalaxyDesign; size: number; label: string }) {
  const design = withStar(props.design);
  const eyeless: GalaxyDesign = { ...design, star: { ...design.star, elements: { ...design.star.elements, eyes: false } } };
  const r = displayRadius(radiusOf(design, "star"));
  const art = bodyArt({ ...design, star: { ...design.star, elements: { ...design.star.elements, eyes: true } } }, "star", r);
  const half = Math.max(art.extent.x, art.extent.y) * 1.04;
  const dark = useSurfaceDarkCopy(design.star.surface?.src ?? null);
  const eyes = art.eyes;
  // 眨眼绕双眼中心那条线压扁：换成 svg 盒子里的百分比
  const originY = eyes === null ? 50 : ((half + eyes[0].y) / (half * 2)) * 100;
  return (
    <span className="aa-lively" style={{ width: props.size, height: props.size }}>
      <StarFigure bySize={false} design={eyeless} size={props.size} label={props.label} />
      {eyes !== null && (
        <span className="aa-look anim-continuous" aria-hidden>
          {/* 眨眼的 scaleY 挂在 span 上，不挂在 svg 上：Chromium 不把 SVG 元素上的 transform 动画交给合成器（实测挂 svg 时主线程 83 帧 / 秒） */}
          <span className="aa-blink anim-continuous" style={{ transformOrigin: `50% ${originY}%` }}>
          <svg
            className="gd-figure"
            width={props.size}
            height={props.size}
            viewBox={`${-half} ${-half} ${half * 2} ${half * 2}`}
          >
            <g className="gd-eyes" data-rim={dark || undefined} transform={`rotate(${art.eyesTilt})`}>
              {eyes.map((eye) => (
                <rect
                  key={eye.x}
                  className="gd-eye"
                  x={eye.x - eye.w / 2}
                  y={eye.y - eye.h / 2}
                  width={eye.w}
                  height={eye.h}
                  rx={eye.w / 2}
                  strokeWidth={dark ? eye.w * 0.45 : undefined}
                />
              ))}
            </g>
          </svg>
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * 深色地表上眼睛要描淡亮边（StarFigure 里 useSurfaceDark 的同一个判定；那边没导出，原型不改头像组件，先抄一份。
 * 方案定了再把那边导出、删掉这份）。
 */
const SURFACE_DARK = 0.38;
const darkness = new Map<string, boolean>();

function useSurfaceDarkCopy(src: string | null): boolean {
  const [dark, setDark] = useState(() => (src === null ? false : (darkness.get(src) ?? false)));
  useEffect(() => {
    if (src === null) {
      setDark(false);
      return;
    }
    const known = darkness.get(src);
    if (known !== undefined) {
      setDark(known);
      return;
    }
    let live = true;
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 16;
      canvas.height = 16;
      const ctx = canvas.getContext("2d");
      if (ctx === null) return;
      ctx.drawImage(img, 0, 0, 16, 16);
      const { data } = ctx.getImageData(0, 0, 16, 16);
      let sum = 0;
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        if ((data[i + 3] ?? 0) / 255 < 0.5) continue;
        sum += (0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0)) / 255;
        n += 1;
      }
      const result = n > 0 && sum / n < SURFACE_DARK;
      darkness.set(src, result);
      if (live) setDark(result);
    };
    img.src = src;
    return () => {
      live = false;
    };
  }, [src]);
  return dark;
}
