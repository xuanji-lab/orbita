import "./galaxy-designer.css";
import { useId } from "react";
import { avatarScale, bodyArt, displayRadius, ELEMENTS_OF, radiusOf, withStar, type BodyArt, type GalaxyDesign } from "./design.ts";

/**
 * 「画主星 / 画头像」的纯组件：输入一份设计稿，输出画面——不读仓库、不读设置、不带动效，同一份稿永远画出同一张图。
 * 侧栏头像、页头头像（StarFigure）与星系里的主星（StarBody）都只经过这里；星系设计面板的预览也用 BodyFigure。
 *
 * 给下一轮留的口子（主智能体样式换成 Qwen 出的球体图片，眼睛、星环、日冕仍由代码画）：
 * 在 GalaxyDesign.star 上加一个图片字段（例如 image: { src, ... }），然后只改 BodyFigure 里「gd-surface 那颗球 + 纹理」那一段——
 * 有图就画 <image clipPath=…>，没有就照旧画纹理；眼睛 / 星环 / 日冕 / 卫星的几何（bodyArt）不动，调用方一个都不用改。
 */

/**
 * 一颗主星的静态形象（侧栏工作区行的头像、工作区页页头）：与面板预览同一个 BodyFigure、同一份设计稿，
 * 不自转、不带动效（用户定过：侧栏头像静态，页面星系才动）。画框按形象的外框（含星环 / 日冕）取，
 * 所以开了星环的主星在头像里会小一些——整颗装进去，不裁。size 由调用方给（px）。
 */
export function StarFigure(props: { design: GalaxyDesign; size: number; label: string; className?: string; bySize?: boolean }) {
  const uid = useId().replace(/:/g, "");
  // 还没有主星的工作区（星系设计里删过主星）也要有张脸：取默认主星画，不改设计稿
  const design = withStar(props.design);
  const r = displayRadius(radiusOf(design, "star"));
  const art = bodyArt(design, "star", r);
  const half = Math.max(art.extent.x, art.extent.y) * 1.04;
  // 质量大的主星头像大一点（只在种子默认下开）：与页面星系同一个规矩——质量决定大小
  const px = props.bySize === true ? Math.round(props.size * avatarScale(design.star.mass)) : props.size;
  return (
    <svg
      className={props.className === undefined ? "gd-figure" : `gd-figure ${props.className}`}
      width={px}
      height={px}
      viewBox={`${-half} ${-half} ${half * 2} ${half * 2}`}
      role="img"
      aria-label={props.label}
      data-elements={ELEMENTS_OF.star.filter((key) => design.star.elements[key]).join(" ")}
    >
      <BodyFigure art={art} uid={uid} />
    </svg>
  );
}


/**
 * 星系画布里的主星（一个 <g>，以 (x, y) 为心、半径 r 画）：与头像同一个形象。还没有主星的设计稿取默认主星画。
 */
export function StarBody(props: { design: GalaxyDesign; x: number; y: number; r: number; uid: string }) {
  return (
    <g className="gd-figure galaxy-star-figure" transform={`translate(${props.x} ${props.y})`}>
      <BodyFigure art={bodyArt(withStar(props.design), "star", props.r)} uid={props.uid} />
    </g>
  );
}

export function BodyFigure(props: { art: BodyArt; uid: string }) {
  const { art, uid } = props;
  const clip = `${uid}-clip`;
  const light = `${uid}-light`;
  const halo = `${uid}-halo`;
  return (
    <g className="gd-body" data-surface={art.surface}>
      <defs>
        <clipPath id={clip}>
          <circle r={art.r} />
        </clipPath>
        <radialGradient id={light} cx="50%" cy="50%" r="50%" fx="34%" fy="30%">
          <stop offset="0%" className="gd-light" stopOpacity={0.62} />
          <stop offset="100%" className="gd-light" stopOpacity={0} />
        </radialGradient>
        <radialGradient id={halo} cx="50%" cy="50%" r="50%">
          <stop offset="60%" className="gd-halo" stopOpacity={0.28} />
          <stop offset="100%" className="gd-halo" stopOpacity={0} />
        </radialGradient>
      </defs>
      {art.corona !== null && (
        <g className="gd-corona">
          <circle r={art.corona.halo} fill={`url(#${halo})`} />
          <circle className="gd-corona-line" r={art.corona.r} />
        </g>
      )}
      {art.moons
        .filter((moon) => moon.behind)
        .map((moon) => (
          <circle key={`${moon.x}`} className="gd-moon" data-behind="true" cx={moon.x} cy={moon.y} r={moon.r} />
        ))}
      {art.ring !== null && (
        <path className="gd-ring gd-ring-back" d={art.ring.back} transform={`rotate(${art.ring.tilt})`} strokeWidth={art.ring.width} />
      )}
      <circle className="gd-surface" r={art.r} />
      <g clipPath={`url(#${clip})`}>
        {art.bands.map((band) => (
          <rect key={band.y} className="gd-band" x={-art.r} y={band.y} width={art.r * 2} height={band.h} />
        ))}
        {art.cap !== null && <ellipse className="gd-cap" cx={art.cap.cx} cy={art.cap.cy} rx={art.cap.rx} ry={art.cap.ry} />}
        {art.cracks.map((d) => (
          <path key={d} className="gd-crack" d={d} />
        ))}
        {art.craters.map((crater) => (
          <circle key={`${crater.x}`} className="gd-crater" cx={crater.x} cy={crater.y} r={crater.r} />
        ))}
        {art.clouds.map((cloud) => (
          <rect key={cloud.y} className="gd-cloud" x={cloud.x} y={cloud.y} width={cloud.w} height={cloud.h} rx={cloud.h / 2} />
        ))}
        <circle r={art.r} fill={`url(#${light})`} />
      </g>
      {/* 只有一双竖胶囊眼：不画嘴、鼻子、腮红、眉毛、瞳孔、高光 */}
      {art.eyes !== null && (
        <g className="gd-eyes" transform={`rotate(${art.eyesTilt})`}>
          {art.eyes.map((eye) => (
            <rect key={eye.x} className="gd-eye" x={eye.x - eye.w / 2} y={eye.y - eye.h / 2} width={eye.w} height={eye.h} rx={eye.w / 2} />
          ))}
        </g>
      )}
      {art.ring !== null && (
        <path className="gd-ring gd-ring-front" d={art.ring.front} transform={`rotate(${art.ring.tilt})`} strokeWidth={art.ring.width} />
      )}
      {art.moons
        .filter((moon) => !moon.behind)
        .map((moon) => (
          <circle key={`${moon.x}`} className="gd-moon" cx={moon.x} cy={moon.y} r={moon.r} />
        ))}
    </g>
  );
}
