import { angularSpeed, ARCS_PER_ORBIT, orbitFrame, planetPx, type Belt, type Camera, type GalaxyLayout, type OrbitFrame, type Viewport } from "./galaxy.ts";

/**
 * 星系公转交给合成器（纯计算，可被 node --test 直接加载；HomeGalaxy 按这里算出的矩阵与关键帧搭 DOM）。
 *
 * 改前：每 33ms 一次 React setState，整张 SVG（主星、几十段轨道弧、带地表图的行星、碎石、锁定框）重新协调、重排样式、重绘，
 * 满载宽窗下渲染进程常年 25–29% CPU（2026-11-24 实测）。改后：
 * - 每个在轨道上走的东西是一串静止的 div，只有两层在转（Web Animations 的 transform 动画，合成器线程跑，主线程不参与）：
 *   「轨道矩阵 M」·「转 α」·「平移到轨道半径」·「反转 −α」·「M 的逆」——前四层把点送到椭圆上，后两层把星体自己转正、拉圆，
 *   合起来对星体只是一个平移：眼睛永远朝上，地表图不变形，点永远压在 orbitArcs 画的那条线上（同一个 framePoint 模型）。
 * - 碎石带整条是一层：M · 转 α，里面几百颗碎石是一张静止的 SVG。
 * - JS 只剩两件小事：行星过了左右两点时换到主星前 / 后那一层（按到点时间排一个 setTimeout，一圈两次），
 *   锁定框 / 引线 / 名字的排布每 PLAN_MS 重算一次（它们挂在星体同一串 div 上，跟着合成器走，只有「朝哪边」要 JS 决定）。
 */

/** 轨道矩阵里「单位圆」的半径（px）：转动层里点离圆心 R0 像素，M 再把它缩成真实的椭圆（太小的数会让合成器取整失真） */
export const R0 = 1000;

/** CSS matrix(a, b, c, d, e, f)：x' = a·x + c·y + e，y' = b·x + d·y + f */
export interface Matrix2D {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

/**
 * 轨道矩阵：把转动层里的点 (R0·cosθ, −R0·sinθ) 送到 framePoint(frame, θ)。
 * 负号是因为屏幕 y 朝下：CSS 的 rotate(α) 顺时针，θ 增加要转 −θ（见 spinFrames）。
 */
export function orbitMatrix(frame: OrbitFrame): Matrix2D {
  return { a: frame.m1x / R0, b: frame.m1y / R0, c: -frame.m2x / R0, d: -frame.m2y / R0, e: frame.cx, f: frame.cy };
}

/** 只取线性部分的逆（星体自己拉圆用，不带平移）；退化（行列式≈0）时退成单位阵 */
export function inverseLinear(m: Matrix2D): Matrix2D {
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-9) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det, e: 0, f: 0 };
}

export function cssMatrix(m: Matrix2D): string {
  const f = (n: number) => (Math.abs(n) < 1e-12 ? "0" : Number(n.toPrecision(8)).toString());
  return `matrix(${f(m.a)}, ${f(m.b)}, ${f(m.c)}, ${f(m.d)}, ${f(m.e)}, ${f(m.f)})`;
}

