/**
 * 星图：故事版引导里一直亮着的那张图，也是玩家的**操作面**——站是按钮（点、Tab + Enter 都行），
 * 玩家在这上面通电、派人出门、放僚机、按顺序点站存成协议。
 *
 * **一个 SVG、固定 600 × 600 的 viewBox、窗口缩放时等比缩**，不重排。文字（站名、卡片）与按钮放在同尺寸的
 * HTML 层里叠在 SVG 上，按百分比定位——SVG 里的字会随图一起缩小，小窗里就读不清。
 *
 * 站只有两个状态，图例用设计系统的：
 * - lost 失步 = 空心 + 偏离自己的位置 + 抖：开场十座全是，接通前一直歪着
 * - linked 接通 = 实心（墨色，同「助手 = 实心星」）+ 锁回轨道 + 连上线
 * 运动都有含义，且只用 transform / opacity：转 = 运转（一圈轨道的站全接通才转）；抖 = 失步；
 * 锁回 = 站从偏离的位置滑回轨道；连线 = 通讯建立（线以起点为原点从 0 长到 1）；扩圈 = 对接锁定。
 * 窗口失焦暂停、prefers-reduced-motion 全部静止，都在 story.css（状态本身仍可见）。
 *
 * 三种画风只换布局表与皮（story-layouts.ts）：
 * observe 轨道 + 发丝辐线；lines 地铁线路（实色粗线、45°折线、一幕一色）；journal 线索卡片 + 虚线牵线。
 */
import type { CSSProperties } from "react";
import type { OnboardingStyle } from "@shared/settings";
import { CENTER, DRIFT, MAP_SIZE, ORBIT_RADIUS, ORBIT_SECONDS, layoutOf, type NodePlace, type Segment } from "./story-layouts.ts";
import {
  STATIONS,
  STATION_IDS,
  ringSynced,
  stationStates,
  type StationId,
  type StationState,
  type StoryState,
} from "./story-script.ts";

export interface StarMapNames {
  stations: Record<StationId, { name: string; feature: string }>;
  stateName: Record<StationState, string>;
  /** 站按钮的读屏名字：「观测站，失步」 */
  button: (name: string, state: string) => string;
}

/** 背景的星尘：写死的伪随机，每次渲染一样（不是装饰动画，是静止的底） */
const STARDUST: readonly { x: number; y: number; r: number; o: number }[] = Array.from({ length: 54 }, (_, i) => {
  const a = Math.abs(Math.sin((i + 1) * 12.9898) * 43758.5453) % 1;
  const b = Math.abs(Math.sin((i + 1) * 78.233) * 12345.6789) % 1;
  const c = Math.abs(Math.sin((i + 1) * 39.346) * 9876.543) % 1;
  return { x: Math.round(a * 580 + 10), y: Math.round(b * 580 + 10), r: 0.7 + c * 1.3, o: 0.25 + c * 0.55 };
});

const pct = (value: number): string => `${((value / MAP_SIZE) * 100).toFixed(3)}%`;

/** 站亮起来的延迟（ms）：等连线从上一座站长到它这里（每段 260ms 一接力，最后一段再留 360ms），线到了站才锁 */
function arriveMs(style: OnboardingStyle, id: StationId): number {
  const segs = layoutOf(style).links[id].length;
  return segs === 0 ? 0 : (segs - 1) * 260 + 360;
}

/** 每座站的 CSS 变量：序号（错开抖动相位）、锁回延迟、失步偏离量 */
function nodeVars(id: StationId, arrive: number): CSSProperties {
  return { "--i": STATION_IDS.indexOf(id), "--arrive": `${arrive}ms`, "--dx": DRIFT[id].x, "--dy": DRIFT[id].y } as CSSProperties;
}

function segmentStyle(seg: Segment, order: number): CSSProperties {
  return { "--s": order, transformOrigin: `${seg.x1}px ${seg.y1}px` } as CSSProperties;
}

