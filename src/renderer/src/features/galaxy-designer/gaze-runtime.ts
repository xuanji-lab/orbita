import { blinkingAt, eyeOpenness, firstMind, nextBlinkStart, gazeOffset, personaOf, restTilt, stepMind, tiltTarget, type Mind, type Persona, type Rng } from "./gaze.ts";

/**
 * 眼睛的 DOM 一半（心思在 gaze.ts）。思路沿用 2026-11-15 的头像 demo（avatar/look.html）：
 * 全页一个 pointermove 只记坐标，一个按拍走的循环统一更新。
 *
 * - 每个 BodyFigure 把自己那一组眼睛（.gd-gaze）登记进来，带 key（天体 id）、最大位移（本地单位）与设计稿里的基础倾角。
 *   同一个 key 的几份（星系里同一颗行星在远 / 近两层各画一份）共用一颗心思，眼神一致；侧栏头像与星系里的主星 key 不同，各动各的。
 * - 只写 CSS transform（translate + rotate，转轴是这双眼睛的中心，见 galaxy-designer.css）。按拍（GAZE_TICK_MS = 50ms）走：
 *   每拍指针只读一次、看指针的天体读一次自己的中心（getBoundingClientRect），位移每拍走剩下的一半（快，像扫视），
 *   倾角每拍走剩下的 0.18（约 0.8 秒转过去，慢），挪得太少就不写。
 *   为什么不按帧缓动、也不用 CSS 过渡：实测（12 个侧栏头像 + 星系 4 颗星，指针绕圈 10 秒）第一版每帧缓动每帧写，渲染进程主线程
 *   从 6–8% 涨到 24–26%；改成 CSS 过渡仍是 18–21%——只要页面上有一个过渡 / 动画在主线程跑，每一帧都要主线程出帧。
 * - 窗口失焦、页面隐藏、系统要求减少动效、离电省电：循环停下，眼睛回正中、按性格歪向初始一侧（不全朝右）。指针离开窗口：正在看的移开。
 */
interface Brain {
  persona: Persona;
  rng: Rng;
  mind: Mind;
  refs: number;
}

interface Entry {
  eyes: SVGGElement;
  body: SVGGraphicsElement;
  brain: Brain;
  key: string;
  /** 最大位移（本地单位） */
  reach: number;
  /** 设计稿里这双眼已经歪了的角度（.gd-eyes 的 rotate 属性）：写进 transform 的是「想要的倾角 − 它」 */
  baseTilt: number;
  /** 上一次写进去的位移（本地单位）与倾角（度，总倾角） */
  cur: { x: number; y: number; tilt: number };
  blinking: boolean;
  /** 上一次写进去的张开程度（1 = 睁着） */
  open: number;
}

/** 多久走一拍（ms）：有天体正看着指针时 50ms（跟手）；都在自顾自时 100ms——小动作不需要跟手，拍数减半，页面出帧也减半 */
const GAZE_TICK_MS = 50;
const IDLE_TICK_MS = 100;
/** 每拍走剩下的多少：位移快（扫视），倾角慢（换姿势） */
const EASE_SHARE = 0.5;
const TILT_SHARE = 0.18;
/** 纵向位移打几折：眼睛在脸上上下挪得少一些（不顶到天体边、不钻到星环下面太多） */
const Y_SHARE = 0.7;
/** 挪动小于最大位移的这一份、倾角小于这么多度，就不写 */
const STEP_SHARE = 0.05;
const MIN_TILT_STEP = 0.5;
let lastTick = 0;

/** 每拍走剩下的 share（按 50ms 一拍定）换算到这一拍实际隔了多久 */
function shareFor(share: number, dt: number): number {
  return 1 - Math.pow(1 - share, Math.min(dt, 250) / GAZE_TICK_MS);
}

const entries = new Map<SVGGElement, Entry>();
const brains = new Map<string, Brain>();
let pointer: { x: number; y: number } | null = null;
let pointerInside = false;
let raf = 0;
let timer = 0;
let listening = false;

