/**
 * 星图的几何：三种画风各一张布局表（固定 600 × 600 的 viewBox，窗口缩放时等比缩，不重排）。
 * 纯数据 + 纯函数；StarMap 只管按表画。
 *
 * - observe（观测记录）：三圈轨道，站在轨道上，连线是从中心辐射出去的发丝线
 * - lines（星座线路图）：地铁线路图——站在线上，线只走水平 / 竖直 / 45°，一幕一条线一个颜色
 * - journal（航行日志）：线索卡片散在板上，虚线按查案顺序一张牵一张，最后牵回领航站
 * 三种布局的站与登场 / 接通顺序完全相同，只是摆法不同。
 */
import type { OnboardingStyle } from "@shared/settings";
import { STATIONS, type Ring, type StationId } from "./story-script.ts";

export const MAP_SIZE = 600;
export const CENTER = MAP_SIZE / 2;

export interface Point {
  x: number;
  y: number;
}

/** 一段直线：连线动画是「以起点为原点从 0 长到 1」，所以每段只有一个起点 */
export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** 标签相对站的位置：dx / dy 是 viewBox 单位，side 决定文字相对锚点往哪边靠 */
export interface LabelPlace {
  dx: number;
  dy: number;
  side: "start" | "middle" | "end";
}

export interface NodePlace extends Point {
  label: LabelPlace;
  /** 线路图：这座站在哪条线上（0 = 换乘站，也就是领航站；1 / 2 / 3 = 一幕一条线） */
  line?: 0 | 1 | 2 | 3;
  /** 航行日志：卡片的歪斜角度（度） */
  tilt?: number;
}

export interface Layout {
  nodes: Record<StationId, NodePlace>;
  /** 每座站接通时画出的线：从上一座站（或领航站）连到它。领航站自己没有 */
  links: Record<StationId, readonly Segment[]>;
  /** 结局时多画的一笔：把链条合成环（日志 = 末站牵回领航站；其余没有） */
  closing: readonly Segment[];
}

/** 观测记录：三圈轨道的半径，和每座站在自己那圈上的起始角度（度，0 = 正东，顺时针） */
export const ORBIT_RADIUS: Record<Exclude<Ring, 0>, number> = { 1: 100, 2: 178, 3: 252 };
/** 九座站按登场顺序，在整圈上每隔 40 度各占一个方向：连线像一把展开的扇子，谁也不压谁的线 */
const ANGLE = Object.fromEntries(STATIONS.filter((station) => station.ring !== 0).map((station, i) => [station.id, -90 + i * 40])) as Record<StationId, number>;

/** 轨道转一圈要多少秒（越外越慢；慢到不抢眼，但盯一会儿能看出在转，不是在晃） */
export const ORBIT_SECONDS: Record<Exclude<Ring, 0>, number> = { 1: 200, 2: 300, 3: 420 };

