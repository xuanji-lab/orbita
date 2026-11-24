/**
 * 星系里「锁定框 + 引线」的排布（纯计算，可被 node --test 直接加载）。
 *
 * 用户 2026-11-24：「在做工的 session 要圈起来，一根线升起来，写它在处理什么任务；这根线要跟着它一起转——
 * 很像太空题材游戏的 Dashboard。」于是：
 * - 锁定框：每颗在做工（等你 / 在跑）的行星外面四个角括号，跟着行星走；
 * - 引线：从锁定框一角斜着升起一段，再折成一条水平线，任务名就写在这条水平线上（下划线式标签）。
 *   每帧按行星此刻的屏幕位置重算，所以线跟着天体转；
 * - 防碰撞：标签框互不重叠、不压别的行星、不压主星、不出画布。放不下时按「等你 > 在跑」（同档按轨道次序 = 要紧程度）
 *   只给前几颗画引线，其余只留锁定框，悬停才出名字；
 * - 不抖：上一帧给某颗选过的方位，这一帧还放得下就沿用（滞回），放不下才换——不然转动中标签会左右乱跳。
 *
 * 大星系（New Task 页）与右栏「编排」面板的星系图共用这一份。
 */

/** 一颗候选行星（屏幕坐标，px） */
export interface CalloutTarget {
  id: string;
  x: number;
  y: number;
  r: number;
  /** recent = 最近但没在做事的会话：排在在做事的后面，样式轻一档 */
  state: "waiting" | "running" | "recent";
  /** 已截断好的文字（任务名） */
  text: string;
  /** 要紧程度次序（越小越要紧）：等你在前、同档按轨道次序 */
  rank: number;
}

/** 方位：引线往哪个角升起（ne = 右上） */
export type CalloutDir = "ne" | "nw" | "se" | "sw";

export interface CalloutPlacement {
  id: string;
  dir: CalloutDir;
  /** 升起的高度档（0 = 短、1 = 长） */
  lift: number;
  /** 引线：锁定框角 → 折点 → 水平线末端（标签下划线就是这一段） */
  start: { x: number; y: number };
  elbow: { x: number; y: number };
  end: { x: number; y: number };
  /** 标签框（文字写在水平线上方） */
  box: Box;
  /** 文字基线起点与对齐 */
  textX: number;
  textY: number;
  anchor: "start" | "end";
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 锁定框比行星大多少（px）：框与星体之间留一道缝，不贴着 */
export const LOCK_GAP = 5;
/** 角括号臂长占框边长的比例，夹在 [3, 9] px */
export const LOCK_ARM = { ratio: 0.3, min: 3, max: 9 } as const;
/** 两档升起高度（px，斜线的竖直分量） */
export const LIFTS = [22, 44] as const;
/** 标签与画布边缘、标签与标签之间至少留的空 */
export const CALLOUT_PAD = 4;
/** 文字左右各留的空、文字框高出字号的量 */
const TEXT_SIDE = 3;
const BOX_EXTRA = 6;

/** 画布宽度 → 最多画几根引线：宽的地方多给几根，窄的右栏只给最要紧的两根 */
export function calloutBudget(width: number): number {
  if (width >= 900) return 5;
  if (width >= 560) return 4;
  if (width >= 380) return 3;
  return 2;
}

/** 估一行字的宽度（px）：CJK 全角按 1em，其余按 0.58em。SVG 里量不到真实宽度之前用它排布 */
export function textWidth(text: string, glyphPx: number): number {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide = (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef) || (code >= 0x3000 && code <= 0x303f);
    w += wide ? glyphPx : glyphPx * 0.58;
  }
  return w;
}

/** 锁定框（四个角括号）的半边长与臂长 */
export function lockFrame(r: number): { half: number; arm: number } {
  const half = r + LOCK_GAP;
  const arm = Math.min(LOCK_ARM.max, Math.max(LOCK_ARM.min, half * 2 * LOCK_ARM.ratio));
  return { half, arm };
}