/** 每颗天体自己的随机数（种子 = key 混一点真随机）：性格按 id 稳定，动作时机每次打开都不一样 */
function freshRng(seed: number): Rng {
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

/** 离电省电档：眼睛不动（App 按电源状态设） */
let suspended = false;

function active(): boolean {
  return document.visibilityState === "visible" && document.hasFocus() && !reduced() && !suspended;
}

/** 离电省电档开关：开时停、眼睛回静止姿势；关时恢复 */
export function setGazeSuspended(value: boolean): void {
  if (suspended === value) return;
  suspended = value;
  if (value) {
    stop();
    resetAll();
  } else kick();
}

function write(entry: Entry): void {
  const { x, y, tilt } = entry.cur;
  const rot = tilt - entry.baseTilt;
  const still = Math.abs(x) < 0.01 && Math.abs(y) < 0.01 && Math.abs(rot) < 0.05;
  entry.eyes.style.transform = still ? "" : `translate(${x.toFixed(3)}px, ${y.toFixed(3)}px) rotate(${rot.toFixed(2)}deg)`;
}

/** 静止姿势：正视、按性格歪向初始一侧 */
function rest(entry: Entry): void {
  entry.cur = { x: 0, y: 0, tilt: restTilt(entry.brain.persona) };
  entry.blinking = false;
  delete entry.eyes.dataset.blink;
  writeLids(entry, 1);
  write(entry);
}

function writeLids(entry: Entry, open: number): void {
  if (Math.abs(open - entry.open) < 0.02) return;
  entry.open = open;
  // 每次现查两只眼（.gd-eye）：眼睛样式换了、React 换了元素，也写得到现在的那两只
  for (const lid of entry.eyes.querySelectorAll<SVGElement>(".gd-eye")) lid.style.transform = open >= 0.999 ? "" : `scaleY(${open.toFixed(2)})`;
}

function resetAll(): void {
  for (const entry of entries.values()) rest(entry);
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
  lastTick = 0;
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
  const dt = lastTick === 0 ? GAZE_TICK_MS : now - lastTick;
  lastTick = now;
  const ease = shareFor(EASE_SHARE, dt);
  const turn = shareFor(TILT_SHARE, dt);
  let following = false;
  for (const brain of brains.values()) {
    stepMind(brain.mind, brain.rng, now, pointerInside);
    if (brain.mind.mode === "look" && p !== null) following = true;
  }
  for (const entry of entries.values()) {
    const mind = entry.brain.mind;
    const looking = mind.mode === "look" && p !== null;
    let center = { x: 0, y: 0 };
    if (looking) {
      const rect = entry.body.getBoundingClientRect();
      center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    const aim = gazeOffset(mind, center, looking ? p : null);
    const target = { x: aim.x * entry.reach, y: aim.y * entry.reach * Y_SHARE, tilt: tiltTarget(mind, center, looking ? p : null) };
    const next = {
      x: entry.cur.x + (target.x - entry.cur.x) * ease,
      y: entry.cur.y + (target.y - entry.cur.y) * ease,
      tilt: entry.cur.tilt + (target.tilt - entry.cur.tilt) * turn,
    };
    const moved = Math.hypot(next.x - entry.cur.x, next.y - entry.cur.y) >= entry.reach * STEP_SHARE;
    const turned = Math.abs(next.tilt - entry.cur.tilt) >= MIN_TILT_STEP;
    if (moved || turned) {
      entry.cur = { x: moved ? next.x : entry.cur.x, y: moved ? next.y : entry.cur.y, tilt: turned ? next.tilt : entry.cur.tilt };
      write(entry);
    }
    // 眨眼：这一拍取样张开程度写进去（data-blink 只是给测量脚本看的标记）
    writeLids(entry, eyeOpenness(mind, now));
    const blink = blinkingAt(mind, now);
    if (blink !== entry.blinking) {
      entry.blinking = blink;
      if (blink) entry.eyes.dataset.blink = "true";
      else delete entry.eyes.dataset.blink;
    }
  }
  // 下一拍：有人在看指针、或有人正在眨眼 → 50ms；否则 100ms，但快要眨眼时提前到那一刻
  let wait = following ? GAZE_TICK_MS : IDLE_TICK_MS;
  for (const brain of brains.values()) {
    if (blinkingAt(brain.mind, now)) wait = GAZE_TICK_MS;
    else wait = Math.min(wait, Math.max(16, nextBlinkStart(brain.mind, now) - now));
  }
  // 心思一直在走（换动作、歪头、眨眼）：只要有登记就继续（拍里对齐到下一帧再写）
  timer = window.setTimeout(
    () => {
      timer = 0;
      raf = requestAnimationFrame(tick);
    },
    wait,
  );
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
  // 指针离开窗口：正在看的这一段到此为止（下一拍接着做「移开」的动作）
  document.documentElement.addEventListener("pointerleave", () => {
    pointerInside = false;
    pointer = null;
    const now = performance.now();
    for (const brain of brains.values()) if (brain.mind.mode === "look") brain.mind.until = now;
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

function brainOf(key: string): Brain {
  const known = brains.get(key);
  if (known !== undefined) {
    known.refs += 1;
    return known;
  }
  const persona = personaOf(key);
  const rng = freshRng(Math.floor(persona.curiosity * 0xffffff));
  const brain: Brain = { persona, rng, mind: firstMind(persona, rng, performance.now()), refs: 1 };
  brains.set(key, brain);
  return brain;
}

/** 登记一组眼睛；key = 天体 id（同 key 共用一颗心思）。返回注销函数 */
export function registerGaze(eyes: SVGGElement, body: SVGGraphicsElement, key: string, reach: number, baseTilt: number): () => void {
  listen();
  const brain = brainOf(key);
  const entry: Entry = { eyes, body, brain, key, reach, baseTilt, cur: { x: 0, y: 0, tilt: restTilt(brain.persona) }, blinking: false, open: 0 };
  entries.set(eyes, entry);
  // 挂上就先摆好静止姿势（不等第一拍）：第一帧就不是全体朝右
  rest(entry);
  kick();
  return () => {
    entries.delete(eyes);
    eyes.style.transform = "";
    delete eyes.dataset.blink;
    for (const lid of eyes.querySelectorAll<SVGElement>(".gd-eye")) lid.style.transform = "";
    brain.refs -= 1;
    if (brain.refs <= 0) brains.delete(key);
    if (entries.size === 0) stop();
  };
}

/** 眼睛大小换了：最大位移与基础倾角跟着换 */
export function updateGaze(eyes: SVGGElement, reach: number, baseTilt: number): void {
  const entry = entries.get(eyes);
  if (entry === undefined) return;
  entry.reach = reach;
  entry.baseTilt = baseTilt;
  write(entry);
}