function polar(ring: Exclude<Ring, 0>, degrees: number): Point {
  const r = ORBIT_RADIUS[ring];
  const rad = (degrees * Math.PI) / 180;
  return { x: round(CENTER + r * Math.cos(rad)), y: round(CENTER + r * Math.sin(rad)) };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 失步的站偏离自己的位置多少（viewBox 单位）：开场十座站全部歪在轨道 / 线路 / 版面之外，接通时锁回原位。
 * 领航站在中心不偏（它是被通电的那颗）；其余九座朝不同方向偏 14–24。
 */
export const DRIFT: Record<StationId, Point> = {
  pilot: { x: 0, y: 0 },
  archive: { x: 16, y: -20 },
  observatory: { x: -22, y: 12 },
  verify: { x: 20, y: 16 },
  wing: { x: -16, y: -18 },
  route: { x: 24, y: -8 },
  log: { x: -14, y: 22 },
  hq: { x: 18, y: -18 },
  protocol: { x: -24, y: -6 },
  patrol: { x: 12, y: 22 },
};

const below: LabelPlace = { dx: 0, dy: 27, side: "middle" };

function observeLayout(): Layout {
  const nodes = {} as Record<StationId, NodePlace>;
  const links = {} as Record<StationId, readonly Segment[]>;
  for (const station of STATIONS) {
    if (station.ring === 0) {
      nodes[station.id] = { x: CENTER, y: CENTER, label: { dx: 0, dy: 30, side: "middle" } };
      links[station.id] = [];
    } else {
      const at = polar(station.ring, ANGLE[station.id]);
      nodes[station.id] = { ...at, label: below };
      links[station.id] = [{ x1: CENTER, y1: CENTER, x2: at.x, y2: at.y }];
    }
  }
  return { nodes, links, closing: [] };
}

/**
 * 线路图：站点（格点 20 的倍数，线只走 0 / 90 / 45 度）。
 * 一线（一幕）：领航站 → 档案站 → 观测站；二线：领航站 → 核验站 → 僚机 → 航线图；三线：领航站 → 日志 → 总部 → 协议 → 巡航。
 */
function linesLayout(): Layout {
  const at = (x: number, y: number, label: LabelPlace, line: 0 | 1 | 2 | 3): NodePlace => ({ x, y, label, line });
  const nodes: Record<StationId, NodePlace> = {
    pilot: at(300, 300, { dx: 0, dy: 34, side: "middle" }, 0),
    archive: at(200, 300, { dx: 0, dy: -20, side: "middle" }, 1),
    observatory: at(140, 440, { dx: 0, dy: 26, side: "middle" }, 1),
    verify: at(300, 200, { dx: -16, dy: 4, side: "end" }, 2),
    wing: at(440, 120, { dx: 0, dy: -20, side: "middle" }, 2),
    route: at(540, 240, { dx: -16, dy: 4, side: "end" }, 2),
    log: at(400, 300, { dx: 0, dy: -20, side: "middle" }, 3),
    hq: at(520, 360, { dx: -16, dy: 4, side: "end" }, 3),
    protocol: at(520, 440, { dx: -16, dy: 4, side: "end" }, 3),
    patrol: at(360, 500, { dx: 0, dy: 26, side: "middle" }, 3),
  };
  const seg = (x1: number, y1: number, x2: number, y2: number): Segment => ({ x1, y1, x2, y2 });
  const links: Record<StationId, readonly Segment[]> = {
    pilot: [],
    archive: [seg(300, 300, 200, 300)],
    observatory: [seg(200, 300, 140, 360), seg(140, 360, 140, 440)],
    verify: [seg(300, 300, 300, 200)],
    wing: [seg(300, 200, 300, 160), seg(300, 160, 340, 120), seg(340, 120, 440, 120)],
    route: [seg(440, 120, 480, 120), seg(480, 120, 540, 180), seg(540, 180, 540, 240)],
    log: [seg(300, 300, 400, 300)],
    hq: [seg(400, 300, 460, 300), seg(460, 300, 520, 360)],
    protocol: [seg(520, 360, 520, 440)],
    patrol: [seg(520, 440, 480, 480), seg(480, 480, 480, 500), seg(480, 500, 360, 500)],
  };
  return { nodes, links, closing: [] };
}

/** 航行日志：卡片的中心（卡片宽约 124、高约 46，彼此错开 ≥ 一张卡）。链条绕领航站一圈 */
function journalLayout(): Layout {
  const card = (x: number, y: number, tilt: number): NodePlace => ({ x, y, tilt, label: { dx: 0, dy: 0, side: "middle" } });
  const nodes: Record<StationId, NodePlace> = {
    pilot: card(300, 300, 0),
    archive: card(130, 215, -1.6),
    observatory: card(210, 100, 1.2),
    verify: card(390, 85, -1),
    wing: card(498, 185, 1.8),
    route: card(500, 335, -1.4),
    log: card(440, 460, 1.1),
    hq: card(290, 525, -1.8),
    protocol: card(140, 478, 1.5),
    patrol: card(92, 350, -1.1),
  };
  const order: StationId[] = ["pilot", "archive", "observatory", "verify", "wing", "route", "log", "hq", "protocol", "patrol"];
  const links = {} as Record<StationId, readonly Segment[]>;
  order.forEach((id, i) => {
    const prev = order[i - 1];
    const here = nodes[id];
    if (prev === undefined) {
      links[id] = [];
      return;
    }
    const from = nodes[prev];
    links[id] = [{ x1: from.x, y1: from.y, x2: here.x, y2: here.y }];
  });
  const last = nodes.patrol;
  const hub = nodes.pilot;
  return { nodes, links, closing: [{ x1: last.x, y1: last.y, x2: hub.x, y2: hub.y }] };
}

const LAYOUTS: Record<OnboardingStyle, Layout> = {
  observe: observeLayout(),
  lines: linesLayout(),
  journal: journalLayout(),
};

export function layoutOf(style: OnboardingStyle): Layout {
  return LAYOUTS[style];
}
