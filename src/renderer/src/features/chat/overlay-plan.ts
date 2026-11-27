import { truncateLabel, type DrawItem, type GalaxyLayout, type PlanetItem, type RockItem } from "./galaxy.ts";
import { calloutBudget, calloutRank, lockFrame, placeCallouts, placeNameTags, type Box, type CalloutDir, type CalloutTarget } from "./callouts.ts";

/**
 * 星系最上层的排布（纯计算，可被 node --test 直接加载；HomeGalaxy 每 33ms / 拖动中每帧按此刻的天体位置算一次）：
 * 谁被主星挡住、谁走进禁区、子智能体的名字写哪边、哪些在做事的会话拉引线。
 *
 * 2026-11-24 用户：「为什么有些视角，session 的 annotation 就消失了。」复现下来有两条规则会让在跑 / 等你 / 最近的标注跟着视角消失：
 * 1. 碎石块那一圈让不开（cramped，低俯角下近侧横过主星、或最外一颗行星挤着）就整圈不画——碎石块连同它的锁定框、引线一起没了；
 * 2. 引线防撞找不到位置（四个方向、两档高度都压到别的天体 / 画布边 / 别的引线）就丢掉。
 * 现在这两种都不丢：放不下引线的（以及碎石块整圈没画的）进 spill，HomeGalaxy 在星系左下角排成一列「等你 · 标题」。
 * 只有「此刻转到主星背后被挡住」的那一颗暂时不标（锁定框淡出），转出来就回来。
 */
export interface OverlayPlanInput {
  items: readonly DrawItem[];
  layout: Pick<GalaxyLayout, "rocks" | "rockOrbit">;
  /** 主星连星环 / 日冕的外缘是主星半径的几倍 */
  starExtent: number;
  /** 子智能体行星的名字（编排星系）；没有 = 不写名字 */
  agentNames: ReadonlyMap<string, string> | null;
  starless: boolean;
  /** 禁区（标题与输入框那一块） */
  avoid: Box | null;
  width: number;
  height: number;
  glyphPx: number;
  waitingWord: string;
  rankOf: ReadonlyMap<string, number>;
  previous: ReadonlyMap<string, { dir: CalloutDir; lift: number }>;
}

export interface OverlayPlanResult {
  hidden: Set<string>;
  masked: Set<string>;
  names: Map<string, { dx: number; dy: number; anchor: "start" | "middle" | "end" }>;
  callouts: Map<string, { dir: CalloutDir; lift: number }>;
  /** 在跑 / 等你 / 最近、但这一刻拉不出引线的（或碎石块整圈没画的）：改在角落列出来 */
  spill: CalloutTarget[];
  /** 此刻被主星挡住、暂时不标的在做事的会话 */
  occluded: string[];
}

type Active = "waiting" | "running" | "recent";

function isActive(state: string | null | undefined): state is Active {
  return state === "waiting" || state === "running" || state === "recent";
}

