/**
 * 眼睛的「心思」（纯计算，可被 node --test 直接加载；DOM 那一半在 gaze-runtime.ts）。
 *
 * 2026-11-24 用户：「如果眼睛能跟着鼠标就好了……不同的行星，注意力是随机的，偶尔注视鼠标的位置，偶尔就分心了。」
 * 同日看了第一版之后：「它自然状态下，倾角都是向右的，应该自然状态下也会眨眼和变换倾角到另一侧。它如果没有很灵动的话，
 * 就会感觉它一会跟我鼠标，然后一会就卡了不动了。如果它表现出自己有自己的想法，有的时候它不想跟我鼠标，这样会比较自然一点。」
 *
 * 第一版的毛病：分心是一个固定姿势（停在原处、倾角永远朝右），一离开鼠标就像卡住。改成每颗天体一个小心思（Mind），三条线各走各的：
 * - 注意力：idle（自顾自）里一串小动作——往左右上下瞟一眼、回正中、偶尔发呆 1–2 秒，每个动作停 0.4–2.5 秒；
 *   一个动作做完，才由它自己决定要不要去看指针（指针在窗口里也不一定看）。看的时候要么瞟一眼（0.5–1.2 秒）就走，
 *   要么盯一阵（1.5–4.5 秒）。看完接着做一个「移开」的动作（往别处瞟、常伴一次眨眼、有时换边歪头），不「啪」地停住。
 * - 歪头（倾角）：在左倾、正、右倾之间换，每 3–8 秒一次，有时先在正中停一下再到另一侧；看指针时头往指针那边歪。
 * - 眨眼：每 2.5–7 秒一次，四分之一连眨两下；移开视线、换边时也常眨。
 * 每颗天体的「性格」按 id 稳定取（personaOf）：好奇心（看指针的概率与盯着的时长）、歪头幅度、初始朝哪边、两只眼的细微差别。
 * 随机数由调用方给（测试用播种的 mulberry32），这里不碰 Math.random。
 */

export type Rng = () => number;

