import { FRAME_EXTENT, angularSpeed } from "./galaxy.ts";

/**
 * 联星（璇玑星系规则：「两个主智能体因为长期共享目标、记忆与协作关系，形成了一套联星系统」）的几何，纯计算。
 *
 * 真实参照：半人马座 α 的 A、B 两星（约 1.1 与 0.9 M☉）隔约 23 AU，绕共同质心每 79.9 年一圈，比邻星的行星只绕自己那颗转；
 * 天狼星 A、B（约 2.06 与 1.02 M☉）隔约 20 AU，50.1 年一圈，质心离 A 更近。两例都是 S 型：行星绕其中一颗星转，
 * 两星间距远大于行星轨道。这里取同一种结构：
 * - 两颗主星绕共同质心转，质心按质量比放：m₁·r₁ = m₂·r₂，r₁ + r₂ = 间距 sep（重的那颗离质心近）；
 * - 这个工作区的行星、碎石带都跟着自己的主星走（S 型），伴星只画星体本身与它的名字——另一座星系的行星与碎石不画，
 *   免得两套轨道在一张图上交叉（比较过淡画：十几颗淡行星在伴星周围一圈，读起来像这座星系多了一圈轨道）；
 * - 间距取这座星系外缘的 SEP_OVER_EXTENT 倍（真实的 S 型间距是行星轨道的 5–10 倍，画面装不下，取能看出「伴星在外面」的最小值）。
 */

/** 间距 = 这座星系外缘（碎石带外沿）× 这个倍数 + 伴星半径：伴星整颗在外缘之外，不压碎石带 */
export const SEP_OVER_EXTENT = 1.25;
/** 联星时画面自动缩小的下限：再小行星的眼睛就读不出来了，剩下的交给用户缩放 */
export const BINARY_ZOOM_MIN = 0.55;

export interface BinaryGeometry {
  /** 两星间距（世界单位） */
  sep: number;
  /** 这颗主星离质心多远 */
  r1: number;
  /** 伴星离质心多远 */
  r2: number;
  /** 公转角速度（rad/s，与行星同一条开普勒式子：外面的转得慢） */
  omega: number;
  /** 为了把两颗主星都装进画框，画面要缩多少（≤ 1） */
  zoom: number;
}

/**
 * m1 = 这个工作区的主星质量，m2 = 伴星质量（界面单位）；extent = 这座星系的外缘；companionR = 伴星半径（世界单位）。
 * 质量不是正数时按等质量算（不让质心跑到无穷远）。
 */
export function binaryGeometry(m1: number, m2: number, extent: number, companionR: number): BinaryGeometry {
  const a = m1 > 0 && Number.isFinite(m1) ? m1 : 1;
  const b = m2 > 0 && Number.isFinite(m2) ? m2 : a;
  const sep = Math.max(extent, 1) * SEP_OVER_EXTENT + Math.max(companionR, 0) * 2;
  const r1 = (sep * b) / (a + b);
  const r2 = sep - r1;
  const need = Math.max(r1 + extent, r2 + companionR * 1.5);
  return { sep, r1, r2, omega: angularSpeed(sep), zoom: Math.min(1, Math.max(BINARY_ZOOM_MIN, FRAME_EXTENT / need)) };
}

/** t 秒时：这颗主星与伴星相对质心的位置（平面世界坐标）。phase 是 t = 0 时伴星的方位角 */
export function binaryPositions(geo: BinaryGeometry, phase: number, tSec: number): { self: { x: number; y: number }; companion: { x: number; y: number } } {
  const theta = phase + geo.omega * tSec;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return { self: { x: -geo.r1 * c, y: -geo.r1 * s }, companion: { x: geo.r2 * c, y: geo.r2 * s } };
}

/** 起始相位：按两个工作区 id 取（同一对每次一样），与谁先打开无关（两边看到的是同一个相位差 π） */
export function binaryPhase(selfId: string, partnerId: string): number {
  const key = selfId < partnerId ? `${selfId}|${partnerId}` : `${partnerId}|${selfId}`;
  let hash = 2166136261;
  for (const ch of key) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  const base = ((hash >>> 0) % 3600) / 3600 * Math.PI * 2;
  // 字典序小的一边看到伴星在 base，另一边在 base + π：同一时刻两边画的是同一对星的同一个姿态
  return selfId < partnerId ? base : base + Math.PI;
}