/** 站的图形：几层叠着，按状态淡入淡出（空心 / 实心）。diamond = 另一个 agent（僚机），设计系统的图例 */
function Glyph(props: { r: number; diamond?: boolean }) {
  const { r } = props;
  if (props.diamond === true) {
    return (
      <g transform="rotate(45)">
        <rect className="sv-hollow" x={-r} y={-r} width={r * 2} height={r * 2} />
        <rect className="sv-fill" x={-r} y={-r} width={r * 2} height={r * 2} />
        <rect className="sv-core" x={-r * 0.45} y={-r * 0.45} width={r * 0.9} height={r * 0.9} />
      </g>
    );
  }
  return (
    <>
      <circle className="sv-hollow" r={r} />
      <circle className="sv-fill" r={r} />
      <circle className="sv-core" r={r * 0.45} />
    </>
  );
}

/** 僚机：绕着僚机站转的小点（一架一个，放出去一架多一个） */
function Moons(props: { count: number; r: number }) {
  if (props.count <= 0) return null;
  return (
    <g className="sv-moons" aria-hidden="true">
      {Array.from({ length: props.count }, (_, i) => (
        <g key={i} className="sv-moon-orbit" style={{ "--phase": `${i * -3}s` } as CSSProperties}>
          <circle className="sv-moon" cx={props.r + 11} cy={0} r={3} />
        </g>
      ))}
    </g>
  );
}

function Node(props: {
  id: StationId;
  place: NodePlace;
  state: StationState;
  focus: boolean;
  hint: boolean;
  nope: boolean;
  moons: number;
  r: number;
  arrive: number;
}) {
  const { id, place, state } = props;
  const hub = id === "pilot";
  return (
    <g className="sv-node" data-id={id} data-state={state} data-focus={props.focus ? "true" : undefined} data-line={place.line} style={nodeVars(id, props.arrive)} transform={`translate(${place.x} ${place.y})`}>
      <g className="sv-drift">
        <circle className="sv-focus" r={props.r + 9} />
        {props.hint && state === "lost" && <circle className="sv-hintring" r={props.r + 14} />}
        <g className="sv-shake">
          <g className={props.nope ? "sv-nope" : undefined}>
            {hub && <circle className="sv-halo" r={props.r + 6} />}
            <Glyph r={props.r} diamond={id === "wing"} />
          </g>
        </g>
        {id === "wing" && <Moons count={props.moons} r={props.r} />}
      </g>
      {state === "linked" && <circle className="sv-ping" r={props.r} key="ping" />}
    </g>
  );
}

function Links(props: { style: OnboardingStyle; states: Record<StationId, StationState>; ring?: 0 | 1 | 2 | 3 }) {
  const layout = layoutOf(props.style);
  return (
    <g className="sv-links">
      {STATIONS.filter((station) => props.ring === undefined || station.ring === props.ring).map((station) => {
        const segs = layout.links[station.id];
        if (segs.length === 0) return null;
        const linked = props.states[station.id] === "linked";
        const place = layout.nodes[station.id];
        return (
          <g key={station.id} data-id={station.id} data-line={place.line} data-state={props.states[station.id]}>
            {/* 线路图的「预定线路」：还没接通的线先以淡虚线画出来，接通时实线从起点长上去盖住它 */}
            {props.style === "lines" && !linked && segs.map((seg, i) => <line key={`g${i}`} className="sv-ghost" x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2} />)}
            {linked && segs.map((seg, i) => <line key={`l${i}`} className="sv-link" x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2} style={segmentStyle(seg, i)} />)}
          </g>
        );
      })}
    </g>
  );
}

interface Live {
  focus: StationId | undefined;
  hint: StationId | undefined;
  moons: number;
  wrongStation: StationId | null;
  wrongSeq: number;
}

