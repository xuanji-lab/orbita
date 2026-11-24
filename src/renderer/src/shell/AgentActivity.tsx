import { useId, type ReactNode } from "react";
import { BodyFigure } from "../features/galaxy-designer/StarFigure.tsx";
import { bodyArt, displayRadius, planetFaceDesign, radiusOf, withStar, type GalaxyDesign, type PlanetDesign } from "../features/galaxy-designer/design.ts";
import { orderedSubAgents, type RowActivity, type SubAgentFixture } from "./sidebar-activity.ts";
import { useT } from "../locale.ts";
import "./agent-activity.css";

/**
 * 编排侧栏智能体行的「谁在干活」（sidebar-activity.ts 讲数据口径）。只在头像外面包一层、往第二行插几个小件，
 * 不改头像组件本身（StarFigure / BodyFigure 原样调用）：
 * - 主智能体在干活 = 头像外一圈细日冕慢慢呼吸（设计系统已有的「呼吸」一类）；主智能体在等你时不演，等你要比任何「在干活」都醒目；
 * - 会话在跑 = 状态词后一根闪烁的插入符（不画头像：会话是碎石，没有脸）；
 * - 子智能体 = 第二行最前面一串它那颗行星的小头像，在主头像右边、不压主星的脸；有几个画几个、不折成「+N」，
 *   放不下的整张不画（不留半张）。真数据来自有归属的子会话，演示数据（?fixture=sub-agents）叠在后面；等你的那颗描一圈 warning。
 * 动效只用 opacity / transform（交给合成器），带 .anim-continuous：窗口失焦 / 隐藏时由 styles.css 统一暂停；减少动效时不演。
 */

/** 一颗子智能体的小头像：只画行星本体与眼睛（星环、云、卫星在十几个像素上只会糊） */
export function PlanetFace(props: { design: GalaxyDesign; planet: PlanetDesign; size: number; label: string }) {
  const uid = useId().replace(/:/g, "");
  const star = withStar(props.design);
  const planet: PlanetDesign = { ...props.planet, elements: { ...props.planet.elements, ring: false, clouds: false, moons: false, corona: false, eyes: true } };
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
export function SubAgentFaces(props: { design: GalaxyDesign; agents: readonly SubAgentFixture[]; size: number }) {
  const t = useT();
  const agents = orderedSubAgents(props.agents);
  if (agents.length === 0) return null;
  return (
    <span className="aa-faces" style={{ height: props.size }}>
      {agents.map((agent, index) => {
        const { planet, designed } = planetAt(props.design, agent.planet);
        const name = (designed ? planet.name.trim() : "") || t.agents.subAgentUnnamed;
        const demo = agent.demo !== false;
        const label = agent.state === "waiting" ? t.agents.subAgentWaiting(name, demo) : t.agents.subAgentWorking(name, demo);
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

/** 头像外包的一层：主智能体在干活时叠一圈呼吸的日冕；figure = 原来那张头像（StarFigure / DustFigure） */
export function ActivityAvatar(props: { activity: RowActivity; figure: ReactNode }) {
  return (
    <span className="agent-avatar aa-avatar" data-main={props.activity.main}>
      {props.activity.main === "working" && <span className="aa-corona anim-continuous" aria-hidden />}
      {props.figure}
    </span>
  );
}
