import "./galaxy-designer.css";
import { useId } from "react";
import { avatarScale, bodyArt, displayRadius, ELEMENTS_OF, radiusOf, withStar, type BodyArt, type GalaxyDesign } from "./design.ts";

/**
 * 「画主星 / 画头像」的纯组件：输入一份设计稿，输出画面——不读仓库、不读设置、不带动效，同一份稿永远画出同一张图。
 * 侧栏头像、页头头像（StarFigure）与星系里的主星（StarBody）都只经过这里；星系设计面板的预览也用 BodyFigure。
 *
 * 地表图（插件 planet-forge 出的无脸地表，BodyDesign.surface）：有就在 BodyFigure 里把它裁进圆当贴图、叠代码画的明暗；
 * 眼睛 / 星环 / 日冕 / 卫星的几何（bodyArt）照旧由代码画——侧栏头像、页头、New Task 星系、右栏星系图、设计面板预览五处同源。
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
 * 「星际空间」（不属于任何工作区）的头像：没有工作区就没有主智能体、也没有主星，所以不画带眼睛的球，
 * 画一小撮碎石——七颗大小不一的石子，取墨色的两档深浅，位置写死（同一张图永远一样）。代码画，不用图片。
 */
const DEBRIS: readonly { x: number; y: number; r: number; tone: "a" | "b" }[] = [
  { x: -4.6, y: -3.2, r: 2.6, tone: "a" },
  { x: 2.4, y: -5.4, r: 1.6, tone: "b" },
  { x: 5.2, y: 0.6, r: 2.2, tone: "a" },
  { x: -0.6, y: 2.2, r: 1.9, tone: "b" },
  { x: -6.2, y: 3.6, r: 1.2, tone: "b" },
  { x: 3, y: 5.6, r: 1.3, tone: "a" },
  { x: 0.4, y: -1.4, r: 0.9, tone: "a" },
];

export function DustFigure(props: { size: number; label: string; className?: string }) {
  return (
    <svg
      className={props.className === undefined ? "gd-dust" : `gd-dust ${props.className}`}
      width={props.size}
      height={props.size}
      viewBox="-10 -10 20 20"
      role="img"
      aria-label={props.label}
    >
      {DEBRIS.map((rock) => (
        <circle key={`${rock.x}:${rock.y}`} className="gd-dust-rock" data-tone={rock.tone} cx={rock.x} cy={rock.y} r={rock.r} />
      ))}
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

/** 地表贴图比圆大一点点：球缘那一圈半透明的羽化边落到裁切圆外面，不在球缘描出一道浅边 */
const IMAGE_OVERSCAN = 1.04;

export function BodyFigure(props: { art: BodyArt; uid: string }) {
  const { art, uid } = props;
  const clip = `${uid}-clip`;
  const light = `${uid}-light`;
  const halo = `${uid}-halo`;
  const shade = `${uid}-shade`;
  const image = art.image;
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
        {image !== null && (
          // 贴图上的明暗：受光点在左上，往右下的球缘渐暗（地表图本身不带光照，明暗只由这里给，不双重打光）
          <radialGradient id={shade} cx="38%" cy="34%" r="74%">
            <stop offset="45%" className="gd-shade-stop" stopOpacity={0} />
            <stop offset="100%" className="gd-shade-stop" stopOpacity={0.62} />
          </radialGradient>
        )}
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
      {image !== null && (
        <g clipPath={`url(#${clip})`} data-image="true">
          <image
            className="gd-surface-image"
            href={image.src}
            x={-art.r * IMAGE_OVERSCAN}
            y={-art.r * IMAGE_OVERSCAN}
            width={art.r * 2 * IMAGE_OVERSCAN}
            height={art.r * 2 * IMAGE_OVERSCAN}
            preserveAspectRatio="xMidYMid slice"
            transform={image.flip ? "scale(1 -1)" : undefined}
          />
          <circle r={art.r} fill={`url(#${shade})`} />
        </g>
      )}
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
        <circle r={art.r} fill={`url(#${light})`} opacity={image === null ? 1 : 0.4} />
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