/** 观测记录：刻度环 + 轨道圈（同步了的圈实线、没同步的虚线）+ 转动的圈组 */
function ObserveLayer(props: { state: StoryState; states: Record<StationId, StationState>; live: Live }) {
  const layout = layoutOf("observe");
  const rings = [1, 2, 3] as const;
  const { live } = props;
  return (
    <>
      {/* 刻度环：天文仪器的外圈，每 5 度一道、每 30 度一道长的。静止的底，不是装饰动画 */}
      <g className="sv-ticks" aria-hidden="true">
        {Array.from({ length: 72 }, (_, i) => {
          const rad = (i * 5 * Math.PI) / 180;
          const long = i % 6 === 0;
          const r0 = 284;
          const r1 = long ? 295 : 290;
          return <line key={i} data-long={long ? "true" : undefined} x1={CENTER + r0 * Math.cos(rad)} y1={CENTER + r0 * Math.sin(rad)} x2={CENTER + r1 * Math.cos(rad)} y2={CENTER + r1 * Math.sin(rad)} />;
        })}
      </g>
      {rings.map((ring) => (
        <g key={`o${ring}`} className="sv-orbit" data-synced={ringSynced(ring, props.state) ? "true" : "false"}>
          <circle className="sv-orbit-off" cx={CENTER} cy={CENTER} r={ORBIT_RADIUS[ring]} />
          <circle className="sv-orbit-on" cx={CENTER} cy={CENTER} r={ORBIT_RADIUS[ring]} />
        </g>
      ))}
      {rings.map((ring) => (
        <g
          key={`g${ring}`}
          className="sv-ring"
          data-ring={ring}
          data-spin={ringSynced(ring, props.state) ? "on" : "off"}
          style={{ "--period": `${ORBIT_SECONDS[ring]}s` } as CSSProperties}
        >
          <Links style="observe" states={props.states} ring={ring} />
          {STATIONS.filter((station) => station.ring === ring).map((station) => (
            <Node
              key={`${station.id}:${live.wrongStation === station.id ? live.wrongSeq : 0}`}
              id={station.id}
              place={layout.nodes[station.id]}
              state={props.states[station.id]}
              focus={live.focus === station.id}
              hint={live.hint === station.id}
              nope={live.wrongStation === station.id}
              moons={live.moons}
              r={9}
              arrive={arriveMs("observe", station.id)}
            />
          ))}
        </g>
      ))}
    </>
  );
}

function Labels(props: {
  style: OnboardingStyle;
  states: Record<StationId, StationState>;
  live: Live;
  names: StarMapNames;
  state: StoryState;
  interactive: (id: StationId) => boolean;
  onTap: (id: StationId) => void;
}) {
  const layout = layoutOf(props.style);
  const { names, live } = props;
  const label = (id: StationId, counter: boolean) => {
    const place = layout.nodes[id];
    const state = props.states[id];
    const focus = live.focus === id;
    const info = names.stations[id];
    const can = props.interactive(id);
    const aria = names.button(info.name, names.stateName[state]);
    const nope = live.wrongStation === id;
    if (props.style === "journal") {
      return (
        <button
          key={`${id}:${nope ? live.wrongSeq : 0}`}
          type="button"
          className="sv-card"
          data-id={id}
          data-state={state}
          data-focus={focus ? "true" : undefined}
          data-hint={live.hint === id && state === "lost" ? "true" : undefined}
          data-nope={nope ? "true" : undefined}
          disabled={!can}
          aria-label={aria}
          onClick={() => props.onTap(id)}
          style={{ left: pct(place.x), top: pct(place.y), "--tilt": `${place.tilt ?? 0}deg`, "--dx": DRIFT[id].x, "--dy": DRIFT[id].y, "--i": STATION_IDS.indexOf(id), "--arrive": `${arriveMs(props.style, id)}ms` } as CSSProperties}
        >
          <span className="sv-card-pin" aria-hidden="true" />
          <b className="sv-card-name">{info.name}</b>
          <small className="sv-card-sub">{state === "lost" ? names.stateName.lost : info.feature}</small>
          {id === "wing" && live.moons > 0 && (
            <span className="sv-card-moons" aria-hidden="true">
              {Array.from({ length: live.moons }, (_, i) => (
                <i key={i} />
              ))}
            </span>
          )}
        </button>
      );
    }
    const place2 = place.label;
    const inner = (
      <>
        <button type="button" className="sv-hit" disabled={!can} aria-label={aria} onClick={() => props.onTap(id)} />
        <span className="sv-lbl-txt" data-side={place2.side} style={{ "--dx": place2.dx, "--dy": place2.dy } as CSSProperties}>
          <b>{info.name}</b>
          {focus && <small>{info.feature}</small>}
        </span>
      </>
    );
    return (
      <div
        key={id}
        className="sv-lbl"
        data-id={id}
        data-state={state}
        data-focus={focus ? "true" : undefined}
        style={{ left: pct(place.x), top: pct(place.y), "--dx0": DRIFT[id].x, "--dy0": DRIFT[id].y, "--arrive": `${arriveMs(props.style, id)}ms` } as CSSProperties}
      >
        {counter ? <div className="sv-lbl-in">{inner}</div> : inner}
      </div>
    );
  };

  if (props.style === "observe") {
    return (
      <>
        {([1, 2, 3] as const).map((ring) => (
          <div
            key={ring}
            className="sv-ov-ring"
            data-ring={ring}
            data-spin={ringSynced(ring, props.state) ? "on" : "off"}
            style={{ "--period": `${ORBIT_SECONDS[ring]}s` } as CSSProperties}
          >
            {STATIONS.filter((station) => station.ring === ring).map((station) => label(station.id, true))}
          </div>
        ))}
        {label("pilot", false)}
      </>
    );
  }
  return <>{STATION_IDS.map((id) => label(id, false))}</>;
}

