/**
 * 星图：故事版引导里一直亮着的那张图。**一个 SVG、固定 600 × 600 的 viewBox、窗口缩放时等比缩**，不重排。
 * 文字（站名、卡片）放在同尺寸的 HTML 层里叠在 SVG 上，按百分比定位——SVG 里的字会随图一起缩小，
 * 小窗里就读不清；叠一层 HTML 才能让字永远是设计系统的真字号。
 *
 * 运动都有含义，且只用 transform / opacity：
 * - 转 = 运转：一圈轨道上的站全接通，这一圈才开始转（观测记录）
 * - 抖 = 失步：出场了但还没接通的站，微微抖动、闪烁
 * - 连线 = 通讯建立：接通那一刻，线从上一座站「长」过来（以起点为原点 scale 0 → 1）
 * - 环形扩散 = 对接锁定：接通那一刻站上扩出一圈就消失
 * 窗口失焦暂停、prefers-reduced-motion 全部静止，都在 story.css（状态本身仍可见）。
 *
 * 三种画风只换布局表与皮（story-layouts.ts）：
 * observe 轨道 + 发丝辐线；lines 地铁线路（实色粗线、45°折线、一幕一色）；journal 线索卡片 + 虚线牵线。
 */
import type { CSSProperties } from "react";
import type { OnboardingStyle } from "@shared/settings";
import { CENTER, MAP_SIZE, ORBIT_RADIUS, ORBIT_SECONDS, layoutOf, type NodePlace, type Segment } from "./story-layouts.ts";
import {
  STATIONS,
  STATION_IDS,
  ringSynced,
  stationStates,
  type Ring,
  type StationId,
  type StationState,
  type StoryState,
} from "./story-script.ts";

export interface StarMapNames {
  stations: Record<StationId, { name: string; feature: string }>;
  stateName: Record<StationState, string>;
}

/** 背景的星尘：写死的伪随机，每次渲染一样（不是装饰动画，是静止的底） */
const STARDUST: readonly { x: number; y: number; r: number; o: number }[] = Array.from({ length: 54 }, (_, i) => {
  const a = Math.abs(Math.sin((i + 1) * 12.9898) * 43758.5453) % 1;
  const b = Math.abs(Math.sin((i + 1) * 78.233) * 12345.6789) % 1;
  const c = Math.abs(Math.sin((i + 1) * 39.346) * 9876.543) % 1;
  return { x: Math.round(a * 580 + 10), y: Math.round(b * 580 + 10), r: 0.7 + c * 1.3, o: 0.25 + c * 0.55 };
});

const pct = (value: number): string => `${((value / MAP_SIZE) * 100).toFixed(3)}%`;

function indexOfStation(id: StationId): number {
  return STATION_IDS.indexOf(id);
}

/** 站亮起来的延迟（ms）：等连线从上一座站长到它这里（每段 260ms 一接力，最后一段再留 360ms），线到了站才亮 */
function arriveMs(style: OnboardingStyle, id: StationId): number {
  const segs = layoutOf(style).links[id].length;
  return segs === 0 ? 0 : (segs - 1) * 260 + 360;
}

function nodeVars(id: StationId, arrive = 0): CSSProperties {
  return { "--i": indexOfStation(id), "--arrive": `${arrive}ms` } as CSSProperties;
}

function segmentStyle(seg: Segment, order: number): CSSProperties {
  return { "--s": order, transformOrigin: `${seg.x1}px ${seg.y1}px` } as CSSProperties;
}

/** 站的图形：三层叠着，按状态淡入淡出（暗点 / 空心 / 实心）。diamond = 另一个 agent（僚机），设计系统的图例 */
function Glyph(props: { r: number; diamond?: boolean }) {
  const { r } = props;
  if (props.diamond === true) {
    return (
      <g transform="rotate(45)">
        <rect className="sv-dot" x={-r * 0.35} y={-r * 0.35} width={r * 0.7} height={r * 0.7} />
        <rect className="sv-hollow" x={-r} y={-r} width={r * 2} height={r * 2} />
        <rect className="sv-fill" x={-r} y={-r} width={r * 2} height={r * 2} />
      </g>
    );
  }
  return (
    <>
      <circle className="sv-dot" r={r * 0.42} />
      <circle className="sv-hollow" r={r} />
      <circle className="sv-fill" r={r} />
    </>
  );
}