/** 播种的随机数（mulberry32）：测试与按 id 取性格时用 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 字符串 → 32 位种子（FNV-1a） */
export function keyHash(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function between(rng: Rng, range: { min: number; max: number }): number {
  return range.min + (range.max - range.min) * rng();
}

/** 一颗天体的性格（按 id 稳定取，同一颗星每次打开都一样） */
export interface Persona {
  /** 好奇心 0.2–0.85：越大越常去看指针、越常盯着不放 */
  curiosity: number;
  /** 歪头幅度（度，7–15） */
  tiltAmp: number;
  /** 一开始（以及窗口失焦、减少动效时静止的姿势）往哪边歪：-1 左、1 右 */
  firstSide: -1 | 1;
  /** 两只眼各自多转的一点点（度，±2.5）：不像复制粘贴 */
  eyeSkew: [number, number];
}

export function personaOf(key: string): Persona {
  const r = mulberry32(keyHash(key));
  return {
    curiosity: 0.2 + 0.65 * r(),
    tiltAmp: 7 + 8 * r(),
    firstSide: r() < 0.5 ? -1 : 1,
    eyeSkew: [(r() - 0.5) * 5, (r() - 0.5) * 5],
  };
}

/** 各种时长（ms）与概率 */
export const MIND = {
  /** idle 里一个小动作停多久 */
  hold: { min: 400, max: 2500 },
  /** 发呆（回正中略往下、不动） */
  daydream: { min: 1000, max: 2000 },
  daydreamChance: 0.12,
  /** idle 里回正中的概率（其余是往某处瞟） */
  centerChance: 0.22,
  /** 看指针：瞟一眼 / 盯一阵 */
  glanceAtPointer: { min: 500, max: 1200 },
  stare: { min: 1500, max: 4500 },
  /** 第一段（错开各天体）：0 到这么久 */
  firstMax: 2500,
  /** 歪头：一侧停多久；先在正中停一下的概率与时长 */
  tiltHold: { min: 3000, max: 8000 },
  tiltCenter: { min: 500, max: 1400 },
  tiltCenterChance: 0.35,
  /** 眨眼间隔、连眨的概率；移开视线、换边歪头时顺带眨一下的概率 */
  blinkGap: { min: 2500, max: 7000 },
  doubleChance: 0.25,
  blinkOnLeaveChance: 0.5,
  blinkOnTiltChance: 0.4,
  /** 移开视线时顺带换边歪头的概率 */
  tiltOnLeaveChance: 0.4,
} as const;

/** 一次眨眼多长（ms）；连眨两次之间隔多久 */
export const BLINK_MS = 200;
export const DOUBLE_GAP_MS = 110;

/** 指针离天体这么远（px）以上，眼睛转到底、头歪到底 */
export const GAZE_REACH_PX = 160;

export type MindMode = "look" | "idle";

export interface Mind {
  persona: Persona;
  mode: MindMode;
  /** 这一段（一个小动作 / 一次看指针）到什么时候 */
  until: number;
  /** idle 时看哪儿：单位圆里的一点（0 = 正中） */
  aim: { x: number; y: number };
  /** idle 里这一段是不是发呆 */
  daydream: boolean;
  /** 静息倾角在哪一侧（0 = 正中停一下） */
  tiltSide: -1 | 0 | 1;
  /** 在正中停完之后去哪一侧 */
  tiltNext: -1 | 1;
  tiltUntil: number;
  /** 排好的眨眼（每次的起点，ms） */
  blinks: number[];
  nextBlink: number;
}

/** 看指针的概率（一个 idle 动作做完、指针在窗口里时）：害羞的 0.25 上下，好奇的近六成 */
export function lookChance(persona: Persona): number {
  return 0.15 + 0.5 * persona.curiosity;
}

function scheduleBlink(mind: Mind, rng: Rng, at: number): void {
  // 已经排着一次（还没眨完）就不叠
  if (mind.blinks.some((start) => start + BLINK_MS > at - DOUBLE_GAP_MS)) return;
  mind.blinks.push(at);
  if (rng() < MIND.doubleChance) mind.blinks.push(at + BLINK_MS + DOUBLE_GAP_MS);
}

/** idle 的一个小动作：瞟向某处（左右为主）、回正中、或发呆 */
function idleAction(mind: Mind, rng: Rng, now: number, leaving = false): void {
  mind.mode = "idle";
  mind.daydream = false;
  const roll = rng();
  if (!leaving && roll < MIND.daydreamChance) {
    mind.daydream = true;
    mind.aim = { x: 0, y: 0.2 };
    mind.until = now + between(rng, MIND.daydream);
    return;
  }
  if (!leaving && roll < MIND.daydreamChance + MIND.centerChance) {
    mind.aim = { x: 0, y: 0 };
  } else {
    // 往某处瞟：横向为主（-1…1 里取 0.45–1 的远近），纵向小一些；移开视线时一定瞟得够远
    const side = rng() < 0.5 ? -1 : 1;
    const x = side * (leaving ? 0.6 + 0.4 * rng() : 0.45 + 0.55 * rng());
    const y = (rng() - 0.5) * 1.1;
    const d = Math.hypot(x, y);
    mind.aim = d > 1 ? { x: x / d, y: y / d } : { x, y };
  }
  mind.until = now + between(rng, MIND.hold);
}

/** 刚挂上的天体：从 idle 开始，第一段 0–2.5 秒随机（各天体错开）；歪头从性格里的初始一侧开始 */
export function firstMind(persona: Persona, rng: Rng, now: number): Mind {
  const mind: Mind = {
    persona,
    mode: "idle",
    until: now,
    aim: { x: 0, y: 0 },
    daydream: false,
    tiltSide: persona.firstSide,
    tiltNext: persona.firstSide === 1 ? -1 : 1,
    tiltUntil: now + 1000 + rng() * (MIND.tiltHold.max - 1000),
    blinks: [],
    nextBlink: now + rng() * MIND.blinkGap.max,
  };
  idleAction(mind, rng, now);
  mind.until = now + rng() * MIND.firstMax;
  return mind;
}

/**
 * 往前走一拍（改 mind）：到点的注意力段、歪头、眨眼各自换下一段。
 * pointerInside = 指针在窗口里（不在就不会去看；正在看的也在这一段完了就移开）。
 */
export function stepMind(mind: Mind, rng: Rng, now: number, pointerInside: boolean): void {
  if (now >= mind.until) {
    if (mind.mode === "look") {
      // 看完：接着做一个「移开」的动作，不在原处停住
      idleAction(mind, rng, now, true);
      if (rng() < MIND.blinkOnLeaveChance) scheduleBlink(mind, rng, now + 60);
      if (rng() < MIND.tiltOnLeaveChance) mind.tiltUntil = Math.min(mind.tiltUntil, now + 150);
    } else if (pointerInside && rng() < lookChance(mind.persona)) {
      mind.mode = "look";
      mind.daydream = false;
      mind.until = now + between(rng, rng() < mind.persona.curiosity ? MIND.stare : MIND.glanceAtPointer);
    } else {
      idleAction(mind, rng, now);
    }
  }
  if (now >= mind.tiltUntil) {
    if (mind.tiltSide === 0) {
      mind.tiltSide = mind.tiltNext;
      mind.tiltUntil = now + between(rng, MIND.tiltHold);
    } else if (rng() < MIND.tiltCenterChance) {
      mind.tiltNext = mind.tiltSide === 1 ? -1 : 1;
      mind.tiltSide = 0;
      mind.tiltUntil = now + between(rng, MIND.tiltCenter);
    } else {
      mind.tiltSide = mind.tiltSide === 1 ? -1 : 1;
      mind.tiltUntil = now + between(rng, MIND.tiltHold);
    }
    if (mind.tiltSide !== 0 && rng() < MIND.blinkOnTiltChance) scheduleBlink(mind, rng, now + 120);
  }
  if (now >= mind.nextBlink) {
    scheduleBlink(mind, rng, now);
    mind.nextBlink = now + between(rng, MIND.blinkGap);
  }
  // 眨完的扔掉
  if (mind.blinks.length > 0 && mind.blinks[0] !== undefined && mind.blinks[0] + BLINK_MS < now) mind.blinks = mind.blinks.filter((start) => start + BLINK_MS >= now);
}

/** 此刻在不在眨眼 */
export function blinkingAt(mind: Mind, now: number): boolean {
  return mind.blinks.some((start) => now >= start && now < start + BLINK_MS);
}

/**
 * 眼睛此刻竖向张开多少（1 = 睁着，0.1 = 闭上）：一次眨眼是「合 → 闭 → 张」的三角，中点最闭。
 * 运行时按拍取样（眨眼时 50ms 一拍：约 0.55 → 0.1 → 0.55 → 1）。不用 CSS 动画——SVG 上的 CSS 动画每一帧都要主线程出帧，
 * 二十来颗星轮流眨，页面就一直在 60fps 出帧（实测渲染进程主线程多 14 个点）。
 */
export function eyeOpenness(mind: Pick<Mind, "blinks">, now: number): number {
  for (const start of mind.blinks) {
    const p = (now - start) / BLINK_MS;
    if (p >= 0 && p < 1) return 1 - 0.9 * (1 - Math.abs(2 * p - 1));
  }
  return 1;
}

/** 下一次眨眼什么时候开始（还没开始的里最早的）；没有排着的 = Infinity */
export function nextBlinkStart(mind: Pick<Mind, "blinks" | "nextBlink">, now: number): number {
  let best = mind.nextBlink > now ? mind.nextBlink : Infinity;
  for (const start of mind.blinks) if (start > now && start < best) best = start;
  return best;
}

/**
 * 眼睛此刻该挪到哪（单位：最大位移的倍数，长度 ≤ 1，屏幕平面里）：
 * look = 朝指针的方向，离得近时挪得少（指针就在脸上时几乎正视）；idle 或没有指针 = aim。
 */
export function gazeOffset(mind: Pick<Mind, "mode" | "aim">, center: { x: number; y: number }, pointer: { x: number; y: number } | null): { x: number; y: number } {
  if (mind.mode === "idle" || pointer === null) return mind.aim;
  const dx = pointer.x - center.x;
  const dy = pointer.y - center.y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return { x: 0, y: 0 };
  const k = Math.min(1, d / GAZE_REACH_PX);
  return { x: (dx / d) * k, y: (dy / d) * k };
}

/** 整双眼睛此刻该歪多少度（正 = 顺时针 / 向右）：看指针时往指针那边歪，否则是静息倾角（当前那一侧） */
export function tiltTarget(mind: Pick<Mind, "mode" | "tiltSide" | "persona">, center: { x: number; y: number }, pointer: { x: number; y: number } | null): number {
  if (mind.mode === "look" && pointer !== null) {
    const k = Math.max(-1, Math.min(1, (pointer.x - center.x) / GAZE_REACH_PX));
    return k * mind.persona.tiltAmp;
  }
  return mind.tiltSide * mind.persona.tiltAmp;
}

/** 静止时的姿势（窗口失焦、减少动效、离电省电）：正视、按性格里的初始一侧歪着 */
export function restTilt(persona: Persona): number {
  return persona.firstSide * persona.tiltAmp;
}