/** 矩阵乘一个点（测试用来核对整串 transform 是不是正好等于 framePoint） */
export function applyMatrix(m: Matrix2D, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

export function rotation(deg: number): Matrix2D {
  const r = (deg * Math.PI) / 180;
  return { a: Math.cos(r), b: Math.sin(r), c: -Math.sin(r), d: Math.cos(r), e: 0, f: 0 };
}

export function multiply(p: Matrix2D, q: Matrix2D): Matrix2D {
  return {
    a: p.a * q.a + p.c * q.b,
    b: p.b * q.a + p.d * q.b,
    c: p.a * q.c + p.c * q.d,
    d: p.b * q.c + p.d * q.d,
    e: p.a * q.e + p.c * q.f + p.e,
    f: p.b * q.e + p.d * q.f + p.f,
  };
}

/** 转一圈要多少毫秒 */
export function periodMs(omega: number): number {
  return ((Math.PI * 2) / Math.max(omega, 1e-9)) * 1000;
}

/**
 * 转动层的关键帧：θ(t) = phase + ω·t。外层转 −θ（dir = −1），反转层转 +θ（dir = +1）。
 * 返回起止角度（度）；动画时长 periodMs(ω)、线性、无限循环，currentTime = 已走的毫秒数 mod 周期。
 */
export function spinFrames(phaseRad: number, dir: 1 | -1): { from: number; to: number } {
  const from = (dir * phaseRad * 180) / Math.PI;
  return { from, to: from + dir * 360 };
}

/** 一个在轨道上走的天体（行星或在做事的碎石块） */
export interface Mover {
  id: string;
  kind: "planet" | "rock";
  frame: OrbitFrame;
  /** t = 0 的轨道角（rad） */
  phase: number;
  omega: number;
  /** 屏幕半径（px），公转中不变 */
  r: number;
  waiting: boolean;
}

export function moversOf(layout: GalaxyLayout, camera: Camera, vp: Viewport, minPlanetPx: number, rockPx: number): Mover[] {
  const movers: Mover[] = layout.planets.map((planet) => ({
    id: planet.id,
    kind: "planet",
    frame: orbitFrame(planet.orbitRadius, planet.inclination, planet.node, camera, vp),
    phase: planet.phase,
    omega: planet.omega,
    r: planetPx(planet.radius, planet.state === "waiting", camera, vp, minPlanetPx),
    waiting: planet.state === "waiting",
  }));
  if (layout.rockOrbit !== null) {
    const frame = orbitFrame(layout.rockOrbit, 0, 0, camera, vp);
    const omega = angularSpeed(layout.rockOrbit);
    for (const rock of layout.rocks) {
      movers.push({ id: rock.id, kind: "rock", frame, phase: rock.theta0, omega, r: rockPx, waiting: rock.state === "waiting" });
    }
  }
  return movers;
}

/**
 * 换层的边界离左右两点再往远侧收 FAR_MARGIN：行星压在自家轨道线上——近半圈的轨道弧画在主星之上，
 * 刚过左右两点、还在远半圈的行星若已在主星之下那一层，会被自家近半圈的那一段弧从身上划过（旧版靠「自家相邻三段弧先画」解决）。
 * 收进 1.5 段弧之后它提前换到前面那层；那一段角度上行星离主星最远，换到主星上面也不会压着主星。
 */
export const FAR_MARGIN = ((Math.PI * 2) / ARCS_PER_ORBIT) * 1.5;

function wrap(theta: number): number {
  const twoPi = Math.PI * 2;
  return ((theta % twoPi) + twoPi) % twoPi;
}

/** 此刻在不在远半圈那一层（主星背后）：θ ∈ (FAR_MARGIN, π − FAR_MARGIN) */
export function moverFar(mover: Mover, tSec: number): boolean {
  const theta = wrap(mover.phase + mover.omega * tSec);
  return theta > FAR_MARGIN && theta < Math.PI - FAR_MARGIN;
}

/** 离下一次换层（θ 走到 FAR_MARGIN 或 π − FAR_MARGIN）还有多少毫秒 */
export function msToNextSide(mover: Mover, tSec: number): number {
  const theta = wrap(mover.phase + mover.omega * tSec);
  let best = Infinity;
  for (const edge of [FAR_MARGIN, Math.PI - FAR_MARGIN]) {
    const ahead = wrap(edge - theta);
    best = Math.min(best, ahead < 1e-6 ? Math.PI * 2 : ahead);
  }
  return (best / Math.max(mover.omega, 1e-9)) * 1000;
}

/**
 * 「被捕获」的路径（转动层坐标里的位移关键帧，最后一帧是 0）：从带子外面、落后一点的方位，沿一段向内的螺线落到自己的位置，
 * 先快后慢，开头是透明的。p = 这颗在转动层里的最终位置（相对圆心），返回每一帧相对最终位置的位移。
 */
export const CAPTURE_STEPS = 8;
export function captureOffsets(px: number, py: number): { dx: number; dy: number; opacity: number }[] {
  const radius = Math.hypot(px, py) || 1;
  const angle = Math.atan2(py, px);
  const out: { dx: number; dy: number; opacity: number }[] = [];
  for (let k = 0; k <= CAPTURE_STEPS; k++) {
    const s = k / CAPTURE_STEPS;
    const left = (1 - s) * (1 - s);
    // 转动层里 θ 增加 = 屏幕上的角度减小（y 朝下），所以「落后」是角度更大
    const a = angle + 0.9 * left;
    const r = radius * (1 + 0.75 * left);
    out.push({ dx: Math.cos(a) * r - px, dy: Math.sin(a) * r - py, opacity: Math.min(1, s * 2.5) });
  }
  return out;
}

/** 碎石在碎石带转动层里的位置（相对圆心，px）：与 dustPoints 同一个模型 */
export function dustDiskPoint(belt: Belt, particleR: number, theta0: number): { x: number; y: number } {
  const mid = (belt.inner + belt.outer) / 2;
  const k = (R0 * particleR) / mid;
  return { x: k * Math.cos(theta0), y: -k * Math.sin(theta0) };
}

/** 屏幕上的碎石位置（测试用：转动层点 → 屏幕，等于 dustPoints 给的位置） */
export function diskToScreen(frame: OrbitFrame, x: number, y: number): { x: number; y: number } {
  return applyMatrix(orbitMatrix(frame), x, y);
}

