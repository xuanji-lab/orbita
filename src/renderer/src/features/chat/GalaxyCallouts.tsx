import { useLayoutEffect, useRef, useState } from "react";
import type { PlanetItem } from "./galaxy.ts";
import { truncateLabel } from "./galaxy.ts";
import {
  calloutBudget,
  calloutRank,
  lockFramePath,
  placeCallouts,
  type CalloutDir,
  type CalloutPlacement,
  type CalloutTarget,
} from "./callouts.ts";

/**
 * 星系上的「锁定框 + 引线」层（New Task 页的大星系与右栏编排面板的星系图共用）：
 * - 在做工（等你 / 在跑）的行星都有锁定框（四个角括号）；等你的框用 warning 色（状态色是第二信号，第一信号是框上的字「等你」）；
 * - 最要紧的几颗（calloutBudget 按画布宽给）从框角升起一根引线，任务名写在线上；放不下的只留框，悬停出名字；
 * - 每帧按行星此刻的位置重排（placeCallouts，带滞回），线跟着天体转。
 * 其余没在做工的行星：悬停出名字（旧的 .galaxy-tag 规矩，不常显）。
 */
export function GalaxyCallouts(props: {
  planets: readonly PlanetItem[];
  /** 行星 id → 轨道次序（越小越要紧） */
  rankOf: ReadonlyMap<string, number>;
  star: { x: number; y: number; r: number } | null;
  width: number;
  height: number;
  waitingWord: string;
}) {
  const [glyphPx, setFontSize] = useState(12);
  const probeRef = useRef<SVGTextElement | null>(null);
  // 字号跟设计系统的 --font-size-sm 走（由 --ui-font-size 派生）：挂上后量一次真实字号，排布按它估字宽
  useLayoutEffect(() => {
    const el = probeRef.current;
    if (el === null) return;
    const size = Number.parseFloat(getComputedStyle(el).fontSize);
    if (Number.isFinite(size) && size > 0 && size !== glyphPx) setFontSize(size);
  });
  const previousRef = useRef(new Map<string, { dir: CalloutDir; lift: number }>());
  const targets: CalloutTarget[] = [];
  for (const planet of props.planets) {
    if (planet.state !== "waiting" && planet.state !== "running") continue;
    if (planet.label === null || planet.label === "") continue;
    const state = planet.state;
    const title = truncateLabel(planet.label);
    targets.push({
      id: planet.planetId,
      x: planet.x,
      y: planet.y,
      r: planet.r,
      state,
      text: state === "waiting" ? `${props.waitingWord} · ${title}` : title,
      rank: calloutRank(state, props.rankOf.get(planet.planetId) ?? 0),
    });
  }
  const placed = placeCallouts({
    targets,
    bodies: props.planets.map((planet) => ({ id: planet.planetId, x: planet.x, y: planet.y, r: planet.r })),
    star: props.star,
    width: props.width,
    height: props.height,
    glyphPx,
    budget: calloutBudget(props.width),
    previous: previousRef.current,
  });
  // 记下这一帧的方位（下一帧先试它）：渲染期写 ref 只影响下一次排布，不触发重渲染
  previousRef.current = new Map(placed.map((item) => [item.id, { dir: item.dir, lift: item.lift }]));
  const byId = new Map<string, CalloutPlacement>(placed.map((item) => [item.id, item]));
  const working = props.planets.filter((planet) => planet.state === "waiting" || planet.state === "running");
  const ordered = [...props.planets].sort((a, b) => (props.rankOf.get(a.planetId) ?? 0) - (props.rankOf.get(b.planetId) ?? 0));
  return (
    <g className="galaxy-callouts" data-callouts={placed.length} data-locked={working.length}>
      <text ref={probeRef} className="galaxy-callout-text" x={-999} y={-999} aria-hidden="true">
        {""}
      </text>
      {working.map((planet) => (
        <path
          key={`lock-${planet.planetId}`}
          className="galaxy-lock"
          data-state={planet.state ?? undefined}
          data-planet={planet.planetId}
          d={lockFramePath(planet.x, planet.y, planet.r)}
        />
      ))}
      {placed.map((item) => {
        const target = targets.find((each) => each.id === item.id);
        return (
          <g key={`callout-${item.id}`} className="galaxy-callout" data-planet={item.id} data-state={target?.state} data-dir={item.dir}>
            <path
              className="galaxy-callout-line"
              d={`M${item.start.x.toFixed(1)} ${item.start.y.toFixed(1)}L${item.elbow.x.toFixed(1)} ${item.elbow.y.toFixed(1)}L${item.end.x.toFixed(1)} ${item.end.y.toFixed(1)}`}
            />
            <text className="galaxy-callout-text" x={item.textX} y={item.textY} textAnchor={item.anchor}>
              {target?.text}
            </text>
          </g>
        );
      })}
      {/* 没画引线的行星：悬停出名字（命中圈比星体大一圈）。有引线的已经写着了，不重复 */}
      {ordered.map((planet) =>
        byId.has(planet.planetId) || planet.label === null || planet.label === "" ? null : (
          <g key={`tag-${planet.planetId}`} className="galaxy-tag">
            <circle className="galaxy-hit" cx={planet.x} cy={planet.y} r={planet.r + 7} />
            <text
              className="galaxy-tag-text"
              x={planet.x > props.width * 0.65 ? planet.x - planet.r - 7 : planet.x + planet.r + 7}
              y={planet.y}
              textAnchor={planet.x > props.width * 0.65 ? "end" : "start"}
              dominantBaseline="central"
            >
              {truncateLabel(planet.label)}
            </text>
          </g>
        ),
      )}
    </g>
  );
}
