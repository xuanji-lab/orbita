/// <reference types="vite/client" />
/**
 * 引导里「压暗 + 框出一块 + 编号点 + 放大镜」的截图框：手册（OnboardingView）与故事版（story/StoryView）共用。
 * 截图随应用打包（shots/<light|dark>/<id>.webp），取景坐标是截图上的比例（见 onboarding-pages.ts）。
 */
import type { CSSProperties } from "react";
import type { Box, Loupe, Pin, ShotId, StepPage } from "./onboarding-pages.ts";
import "./onboarding.css";

/** 截图随应用打包：shots/<light|dark>/<id>.webp → 构建后的资源地址 */
const SHOT_URLS = import.meta.glob("./shots/*/*.webp", { eager: true, query: "?url", import: "default" }) as Record<string, string>;

function shotUrl(set: "light" | "dark", id: ShotId): string | undefined {
  return SHOT_URLS[`./shots/${set}/${id}.webp`];
}

/** 截图的宽高比（拍图统一 1440×900） */
const SHOT_RATIO = 1440 / 900;

const pct = (value: number): string => `${(value * 100).toFixed(3)}%`;

function boxStyle(box: Box): CSSProperties {
  return { left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h) };
}

/** edge：放大镜里的编号点，只取 x，竖向骑在放大镜上边框上（见 .ob-pin-edge），不压住放大的字 */
function PinMark(props: { pin: Pin; edge?: boolean }) {
  const style: CSSProperties = props.edge === true ? { left: pct(props.pin.x) } : { left: pct(props.pin.x), top: pct(props.pin.y) };
  return (
    <span className={props.edge === true ? "ob-pin ob-pin-edge" : "ob-pin"} style={style} aria-hidden="true">
      {props.pin.n}
    </span>
  );
}

/** 放大镜：同一张截图，背景按比例放大到 from 那一块 */
function LoupeView(props: { loupe: Loupe; url: string | undefined }) {
  const { from, at, scale } = props.loupe;
  const style: CSSProperties = {
    left: pct(at.x),
    top: pct(at.y),
    width: pct(from.w * scale),
    aspectRatio: `${from.w * SHOT_RATIO} / ${from.h}`,
    backgroundImage: props.url === undefined ? undefined : `url("${props.url}")`,
    backgroundSize: `${(100 / from.w).toFixed(3)}% auto`,
    backgroundPosition: `${from.w >= 1 ? 0 : ((from.x / (1 - from.w)) * 100).toFixed(3)}% ${from.h >= 1 ? 0 : ((from.y / (1 - from.h)) * 100).toFixed(3)}%`,
  };
  return (
    <div className="ob-loupe" style={style} aria-hidden="true">
      {props.loupe.pins?.map((pin) => <PinMark key={`l${pin.n}-${pin.x}`} pin={pin} edge />)}
    </div>
  );
}

/** 截图框：压暗 + 框出 focus + 编号点 + 放大镜 */
export function Shot(props: { page: { shot: ShotId } & Partial<Pick<StepPage, "focus" | "pins" | "loupe">>; set: "light" | "dark"; alt: string }) {
  const url = shotUrl(props.set, props.page.shot);
  const { focus, pins, loupe } = props.page;
  return (
    <div className="ob-figure">
      <div className="ob-frame">
        <div className="ob-win">
          {url === undefined ? <div className="ob-win-missing" /> : <img src={url} alt={props.alt} draggable={false} />}
          {focus !== undefined && <div className="ob-spot" style={boxStyle(focus)} />}
        </div>
        {pins?.map((pin) => <PinMark key={`${pin.n}-${pin.x}-${pin.y}`} pin={pin} />)}
        {loupe !== undefined && <LoupeView loupe={loupe} url={url} />}
      </div>
    </div>
  );
}