export function planOverlay(input: OverlayPlanInput): OverlayPlanResult {
  const { items, avoid, glyphPx } = input;
  const star = items.find((item) => item.kind === "star");
  const starDisc = star === undefined ? null : { x: star.x, y: star.y, r: star.r * input.starExtent };
  const planets = items.filter((item): item is PlanetItem => item.kind === "planet");
  const rocks = items.filter((item): item is RockItem => item.kind === "rock");
  const hidden = new Set<string>();
  const masked = new Set<string>();
  for (const body of [...planets, ...rocks]) {
    const reach = body.kind === "rock" ? lockFrame(body.r).half : body.r;
    if (starDisc !== null && star !== undefined && body.depth > star.depth && Math.hypot(body.x - starDisc.x, body.y - starDisc.y) < starDisc.r + reach) hidden.add(body.planetId);
    // 走进禁区（标题与输入框那一块）：整颗淡出，名字、框、命中圈都不画
    if (avoid !== null && boxesOverlap(avoid, { x0: body.x - reach, y0: body.y - reach, x1: body.x + reach, y1: body.y + reach })) {
      masked.add(body.planetId);
      hidden.add(body.planetId);
    }
  }
  const visiblePlanets = planets.filter((planet) => !hidden.has(planet.planetId));
  const visibleRocks = rocks.filter((rock) => !hidden.has(rock.planetId));
  const names = new Map<string, { dx: number; dy: number; anchor: "start" | "middle" | "end" }>();
  const agents = input.agentNames;
  const tags =
    agents === null
      ? []
      : placeNameTags({
          planets: visiblePlanets.map((planet) => ({ id: planet.planetId, x: planet.x, y: planet.y, r: planet.r, name: agents.get(planet.planetId) ?? "" })),
          bodies: [...planets.map((body) => ({ id: body.planetId, x: body.x, y: body.y, r: body.r })), ...rocks.map((body) => ({ id: body.planetId, x: body.x, y: body.y, r: lockFrame(body.r).half }))],
          star: starDisc,
          width: input.width,
          height: input.height,
          glyphPx,
        });
  for (const tag of tags) {
    if (avoid !== null && boxesOverlap(avoid, tag.box)) continue;
    const planet = planets.find((p) => p.planetId === tag.id);
    if (planet !== undefined) names.set(tag.id, { dx: Math.round((tag.x - planet.x) * 10) / 10, dy: Math.round((tag.y - planet.y) * 10) / 10, anchor: tag.anchor });
  }
  const callouts = new Map<string, { dir: CalloutDir; lift: number }>();
  const spill: CalloutTarget[] = [];
  const occluded: string[] = [];
  if (!input.starless) {
    const bodies = agents === null ? visiblePlanets : [...visiblePlanets.map((planet) => ({ ...planet, label: null })), ...visibleRocks];
    const targets: CalloutTarget[] = [];
    const textOf = (state: Active, label: string): string => (state === "waiting" ? `${input.waitingWord} · ${truncateLabel(label)}` : truncateLabel(label));
    for (const body of bodies) {
      // recent（最近但没在做事的会话，只有碎石块有）也拉引线写名字，排在在做事的后面、样式轻一档
      if (!isActive(body.state)) continue;
      if (body.label === null || body.label === "") continue;
      targets.push({ id: body.planetId, x: body.x, y: body.y, r: body.r, state: body.state, text: textOf(body.state, body.label), rank: calloutRank(body.state, input.rankOf.get(body.planetId) ?? 0) });
    }
    for (const body of [...planets, ...rocks]) {
      if (hidden.has(body.planetId) && !masked.has(body.planetId) && isActive(body.state) && body.label !== null && body.label !== "" && (agents === null || body.kind === "rock")) occluded.push(body.planetId);
    }
    const placed = placeCallouts({
      targets,
      bodies: bodies.map((body) => ({ id: body.planetId, x: body.x, y: body.y, r: body.r })),
      star: starDisc,
      width: input.width,
      height: input.height,
      glyphPx,
      budget: calloutBudget(input.width),
      previous: input.previous,
      reserved: avoid === null ? tags.map((tag) => tag.box) : [...tags.map((tag) => tag.box), avoid],
    });
    for (const item of placed) callouts.set(item.id, { dir: item.dir, lift: item.lift });
    for (const target of targets) if (!callouts.has(target.id)) spill.push(target);
    // 碎石块那一圈整圈没画（cramped）：它们没有屏幕位置，直接进角落那一列
    if (input.layout.rockOrbit === null && agents !== null) {
      input.layout.rocks.forEach((rock, index) => {
        if (!isActive(rock.state) || rock.label === "") return;
        spill.push({ id: rock.id, x: Number.NaN, y: Number.NaN, r: 0, state: rock.state, text: textOf(rock.state, rock.label), rank: calloutRank(rock.state, 100 + index) });
      });
    }
    spill.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  }
  return { hidden, masked, names, callouts, spill, occluded };
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}