/** 四个角括号的 SVG path（以行星中心为原点的绝对坐标） */
export function lockFramePath(x: number, y: number, r: number): string {
  const { half, arm } = lockFrame(r);
  const l = x - half;
  const rt = x + half;
  const t = y - half;
  const b = y + half;
  const f = (n: number): string => n.toFixed(1);
  return [
    `M${f(l)} ${f(t + arm)}V${f(t)}H${f(l + arm)}`,
    `M${f(rt - arm)} ${f(t)}H${f(rt)}V${f(t + arm)}`,
    `M${f(rt)} ${f(b - arm)}V${f(b)}H${f(rt - arm)}`,
    `M${f(l + arm)} ${f(b)}H${f(l)}V${f(b - arm)}`,
  ].join("");
}

const DIRS: readonly CalloutDir[] = ["ne", "nw", "se", "sw"];

/** 某颗行星按某方位、某档高度的引线与标签框 */
export function calloutGeometry(target: CalloutTarget, dir: CalloutDir, lift: number, glyphPx: number): CalloutPlacement {
  const { half } = lockFrame(target.r);
  const east = dir === "ne" || dir === "se";
  const north = dir === "ne" || dir === "nw";
  const sx = target.x + (east ? half : -half);
  const sy = target.y + (north ? -half : half);
  const rise = LIFTS[lift] ?? LIFTS[0];
  // 斜线 45°：水平走与竖直升同样的距离
  const ex = sx + (east ? rise * 0.6 : -rise * 0.6);
  const ey = sy + (north ? -rise : rise);
  const w = textWidth(target.text, glyphPx) + TEXT_SIDE * 2;
  const h = glyphPx + BOX_EXTRA;
  const endX = ex + (east ? w : -w);
  const box: Box = east ? { x0: ex, y0: ey - h, x1: endX, y1: ey } : { x0: endX, y0: ey - h, x1: ex, y1: ey };
  return {
    id: target.id,
    dir,
    lift,
    start: { x: sx, y: sy },
    elbow: { x: ex, y: ey },
    end: { x: endX, y: ey },
    box,
    textX: east ? ex + TEXT_SIDE : ex - TEXT_SIDE,
    textY: ey - BOX_EXTRA / 2 - 1,
    anchor: east ? "start" : "end",
  };
}

function overlaps(a: Box, b: Box, pad: number): boolean {
  return a.x0 < b.x1 + pad && b.x0 < a.x1 + pad && a.y0 < b.y1 + pad && b.y0 < a.y1 + pad;
}

function circleHitsBox(cx: number, cy: number, r: number, box: Box): boolean {
  const nx = Math.min(Math.max(cx, box.x0), box.x1);
  const ny = Math.min(Math.max(cy, box.y0), box.y1);
  return (cx - nx) ** 2 + (cy - ny) ** 2 < r * r;
}

export interface PlaceInput {
  targets: readonly CalloutTarget[];
  /** 画面上别的天体（所有行星，含不画引线的）：标签不压它们 */
  bodies: readonly { id: string; x: number; y: number; r: number }[];
  /** 主星（屏幕坐标与半径，含星环 / 日冕外缘） */
  star: { x: number; y: number; r: number } | null;
  width: number;
  height: number;
  glyphPx: number;
  /** 最多画几根（calloutBudget） */
  budget: number;
  /** 上一帧各颗选的方位：还放得下就沿用 */
  previous?: ReadonlyMap<string, { dir: CalloutDir; lift: number }>;
  /** 已经占了的字框（子智能体行星常显的名字）：引线的标签不压它们 */
  reserved?: readonly Box[];
}

/**
 * 排布：按 rank 从要紧到不要紧逐颗试，先试上一帧的方位，再按 ne → nw → se → sw、短 → 长试；
 * 第一个「不出画布、不压已放的标签、不压任何天体与主星」的方位就是它。放够 budget 根即停；
 * 某颗哪个方位都放不下就跳过它（它只留锁定框，悬停出名字），不挤占后面的。
 */