export function StarMap(props: {
  style: OnboardingStyle;
  state: StoryState;
  focus: StationId | undefined;
  /** 提示玩家点哪座（tap 动作的目标；按顺序点的步，点错之后的下一座） */
  hint: StationId | undefined;
  /** 僚机站身边绕着几架僚机 */
  moons: number;
  /** 最近一次点错的站（抖一下）与第几次点错（同一座连点两次也要再抖） */
  wrongStation: StationId | null;
  wrongSeq: number;
  /** 这一刻这座站能不能点 */
  interactive: (id: StationId) => boolean;
  onTap: (id: StationId) => void;
  names: StarMapNames;
  ariaLabel: string;
}) {
  const states = stationStates(props.state);
  const layout = layoutOf(props.style);
  const pilot = layout.nodes.pilot;
  const hubR = props.style === "lines" ? 17 : 14;
  const nodeR = props.style === "lines" ? 12 : 9;
  const journal = props.style === "journal";
  const live: Live = { focus: props.focus, hint: props.hint, moons: props.moons, wrongStation: props.wrongStation, wrongSeq: props.wrongSeq };
  return (
    <div className="sv-map" data-style={props.style}>
      <svg className="sv-svg" viewBox={`0 0 ${MAP_SIZE} ${MAP_SIZE}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={props.ariaLabel}>
        {journal && (
          <g className="sv-dust" aria-hidden="true">
            {STARDUST.map((dot, i) => (
              <circle key={i} cx={dot.x} cy={dot.y} r={dot.r} opacity={dot.o} />
            ))}
          </g>
        )}
        {props.style === "observe" ? (
          <ObserveLayer state={props.state} states={states} live={live} />
        ) : (
          <>
            <Links style={props.style} states={states} />
            {journal && (
              <g className="sv-closing">
                {states.patrol === "linked" &&
                  layout.closing.map((seg, i) => (
                    <line key={i} className="sv-link sv-link-closing" x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2} style={segmentStyle(seg, 0)} />
                  ))}
              </g>
            )}
            {!journal &&
              STATIONS.filter((station) => station.ring !== 0).map((station) => (
                <Node
                  key={`${station.id}:${live.wrongStation === station.id ? live.wrongSeq : 0}`}
                  id={station.id}
                  place={layout.nodes[station.id]}
                  state={states[station.id]}
                  focus={live.focus === station.id}
                  hint={live.hint === station.id}
                  nope={live.wrongStation === station.id}
                  moons={live.moons}
                  r={nodeR}
                  arrive={arriveMs(props.style, station.id)}
                />
              ))}
          </>
        )}
        {/* 领航站在最上层：观测记录里它不随轨道转（转的是别的站围着它转） */}
        {!journal && (
          <Node
            key={`pilot:${live.wrongStation === "pilot" ? live.wrongSeq : 0}`}
            id="pilot"
            place={pilot}
            state={states.pilot}
            focus={live.focus === "pilot"}
            hint={live.hint === "pilot"}
            nope={live.wrongStation === "pilot"}
            moons={0}
            r={hubR}
            arrive={0}
          />
        )}
      </svg>
      <div className="sv-ov">
        <Labels style={props.style} states={states} live={live} names={props.names} state={props.state} interactive={props.interactive} onTap={props.onTap} />
      </div>
    </div>
  );
}
