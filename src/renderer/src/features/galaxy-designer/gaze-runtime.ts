import { BLINK_MS, firstGaze, gazeOffset, nextGaze, type GazeState, type Rng } from "./gaze.ts";

/**
 * 眼睛跟着指针的 DOM 一半（规则在 gaze.ts）。思路沿用 2026-11-15 的头像 demo（avatar/look.html）：
 * 全页一个 pointermove 只记坐标，一个按需启动的 requestAnimationFrame 循环统一更新，眼睛到位、没有天体在注视时停下。
 *
 * - 每个 BodyFigure 把自己那一组眼睛（.gd-gaze）登记进来，带最大位移（本地单位：眼宽 × 0.4，侧栏头像再 × 0.6）。
 * - 只写 CSS transform（translate）。按拍（GAZE_TICK_MS = 50ms）走：每拍指针只读一次、注视中的天体读一次自己的中心
 *   （getBoundingClientRect），眼睛走剩下的一半（EASE_SHARE），挪得太少就不写。
 *   为什么不按帧缓动、也不用 CSS 过渡：实测（12 个侧栏头像 + 星系 4 颗星，指针绕圈 10 秒）第一版每帧缓动每帧写，渲染进程主线程
 *   从 6–8% 涨到 24–26%；改成 CSS 过渡仍是 18–21%——只要页面上有一个过渡 / 动画在主线程跑，每一帧都要主线程出帧。
 *   按拍写之后是 10–11%（见报告）。
 * - 窗口失焦、页面隐藏、系统要求减少动效：循环停下，所有眼睛回到正中。指针离开窗口：一律分心。
 */
interface Entry {
  eyes: SVGGElement;
  body: SVGGraphicsElement;
  /** 最大位移（本地单位） */
  reach: number;
  rng: Rng;
  state: GazeState;
  /** 上一次写进去的位移（本地单位） */
  cur: { x: number; y: number };
  blinking: boolean;
}

/** 多久定一次目标（ms）：注视的方向、换段、眨眼都按这一拍 */
const GAZE_TICK_MS = 50;
/** 每拍走剩下的多少（50ms 一拍走一半：约 150ms 走完八成，不瞬移） */
const EASE_SHARE = 0.5;
/** 目标挪动小于这么多（本地单位）就不写，免得每拍都让 SVG 重绘 */
const MIN_STEP = 0.12;
/** 目标挪动小于最大位移的这一份也不写：指针慢慢移动时眼睛一小步一小步地跟（每步由 CSS 过渡抹平），不是每拍都动 */
const STEP_SHARE = 0.08;

const entries = new Map<SVGGElement, Entry>();
let pointer: { x: number; y: number } | null = null;
let pointerInside = false;
let raf = 0;
let timer = 0;
let listening = false;
let seed = 0x9e3779b9;

/** 每颗天体自己的随机数（mulberry32，种子各不相同）：时间错开靠它 */
function freshRng(): Rng {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let a = (seed ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function reduced(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function active(): boolean {
  return document.visibilityState === "visible" && document.hasFocus() && !reduced();
}

function write(entry: Entry): void {
  const { x, y } = entry.cur;
  entry.eyes.style.transform = Math.abs(x) < 0.01 && Math.abs(y) < 0.01 ? "" : `translate(${x.toFixed(3)}px, ${y.toFixed(3)}px)`;
}

function resetAll(): void {
  for (const entry of entries.values()) {
    entry.cur = { x: 0, y: 0 };
    entry.blinking = false;
    delete entry.eyes.dataset.blink;
    write(entry);
  }
}

function kick(): void {
  if (raf !== 0 || timer !== 0 || entries.size === 0) return;
  if (!active()) {
    resetAll();
    return;
  }
  raf = requestAnimationFrame(tick);
}

function stop(): void {
  if (raf !== 0) cancelAnimationFrame(raf);
  if (timer !== 0) window.clearTimeout(timer);
  raf = 0;
  timer = 0;
}

function tick(now: number): void {
  raf = 0;
  if (!active()) {
    resetAll();
    return;
  }
  const p = pointer; // 这一拍只取一次
  for (const entry of entries.values()) {
    if (now >= entry.state.until) entry.state = nextGaze(entry.state, entry.rng, now, pointerInside);
    let center = { x: 0, y: 0 };
    if (entry.state.mode === "look" && p !== null) {
      const rect = entry.body.getBoundingClientRect();
      center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    const aim = gazeOffset(entry.state, center, entry.state.mode === "look" ? p : null);
    const target = { x: aim.x * entry.reach, y: aim.y * entry.reach };
    // 缓动在这里按拍走（每拍走剩下的一半），挪得太少就不写：不用 CSS 过渡——过渡一跑，页面每一帧都要主线程出帧，
    // 实测光是「有一个过渡在跑」就让渲染进程多 8–11 个百分点
    const next = { x: entry.cur.x + (target.x - entry.cur.x) * EASE_SHARE, y: entry.cur.y + (target.y - entry.cur.y) * EASE_SHARE };
    if (Math.hypot(next.x - entry.cur.x, next.y - entry.cur.y) >= Math.max(MIN_STEP, entry.reach * STEP_SHARE)) {
      entry.cur = next;
      write(entry);
    }
    const blinkAt = entry.state.blinkAt;
    const blink = blinkAt !== null && now >= blinkAt && now < blinkAt + BLINK_MS;
    if (blink !== entry.blinking) {
      entry.blinking = blink;
      if (blink) entry.eyes.dataset.blink = "true";
      else delete entry.eyes.dataset.blink;
    }
  }
  // 一直有天体在换状态、眨眼、跟着指针：只要有登记就继续，按 GAZE_TICK_MS 一拍（拍里对齐到下一帧再写）
  timer = window.setTimeout(() => {
    timer = 0;
    raf = requestAnimationFrame(tick);
  }, GAZE_TICK_MS);
}

function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener(
    "pointermove",
    (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      pointerInside = true;
    },
    { passive: true },
  );
  // 指针离开窗口：一律分心（下一段换状态时生效，眼睛慢慢移开）
  document.documentElement.addEventListener("pointerleave", () => {
    pointerInside = false;
    pointer = null;
    const now = performance.now();
    for (const entry of entries.values()) if (entry.state.mode === "look") entry.state = { ...entry.state, until: now };
  });
  const sync = (): void => {
    if (active()) kick();
    else {
      stop();
      resetAll();
    }
  };
  window.addEventListener("focus", sync);
  window.addEventListener("blur", sync);
  document.addEventListener("visibilitychange", sync);
  window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", sync);
}

/** 登记一组眼睛；返回注销函数 */
export function registerGaze(eyes: SVGGElement, body: SVGGraphicsElement, reach: number): () => void {
  listen();
  const rng = freshRng();
  entries.set(eyes, { eyes, body, reach, rng, state: firstGaze(rng, performance.now()), cur: { x: 0, y: 0 }, blinking: false });
  kick();
  return () => {
    entries.delete(eyes);
    eyes.style.transform = "";
    if (entries.size === 0) stop();
  };
}

/** 改最大位移（眼睛大小换了） */
export function updateGazeReach(eyes: SVGGElement, reach: number): void {
  const entry = entries.get(eyes);
  if (entry !== undefined) entry.reach = reach;
}