export function placeCallouts(input: PlaceInput): CalloutPlacement[] {
  const order = [...input.targets].sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  const placed: CalloutPlacement[] = [];
  const bounds: Box = { x0: CALLOUT_PAD, y0: CALLOUT_PAD, x1: input.width - CALLOUT_PAD, y1: input.height - CALLOUT_PAD };
  for (const target of order) {
    if (placed.length >= input.budget) break;
    const tries: { dir: CalloutDir; lift: number }[] = [];
    const prev = input.previous?.get(target.id);
    if (prev !== undefined) tries.push(prev);
    for (const lift of [0, 1]) for (const dir of DIRS) if (prev === undefined || prev.dir !== dir || prev.lift !== lift) tries.push({ dir, lift });
    for (const attempt of tries) {
      const geo = calloutGeometry(target, attempt.dir, attempt.lift, input.glyphPx);
      const { box } = geo;
      if (box.x0 < bounds.x0 || box.x1 > bounds.x1 || box.y0 < bounds.y0 || box.y1 > bounds.y1) continue;
      if (placed.some((other) => overlaps(other.box, box, CALLOUT_PAD))) continue;
      if (input.reserved !== undefined && input.reserved.some((other) => overlaps(other, box, CALLOUT_PAD))) continue;
      if (input.bodies.some((body) => circleHitsBox(body.x, body.y, lockFrame(body.r).half, box))) continue;
      if (input.star !== null && circleHitsBox(input.star.x, input.star.y, input.star.r + 2, box)) continue;
      placed.push(geo);
      break;
    }
  }
  return placed;
}

/** 候选次序：等你在前（rank 0 段），在跑其次，最近但没在做事的最后；同档按轨道次序（index） */
export function calloutRank(state: "waiting" | "running" | "recent", orbitIndex: number): number {
  return (state === "waiting" ? 0 : state === "running" ? 1000 : 2000) + orbitIndex;
}

/**
 * 最近但没在做事的会话的「锁定框」：一整圈虚线方框（不是四个角括号）——与在做事的那种一眼分得开，
 * 框得住又不抢眼。尺寸与 lockFramePath 同一个 half，引线的起点不用改。
 */
export function recentFramePath(x: number, y: number, r: number): string {
  const { half } = lockFrame(r);
  const f = (n: number): string => n.toFixed(1);
  return `M${f(x - half)} ${f(y - half)}H${f(x + half)}V${f(y + half)}H${f(x - half)}Z`;
}

/** 名字牌：一颗子智能体行星常显的名字（写在星体正下方，放不下换右边、左边） */
export interface NameTag {
  id: string;
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  box: Box;
}

/**
 * 子智能体行星的名字常显（编排星系里行星就是子智能体，名字是它的身份，不是悬停才出的提示）。
 * 依次试「正下方 → 右边 → 左边」，第一个不出画布、不压别的天体（含主星）、不压已放名字的位置就是它；
 * 都放不下这一帧就不写（转开了再出现），绝不压在别的天体上。
 */
export function placeNameTags(input: {
  planets: readonly { id: string; x: number; y: number; r: number; name: string }[];
  bodies: readonly { id: string; x: number; y: number; r: number }[];
  star: { x: number; y: number; r: number } | null;
  width: number;
  height: number;
  glyphPx: number;
}): NameTag[] {
  const out: NameTag[] = [];
  const h = input.glyphPx + 2;
  for (const planet of input.planets) {
    if (planet.name === "") continue;
    const w = textWidth(planet.name, input.glyphPx);
    const tries: NameTag[] = [
      { id: planet.id, x: planet.x, y: planet.y + planet.r + 3 + h / 2, anchor: "middle", box: { x0: planet.x - w / 2, y0: planet.y + planet.r + 3, x1: planet.x + w / 2, y1: planet.y + planet.r + 3 + h } },
      { id: planet.id, x: planet.x + planet.r + 5, y: planet.y, anchor: "start", box: { x0: planet.x + planet.r + 5, y0: planet.y - h / 2, x1: planet.x + planet.r + 5 + w, y1: planet.y + h / 2 } },
      { id: planet.id, x: planet.x - planet.r - 5, y: planet.y, anchor: "end", box: { x0: planet.x - planet.r - 5 - w, y0: planet.y - h / 2, x1: planet.x - planet.r - 5, y1: planet.y + h / 2 } },
    ];
    for (const tag of tries) {
      const { box } = tag;
      if (box.x0 < CALLOUT_PAD || box.y0 < CALLOUT_PAD || box.x1 > input.width - CALLOUT_PAD || box.y1 > input.height - CALLOUT_PAD) continue;
      if (input.bodies.some((body) => body.id !== planet.id && circleHitsBox(body.x, body.y, body.r + 2, box))) continue;
      if (input.star !== null && circleHitsBox(input.star.x, input.star.y, input.star.r + 2, box)) continue;
      if (out.some((other) => overlaps(other.box, box, 2))) continue;
      out.push(tag);
      break;
    }
  }
  return out;
}