function Node(props: { id: StationId; place: NodePlace; state: StationState; focus: boolean; r: number; arrive: number }) {
  const { id, place, state } = props;
  const hub = id === "pilot";
  return (
    <g className="sv-node" data-id={id} data-state={state} data-focus={props.focus ? "true" : undefined} data-line={place.line} style={nodeVars(id, props.arrive)} transform={`translate(${place.x} ${place.y})`}>
      <circle className="sv-focus" r={props.r + 9} />
      <g className="sv-shake">
        {hub && <circle className="sv-halo" r={props.r + 6} />}
        <Glyph r={props.r} diamond={id === "wing"} />
      </g>
      {state === "linked" && <circle className="sv-ping" r={props.r} key="ping" />}
    </g>
  );
}

function Links(props: { style: OnboardingStyle; states: Record<StationId, StationState>; ring?: Ring }) {
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

/** 观测记录：轨道圈（同步了的圈实线、没同步的虚线）+ 转动的圈组 */
function ObserveLayer(props: { state: StoryState; states: Record<StationId, StationState>; focus: StationId | undefined }) {
  const layout = layoutOf("observe");
  const rings = [1, 2, 3] as const;
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
            <Node key={station.id} id={station.id} place={layout.nodes[station.id]} state={props.states[station.id]} focus={props.focus === station.id} r={7} arrive={arriveMs("observe", station.id)} />
          ))}
        </g>
      ))}
    </>
  );
}

function Labels(props: { style: OnboardingStyle; states: Record<StationId, StationState>; focus: StationId | undefined; names: StarMapNames; state: StoryState }) {
  const layout = layoutOf(props.style);
  const { names } = props;
  const label = (id: StationId, counter: boolean) => {
    const place = layout.nodes[id];
    const state = props.states[id];
    const focus = props.focus === id;
    const info = names.stations[id];
    if (props.style === "journal") {
      return (
        <div
          key={id}
          className="sv-card"
          data-id={id}
          data-state={state}
          data-focus={focus ? "true" : undefined}
          style={{ left: pct(place.x), top: pct(place.y), "--tilt": `${place.tilt ?? 0}deg`, ...nodeVars(id, arriveMs(props.style, id)) } as CSSProperties}
        >
          <span className="sv-card-pin" aria-hidden="true" />
          {state === "dim" ? (
            <span className="sv-card-q" aria-hidden="true">
              ?
            </span>
          ) : (
            <>
              <b className="sv-card-name">{info.name}</b>
              <small className="sv-card-sub">{state === "lost" ? names.stateName.lost : info.feature}</small>
            </>
          )}
        </div>
      );
    }
    const place2 = place.label;
    const inner = (
      <span className="sv-lbl-txt" data-side={place2.side} style={{ "--dx": place2.dx, "--dy": place2.dy } as CSSProperties}>
        <b>{info.name}</b>
        {focus && state !== "dim" && <small>{info.feature}</small>}
      </span>
    );
    return (
      <div key={id} className="sv-lbl" data-id={id} data-state={state} data-focus={focus ? "true" : undefined} style={{ left: pct(place.x), top: pct(place.y) }}>
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

export function StarMap(props: { style: OnboardingStyle; state: StoryState; focus: StationId | undefined; names: StarMapNames; ariaLabel: string }) {
  const states = stationStates(props.state);
  const layout = layoutOf(props.style);
  const pilot = layout.nodes.pilot;
  const hubR = props.style === "lines" ? 15 : 12;
  const nodeR = props.style === "lines" ? 10 : 7;
  const journal = props.style === "journal";
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
          <ObserveLayer state={props.state} states={states} focus={props.focus} />
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
                <Node key={station.id} id={station.id} place={layout.nodes[station.id]} state={states[station.id]} focus={props.focus === station.id} r={nodeR} arrive={arriveMs(props.style, station.id)} />
              ))}
          </>
        )}
        {/* 领航站在最上层：观测记录里它不随轨道转（转的是别的站围着它转） */}
        {!journal && <Node id="pilot" place={{ ...pilot, x: pilot.x, y: pilot.y }} state={states.pilot} focus={props.focus === "pilot"} r={hubR} arrive={0} />}
      </svg>
      <div className="sv-ov" aria-hidden="true">
        <Labels style={props.style} states={states} focus={props.focus} names={props.names} state={props.state} />
      </div>
      <ul className="sv-sr">
        {STATION_IDS.map((id) => (
          <li key={id}>
            {props.names.stations[id].name}: {props.names.stateName[states[id]]}
          </li>
        ))}
      </ul>
    </div>
  );
}
